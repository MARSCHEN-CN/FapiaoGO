#!/usr/bin/env node
/**
 * Sumatra Landscape Gate — PostScript 原生横向纸（C-2 后续调查，2026-08-11）
 *
 * 背景：真实打印验证发现「竖向纸张通过、横向纸张失败」。最小复现证明：
 *   PostScript 纸（240×140mm 原生横向）bake 产物（MediaBox 240×140 /Rotate=0）
 *   经生产命令 `landscape,noscale,paper=postscript` 打印到 Wondershare：
 *   - /Rotate=90（Sumatra landscape 旗标伴生内容旋转）→ 内容二次旋转
 *   - content bbox 36×59mm（旋转 + 裁切）→ 横向打印失败
 *
 * 本 Gate 固化验收基线（修复后应 PASS）：
 *   PostScript 纸 bake → Sumatra noscale → artifact 必须：
 *   1. 物理尺寸 == 240×140mm（±1mm）——纸方向正确（横）
 *   2. /Rotate == 0 ——内容未被二次旋转
 *   3. content bbox 无旋转 + 无裁切（bbox 宽高比与 bake 产物一致，≥ 90% 面积）
 *
 * 当前状态：EXPECTED FAIL（记录生产 bug；修复方向见调查报告）。
 * 用法: node sumatraLandscapeGate.mjs [--print-command '...']（默认生产命令）
 * 退出码：0 = PASS（修复达成）；1 = FAIL（bug 存在 / 复现失败）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const PY = path.join(REPO, 'backend', 'venv', 'Scripts', 'python.exe')
const SUMATRA = path.join(REPO, 'resources', 'sumatra', 'SumatraPDF.exe')
const OUT = path.join(HERE, '.out', 'landscape-gate')

function sleep(ms) { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ms) }
function sh(cmd, args, timeout = 120000) { return execFileSync(cmd, args, { timeout }).toString() }

const argv = process.argv.slice(2)
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const PRINT_CMD = get('--print-command', 'landscape,noscale,paper=postscript')

function main() {
  fs.mkdirSync(OUT, { recursive: true })
  console.log('=== Sumatra Landscape Gate（PostScript 原生横向纸）===')
  console.log(`print-command: "${PRINT_CMD}"`)

  // 1. bake PostScript 纸（240×140，横内容横纸）
  const code = `
const { resolveContentPlacement } = require('./frontend/src/layout/RotationResolver.js')
const placement = resolveContentPlacement({
  contentPhysicalSize: { width: 842 * 300/72, height: 595 * 300/72 },
  contentRotation: 0,
  physicalPaper: { widthMM: 240, heightMM: 140 },
  margins: { left: 3, right: 3, top: 3, bottom: 3 },
  dpi: 300,
})
console.log(JSON.stringify(placement))
`
  const placement = JSON.parse(sh(process.execPath, ['-e', code]).trim())
  const srcPdf = path.join(REPO, 'test_fixtures', 'a4_landscape_sample.pdf')
  const bakedPdf = path.join(OUT, 'ps.baked.pdf')
  const spec = {
    source_pdf: srcPdf.replace(/\\/g, '/'), output_pdf: bakedPdf.replace(/\\/g, '/'),
    paper: { widthMm: 240, heightMm: 140 },
    placement: {
      scale: placement.scale, offset: placement.offset, placedRect: placement.placedRect,
      layoutRotation: placement.layoutRotation, canvasSize: placement.canvasSize,
    },
    dpi: 300,
  }
  fs.writeFileSync(path.join(OUT, 'ps.baked.spec.json'), JSON.stringify(spec))
  const bakeOut = JSON.parse(sh(PY, [
    path.join(REPO, 'scripts', 'placement_bake.py'),
    '--source', srcPdf, '--output', bakedPdf,
    '--paper-width-mm', '240', '--paper-height-mm', '140',
    '--placement-file', path.join(OUT, 'ps.baked.spec.json'), '--dpi', '300',
  ]))
  if (!bakeOut.success) { console.error('❌ bake 失败:', bakeOut.error); process.exit(1) }
  console.log(`bake: MediaBox=${bakeOut.info.mediaBox} /Rotate=0 layoutRotation=${placement.layoutRotation}`)

  // 2. 基线：bake 产物自身 bbox（验收参照）
  const bakedMeasure = probe(bakedPdf)
  console.log(`bake 内容: ${bakedMeasure.bboxWmM}×${bakedMeasure.bboxHmM}mm`)

  // 3. Sumatra 打印 + grab
  if (!fs.existsSync(SUMATRA)) { console.error('❌ SumatraPDF 不存在'); process.exit(1) }
  const W = 'C:/ProgramData/Wondershare/PDFelement10/PDFCreator'
  try {
    sh(SUMATRA, ['-print-to', 'Wondershare PDFelement', '-print-settings', PRINT_CMD, '-silent', '-exit-when-done', bakedPdf])
  } catch (e) { console.error('❌ Sumatra 失败:', e.message); process.exit(1) }
  const stem = path.basename(bakedPdf).replace(/\.pdf$/i, '')
  const artifact = path.join(OUT, 'artifact.pdf')
  const deadline = Date.now() + 30000
  let got = false
  while (Date.now() < deadline) {
    sleep(2000)
    try {
      const names = fs.readdirSync(W).filter(f => f === stem + '.pdf' || new RegExp(`^${stem}_\\d+\\.pdf$`).test(f))
      if (!names.length) continue
      const full = path.join(W, names.sort().pop())
      if (fs.statSync(full).size > 0) { fs.copyFileSync(full, artifact); got = true; break }
    } catch {}
  }
  if (!got) { console.error('❌ 未抓到 artifact'); process.exit(1) }

  // 4. artifact 断言
  const m = probe(artifact)
  console.log(`artifact: MediaBox=${JSON.stringify(m.rawMediaBoxPt)}pt /Rotate=${m.rotate} 视觉 ${m.wMm}×${m.hMm}mm`)
  console.log(`content bbox: ${m.bboxWmM}×${m.bboxHmM}mm`)
  const sizeOk = Math.abs(m.wMm - 240) < 1 && Math.abs(m.hMm - 140) < 1
  const rotOk = m.rotate === 0
  // 内容宽高比接近 bake 产物（无旋转），面积 ≥ 90%（无裁切）
  const ratio = Math.min(m.bboxWmM / bakedMeasure.bboxWmM, m.bboxHmM / bakedMeasure.bboxHmM)
  const areaRatio = (m.bboxWmM * m.bboxHmM) / (bakedMeasure.bboxWmM * bakedMeasure.bboxHmM)
  const contentOk = areaRatio >= 0.9 && ratio >= 0.9
  console.log(`断言: 尺寸=${sizeOk ? '✅' : '❌'} /Rotate=0=${rotOk ? '✅' : '❌'} 内容完整=${contentOk ? '✅' : '❌'} (面积比 ${(areaRatio * 100).toFixed(0)}%)`)
  const pass = sizeOk && rotOk && contentOk
  console.log(pass
    ? '\nGATE PASS ✅ PostScript 横向纸原样输出（修复达成）'
    : '\nGATE FAIL ❌ PostScript 横向纸异常（生产 bug 复现/未修复）')
  process.exit(pass ? 0 : 1)
}

function probe(pdf) {
  const code = `
import fitz, numpy as np, json
d = fitz.open(r'${pdf.replace(/\\/g, '/')}')
p = d[0]
pix = p.get_pixmap(dpi=300)
a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
mask = a[:,:,:3].mean(axis=2) < 250
mm = 25.4/300
ys, xs = np.where(mask)
print(json.dumps({
  'rawMediaBoxPt': [round(v,2) for v in p.rect], 'rotate': p.rotation,
  'wMm': round(pix.width*mm,1), 'hMm': round(pix.height*mm,1),
  'bboxWmM': round((xs.max()-xs.min())*mm,1) if mask.sum() else 0,
  'bboxHmM': round((ys.max()-ys.min())*mm,1) if mask.sum() else 0,
}))
d.close()
`
  return JSON.parse(sh(PY, ['-c', code]).trim())
}

main()
