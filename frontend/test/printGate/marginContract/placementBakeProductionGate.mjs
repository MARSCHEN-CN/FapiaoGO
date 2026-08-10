#!/usr/bin/env node
/**
 * Placement Bake Production Gate — C-2 Step 4-2b（2026-08-10）
 *
 * 验证「生产 executor consumption」：main.js print-source-file 消费
 * settings.placement + settings.executionPaper → placement_bake → Sumatra 执行。
 *
 * 与 A3-03（4-2a DEV Gate）的区别——本 Gate 验证的是【生产接线层】：
 *   1. 真实 production settings 形态（placement + executionPaper + legacy paper/landscape/fit）
 *   2. 调 placement-bake-processor（生产消费层，非直接调脚本）的 hasPlacement / buildBakeSpec
 *   3. Sumatra 用 NOSCALE（4-2b-2b 生产执行策略：baked PDF → Sumatra 不参与 layout；
 *      4-2b-1 的 fit 验证已由 4-2b-2a sumatraNoScaleGate 证明 fit==noscale）
 *   4. main.js 接线源码守卫（handler 必须调用 placementBake.process + bake 成功路径 noscale）
 *
 * 验收断言：
 *   - hasPlacement(PDF) === true；OFD/纸型错位 === false（降级守卫）
 *   - bake 产物：MediaBox/CropBox == 210×297mm、/Rotate=0
 *   - Sumatra noscale artifact：竖纸 + 内容中心 vs bake 产物中心偏差 < 2mm
 *   - noscale 未二次变换：artifact 逐边增量 vs bake 产物 < 0.5mm
 *   - main.js handler 含 placementBake.process + scalePolicy:'none'（bake 成功路径）
 *
 * 用法:
 *   node placementBakeProductionGate.mjs                    # 完整端到端（需 Sumatra + Wondershare）
 *   node placementBakeProductionGate.mjs --skip-print       # 只验证 bake + 接线层（无需打印机）
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
const OUT = path.join(HERE, '.out')
const TOLERANCE_MM = 1.5

const require = createRequire(import.meta.url)
// 生产消费层（纯 CommonJS，无 electron 依赖，node 可直接 require）
const placementBake = require(path.join(REPO, 'electron', 'print-service', 'placement-bake-processor.js'))

const argv = process.argv.slice(2)
const skipPrint = argv.includes('--skip-print')

function sleep(ms) { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ms) }
function sh(cmd, args, timeout = 120000) {
  return execFileSync(cmd, args, { timeout }).toString()
}

// ── 1. 真实 placement（与 usePrint placements useMemo / A3-03 同源）──
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

// ── 2. 构造生产形态 settings（PrintService.buildPrintSettings 输出同构）──
function buildProductionSettings(placement) {
  return {
    // legacy 字段（Sumatra 纸命令来源）
    rotation: 0,
    sourceRotation: 0,
    paper: 'A4',
    paperkind: undefined,
    fit: 'contain',
    landscape: false,
    contentOrientation: 'landscape',
    duplex: false,
    grayscale: false,
    copies: 1,
    marginLeft: 3, marginRight: 3, marginTop: 3, marginBottom: 3,
    customPaper: undefined,
    // C-2 Step 4-1：Plan truth（IPC 透传）
    placement,
    executionPaper: {
      size: 'A4',
      orientation: 'portrait',       // needSwap 后物理方向（横票竖纸 = portrait）
      widthMM: 210,
      heightMM: 297,
      customPaper: null,
    },
  }
}

// ── 3. 量 PDF 内容 bbox（px@300，top-left）──
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
  'cxMm': round(((xs.min()+xs.max())/2)*mm, 2), 'cyMm': round(((ys.min()+ys.max())/2)*mm, 2),
}))
d.close()
`
  const out = sh(PY, ['-c', code]).trim()
  return JSON.parse(out)
}

// ── 4. main.js 接线源码守卫 ──
function checkMainJsWiring() {
  const mainJs = fs.readFileSync(path.join(REPO, 'electron', 'main.js'), 'utf8')
  // ① require processor
  if (!/placement-bake-processor/.test(mainJs)) {
    console.error('[4-2B-1-GATE] FAIL: main.js 未 require placement-bake-processor')
    return false
  }
  // ② handler 调用 placementBake.process（生产接线存在）
  if (!/placementBake\.process\(/.test(mainJs)) {
    console.error('[4-2B-1-GATE] FAIL: print-source-file handler 未调用 placementBake.process')
    return false
  }
  // ③ bake 成功分支必须 noscale（4-2b-2b，D2）——但 noscale 只在 bake 成功路径
  //    （条件分支，legacy/pdfMargin 路径不受影响，rollback 极易）。
  //    bake 分支 = `if (bakeEnabled) {...} else if (hasMargins...)`。
  const bakeBlock = mainJs.match(/if \(bakeEnabled\) \{[\s\S]*?\n    \} else if/)?.[0] || ''
  if (!bakeBlock) {
    console.error('[4-2B-GATE] FAIL: bake 分支不存在')
    return false
  }
  // noscale 必须在 bakeResult.path !== target.filePath（bake 成功）块内：
  // 切片定位成功块（if 头 → } else），块内须含 scalePolicy:'none'
  const idx = bakeBlock.indexOf('bakeResult.path !== target.filePath')
  const elseIdx = bakeBlock.indexOf('} else', idx)
  const successSlice = (idx >= 0 && elseIdx > idx) ? bakeBlock.slice(idx, elseIdx) : ''
  if (!/scalePolicy:\s*['"]none['"]/.test(successSlice)) {
    console.error('[4-2B-GATE] FAIL: bake 成功路径未切 noscale（4-2b-2b 要求）')
    return false
  }
  console.log('[4-2B-GATE] ok: main.js 接线存在（require + process 调用 + bake 成功路径 noscale）')
  return true
}

function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const srcPdf = path.join(REPO, 'test_fixtures', '25952000000127675627.pdf')

  console.log('=== 4-2b-1 Placement Bake Production Gate ===')
  console.log(`源: ${path.relative(REPO, srcPdf)}`)

  // ── Step 1: 生产形态 settings ──
  const placement = computePlacement()
  const settings = buildProductionSettings(placement)
  console.log(`placement: layoutRotation=${placement.layoutRotation} scale=${placement.scale.toFixed(4)} offset=(${placement.offset.x},${placement.offset.y})`)

  // ── Step 2: 生产消费层判定 + spec 构造 ──
  const decisionPdf = placementBake.hasPlacement(settings, srcPdf)
  const decisionOfd = placementBake.hasPlacement(settings, srcPdf.replace(/\.pdf$/, '.ofd'))
  const decisionMismatch = placementBake.hasPlacement(
    { ...settings, executionPaper: { ...settings.executionPaper, orientation: 'landscape', widthMM: 297, heightMM: 210 } },
    srcPdf)
  console.log(`hasPlacement: PDF=${decisionPdf} OFD=${decisionOfd} paperMismatch=${decisionMismatch}`)
  if (!decisionPdf) { console.error('[4-2B-1-GATE] FAIL: 生产判定未生效（PDF 应为 true）'); process.exit(1) }
  if (decisionOfd) { console.error('[4-2B-1-GATE] FAIL: OFD 不应 bake（降级守卫失效）'); process.exit(1) }
  if (decisionMismatch) { console.error('[4-2B-1-GATE] FAIL: 纸型错位不应 bake（canBakeSafely 失效）'); process.exit(1) }

  const spec = placementBake.buildBakeSpec(srcPdf, settings, path.join(OUT, '4-2b-1.baked.pdf'))
  const specOk = spec.paper.widthMm === 210 && spec.paper.heightMm === 297
    && spec.dpi === 300 && spec.placement.layoutRotation === placement.layoutRotation
  if (!specOk) { console.error('[4-2B-1-GATE] FAIL: buildBakeSpec 字段搬运错误'); process.exit(1) }
  console.log('[4-2B-1-GATE] ok: hasPlacement + buildBakeSpec 判定正确')

  // ── Step 3: 真跑生产脚本（同 processor.process 的 spawn 路径）──
  const specFile = path.join(OUT, '4-2b-1.spec.json')
  fs.writeFileSync(specFile, JSON.stringify(spec))
  const bakeOut = JSON.parse(sh(PY, [
    path.join(REPO, 'scripts', 'placement_bake.py'),
    // CLI 契约：显式参数 required（4-2a 冻结脚本）；placement-file 模式 = 显式覆盖 spec
    '--source', spec.source_pdf,
    '--output', spec.output_pdf,
    '--paper-width-mm', String(spec.paper.widthMm),
    '--paper-height-mm', String(spec.paper.heightMm),
    '--placement-file', specFile,
    '--dpi', String(spec.dpi),
  ]))
  if (!bakeOut.success) { console.error('[4-2B-1-GATE] FAIL: bake 失败:', bakeOut.error); process.exit(1) }
  const bakedPdf = spec.output_pdf
  console.log(`bake OK: MediaBox=${bakeOut.info.mediaBox} /Rotate=${bakeOut.info.rotate} phi=${bakeOut.info.phi}`)

  // ── Step 4: bake 契约断言 ──
  const baked = measureBBox(bakedPdf)
  console.log(`bake 输出: ${baked.wMm}x${baked.hMm}mm /Rotate=${baked.rotate} 边距 L${baked.L} T${baked.T} R${baked.R} B${baked.B}`)
  const bakePass = Math.abs(baked.wMm - 210) < 1 && Math.abs(baked.hMm - 297) < 1 && baked.rotate === 0
  console.log(bakePass ? '  ✅ bake 契约：MediaBox==paper + /Rotate=0' : '  ❌ bake 契约失败')
  if (!bakePass) process.exit(1)

  // main.js 接线守卫
  if (!checkMainJsWiring()) process.exit(1)

  // ── Step 5: 端到端（bake → Sumatra NOSCALE —— 4-2b-2b 生产执行策略）──
  if (skipPrint) {
    console.log('（--skip-print：跳过 Sumatra 打印，接线层 + bake 层已验证）')
    console.log('\nGATE PASS（生产接线 + bake 层）')
    process.exit(0)
  }
  if (!fs.existsSync(SUMATRA)) {
    console.error(`❌ SumatraPDF 不存在: ${SUMATRA}`)
    process.exit(1)
  }
  console.log('\n▶ Sumatra NOSCALE 打印（4-2b-2b：baked PDF，Sumatra 纯执行不参与 layout）...')
  try {
    // 生产 buildPrintSettings 同构命令：竖纸 disable-auto-rotation + noscale + paper=a4
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
      const names = fs.readdirSync(W).filter(f => f.startsWith('4-2b-1.baked'))
      if (names.length) {
        artifactPdf = path.join(W, names.sort().pop())
        // ⚠️ 非空检查：fs.existsSync 对 0 字节空文件误判（A3-V2 grab bug 教训）
        if (fs.statSync(artifactPdf).size > 0) break
      }
    } catch {}
  }
  if (!artifactPdf) {
    console.error('❌ 未抓到 Sumatra artifact（Wondershare 落盘）')
    process.exit(1)
  }
  console.log(`▶ artifact: ${artifactPdf}`)

  // ── Step 6: artifact 断言（4-2b-2b 验收：noscale 不破坏 bake 几何）──
  const art = measureBBox(artifactPdf)
  console.log(`artifact: ${art.wMm}x${art.hMm}mm /Rotate=${art.rotate} 边距 L${art.L} T${art.T} R${art.R} B${art.B}`)
  const symL = Math.abs(art.L - art.R)
  const symT = Math.abs(art.T - art.B)
  // 主断言 = noscale 未二次变换（bake 产物 MediaBox==paper 时 noscale 1:1 no-op）：
  //   a) 内容中心漂移 vs 纸中心（bake 产物本身居中 → artifact 也应居中）
  //   b) 逐边增量：artifact 边距 vs bake 产物边距（noscale 若介入会 > 0.5mm）
  const driftL = Math.abs(art.L - baked.L)
  const driftT = Math.abs(art.T - baked.T)
  const driftR = Math.abs(art.R - baked.R)
  const driftB = Math.abs(art.B - baked.B)
  const maxDrift = Math.max(driftL, driftT, driftR, driftB)
  const centerDrift = Math.hypot(art.cxMm - 105, art.cyMm - 148.5)
  // 参考：四边对称（受源发票自身非对称内边距影响，非 noscale 问题——4-2a 已验对称语义）
  console.log(`参考对称性: |L-R|=${symL.toFixed(2)}mm |T-B|=${symT.toFixed(2)}mm（源内容非对称，非判定项）`)
  console.log(`noscale 未二次缩放: 内容中心漂移 ${centerDrift.toFixed(2)}mm（容差 2mm）`)
  console.log(`noscale 逐边增量: L+${driftL.toFixed(2)} T+${driftT.toFixed(2)} R+${driftR.toFixed(2)} B+${driftB.toFixed(2)}mm（容差 0.5mm，max=${maxDrift.toFixed(2)}）`)
  const pass = Math.abs(art.wMm - 210) < 1 && Math.abs(art.hMm - 297) < 1
    && art.rotate === 0 && centerDrift < 2.0 && maxDrift < 0.5
  console.log(pass
    ? '\nGATE PASS ✅ 4-2b-2b 生产执行：baked PDF → Sumatra noscale 纯执行（几何零干预）'
    : '\nGATE FAIL ❌ 4-2b-2b 验收未达')
  process.exit(pass ? 0 : 1)
}

main()
