/**
 * composeSlotRasterContract — slot.contentRect raster contract regression test
 *
 * 定位：C1/C2 共享不变量（raster contract），不是某个 renderer / C2-a 实现的测试。
 *
 * 保护对象：ComposeSlotRasterizer 产出的 slot.contentRect 与旧 renderer 自算公式
 * （7ec49222 renderers.js _composeContentRectPx）字节级兼容。
 *
 * 为什么是共享不变量而非 C2-a 测试：
 *   C2-a 只是把 contentRect 的「所有权」从 renderer 上移到 Rasterizer（符合 C 阶段铁律
 *   "Derived geometry must cross ownership boundaries only once"）。本测试锁的是
 *   slot.contentRect 这个 contract 本身——它与具体哪个 renderer 消费无关。
 *   因此 C3（mergeFactory 接入）、D（DocumentEngine 接管 source）、删除旧 renderer 时，
 *   本测试仍是有效防护：只要 Rasterizer 输出的 contentRect 变了，就会立刻红。
 *
 * 不依赖 config.js / renderers.js（后者含 DOMMatrix / pdfjs ?url 等浏览器依赖，node 不可导入）。
 * 只 import 纯模块 ComposeSlotLayoutFactory + rasterizeSlots，并复刻 createLayout 的纯几何部分
 * （margin=0 时 areaPx === page，与 compose 场景一致）。
 *
 * 运行：
 *   node --test src/compose/composeSlotRasterContract.test.js
 *   BASELINE=1 node --test src/compose/composeSlotRasterContract.test.js   # 打印 contentRect 基线
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ComposeSlotLayoutFactory, DEFAULT_SLOT_MARGIN_MM } from './composeSlot.js'
import { rasterizeSlots } from './composeSlotRasterizer.js'

// ── 旧 renderer 公式（7ec49222 _composeContentRectPx）逐字复刻 ──
function oldComposeContentRectPx(slot, dpi, internalMarginMm) {
  if (!internalMarginMm) return { x: slot.x, y: slot.y, width: slot.width, height: slot.height }
  const inset = (internalMarginMm * dpi) / 25.4
  return {
    x: slot.x + inset,
    y: slot.y + inset,
    width: Math.max(0, slot.width - 2 * inset),
    height: Math.max(0, slot.height - 2 * inset),
  }
}

// 复刻 createLayout 的 areaPx（margin=0）：page px = round(mm*dpi/25.4)
function buildAreaPx(widthMM, heightMM, dpi) {
  return {
    x: 0,
    y: 0,
    width: Math.round(widthMM * dpi / 25.4),
    height: Math.round(heightMM * dpi / 25.4),
  }
}

// 复刻 createLayout 纯几何部分：Factory(mm) → Rasterizer(px)
function buildSlots(widthMM, heightMM, dpi, count, strategy, margin = 0) {
  const area = buildAreaPx(widthMM, heightMM, dpi)
  const mLeft = typeof margin === 'object' ? margin.left : margin
  const mTop = typeof margin === 'object' ? margin.top : margin
  const mRight = typeof margin === 'object' ? margin.right : margin
  const mBottom = typeof margin === 'object' ? margin.bottom : margin
  const printableWidthMm = widthMM - (typeof margin === 'object' ? mLeft + mRight : 2 * margin)
  const printableHeightMm = heightMM - (typeof margin === 'object' ? mTop + mBottom : 2 * margin)
  const paperMM = { widthMM: printableWidthMm, heightMM: printableHeightMm, isLandscape: false }
  const mergeMode = strategy === 'grid' ? 'merge4' : `merge${count}`
  const internalMarginMm = count > 1 ? DEFAULT_SLOT_MARGIN_MM : 0
  const gridCols = 2
  const gridRows = 2
  const logical = ComposeSlotLayoutFactory({
    paper: paperMM,
    mergeMode,
    marginMm: internalMarginMm,
    paperXMm: mLeft,
    paperYMm: mTop,
  })
  const px = rasterizeSlots(logical, { dpi, areaPx: area, gridCols, gridRows, marginMm: internalMarginMm })
  return { px, dpi, internalMarginMm, area }
}

const PAPERS = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  // @300dpi → round(211.67*300/25.4)=2500, round(300.47*300/25.4)=3550
  'Custom-211.67x300.47': { w: 211.67, h: 300.47 },
}

const CASES = [
  { name: 'A4@300 merge2', paper: 'A4', dpi: 300, count: 2, strategy: 'vertical' },
  { name: 'A4@300 merge3', paper: 'A4', dpi: 300, count: 3, strategy: 'vertical' },
  { name: 'A4@300 merge4', paper: 'A4', dpi: 300, count: 4, strategy: 'grid' },
  { name: 'A4@300 single', paper: 'A4', dpi: 300, count: 1, strategy: 'vertical' },
  { name: 'Custom≈2500x3550@300 merge3', paper: 'Custom-211.67x300.47', dpi: 300, count: 3, strategy: 'vertical' },
  { name: 'A4@300 merge3 landscape', paper: 'A4', dpi: 300, count: 3, strategy: 'vertical', landscape: true },
  { name: 'A4@600 merge3', paper: 'A4', dpi: 600, count: 3, strategy: 'vertical' },
  { name: 'A3@300 merge2', paper: 'A3', dpi: 300, count: 2, strategy: 'vertical' },
]

for (const c of CASES) {
  test(c.name, () => {
    const { w, h } = PAPERS[c.paper]
    let widthMM = w
    let heightMM = h
    if (c.landscape) [widthMM, heightMM] = [h, w]
    const { px, dpi, internalMarginMm, area } = buildSlots(widthMM, heightMM, c.dpi, c.count, c.strategy)

    if (process.env.BASELINE) {
      console.log(`# ${c.name}  area=${JSON.stringify(area)}  internalMarginMm=${internalMarginMm}`)
      px.forEach((s, i) => console.log(`  slot${i} contentRect=${JSON.stringify(s.contentRect)}`))
    }

    let maxDiff = 0
    for (const slot of px) {
      const old = oldComposeContentRectPx(slot, dpi, internalMarginMm)
      for (const key of ['x', 'y', 'width', 'height']) {
        maxDiff = Math.max(maxDiff, Math.abs(old[key] - slot.contentRect[key]))
      }
    }
    assert.ok(
      maxDiff < 1e-6,
      `${c.name}: old vs new contentRect 最大误差 ${maxDiff}（应 < 1e-6 px）`,
    )
  })
}
