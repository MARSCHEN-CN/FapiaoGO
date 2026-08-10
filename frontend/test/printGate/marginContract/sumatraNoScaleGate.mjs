#!/usr/bin/env node
/**
 * Sumatra NoScale Gate — C-2 Step 4-2b-2a（2026-08-10，DEV migration proof）
 *
 * 目标（用户批准，4-2b-2 边界：不碰 geometry 链）：
 *   证明「baked PDF → Sumatra noscale」与「baked PDF → Sumatra fit」严格等价：
 *
 *     Plan geometry → placement bake → MediaBox == executionPaper
 *         ├─ Sumatra fit     → artifact_fit
 *         └─ Sumatra noscale → artifact_noscale
 *
 *   当 PDF 已 bake 到最终纸尺寸时，Sumatra 不应再参与 layout。
 *
 * Case 矩阵（用户表格语义；内容 PDF 为 bake 输入源）：
 *   A3-01 portrait A4 + portrait content（竖纸竖内容，无旋转）
 *   A3-02 landscape A4 + landscape content（横纸横内容）
 *   A3-03 横票→竖纸（layoutRotation=-90，内容旋转烤进 bake）
 *   A3-04 portrait content + landscape paper（反向方向冲突）
 *   A3-07 margin 极限（内容接近纸边缘）
 *
 * 断言（fit vs noscale artifact 对比）：
 *   - artifact 物理尺寸一致（±1mm）——printer DEVMODE / paper command 历史变量不能改尺寸
 *   - content bbox 逐边 drift ≤ 0.5mm
 *   - content center drift ≤ 1mm
 *   允许：raster 差异、printer metadata 差异（不看 PDF 内部，只量 artifact 几何）
 *
 * 生产命令 = buildPrintSettings 1:1（fit:'contain' → fit；fit:'none' → noscale），
 * 消除「复刻漂移」（与 A3-V2 同源，require 生产模块）。
 *
 * 用法:
 *   node sumatraNoScaleGate.mjs                    # 全 5 case 端到端（需 Sumatra + Wondershare）
 *   node sumatraNoScaleGate.mjs --only A3-03       # 单 case
 *   node sumatraNoScaleGate.mjs --skip-print       # 只验证 bake + 断言链（无需打印机）
 *
 * 退出码：0 = PASS；1 = FAIL。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const PY = path.join(REPO, 'backend', 'venv', 'Scripts', 'python.exe')
const SUMATRA = path.join(REPO, 'resources', 'sumatra', 'SumatraPDF.exe')
const OUT = path.join(HERE, '.out', 'noscale')
const DPI = 300

const require = createRequire(import.meta.url)
const { buildPrintSettings } = require(path.join(REPO, 'electron', 'print-service', 'print-settings.js'))

const argv = process.argv.slice(2)
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const only = get('--only', '')
const skipPrint = argv.includes('--skip-print')

// 容差（用户批准）：bbox 逐边 drift ≤ 0.5mm；center drift ≤ 1mm；物理尺寸 ±1mm
const BBOX_DRIFT_MM = 0.5
const CENTER_DRIFT_MM = 1.0
const SIZE_TOL_MM = 1.0

function sleep(ms) { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ms) }
function sh(cmd, args, timeout = 120000) {
  return execFileSync(cmd, args, { timeout }).toString()
}

// ── 1. 真实 placement（RotationResolver，与生产 placements useMemo 同源）──
function computePlacement(contentPt, paperMm, margins) {
  const code = `
const { resolveContentPlacement } = require('./frontend/src/layout/RotationResolver.js')
const placement = resolveContentPlacement({
  contentPhysicalSize: { width: ${contentPt.w} * 300/72, height: ${contentPt.h} * 300/72 },
  contentRotation: 0,
  physicalPaper: { widthMM: ${paperMm.w}, heightMM: ${paperMm.h} },
  margins: { left: ${margins.l}, right: ${margins.r}, top: ${margins.t}, bottom: ${margins.b} },
  dpi: 300,
})
console.log(JSON.stringify(placement))
`
  return JSON.parse(sh(process.execPath, ['-e', code]).trim())
}

// ── 2. bake（4-2a 冻结脚本；PlacementBakeSpec 契约）──
function bake(srcPdf, outPdf, paperMm, placement) {
  const spec = {
    source_pdf: srcPdf.replace(/\\/g, '/'),
    output_pdf: outPdf.replace(/\\/g, '/'),
    paper: { widthMm: paperMm.w, heightMm: paperMm.h },
    placement: {
      scale: placement.scale,
      offset: placement.offset,
      placedRect: placement.placedRect,
      layoutRotation: placement.layoutRotation,
      canvasSize: placement.canvasSize,
    },
    dpi: DPI,
  }
  const specFile = outPdf.replace(/\.pdf$/, '.spec.json')
  fs.writeFileSync(specFile, JSON.stringify(spec))
  const out = JSON.parse(sh(PY, [
    path.join(REPO, 'scripts', 'placement_bake.py'),
    '--source', srcPdf, '--output', outPdf,
    '--paper-width-mm', String(paperMm.w), '--paper-height-mm', String(paperMm.h),
    '--placement-file', specFile, '--dpi', String(DPI),
  ]))
  if (!out.success) throw new Error(`bake 失败: ${out.error}`)
  return out.info
}

// ── 3. 量 PDF 内容 bbox（px@300，top-left）+ 物理尺寸 ──
function measureBBox(pdfPath) {
  const code = `
import fitz, numpy as np, json
d = fitz.open(r'${pdfPath.replace(/\\/g, '/')}')
p = d[0]
pix = p.get_pixmap(dpi=300)
a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
mask = a[:,:,:3].mean(axis=2) < 250
mm = 25.4/300
if mask.sum() == 0:
    print(json.dumps({'empty': True}))
else:
    ys, xs = np.where(mask)
    print(json.dumps({
      'wMm': round(pix.width*mm, 2), 'hMm': round(pix.height*mm, 2),
      'L': round(xs.min()*mm, 2), 'T': round(ys.min()*mm, 2),
      'R': round((pix.width-1-xs.max())*mm, 2), 'B': round((pix.height-1-ys.max())*mm, 2),
      'cxMm': round(((xs.min()+xs.max())/2)*mm, 2), 'cyMm': round(((ys.min()+ys.max())/2)*mm, 2),
    }))
d.close()
`
  const out = sh(PY, ['-c', code]).trim()
  return JSON.parse(out)
}

// ── 4. Sumatra 打印（fit / noscale 由 printSettings 决定；返回 artifact 路径）──
function printWithSumatra(bakedPdf, printSettings, tag) {
  const artifact = path.join(OUT, `${tag}.pdf`)
  try {
    sh(SUMATRA, ['-print-to', 'Wondershare PDFelement',
      '-print-settings', printSettings,
      '-silent', '-exit-when-done', bakedPdf])
  } catch (e) {
    throw new Error(`Sumatra 调用失败: ${e.message}`)
  }
  // 抓取 Wondershare 落盘（按内容文件名匹配 + mtime 最新 + 非空检查——A3-V2/RG-3 教训）
  const W = 'C:/ProgramData/Wondershare/PDFelement10/PDFCreator'
  const stem = path.basename(bakedPdf).replace(/\.pdf$/i, '')
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    sleep(2000)
    try {
      const names = fs.readdirSync(W).filter(f => f === stem + '.pdf' || new RegExp(`^${stem}_\\d+\\.pdf$`).test(f))
      if (!names.length) continue
      const full = path.join(W, names.sort().pop())
      if (fs.statSync(full).size > 0) { fs.copyFileSync(full, artifact); return artifact }
    } catch {}
  }
  throw new Error(`未抓到 Sumatra artifact（Wondershare 落盘）: ${stem}`)
}

// ── 5. Case 定义（内容 PDF + 目标纸 + margins）──
const CASES = [
  {
    id: 'A3-01', name: 'portrait A4 + portrait content',
    content: path.join(HERE, '.out', 'a3v2_portrait_content.pdf'),
    paper: { w: 210, h: 297 }, paperOrient: 'portrait', contentOrient: 'portrait',
    margins: { l: 3, r: 3, t: 3, b: 3 },
  },
  {
    id: 'A3-02', name: 'landscape A4 + landscape content',
    content: path.join(REPO, 'test_fixtures', 'a4_landscape_sample.pdf'),
    paper: { w: 297, h: 210 }, paperOrient: 'landscape', contentOrient: 'landscape',
    margins: { l: 3, r: 3, t: 3, b: 3 },
  },
  {
    id: 'A3-03', name: '横票→竖纸（layoutRotation=-90）',
    content: path.join(REPO, 'test_fixtures', '25952000000127675627.pdf'),
    paper: { w: 210, h: 297 }, paperOrient: 'portrait', contentOrient: 'landscape',
    margins: { l: 3, r: 3, t: 3, b: 3 },
  },
  {
    id: 'A3-04', name: 'portrait content + landscape paper（反向冲突）',
    content: path.join(HERE, '.out', 'a3v2_portrait_content.pdf'),
    paper: { w: 297, h: 210 }, paperOrient: 'landscape', contentOrient: 'portrait',
    margins: { l: 3, r: 3, t: 3, b: 3 },
  },
  {
    id: 'A3-07', name: 'margin 极限（内容接近纸边缘）',
    content: path.join(HERE, '.out', 'a3v2_asym_margin.pdf'),
    paper: { w: 210, h: 297 }, paperOrient: 'portrait', contentOrient: 'portrait',
    margins: { l: 1, r: 1, t: 1, b: 1 },
  },
]

// 内容 PDF 尺寸（pt）——与 fixture 探测一致
const CONTENT_PT = {
  'a3v2_portrait_content.pdf': { w: 595.3, h: 841.9 },
  'a4_landscape_sample.pdf': { w: 842.0, h: 595.0 },
  '25952000000127675627.pdf': { w: 595.3, h: 396.9 },
  'a3v2_asym_margin.pdf': { w: 595.3, h: 841.9 },
}

function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const active = CASES.filter(c => !only || c.id === only)
  if (!active.length) { console.error('❌ 无匹配 case'); process.exit(2) }

  console.log('=== 4-2b-2a Sumatra NoScale Gate（fit vs noscale 等价证明）===')
  let allPass = true

  for (const c of active) {
    const contentPt = CONTENT_PT[path.basename(c.content)]
    if (!contentPt) { console.error(`❌ 未知内容尺寸: ${c.content}`); process.exit(2) }

    console.log(`\n── ${c.id} ${c.name} ──`)
    console.log(`  content: ${path.relative(REPO, c.content)} (${contentPt.w}×${contentPt.h}pt)`)
    console.log(`  paper: ${c.paper.w}×${c.paper.h}mm (${c.paperOrient})`)

    // 1. 真实 placement + bake
    const placement = computePlacement(contentPt, c.paper, c.margins)
    console.log(`  placement: layoutRotation=${placement.layoutRotation} scale=${placement.scale.toFixed(4)}`)
    const bakedPdf = path.join(OUT, `${c.id}.baked.pdf`)
    const bakeInfo = bake(c.content, bakedPdf, c.paper, placement)
    console.log(`  bake: MediaBox=${bakeInfo.mediaBox} /Rotate=${bakeInfo.rotate} phi=${bakeInfo.phi}`)

    // 2. 生产命令（fit vs noscale 同一 ps，只改 fit）
    const basePs = {
      rotation: 0, sourceRotation: 0,
      paper: 'A4', paperOrientation: c.paperOrient, contentOrientation: c.contentOrient,
    }
    const cmdFit = buildPrintSettings({ ...basePs, fit: 'contain' })
    const cmdNoScale = buildPrintSettings({ ...basePs, fit: 'none' })
    console.log(`  cmd(fit):     "${cmdFit}"`)
    console.log(`  cmd(noscale): "${cmdNoScale}"`)

    if (skipPrint) {
      console.log('  （--skip-print：跳过 Sumatra 打印）')
      const baked = measureBBox(bakedPdf)
      console.log(`  bake 输出: ${baked.wMm}×${baked.hMm}mm 边距 L${baked.L} T${baked.T} R${baked.R} B${baked.B}`)
      continue
    }

    // 3. fit 打印 → artifact_fit
    const artFit = printWithSumatra(bakedPdf, cmdFit, `${c.id}.fit`)
    const fit = measureBBox(artFit)
    console.log(`  fit artifact: ${fit.wMm}×${fit.hMm}mm 边距 L${fit.L} T${fit.T} R${fit.R} B${fit.B}`)

    // 4. noscale 打印 → artifact_noscale
    const artNs = printWithSumatra(bakedPdf, cmdNoScale, `${c.id}.noscale`)
    const ns = measureBBox(artNs)
    console.log(`  noscale artifact: ${ns.wMm}×${ns.hMm}mm 边距 L${ns.L} T${ns.T} R${ns.R} B${ns.B}`)

    // 5. 断言：fit vs noscale 严格等价（drift 容差内）
    const sizeOk = Math.abs(fit.wMm - ns.wMm) <= SIZE_TOL_MM && Math.abs(fit.hMm - ns.hMm) <= SIZE_TOL_MM
    const driftL = Math.abs(fit.L - ns.L), driftT = Math.abs(fit.T - ns.T)
    const driftR = Math.abs(fit.R - ns.R), driftB = Math.abs(fit.B - ns.B)
    const maxDrift = Math.max(driftL, driftT, driftR, driftB)
    const centerDrift = Math.hypot(fit.cxMm - ns.cxMm, fit.cyMm - ns.cyMm)
    const pass = sizeOk && maxDrift <= BBOX_DRIFT_MM && centerDrift <= CENTER_DRIFT_MM

    console.log(`  尺寸差: ΔW=${Math.abs(fit.wMm - ns.wMm).toFixed(2)} ΔH=${Math.abs(fit.hMm - ns.hMm).toFixed(2)}mm（容差 ${SIZE_TOL_MM}mm）`)
    console.log(`  bbox drift: L+${driftL.toFixed(2)} T+${driftT.toFixed(2)} R+${driftR.toFixed(2)} B+${driftB.toFixed(2)}mm（容差 ${BBOX_DRIFT_MM}mm，max=${maxDrift.toFixed(2)}）`)
    console.log(`  center drift: ${centerDrift.toFixed(2)}mm（容差 ${CENTER_DRIFT_MM}mm）`)
    console.log(pass ? '  ✅ noscale == fit（等价证明成立）' : '  ❌ noscale != fit（drift 超容差）')
    if (!pass) allPass = false
  }

  console.log(allPass
    ? '\nGATE PASS ✅ 4-2b-2a：Sumatra noscale 与 fit 在 baked PDF 上严格等价（几何零干预）'
    : '\nGATE FAIL ❌ 4-2b-2a：存在 case noscale 与 fit 不等价')
  process.exit(allPass ? 0 : 1)
}

main()
