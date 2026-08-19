// gate3A3OfdImageMerge.test.mjs — PPC-OFD Gate 3-A.3: OFD + Image Merge Geometry
//
// 验证命题（用户批准）：Gate 4 冻结的 merge geometry 是否对 OFD RenderResource 完全格式无关。
//
// 取证结论（进入前取证，docs/ppc-ofd-integration-gate3-a2-rotation-evidence.md 补充）：
//   · 真实 merge 渲染链 = **usePreview merge 分支**（usePreview.js:875-884）：
//     renderMultipleItemsToCanvas(items, paper, PREVIEW_DPI, forcedLandscape, fileRotations,
//       mergeModeGroupSize, false, false, {strategy, gridCols, gridRows, userMargins, customPaper}, paperLayout)
//     —— 带 paperLayout → **V16 路径**（MultiTicketComposer.composePlans → buildRenderCommand → drawRenderCommand）。
//   · `mergeFactory.buildMergeRenderCommands` **无生产调用方**（Gate 4 Path B 审计对象，未接线）——
//     3-A.3 以真实链为准，不 mock mergeFactory。
//   · merge2/3 = strategy 'vertical'，merge4 = 'grid'（usePreview.js:709）。
//   · merge 打印 = M3-1 Artifact→PNG adapter（复用预览 canvas，不二次 render）→ 3-A.3 只验证预览侧几何。
//   · OFD item 在 merge 组内仍只表现为 `_previewImageUrl`（无 _pdfData → image 类型）。
//
// 验收顺序（冻结）：A3.1 Geometry owner proof → A3.2 Slot geometry → A3.3 OFD slot 无特殊偏移 →
// A3.4 rotation isolation。输入策略：A deterministic fixture（2100×2970）+ B real OFD raster
// snapshot（2480×3508 @300dpi）。
//
// 纪律：test-only；零生产码修改；复用 nodePolyfill.mjs / env-shim.loader.mjs。
//
// 运行：
//   cd frontend
//   node --loader ./test/printGate/env-shim.loader.mjs --test ./test/printGate/gate3A3OfdImageMerge.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { installNodePolyfills, MOCK_IMAGE_SIZES } from './nodePolyfill.mjs'

installNodePolyfills()

// ─────────────────────────────────────────────────────────────
// 1. 加载真实生产链（动态 import：先 polyfill 后加载）
// ─────────────────────────────────────────────────────────────
const { renderMultipleItemsToCanvas } = await import('../../src/renderers.js')
const { computePaperLayout } = await import('../../src/previewState.js')
const { computeSlots } = await import('../../src/layout/SlotLayout.js')
const { getPaperPixels } = await import('../../src/layout.js')

const PREVIEW_DPI = 300
const PAPER_PX = getPaperPixels('A4', PREVIEW_DPI, false) // {2480, 3508}

// ─────────────────────────────────────────────────────────────
// 2. Fixture（A deterministic + B real snapshot）
// ─────────────────────────────────────────────────────────────
MOCK_IMAGE_SIZES.set('mock://ofd/m-a', { width: 2100, height: 2970 }) // A 类 OFD（A4 同比例合成）
MOCK_IMAGE_SIZES.set('mock://img/m-a', { width: 2100, height: 2970 }) // A 类 Image（同尺寸对照）
MOCK_IMAGE_SIZES.set('mock://ofd/m-r', { width: 2480, height: 3508 }) // B 类 OFD（real snapshot 契约）
MOCK_IMAGE_SIZES.set('mock://img/m-r', { width: 2480, height: 3508 }) // B 类 Image（同尺寸对照）

const OFD_A = { key: 'ofd-m-a', fileFormat: 'ofd', docId: 'doc-ofd-m-a', _previewImageUrl: 'mock://ofd/m-a' }
const IMG_A = { key: 'img-m-a', fileFormat: 'image', docId: 'doc-img-m-a', _previewImageUrl: 'mock://img/m-a' }
const OFD_R = { key: 'ofd-m-r', fileFormat: 'ofd', docId: 'doc-ofd-m-r', _previewImageUrl: 'mock://ofd/m-r' }
const IMG_R = { key: 'img-m-r', fileFormat: 'image', docId: 'doc-img-m-r', _previewImageUrl: 'mock://img/m-r' }

// 复刻 usePreview.js:875-884 merge 调用（V16 slotted path，paperLayout 传入）
async function renderMerge(items, { rotations = {}, slotCount = 2, strategy = 'vertical', landscape = false } = {}) {
  const paperLayout = computePaperLayout({
    paperSize: 'A4',
    margins: { left: 3, right: 3, top: 3, bottom: 3 },
  })
  return renderMultipleItemsToCanvas(
    items,
    'A4',
    PREVIEW_DPI,
    landscape,
    rotations,
    slotCount,
    false, // isPrint = false（与预览一致，M3-1 PNG adapter 复用）
    false, // showSafeMargin
    { strategy, gridCols: 2, gridRows: 2, userMargins: { left: 3, right: 3, top: 3, bottom: 3 }, customPaper: undefined },
    paperLayout,
  )
}

// drawImage dest 并集 bbox（单次绘制 = 单 slot 内容足迹）
function drawRect(drawImage) {
  return { x: drawImage.dx, y: drawImage.dy, w: drawImage.dw, h: drawImage.dh }
}

// ─────────────────────────────────────────────────────────────
// A3.1 Geometry owner proof：OFD 与 Image 同一 placement 算法
// ─────────────────────────────────────────────────────────────
test('A3.1 Geometry owner: 混合 [OFD, Image] 与纯 Image 组产出完全一致的绘制几何（格式无关）', async () => {
  // A 类同尺寸：混合组 vs 纯 Image 组（rotation 0/0, merge2 vertical）
  const mixed = await renderMerge([OFD_A, IMG_A], { rotations: { 'ofd-m-a': 0, 'img-m-a': 0 }, slotCount: 2 })
  const pureImg = await renderMerge([IMG_A, IMG_A], { rotations: { 'img-m-a': 0 }, slotCount: 2 })

  assert.equal(mixed.ctx.drawImages.length, 2, '两 slot 各绘制一次')
  assert.equal(pureImg.ctx.drawImages.length, 2)
  // OFD 与 Image 走同一 createPlacement（drawImage dest 逐 slot 一致）——若有 if(ofd) 分支，此处必 diff
  assert.deepEqual(
    mixed.ctx.drawImages.map(drawRect),
    pureImg.ctx.drawImages.map(drawRect),
    '混合组 vs 纯 Image 组：slot 落盘矩形逐槽一致（OFD 无特殊几何）',
  )
  assert.deepEqual(
    mixed.ctx.rotates.map(r => r.degrees),
    pureImg.ctx.rotates.map(r => r.degrees),
    '旋转记录一致（均 0 次）',
  )
})

test('A3.1-B Geometry owner: real snapshot（2480×3508）混合组同样格式无关', async () => {
  const mixedR = await renderMerge([OFD_R, IMG_R], { rotations: { 'ofd-m-r': 0, 'img-m-r': 0 }, slotCount: 2 })
  const pureR = await renderMerge([IMG_R, IMG_R], { rotations: { 'img-m-r': 0 }, slotCount: 2 })
  assert.deepEqual(
    mixedR.ctx.drawImages.map(drawRect),
    pureR.ctx.drawImages.map(drawRect),
    'B 类 real snapshot：OFD 与 Image 落盘矩形一致',
  )
})

// ─────────────────────────────────────────────────────────────
// A3.2 Slot geometry：slot.contentRect 来源一致（computeSlots 同一公式）
// ─────────────────────────────────────────────────────────────
test('A3.2 Slot geometry: merge2 vertical 分区 = computeSlots 冻结公式；每 slot 内容落于其 contentRect', async () => {
  const paperLayout = computePaperLayout({ paperSize: 'A4', margins: { left: 3, right: 3, top: 3, bottom: 3 } })
  const slots = computeSlots(paperLayout, { count: 2, strategy: 'vertical' })
  assert.equal(slots.length, 2)

  const canvas = await renderMerge([OFD_A, IMG_A], { rotations: { 'ofd-m-a': 0, 'img-m-a': 0 }, slotCount: 2 })

  // 逐槽：drawImage 落盘区域（createPlacement 产物）⊂ 该槽 contentRect（Gate 4.3 G3 ownership 复述）
  for (let i = 0; i < 2; i++) {
    const r = drawRect(canvas.ctx.drawImages[i])
    const cr = slots[i].contentRect
    assert.ok(r.x >= cr.x - 0.5 && r.y >= cr.y - 0.5, `slot${i} 内容左上角在 contentRect 内`)
    assert.ok(r.x + r.w <= cr.x + cr.width + 0.5, `slot${i} 内容右边不超 contentRect`)
    assert.ok(r.y + r.h <= cr.y + cr.height + 0.5, `slot${i} 内容下边不超 contentRect`)
  }
  // 两槽分区不重叠（竖向等分：slot1.y >= slot0 底）
  assert.ok(slots[1].contentRect.y >= slots[0].contentRect.y + slots[0].contentRect.height - 0.5, 'slot 分区无重叠')
})

test('A3.2-B Slot geometry: merge4 grid 分区 = computeSlots 公式；OFD 参与 grid 无特殊偏移', async () => {
  const paperLayout = computePaperLayout({ paperSize: 'A4', margins: { left: 3, right: 3, top: 3, bottom: 3 } })
  const slots = computeSlots(paperLayout, { count: 4, strategy: 'grid', gridCols: 2, gridRows: 2 })
  assert.equal(slots.length, 4)

  // 混合组：OFD/Image/Image/OFD 交错（验证 OFD 在任意 grid 槽位无偏移）。
  // 注：真实 merge4 为横向纸（getForcedLandscape），此处用 portrait grid 专注「格式无关」断言
  //     （landscape slotToLandscape 交换已由 Gate 4.3 orientation 用例覆盖，避免坐标系错位）。
  const canvas = await renderMerge([OFD_A, IMG_A, IMG_A, OFD_A], {
    rotations: {}, slotCount: 4, strategy: 'grid',
  })
  assert.equal(canvas.ctx.drawImages.length, 4)
  for (let i = 0; i < 4; i++) {
    const r = drawRect(canvas.ctx.drawImages[i])
    const cr = slots[i].contentRect
    assert.ok(r.x >= cr.x - 0.5 && r.y >= cr.y - 0.5 && r.x + r.w <= cr.x + cr.width + 0.5 && r.y + r.h <= cr.y + cr.height + 0.5,
      `grid slot${i} 内容落于其 contentRect（OFD 槽位无偏移）`)
  }
})

// ─────────────────────────────────────────────────────────────
// A3.3 OFD slot 无特殊偏移（防 if(ofd) 调整；bbox ⊂ slot.contentRect）
// ─────────────────────────────────────────────────────────────
test('A3.3 OFD 无特殊偏移: OFD bbox ⊂ slot.contentRect，且 slot geometry(OFD)==slot geometry(Image)（同尺寸）', async () => {
  // 行为：OFD 与 Image 同尺寸同槽位 → drawImage 区域逐像素一致（A3.1 已证），此处补 bbox 占位断言
  const canvas = await renderMerge([OFD_A, IMG_A], { rotations: { 'ofd-m-a': 0, 'img-m-a': 0 }, slotCount: 2 })
  const paperLayout = computePaperLayout({ paperSize: 'A4', margins: { left: 3, right: 3, top: 3, bottom: 3 } })
  const slots = computeSlots(paperLayout, { count: 2, strategy: 'vertical' })

  for (let i = 0; i < 2; i++) {
    const r = drawRect(canvas.ctx.drawImages[i])
    const cr = slots[i].contentRect
    const ratio = (r.w * r.h) / (cr.width * cr.height)
    assert.ok(ratio >= 0.15, `slot${i} 内容占比 ${(ratio * 100).toFixed(1)}% ≥15%（非空白）`)
    assert.ok(r.x >= cr.x && r.y >= cr.y && r.x + r.w <= cr.x + cr.width + 0.5 && r.y + r.h <= cr.y + cr.height + 0.5,
      `slot${i} bbox 落于 contentRect（无 OFD 溢出/偏移）`)
  }

  // 静态：merge 渲染链（renderers.js V16 组装段 + SlotLayout）无 ofd 条件分支
  const renderersSrc = readFileSync(fileURLToPath(new URL('../../src/renderers.js', import.meta.url)), 'utf8')
  const slotSrc = readFileSync(fileURLToPath(new URL('../../src/layout/SlotLayout.js', import.meta.url)), 'utf8')
  assert.ok(!/if\s*\([^)]*ofd/i.test(renderersSrc), 'renderers.js 无 if(ofd) 分支')
  assert.ok(!/ofd/i.test(slotSrc), 'SlotLayout 无 ofd 关键字（纯几何）')
})

// ─────────────────────────────────────────────────────────────
// A3.4 rotation isolation：merge 内 OFD/Image 旋转互不污染
// ─────────────────────────────────────────────────────────────
test('A3.4 rotation isolation: slot A rot90 / slot B rot0 → rotate 恰 1 次 90°（互不污染）', async () => {
  const canvas = await renderMerge([OFD_A, IMG_A], { rotations: { 'ofd-m-a': 90, 'img-m-a': 0 }, slotCount: 2 })
  assert.equal(canvas.ctx.rotates.length, 1, '仅 OFD slot 旋转（1 次）')
  assert.equal(Math.round(canvas.ctx.rotates[0].degrees), 90, 'OFD slot rotate 角度 90°')
  // 无第二旋转层：Image slot（rot0）不产生 rotate；drawRenderCommand 每 cmd 独立（renderDraw.js:54 唯一锚点）
  assert.equal(canvas.ctx.drawImages.length, 2, '两 slot 均绘制')
})

test('A3.4-B rotation isolation: slot A rot0 / slot B rot90 → rotate 恰 1 次 90°（顺序=slot 序）', async () => {
  const canvas = await renderMerge([OFD_A, IMG_A], { rotations: { 'ofd-m-a': 0, 'img-m-a': 90 }, slotCount: 2 })
  assert.equal(canvas.ctx.rotates.length, 1, '仅 Image slot 旋转（1 次）')
  assert.equal(Math.round(canvas.ctx.rotates[0].degrees), 90)
})

test('A3.4-C rotation isolation: 双旋转 slot（90+270）→ 各一次、互不叠加', async () => {
  const canvas = await renderMerge([OFD_A, IMG_A], { rotations: { 'ofd-m-a': 90, 'img-m-a': 270 }, slotCount: 2 })
  assert.equal(canvas.ctx.rotates.length, 2, '两 slot 各旋转一次')
  assert.equal(Math.round(canvas.ctx.rotates[0].degrees), 90, 'slot0 = 90°')
  assert.equal(Math.round(canvas.ctx.rotates[1].degrees), 270, 'slot1 = 270°（无叠加/无交叉）')
})
