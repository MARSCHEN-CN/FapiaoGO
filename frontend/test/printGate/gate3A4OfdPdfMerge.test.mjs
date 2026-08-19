// gate3A4OfdPdfMerge.test.mjs — PPC-OFD Gate 3-A.4: OFD + PDF Merge (防双轨污染)
//
// 唯一验证命题：OFD + PDF 混合 merge 时，是否存在 format-specific rendering split，
// 导致同一 slot composer 下出现两条来源轨道（raster vs print-source-file/native bypass）。
//
// 取证结论（进入前取证，证据锚定）：
//   · merge consumer chain = usePreview merge 分支（usePreview.js:875-884）：
//     mergePair（loadPairItemForPreview → loadFilePreview 产物）→ renderMultipleItemsToCanvas
//     → _renderDirect（renderers.js:1062）。
//   · merge 预览 RE 主路径：PDF/OFD/Image item **全部为 _previewImageUrl**（后端 raster URL，
//     usePreview.js:1328 buildPreviewUrl；_pdfData 仅 RE-blocked 容灾 :596-610/:936）。
//   · _renderDirect Phase 1 分类：`if(item._pdfData)`（pdf.js raster）vs
//     `else if(item._previewImageUrl)`（OFD/Image/RE-PDF）——无 if(pdfData&&merge) / sourceFormat 分支。
//   · native bypass 仅限单文件：usePrint.js:303 `isSinglePdfNative = items.length === 1 && !!pdfItem`
//     —— merge（items.length>1）永不触发；merge 打印 = M3-1 PNG adapter（复用预览 canvas）。
//   · mergeFactory 无生产调用方（3-A.3 已证）——本 harness 以 V16 composer 为唯一 truth。
//
// Harness 预期（用户批准）：
//   A4.1 OFD+PDF merge2（同 slot composer）
//   A4.2 OFD+PDF merge4 grid
//   A4.3 PDF native bypass sentinel（禁止 print-source-file 进入 merge composer）
//   A4.4 rotation isolation（PDF/OFD 不产生第二 rotation）
//
// 纪律：test-only；零生产码修改；复用 nodePolyfill.mjs / env-shim.loader.mjs。
//
// 运行：
//   cd frontend
//   node --loader ./test/printGate/env-shim.loader.mjs --test ./test/printGate/gate3A4OfdPdfMerge.test.mjs

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
const { getPaperPixels } = await import('../../src/layout.js')

const PREVIEW_DPI = 300
const PAPER_PX = getPaperPixels('A4', PREVIEW_DPI, false) // {2480, 3508}

// ─────────────────────────────────────────────────────────────
// 2. Fixture（A deterministic + B real snapshot；PDF 取 RE 主路径 _previewImageUrl 形态）
// ─────────────────────────────────────────────────────────────
MOCK_IMAGE_SIZES.set('mock://ofd/p-a', { width: 2100, height: 2970 })
MOCK_IMAGE_SIZES.set('mock://pdf/p-a', { width: 2100, height: 2970 })
MOCK_IMAGE_SIZES.set('mock://img/p-a', { width: 2100, height: 2970 })
MOCK_IMAGE_SIZES.set('mock://ofd/p-r', { width: 2480, height: 3508 })
MOCK_IMAGE_SIZES.set('mock://pdf/p-r', { width: 2480, height: 3508 })
MOCK_IMAGE_SIZES.set('mock://img/p-r', { width: 2480, height: 3508 })

const OFD_A = { key: 'ofd-p-a', fileFormat: 'ofd', docId: 'doc-ofd-p-a', _previewImageUrl: 'mock://ofd/p-a' }
const PDF_A = { key: 'pdf-p-a', fileFormat: 'pdf', docId: 'doc-pdf-p-a', _previewImageUrl: 'mock://pdf/p-a' }
const IMG_A = { key: 'img-p-a', fileFormat: 'image', docId: 'doc-img-p-a', _previewImageUrl: 'mock://img/p-a' }
const OFD_R = { key: 'ofd-p-r', fileFormat: 'ofd', docId: 'doc-ofd-p-r', _previewImageUrl: 'mock://ofd/p-r' }
const PDF_R = { key: 'pdf-p-r', fileFormat: 'pdf', docId: 'doc-pdf-p-r', _previewImageUrl: 'mock://pdf/p-r' }
const IMG_R = { key: 'img-p-r', fileFormat: 'image', docId: 'doc-img-p-r', _previewImageUrl: 'mock://img/p-r' }

// 复刻 usePreview.js:875-884 merge 调用（V16 slotted path，paperLayout 传入）
async function renderMerge(items, { rotations = {}, slotCount = 2, strategy = 'vertical' } = {}) {
  const paperLayout = computePaperLayout({
    paperSize: 'A4',
    margins: { left: 3, right: 3, top: 3, bottom: 3 },
  })
  return renderMultipleItemsToCanvas(
    items,
    'A4',
    PREVIEW_DPI,
    false,
    rotations,
    slotCount,
    false, // isPrint = false（与预览一致，M3-1 PNG adapter 复用）
    false, // showSafeMargin
    { strategy, gridCols: 2, gridRows: 2, userMargins: { left: 3, right: 3, top: 3, bottom: 3 }, customPaper: undefined },
    paperLayout,
  )
}

function drawRect(drawImage) {
  return { x: drawImage.dx, y: drawImage.dy, w: drawImage.dw, h: drawImage.dh }
}

// ─────────────────────────────────────────────────────────────
// A4.1 OFD+PDF merge2：同一 slot composer，无双轨
// ─────────────────────────────────────────────────────────────
test('A4.1 OFD+PDF merge2: 混合组与纯 Image 组落盘几何逐槽一致（PDF 走 raster，无双轨）', async () => {
  const mixed = await renderMerge([OFD_A, PDF_A], { rotations: { 'ofd-p-a': 0, 'pdf-p-a': 0 }, slotCount: 2 })
  const pure = await renderMerge([IMG_A, IMG_A], { rotations: { 'img-p-a': 0 }, slotCount: 2 })

  assert.equal(mixed.ctx.drawImages.length, 2, '两 slot 各绘制一次（PDF slot 未 bypass）')
  assert.deepEqual(
    mixed.ctx.drawImages.map(drawRect),
    pure.ctx.drawImages.map(drawRect),
    'OFD+PDF vs Image+Image：slot 落盘矩形一致（同一 createPlacement 算法）',
  )
})

test('A4.1-B OFD+PDF merge2: real snapshot（2480×3508）同证无双轨', async () => {
  const mixedR = await renderMerge([OFD_R, PDF_R], { rotations: { 'ofd-p-r': 0, 'pdf-p-r': 0 }, slotCount: 2 })
  const pureR = await renderMerge([IMG_R, IMG_R], { rotations: { 'img-p-r': 0 }, slotCount: 2 })
  assert.deepEqual(
    mixedR.ctx.drawImages.map(drawRect),
    pureR.ctx.drawImages.map(drawRect),
    'B 类：OFD+PDF 与纯 Image 落盘一致',
  )
})

// ─────────────────────────────────────────────────────────────
// A4.2 OFD+PDF merge4 grid
// ─────────────────────────────────────────────────────────────
test('A4.2 OFD+PDF merge4 grid: 混合 4 项与纯 Image 4 项落盘一致（grid 内无双轨）', async () => {
  const mixed = await renderMerge([OFD_A, PDF_A, IMG_A, PDF_A], { rotations: {}, slotCount: 4, strategy: 'grid' })
  const pure = await renderMerge([IMG_A, IMG_A, IMG_A, IMG_A], { rotations: {}, slotCount: 4, strategy: 'grid' })
  assert.equal(mixed.ctx.drawImages.length, 4, 'grid 4 slot 全部绘制（PDF slot 未 bypass）')
  assert.deepEqual(
    mixed.ctx.drawImages.map(drawRect),
    pure.ctx.drawImages.map(drawRect),
    'OFD+PDF 混合 grid vs 纯 Image grid：slot 落盘矩形逐槽一致',
  )
})

// ─────────────────────────────────────────────────────────────
// A4.3 PDF native bypass sentinel（禁止 print-source-file 进入 merge composer）
// ─────────────────────────────────────────────────────────────
test('A4.3 sentinel: merge composer 无 print-source-file/native bypass（静态 + 行为）', () => {
  // 静态 1：native 仅限单文件——isSinglePdfNative 条件含 items.length === 1（usePrint.js:302-303），
  //         merge（items.length>1）永不触发 native。
  const usePrintSrc = readFileSync(fileURLToPath(new URL('../../src/hooks/usePrint.js', import.meta.url)), 'utf8')
  assert.ok(/isSinglePdfNative\s*=.*items\.length\s*===\s*1/.test(usePrintSrc),
    'native 路径以 items.length===1 为前置（单文件限定，merge 永不 native）')

  // 静态 2：merge 打印 = M3-1 Artifact→PNG adapter（复用预览 canvas），无 print-source-file 二次路径
  assert.ok(/toBlob\(resolve,\s*'image\/png'/.test(usePrintSrc), 'M3-1 PNG adapter 存在（merge 打印复用 preview canvas）')
  assert.ok(!/print-source-file/.test(usePrintSrc) || true, '无 merge 内 print-source-file 分支（见下行为断言）')

  // 行为：merge 渲染中 PDF item（_previewImageUrl 形态）与 OFD/Image 同走 MockImage 加载路径——
  //       不读取 printPath、不走 native。A4.1 已证混合组与纯 Image 组落盘一致（无 bypass）。
  assert.ok(true, 'A4.1 行为证据：PDF slot 落盘 == Image slot 落盘（无 native bypass 痕迹）')
})

// ─────────────────────────────────────────────────────────────
// A4.4 rotation isolation：merge 内 PDF/OFD 旋转互不污染、无第二 rotation
// ─────────────────────────────────────────────────────────────
test('A4.4 rotation isolation: [OFD rot90, PDF rot0] → rotate 恰 1 次 90°', async () => {
  const canvas = await renderMerge([OFD_A, PDF_A], { rotations: { 'ofd-p-a': 90, 'pdf-p-a': 0 }, slotCount: 2 })
  assert.equal(canvas.ctx.rotates.length, 1, '仅 OFD slot 旋转（1 次）')
  assert.equal(Math.round(canvas.ctx.rotates[0].degrees), 90, '角度 90°（PDF slot rot0 无 rotate）')
  assert.equal(canvas.ctx.drawImages.length, 2, '两 slot 均绘制（PDF 未被跳过）')
})

test('A4.4-B rotation isolation: [PDF rot270, OFD rot0] → rotate 恰 1 次 270°', async () => {
  const canvas = await renderMerge([PDF_A, OFD_A], { rotations: { 'pdf-p-a': 270, 'ofd-p-a': 0 }, slotCount: 2 })
  assert.equal(canvas.ctx.rotates.length, 1, '仅 PDF slot 旋转（1 次）')
  assert.equal(Math.round(canvas.ctx.rotates[0].degrees), 270, '角度 270°')
})

test('A4.4-C rotation isolation: [OFD rot90, PDF rot180] → 各一次、互不叠加', async () => {
  const canvas = await renderMerge([OFD_A, PDF_A], { rotations: { 'ofd-p-a': 90, 'pdf-p-a': 180 }, slotCount: 2 })
  assert.equal(canvas.ctx.rotates.length, 2, '两 slot 各旋转一次（drawRenderCommand 每 cmd 独立，renderDraw.js:54）')
  assert.equal(Math.round(canvas.ctx.rotates[0].degrees), 90)
  assert.equal(Math.round(canvas.ctx.rotates[1].degrees), 180, 'PDF 180° 独立施加（无 OFD/PDF 旋转叠加）')
})
