/**
 * 临时审计脚本：验证用户给出的 3 个固定案例（rotation-refactor 分支）
 * 验证点：
 *   1. resolveContentPlacement 纯数学模型（fitRotation / renderRotation）
 *   2. PrintPreviewModel 端到端：thumbnailUrl 仅带 contentRotation（不双旋转）
 *      slot.placement.renderTransform 不拉伸 + rotationDeg 与模型一致
 * 运行：node --test test/_audit3_verify.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveContentPlacement } from '../src/layout/RotationResolver.js'
import { buildPrintPreviewModel } from '../src/print/PrintPreviewModel.js'
import { buildPrintExecutionPlan, SOURCE_FILE_FILTER } from '../src/print/buildPrintExecutionPlan.js'

const mm = (w, h) => ({ widthMM: w, heightMM: h })
const A4 = mm(210, 297)        // 竖形纸（paperShape = portrait）
const A4L = mm(297, 210)       // 横形纸（paperShape = landscape）

// 横票 609×394（原始，旋转前）
const LAND_FILE = { width: 609, height: 394 }
const margins = { left: 3, right: 3, top: 3, bottom: 3 }

// ── 纯数学：resolveContentPlacement ──
test('T1 纯数学：横票+contentRotation=0+A4竖纸+纵方向 → shapeFit=-90 orientFit=0 renderRotation=270(≡-90)', () => {
  const r = resolveContentPlacement({
    contentPhysicalSize: LAND_FILE, contentRotation: 0,
    paperSize: A4, paperOrientation: 'portrait', margins,
  })
  assert.equal(r.shapeFitRotation, -90, 'shapeFitRotation')
  assert.equal(r.orientationFitRotation, 0, 'orientationFitRotation')
  assert.equal(r.fitRotation, -90, 'fitRotation')
  assert.equal(r.renderRotation, 270, 'renderRotation = normalize(-90) = 270（视觉≡-90）')
})

test('T2 纯数学：横票+A4竖纸+切横方向 → shapeFit=-90 orientFit=+90 renderRotation=0', () => {
  const r = resolveContentPlacement({
    contentPhysicalSize: LAND_FILE, contentRotation: 0,
    paperSize: A4, paperOrientation: 'landscape', margins,
  })
  assert.equal(r.shapeFitRotation, -90)
  assert.equal(r.orientationFitRotation, 90)
  assert.equal(r.fitRotation, 0)
  assert.equal(r.renderRotation, 0)
})

test('T3a 纯数学：横纸型+横票+横方向 → orientationFit=-90, renderRotation=270(≡-90)', () => {
  const r = resolveContentPlacement({
    contentPhysicalSize: LAND_FILE, contentRotation: 0,
    paperSize: A4L, paperOrientation: 'landscape', margins,
  })
  assert.equal(r.shapeFitRotation, 0)
  assert.equal(r.orientationFitRotation, -90)  // Commit 2-H v2：横纸+横方向 → 放倒 -90
  assert.equal(r.fitRotation, -90)
  assert.equal(r.renderRotation, 270)
})

test('T3b 纯数学：横纸型+横票+切纵方向 → renderRotation=0（Commit 2-H：横向纸型下 orientationFit 恒为 0，用户纵不补偿旋转）', () => {
  const r = resolveContentPlacement({
    contentPhysicalSize: LAND_FILE, contentRotation: 0,
    paperSize: A4L, paperOrientation: 'portrait', margins,
  })
  assert.equal(r.shapeFitRotation, 0)
  assert.equal(r.orientationFitRotation, 0)  // Commit 2-H: 横向纸型下 orientationFit 恒为 0
  assert.equal(r.fitRotation, 0)
  assert.equal(r.renderRotation, 0)
})

// ── 端到端：PrintPreviewModel ──
// 给 docId 以便 getThumbnailUrl 走后端路径（验证 content_rotation 仅 = contentRotation）
const mk = (key, over = {}) => ({
  key, name: `${key}.pdf`, status: 'parsed', printPath: `/tmp/${key}.pdf`,
  fileFormat: 'pdf', docId: `DOC_${key}`, _pdfPageWidth: 609, _pdfPageHeight: 394, ...over,
})

test('T1 端到端：横票+A4纵方向 → thumbnailUrl 无 content_rotation + renderTransform 不拉伸 + rotationDeg=270', () => {
  const files = [mk('LAND')]
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: {} })
  const m = buildPrintPreviewModel(plan, { files, settings: {} })
  const s = m.pages[0].slots[0]
  assert.ok(s.thumbnailUrl, 'thumbnailUrl 应生成')
  assert.equal(s.thumbnailUrl.includes('content_rotation'), false, 'rotation=0 → 缩略图无 content_rotation 参数')
  assert.equal(s.contentRotation, 0, 'slot.contentRotation 透传用户旋转')
  assert.equal(s.placement.renderTransform.rotationDeg, 270, 'rotationDeg=270(≡-90)')
  // 不拉伸：image 尺寸=原始 609×394 points 归一化后 = 2537.5×1641.67 px@300（非旋转包围盒）
  assert.ok(Math.abs(s.placement.renderTransform.imageWidth - 2537.5) < 0.5, `imageWidth=${s.placement.renderTransform.imageWidth}≈2537.5(609pt×300/72)`)
  assert.ok(Math.abs(s.placement.renderTransform.imageHeight - 1641.67) < 0.5, `imageHeight=${s.placement.renderTransform.imageHeight}≈1641.67(394pt×300/72)`)
})

test('T2 端到端：横票+A4切横方向 → 无 content_rotation + rotationDeg=270(≡-90)（Commit 2-H v2：横纸型+横方向放倒）', () => {
  const files = [mk('LAND')]
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: { landscape: true } })
  const m = buildPrintPreviewModel(plan, { files, settings: { landscape: true } })
  const s = m.pages[0].slots[0]
  assert.equal(s.thumbnailUrl.includes('content_rotation'), false)
  assert.equal(s.placement.renderTransform.rotationDeg, 270, 'rotationDeg=270(≡-90) [Commit 2-H v2：横纸型+横方向放倒]')
})

test('情况B 守卫：Resolver 对原始 609×394 + contentRotation=90 → 单次旋转 effectiveContentSize=394×609', () => {
  // PrintPreviewModel 传入的是 getContentDimensions(f) = 原始 609×394（非缩略图旋转后尺寸）
  const r = resolveContentPlacement({
    contentPhysicalSize: { width: 609, height: 394 },
    contentRotation: 90,
    paperSize: A4, paperOrientation: 'portrait', margins,
  })
  assert.equal(r.contentRotation, 90)
  assert.equal(r.effectiveContentSize.width, 394, '单次旋转：609×394 → 394×609')
  assert.equal(r.effectiveContentSize.height, 609)
  // 反证：若误传已旋转 394×609 + contentRotation=90 → 双旋转成 609×394（绝不允许，证明必须传原始尺寸）
  const bad = resolveContentPlacement({
    contentPhysicalSize: { width: 394, height: 609 },
    contentRotation: 90,
    paperSize: A4, paperOrientation: 'portrait', margins,
  })
  assert.equal(bad.effectiveContentSize.width, 609, '双旋转会得到 609×394（错误样例，印证 model 必须传原始尺寸）')
})
