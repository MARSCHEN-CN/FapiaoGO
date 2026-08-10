#!/usr/bin/env node
/**
 * A3-03 Placement Bake Gate — C-2 Step 4-2a（DEV，2026-08-10）
 *
 * 端到端验证「Plan placement → bake → Sumatra noscale 纯执行」闭环：
 *
 *   1. 用 RotationResolver.resolveContentPlacement 算横票竖纸的 placement（真实 Plan 几何）
 *   2. placement_bake.py 烤进 PDF（PlacementBakeSpec 契约）
 *   3. Sumatra noscale + paper command 打印（Wondershare capture）
 *   4. 断言 artifact：
 *      - MediaBox == target paper（A4 portrait 595×842）
 *      - /Rotate == 0
 *      - 内容四边距对称（|L-R| < 1.5mm、|T-B| < 1.5mm）—— A3-03 验收：
 *        「竖纸 + 居中 + 正确 margin」（不再被 Sumatra fit 缩进竖纸）
 *
 * ⚠️ 只验证 bake + executor 闭环；不改生产接线（4-2b 范围）。
 *
 * 用法:
 *   node placementBakeGate.mjs                     # 完整端到端（需 Sumatra + Wondershare）
 *   node placementBakeGate.mjs --skip-print        # 只验证 bake 输出（无需打印机）
 *   node placementBakeGate.mjs --only-bake         # 只跑 bake + 本地断言
 *
 * 退出码：0 = PASS；1 = FAIL。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const PY = path.join(REPO, 'backend', 'venv', 'Scripts', 'python.exe')
const SUMATRA = path.join(REPO, 'resources', 'sumatra', 'SumatraPDF.exe')
const OUT = path.join(HERE, '.out')
const TOLERANCE_MM = 1.5

const argv = process.argv.slice(2)
const skipPrint = argv.includes('--skip-print')
const onlyBake = argv.includes('--only-bake')

function sleep(ms) { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ms) }
function sh(cmd, args, timeout = 120000) {
  return execFileSync(cmd, args, { timeout }).toString()
}

// ── 1. 真实 placement（与 usePrint placements useMemo 同源）──
function computePlacement() {
  const code = `
const { resolveContentPlacement } = require('./frontend/src/layout/RotationResolver.js')
const placement = resolveContentPlacement({
  contentPhysicalSize: { width: 595.28 * 300/72, height: 396.85 * 300/72 },
  contentRotation: 0,
  physicalPaper: { widthMM: 210, heightMM: 297 },
  margins: { left: 3, right: 3, top: 3, bottom: 3 },
  dpi: 300,
})
console.log(JSON.stringify(placement))
`
  const out = sh(process.execPath, ['-e', code]).trim()
  return JSON.parse(out)
}

// ── 2. 量 PDF 内容 bbox（px@300，top-left）──
function measureBBox(pdfPath) {
  const code = `
import fitz, numpy as np, json
d = fitz.open(r'${pdfPath.replace(/\\/g, '/')}')
p = d[0]
pix = p.get_pixmap(dpi=300)
a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
mask = a[:,:,:3].mean(axis=2) < 250
ys, xs = np.where(mask)
mm = 25.4/300
print(json.dumps({
  'wMm': round(pix.width*mm, 2), 'hMm': round(pix.height*mm, 2),
  'rotate': p.rotation,
  'L': round(xs.min()*mm, 2), 'T': round(ys.min()*mm, 2),
  'R': round((pix.width-1-xs.max())*mm, 2), 'B': round((pix.height-1-ys.max())*mm, 2),
}))
d.close()
`
  const out = sh(PY, ['-c', code]).trim()
  return JSON.parse(out)
}

function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const srcPdf = path.join(REPO, 'test_fixtures', '25952000000127675627.pdf')
  const bakedPdf = path.join(OUT, 'a3-03.baked.pdf')

  console.log('=== A3-03 Placement Bake Gate（C-2 Step 4-2a DEV）===')
  console.log(`源: ${path.relative(REPO, srcPdf)}`)

  // ── Step 1: 真实 placement ──
  const placement = computePlacement()
  console.log(`placement: layoutRotation=${placement.layoutRotation} scale=${placement.scale.toFixed(4)} offset=(${placement.offset.x},${placement.offset.y})`)
  console.log(`          placedRect=(${placement.placedRect.x},${placement.placedRect.y},${placement.placedRect.w}x${placement.placedRect.h})`)
  console.log(`          canvasSize=(${placement.canvasSize.width}x${placement.canvasSize.height})`)

  // ── Step 2: bake（PlacementBakeSpec 契约）──
  const specFile = path.join(OUT, 'a3-03.spec.json')
  fs.writeFileSync(specFile, JSON.stringify({
    source_pdf: srcPdf.replace(/\\/g, '/'),
    output_pdf: bakedPdf.replace(/\\/g, '/'),
    paper: { widthMm: 210, heightMm: 297 },
    placement: {
      scale: placement.scale,
      offset: placement.offset,
      placedRect: placement.placedRect,
      layoutRotation: placement.layoutRotation,
      canvasSize: placement.canvasSize,
    },
    dpi: 300,
  }))
  const bakeOut = JSON.parse(sh(PY, [
    path.join(REPO, 'scripts', 'placement_bake.py'),
    '--source', srcPdf, '--output', bakedPdf,
    '--paper-width-mm', '210', '--paper-height-mm', '297',
    '--placement-file', specFile, '--dpi', '300',
  ]))
  if (!bakeOut.success) {
    console.error('❌ bake 失败:', bakeOut.error)
    process.exit(1)
  }
  console.log(`bake OK: MediaBox=${bakeOut.info.mediaBox} /Rotate=${bakeOut.info.rotate} phi=${bakeOut.info.phi}`)

  // ── Step 3: bake 输出契约断言 ──
  const baked = measureBBox(bakedPdf)
  console.log(`bake 输出: ${baked.wMm}x${baked.hMm}mm /Rotate=${baked.rotate} 边距 L${baked.L} T${baked.T} R${baked.R} B${baked.B}`)
  const bakePass = Math.abs(baked.wMm - 210) < 1 && Math.abs(baked.hMm - 297) < 1 && baked.rotate === 0
  console.log(bakePass ? '  ✅ MediaBox==paper + /Rotate=0' : '  ❌ bake 输出契约失败')
  if (!bakePass) process.exit(1)

  // ── Step 4: 端到端（bake → Sumatra noscale）──
  if (onlyBake) {
    console.log('（--only-bake：跳过 Sumatra 打印）')
    console.log('\nGATE PASS（bake 层）')
    process.exit(0)
  }
  if (skipPrint) {
    console.log('（--skip-print：跳过 Sumatra 打印，仅验证 bake）')
    console.log('\nGATE PASS（bake 层，未验证 executor）')
    process.exit(0)
  }

  if (!fs.existsSync(SUMATRA)) {
    console.error(`❌ SumatraPDF 不存在: ${SUMATRA}`)
    process.exit(1)
  }
  console.log('\n▶ Sumatra noscale 打印（纯执行，无 fit 介入）...')
  try {
    sh(SUMATRA, ['-print-to', 'Wondershare PDFelement',
      '-print-settings', 'disable-auto-rotation,noscale,paper=a4',
      '-silent', '-exit-when-done', bakedPdf])
  } catch (e) {
    console.error('❌ Sumatra 调用失败:', e.message)
    process.exit(1)
  }

  // 等待落盘 + 抓取
  const W = 'C:/ProgramData/Wondershare/PDFelement10/PDFCreator'
  const deadline = Date.now() + 30000
  let artifactPdf = null
  while (Date.now() < deadline) {
    sleep(2000)
    try {
      const names = fs.readdirSync(W).filter(f => f.startsWith('a3-03.baked'))
      if (names.length) {
        artifactPdf = path.join(W, names.sort().pop())
        break
      }
    } catch {}
  }
  if (!artifactPdf) {
    console.error('❌ 未抓到 Sumatra artifact（Wondershare 落盘）')
    process.exit(1)
  }
  console.log(`▶ artifact: ${artifactPdf}`)

  // ── Step 5: artifact 断言（A3-03 验收：竖纸 + 居中）──
  const art = measureBBox(artifactPdf)
  console.log(`artifact: ${art.wMm}x${art.hMm}mm /Rotate=${art.rotate} 边距 L${art.L} T${art.T} R${art.R} B${art.B}`)
  const symL = Math.abs(art.L - art.R)
  const symT = Math.abs(art.T - art.B)
  const pass = Math.abs(art.wMm - 210) < 1 && Math.abs(art.hMm - 297) < 1
    && art.rotate === 0 && symL < TOLERANCE_MM && symT < TOLERANCE_MM
  console.log(`对称性: |L-R|=${symL.toFixed(2)}mm |T-B|=${symT.toFixed(2)}mm（容差 ${TOLERANCE_MM}mm）`)
  console.log(pass
    ? '\nGATE PASS ✅ A3-03 闭环：竖纸 + 居中 + 正确 margin（Sumatra 纯执行）'
    : '\nGATE FAIL ❌ A3-03 验收未达')
  process.exit(pass ? 0 : 1)
}

main()
