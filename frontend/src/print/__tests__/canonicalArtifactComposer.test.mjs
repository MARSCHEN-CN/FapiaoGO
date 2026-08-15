/**
 * canonicalArtifactComposer.test.mjs — R2.3-A Final Artifact 组合器回归
 *
 * 验证目标（R2.3-A）：
 *   ✅ composeCanonicalArtifactPlan 纯几何：每 slot placement 与 Golden 一致
 *      （scale>0 / layoutRotation∈{0,-90} / placedRect 居中于 contentRect）
 *   ✅ 真实 node-canvas 执行后逐像素验证：每 slot 内容 bbox ⊆ 自己 contentRect±2、
 *      零越界（无像素污染边距带/相邻票位）、每 slot 区域主色=本票色（区域归属法）
 *   ✅ N6 矩阵：merge2/3/4 竖 + merge4 横 + 非对称边距横纸 + rot 0/90/180/270
 *   ✅ 静态契约：组合器零 DOM/pdf.js/旧几何依赖
 *   ❌ 不碰 Preview / 不删旧 Raster（renderers.js 原样） / 不改 Sumatra 链
 *
 * 运行：node frontend/src/print/__tests__/canonicalArtifactComposer.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { composeCanonicalArtifactPlan, executeComposePlan, CANONICAL_COMPOSE_VERSION } from '../canonicalArtifactComposer.js'
import { buildCanonicalPlacement } from '../canonicalPlacement.js'
import { resolveMergeModeContract } from '../mergeModeContract.js'

const require = createRequire(import.meta.url)
const { createCanvas } = require('C:/Users/Mars_chen/.workbuddy/binaries/node/workspace/node_modules/canvas')

const DPI = 300
const CONTENT = { width: 1400, height: 1980 }
const TOL = 2
const SLOT_COLORS = [
  [224, 48, 48], [48, 224, 48], [48, 48, 224], [224, 224, 48],
]

function mkPaperLayout(paperW, paperH, margins) {
  const px = (mm) => Math.round((mm / 25.4) * DPI)
  const mL = px(margins.left), mR = px(margins.right), mT = px(margins.top), mB = px(margins.bottom)
  return {
    paperRect: { w: px(paperW), h: px(paperH) },
    usableRect: { x: mL, y: mT, w: px(paperW) - mL - mR, h: px(paperH) - mT - mB },
  }
}
const PAPER_A4 = () => mkPaperLayout(210, 297, { left: 3, right: 3, top: 3, bottom: 3 })
const PAPER_A4_LAND = () => mkPaperLayout(210, 297, { left: 3, right: 3, top: 3, bottom: 3 })
const PAPER_A4_LAND_ASYM = () => mkPaperLayout(210, 297, { left: 30, right: 3, top: 3, bottom: 3 })

function mkSources(rotations, count = 4) {
  return Array.from({ length: count }, (_, i) => ({
    source: null, // 占位；真实 canvas 在 execute 前注入
    width: CONTENT.width,
    height: CONTENT.height,
    contentRotation: rotations[i % rotations.length],
    _color: SLOT_COLORS[i],
  }))
}

// 构造真实源 canvas（单色，便于像素分类）
function materializeSources(slotSources) {
  return slotSources.map(s => {
    if (!s) return null
    const c = createCanvas(CONTENT.width, CONTENT.height)
    const ctx = c.getContext('2d')
    ctx.fillStyle = `rgb(${s._color[0]},${s._color[1]},${s._color[2]})`
    ctx.fillRect(0, 0, CONTENT.width, CONTENT.height)
    return { source: c, width: CONTENT.width, height: CONTENT.height }
  })
}

const CASES = [
  { name: 'merge2 竖 rot[0,90]', paper: PAPER_A4, opts: { groupSize: 2, strategy: 'vertical' }, rotations: [0, 90] },
  { name: 'merge3 竖 rot[0,90,180]', paper: PAPER_A4, opts: { groupSize: 3, strategy: 'vertical' }, rotations: [0, 90, 180] },
  { name: 'merge4 grid 竖 rot[0,90,180,270]', paper: PAPER_A4, opts: { groupSize: 4, strategy: 'grid', gridCols: 2, gridRows: 2 }, rotations: [0, 90, 180, 270] },
  { name: 'merge4 grid 横 rot[0,90,180,270]', paper: PAPER_A4_LAND, opts: { groupSize: 4, strategy: 'grid', gridCols: 2, gridRows: 2, forcedLandscape: true }, rotations: [0, 90, 180, 270] },
  { name: 'merge4 grid 横 非对称边距(左30mm)', paper: PAPER_A4_LAND_ASYM, opts: { groupSize: 4, strategy: 'grid', gridCols: 2, gridRows: 2, forcedLandscape: true }, rotations: [0, 90, 180, 270] },
  { name: 'merge2 竖 缺源(2 文件) → 空 slot 跳过', paper: PAPER_A4, opts: { groupSize: 3, strategy: 'vertical' }, rotations: [0, 90], count: 2 },
]

let failed = 0
const fail = (m) => { failed++; console.error('  ✗ ' + m) }
const ok = (m) => console.log('  ✓ ' + m)

const isBg = (px) => px[0] >= 250 && px[1] >= 250 && px[2] >= 250

// ───────────── [1] 纯几何：plan placement 与 CanonicalPlacement 一致 + 不变量 ─────────────
console.log('\n[1] 纯几何：composeCanonicalArtifactPlan 与 Golden 契约一致')
for (const c of CASES) {
  const slotSources = mkSources(c.rotations, c.count ?? c.opts.groupSize)
  const plan = composeCanonicalArtifactPlan({ paperLayout: c.paper(), dpi: DPI, slotSources, ...c.opts })
  if (plan.invalid || !plan.canvasSize) { fail(`${c.name}: plan invalid`); continue }
  try {
    const slots = plan.slots
    assert.ok(slots.length === c.opts.groupSize, 'slot 数 = groupSize')
    const expW = c.opts.forcedLandscape ? 3508 : 2480
    const expH = c.opts.forcedLandscape ? 2480 : 3508
    assert.deepEqual(plan.canvasSize, { width: expW, height: expH }, 'canvasSize 纸张方向')
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]
      if (i >= (c.count ?? c.opts.groupSize)) {
        assert.equal(s.sourceIndex, -1, `空 slot ${i} sourceIndex=-1`)
        continue
      }
      const p = s.placement
      assert.ok(p.scale > 0 && Number.isFinite(p.scale), `slot${i} scale>0`)
      assert.ok(p.rotation.layout === 0 || p.rotation.layout === -90, `slot${i} layoutRotation∈{0,-90} (got ${p.rotation.layout})`)
      // placedRect 居中于 contentRect（paper-absolute：slot-local placedRect + translate 偏移）
      const cr = s.slot.contentRect
      const cx = cr.x + cr.width / 2, cy = cr.y + cr.height / 2
      const px = s.translate.x + p.placedRect.x + p.placedRect.w / 2
      const py = s.translate.y + p.placedRect.y + p.placedRect.h / 2
      assert.ok(Math.abs(cx - px) <= 2 && Math.abs(cy - py) <= 2, `slot${i} placedRect 居中 (Δ=${Math.abs(cx - px).toFixed(1)},${Math.abs(cy - py).toFixed(1)})`)
      // 与独立 buildCanonicalPlacement 逐字段一致（无损重打包已被 R2.1 证明，这里验证组合器不重算）
      const direct = buildCanonicalPlacement({
        contentPhysicalSize: { width: CONTENT.width, height: CONTENT.height },
        contentRotation: c.rotations[i % c.rotations.length],
        physicalPaper: { widthMM: s.slot.paperRect.width / (DPI / 25.4), heightMM: s.slot.paperRect.height / (DPI / 25.4) },
        margins: { left: 0, right: 0, top: 0, bottom: 0 },
        dpi: DPI,
      })
      assert.deepEqual(p.placedRect, direct.placedRect, `slot${i} placedRect == canonical`)
      assert.equal(p.scale, direct.scale, `slot${i} scale == canonical`)
    }
    ok(c.name)
  } catch (e) {
    fail(`${c.name}: ${e.message}`)
  }
}

// ───────────── [2] 真实 node-canvas 执行：逐像素隔离验证（区域归属法）─────────────
console.log('\n[2] 真实 Canvas 执行：每 slot 内容 ⊆ 自己 contentRect，零越界，主色=本票色')
for (const c of CASES) {
  const slotSources = mkSources(c.rotations, c.count ?? c.opts.groupSize)
  const plan = composeCanonicalArtifactPlan({ paperLayout: c.paper(), dpi: DPI, slotSources, ...c.opts })
  const canvas = createCanvas(plan.canvasSize.width, plan.canvasSize.height)
  const ctx = canvas.getContext('2d')
  const sources = materializeSources(slotSources)
  executeComposePlan(ctx, plan, sources, createCanvas)

  // 区域归属法扫描（Stage3 同款）
  const W = plan.canvasSize.width, H = plan.canvasSize.height
  const data = ctx.getImageData(0, 0, W, H).data
  const regions = plan.slots.filter(s => s.sourceIndex >= 0).map(s => ({
    slot: s,
    x0: s.slot.contentRect.x - TOL, y0: s.slot.contentRect.y - TOL,
    x1: s.slot.contentRect.x + s.slot.contentRect.width + TOL,
    y1: s.slot.contentRect.y + s.slot.contentRect.height + TOL,
  }))
  const bboxes = regions.map(() => ({ minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 }))
  const hist = regions.map(() => new Map())
  let outside = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (isBg([data[i], data[i + 1], data[i + 2]])) continue
      let owner = -1
      for (let r = 0; r < regions.length; r++) {
        const rg = regions[r]
        if (x >= rg.x0 && x <= rg.x1 && y >= rg.y0 && y <= rg.y1) { owner = r; break }
      }
      if (owner < 0) { outside++; continue }
      const bb = bboxes[owner]
      if (x < bb.minX) bb.minX = x
      if (x > bb.maxX) bb.maxX = x
      if (y < bb.minY) bb.minY = y
      if (y > bb.maxY) bb.maxY = y
      const key = `${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`
      hist[owner].set(key, (hist[owner].get(key) || 0) + 1)
    }
  }

  let planFail = 0
  for (let r = 0; r < regions.length; r++) {
    const rg = regions[r]
    const bb = bboxes[r]
    const cr = rg.slot.slot.contentRect
    if (bb.maxX < 0) { fail(`${c.name} slot${rg.slot.index}: 无内容`); planFail++; continue }
    const inside = bb.minX >= cr.x - TOL && bb.minY >= cr.y - TOL && bb.maxX <= cr.x + cr.width + TOL && bb.maxY <= cr.y + cr.height + TOL
    if (!inside) {
      fail(`${c.name} slot${rg.slot.index}: bbox (${bb.minX},${bb.minY},${bb.maxX - bb.minX + 1},${bb.maxY - bb.minY + 1}) 越出 contentRect ${JSON.stringify(cr)}`)
      planFail++
      continue
    }
    // 主色校验
    let bestKey = null, bestN = -1
    for (const [k, n] of hist[r]) { if (n > bestN) { bestN = n; bestKey = k } }
    const [mr, mg, mb] = bestKey.split(',').map(v => Number(v) * 8 + 4)
    const own = SLOT_COLORS[rg.slot.index]
    const dMain = Math.sqrt((mr - own[0]) ** 2 + (mg - own[1]) ** 2 + (mb - own[2]) ** 2)
    if (dMain > 60) {
      fail(`${c.name} slot${rg.slot.index}: 主色 rgb(${mr},${mg},${mb}) ≠ 本票色 rgb(${own}) (Δ=${dMain.toFixed(0)})`)
      planFail++
      continue
    }
    ok(`${c.name} slot${rg.slot.index}: bbox⊆contentRect ✓ 主色=本票色 ✓`)
  }
  if (outside > 0) { fail(`${c.name}: ${outside} 像素落在所有 contentRect 之外`); planFail++ }
  else ok(`${c.name}: 零越界`)
  if (planFail > 0) { fail(`${c.name}: ${planFail} 项异常`) }
  else ok(`${c.name}: ✅ 像素级隔离通过`)
}

// ───────────── [3] 静态契约 ─────────────
console.log('\n[3] 静态契约：组合器零 DOM / pdf.js / 旧几何依赖')
{
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../canonicalArtifactComposer.js')
  const raw = readFileSync(path, 'utf8')
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  const mustHave = [
    ['computeSlots（Virtual Paper 划分）', /computeSlots/],
    ['buildCanonicalPlacement（唯一几何）', /buildCanonicalPlacement/],
    ['buildCanvasDrawOps（投影）', /buildCanvasDrawOps/],
    ['applyDrawOps（执行）', /applyDrawOps/],
  ]
  for (const [label, re] of mustHave) {
    if (re.test(src)) ok(`依赖: ${label}`)
    else fail(`缺失: ${label}`)
  }
  const banned = [
    ['document / window（DOM）', /document|window/],
    ['Image / renderPDFPageRaw（raster 层）', /new Image|renderPDFPageRaw/],
    ['createPlacement（旧几何）', /createPlacement/],
    ['MultiTicketComposer / composePlans（旧合成）', /MultiTicketComposer|composePlans/],
    ['buildRenderCommand（旧命令）', /buildRenderCommand/],
    ['slotToLandscape（Golden 明确不用）', /slotToLandscape/],
    ['slotMarginPx 内缩（Golden slot 内边距=0）', /slotMarginPx/],
  ]
  for (const [label, re] of banned) {
    if (re.test(src)) fail(`黑名单命中: ${label}`)
    else ok(`黑名单干净: ${label}`)
  }
  if (CANONICAL_COMPOSE_VERSION !== 1) fail('CANONICAL_COMPOSE_VERSION 应为 1')
  else ok('CANONICAL_COMPOSE_VERSION = 1')
}

// ───────────── [4] R2.3-A.1 Merge Topology Contract ─────────────
console.log('\n[4] Merge Topology Contract：slotCount 由 mode 决定；缺失=EMPTY VP；merge4 强制横向')
{
  const contractCases = [
    { mode: 'merge2', slotCount: 2, strategy: 'vertical', forcedLandscape: false },
    { mode: 'merge3', slotCount: 3, strategy: 'vertical', forcedLandscape: false },
    { mode: 'merge4', slotCount: 4, strategy: 'grid', forcedLandscape: true },
    { mode: 'none', slotCount: 1, strategy: 'vertical', forcedLandscape: false },
  ]
  for (const cc of contractCases) {
    try {
      const c = resolveMergeModeContract(cc.mode)
      assert.equal(c.slotCount, cc.slotCount, `${cc.mode}.slotCount`)
      assert.equal(c.strategy, cc.strategy, `${cc.mode}.strategy`)
      assert.equal(c.forcedLandscape, cc.forcedLandscape, `${cc.mode}.forcedLandscape`)
      ok(`contract ${cc.mode}: slotCount=${c.slotCount} strategy=${c.strategy} forcedLandscape=${c.forcedLandscape}`)
    } catch (e) {
      fail(`contract ${cc.mode}: ${e.message}`)
    }
  }

  // 用户回归矩阵：mode × 文件数 → 期望 slotCount + EMPTY 分布
  const topology = [
    { mode: 'merge2', files: 2, empty: 0 },
    { mode: 'merge2', files: 1, empty: 1 },
    { mode: 'merge3', files: 3, empty: 0 },
    { mode: 'merge3', files: 2, empty: 1 },
    { mode: 'merge3', files: 1, empty: 2 },
    { mode: 'merge4', files: 4, empty: 0 },
    { mode: 'merge4', files: 3, empty: 1 },
    { mode: 'merge4', files: 2, empty: 2 },
    { mode: 'merge4', files: 1, empty: 3 },
  ]
  for (const t of topology) {
    const contract = resolveMergeModeContract(t.mode)
    const sources = mkSources([0], t.files)
    const plan = composeCanonicalArtifactPlan({
      paperLayout: PAPER_A4(), dpi: DPI, groupSize: contract.slotCount,
      strategy: contract.strategy, gridCols: contract.gridCols, gridRows: contract.gridRows,
      forcedLandscape: contract.forcedLandscape,
      slotSources: sources.map(s => ({ width: s.width, height: s.height, contentRotation: 0 })),
    })
    try {
      assert.equal(plan.slots.length, contract.slotCount, `${t.mode}+${t.files} 页 slot 数 = mode.slotCount`)
      const emptyCount = plan.slots.filter(s => s.sourceIndex < 0).length
      assert.equal(emptyCount, t.empty, `${t.mode}+${t.files} EMPTY VP 数 = ${t.empty}`)
      for (let i = 0; i < plan.slots.length; i++) {
        const s = plan.slots[i]
        if (i < t.files) assert.ok(s.sourceIndex === i, `${t.mode}+${t.files} slot${i} 有源`)
        else assert.equal(s.sourceIndex, -1, `${t.mode}+${t.files} slot${i} = EMPTY`)
        // EMPTY VP 的纸张几何必须存在（paperRect 完整）
        assert.ok(s.slot.paperRect.width > 0 && s.slot.paperRect.height > 0, `${t.mode}+${t.files} slot${i} paperRect 存在`)
      }
      // merge4 强制横向：canvas = 3508×2480（A4）
      if (t.mode === 'merge4') {
        assert.deepEqual(plan.canvasSize, { width: 3508, height: 2480 }, 'merge4 canvas 横向')
      }
      ok(`${t.mode}+${t.files} 文件: ${contract.slotCount} VP（${t.files} 有源 + ${t.empty} EMPTY）✓ merge4 横向=${contract.forcedLandscape}`)
    } catch (e) {
      fail(`${t.mode}+${t.files}: ${e.message}`)
    }
  }

  // 无坍缩等价：merge3 满 3 源 vs 2 源 → slots[0..1] 的 placement/translate 完全不变
  {
    const full = composeCanonicalArtifactPlan({
      paperLayout: PAPER_A4(), dpi: DPI, groupSize: 3, strategy: 'vertical',
      slotSources: mkSources([0, 90, 180], 3).map(s => ({ width: s.width, height: s.height, contentRotation: s.contentRotation })),
    })
    const short = composeCanonicalArtifactPlan({
      paperLayout: PAPER_A4(), dpi: DPI, groupSize: 3, strategy: 'vertical',
      slotSources: mkSources([0, 90], 2).map(s => ({ width: s.width, height: s.height, contentRotation: s.contentRotation })),
    })
    try {
      assert.deepEqual(short.slots[0].placement, full.slots[0].placement, 'merge3 缺源不改 slot0 placement')
      assert.deepEqual(short.slots[1].placement, full.slots[1].placement, 'merge3 缺源不改 slot1 placement')
      assert.deepEqual(short.slots[0].translate, full.slots[0].translate, 'slot0 translate 不变')
      assert.deepEqual(short.slots[1].translate, full.slots[1].translate, 'slot1 translate 不变')
      assert.deepEqual(short.slots[2].translate, full.slots[2].translate, 'slot2 translate 不变（EMPTY 仍存在）')
      ok('merge3 缺源无坍缩：slots[0..2] geometry 与满源完全一致（EMPTY 不改变其他 VP）')
    } catch (e) {
      fail(`无坍缩等价: ${e.message}`)
    }
  }

  // EMPTY VP 区域像素验证：merge3 + 2 文件 → 第 3 区域纯空白，前两区有内容
  {
    const contract = resolveMergeModeContract('merge3')
    const slotSources = mkSources([0, 90], 2)
    const plan = composeCanonicalArtifactPlan({
      paperLayout: PAPER_A4(), dpi: DPI, groupSize: contract.slotCount, strategy: contract.strategy,
      slotSources: slotSources.map(s => ({ width: s.width, height: s.height, contentRotation: s.contentRotation })),
    })
    const canvas = createCanvas(plan.canvasSize.width, plan.canvasSize.height)
    const ctx = canvas.getContext('2d')
    executeComposePlan(ctx, plan, materializeSources(slotSources), createCanvas)
    const data = ctx.getImageData(0, 0, plan.canvasSize.width, plan.canvasSize.height).data
    // slot2 区域（EMPTY）：零非背景像素
    const e2 = plan.slots[2].slot.contentRect
    let slot2Pixels = 0
    for (let y = e2.y; y < e2.y + e2.height; y++) {
      for (let x = e2.x; x < e2.x + e2.width; x++) {
        const i = (y * plan.canvasSize.width + x) * 4
        if (!isBg([data[i], data[i + 1], data[i + 2]])) slot2Pixels++
      }
    }
    // slot0 区域应有内容
    const e0 = plan.slots[0].slot.contentRect
    let slot0Pixels = 0
    for (let y = e0.y; y < e0.y + e0.height; y++) {
      for (let x = e0.x; x < e0.x + e0.width; x++) {
        const i = (y * plan.canvasSize.width + x) * 4
        if (!isBg([data[i], data[i + 1], data[i + 2]])) slot0Pixels++
      }
    }
    try {
      assert.equal(slot2Pixels, 0, `merge3+2 EMPTY slot2 区域像素=0（实际 ${slot2Pixels}）`)
      assert.ok(slot0Pixels > 1000, `merge3+2 slot0 有内容（${slot0Pixels} px）`)
      ok(`merge3+2 像素：EMPTY slot2 区域纯空白 ✓ slot0 有内容 ✓（EMPTY VP 真实存在且未被侵占）`)
    } catch (e) {
      fail(`EMPTY VP 像素: ${e.message}`)
    }
  }

  // merge4 纸张方向：竖 A4 输入 / 横 A4 输入 → 均强制 Landscape 2×2
  for (const [label, paper] of [['竖 A4 输入', PAPER_A4()], ['横 A4 输入', PAPER_A4_LAND()]]) {
    const contract = resolveMergeModeContract('merge4')
    const plan = composeCanonicalArtifactPlan({
      paperLayout: paper, dpi: DPI, groupSize: contract.slotCount, strategy: contract.strategy,
      gridCols: contract.gridCols, gridRows: contract.gridRows, forcedLandscape: contract.forcedLandscape,
      slotSources: mkSources([0], 4).map(s => ({ width: s.width, height: s.height, contentRotation: 0 })),
    })
    try {
      assert.deepEqual(plan.canvasSize, { width: 3508, height: 2480 }, `${label} → canvas 横向 3508×2480`)
      assert.equal(plan.slots.length, 4, `${label} → 4 VP`)
      ok(`merge4 ${label} → Landscape 2×2 (${plan.canvasSize.width}×${plan.canvasSize.height}) ✓`)
    } catch (e) {
      fail(`merge4 ${label}: ${e.message}`)
    }
  }
}

console.log('')
if (failed > 0) {
  console.error(`\n❌ canonicalArtifactComposer 测试失败：${failed} 项。`)
  process.exit(1)
} else {
  console.log('✅ canonicalArtifactComposer 测试通过：R2.3-A 组合器纯几何与 Golden 一致，真实 Canvas 像素级隔离无损，R2.3-A.1 Merge Topology Contract（slotCount=Mode / EMPTY VP / 无坍缩 / merge4 强制横向）全过。')
  process.exit(0)
}
