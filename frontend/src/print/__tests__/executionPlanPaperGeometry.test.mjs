/**
 * ExecutionPlan 纸张几何 — Phase 1-C-2 Step 1 验收（G-C2-2 / G-C2-3）
 *
 * G-C2-2：同一 PrintSpec 输入 → Preview placement == ExecutionPlan placement
 *   （覆盖 A4 portrait / A4 landscape / 横票竖纸 / rot90 pending vector）
 * G-C2-3：方向突变（portrait → landscape）→ paper dims change + placement recalc
 *
 * 运行: node --test frontend/src/print/__tests__/executionPlanPaperGeometry.test.mjs
 * 纯 node（不依赖 vite import.meta.env；避免 import PrintPreviewModel/config.js）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveContentPlacement } from '../../layout/RotationResolver.js'
import { resolvePaperSpec } from '../paperSpec.js'
import { createPrintPlanInput, buildPrintExecutionPlan } from '../buildPrintExecutionPlan.js'
import { buildPrintPreviewModel, fileContentPx } from '../PrintPreviewModel.js'

const PREVIEW_DPI = 300

// 横票：210mm × 99mm（典型增值税电子发票横票），px@72 → pt
function mkInvoice({ key = 'f1', wMM = 210, hMM = 99 } = {}) {
  return {
    key, name: `${key}.pdf`, status: 'parsed', printPath: 'x.pdf', fileFormat: 'pdf',
    _pdfPageWidth: wMM / 25.4 * 72,
    _pdfPageHeight: hMM / 25.4 * 72,
  }
}

const MARGINS = { left: 3, right: 3, top: 3, bottom: 3 }

function previewPlacement(settings, file, contentRotation = 0) {
  // 复刻 usePrint placements（C-2 S1-B）与 PrintPreviewModel 同源：
  // fileContentPx（PDF points × dpi/72 → px@dpi）→ resolvePaperSpec（needSwap 归一化）
  // → resolveContentPlacement（唯一 resolver）
  const paper = resolvePaperSpec(settings)
  const contentPx = fileContentPx(file)
  return resolveContentPlacement({
    contentPhysicalSize: contentPx,
    contentRotation,
    physicalPaper: { widthMM: paper.widthMM, heightMM: paper.heightMM },
    margins: MARGINS,
    dpi: PREVIEW_DPI,
  })
}

function planPlacement(settings, file, contentRotation = 0) {
  // usePrint 模式：placements 在 hook 层算（resolveContentPlacement）→ plan 携带
  const preview = previewPlacement(settings, file, contentRotation)
  const placements = { [file.key]: preview }
  const { files, options } = createPrintPlanInput(
    [file], { ...settings, ...MARGINS }, { [file.key]: contentRotation }, placements)
  const plan = buildPrintExecutionPlan(files, options)
  const slot = plan.pages[0].slots[0]
  assert.ok(slot.placement, 'slot.placement 不应为空（G3 死代码已修）')
  return { slot, preview, plan }
}

function assertPlacementEqual(planSlot, preview) {
  assert.equal(planSlot.placement.scale, preview.scale, 'scale')
  assert.deepEqual(planSlot.placement.offset, preview.offset, 'offset')
  assert.deepEqual(planSlot.placement.placedRect, preview.placedRect, 'placedRect')
}

test('G-C2-2a: A4 portrait（横票内容竖纸）→ Plan 携带的 placement == Preview resolver 输出', () => {
  const settings = { paperSize: 'A4', landscape: false, mergeMode: 'none' }
  const file = mkInvoice()
  const { slot, preview, plan } = planPlacement(settings, file)
  assertPlacementEqual(slot, preview)
  assert.deepEqual(plan.pages[0].paper,
    { size: 'A4', orientation: 'portrait', widthMM: 210, heightMM: 297, customPaper: null, paperkind: undefined })
})

test('G-C2-2b: A4 landscape（横打）→ physicalPaper 宽高交换 + placement 一致', () => {
  const settings = { paperSize: 'A4', landscape: true, mergeMode: 'none' }
  const file = mkInvoice()
  const { slot, preview, plan } = planPlacement(settings, file)
  assertPlacementEqual(slot, preview)
  assert.deepEqual(plan.pages[0].paper,
    { size: 'A4', orientation: 'landscape', widthMM: 297, heightMM: 210, customPaper: null, paperkind: undefined })
})

test('G-C2-2c: 横票竖纸（A4 portrait + 横内容）→ layoutRotation=-90 对齐（Preview 同约定）', () => {
  const settings = { paperSize: 'A4', landscape: false, mergeMode: 'none' }
  const file = mkInvoice({ wMM: 210, hMM: 99 })
  const { slot, preview } = planPlacement(settings, file)
  assertPlacementEqual(slot, preview)
  assert.equal(preview.layoutRotation, -90)
})

test('G-C2-2d: rot90 pending vector（contentRotation=90）→ Preview == Plan placement', () => {
  const settings = { paperSize: 'A4', landscape: false, mergeMode: 'none' }
  const file = mkInvoice()
  const { slot, preview } = planPlacement(settings, file, 90)
  assertPlacementEqual(slot, preview)
})

test('G-C2-2e: Voucher240x140 原生横向纸（portrait 请求）→ physicalPaper 宽高交换（B1 语义）', () => {
  const settings = { paperSize: 'Voucher240x140', landscape: false, mergeMode: 'none' }
  const file = mkInvoice()
  const { slot, preview, plan } = planPlacement(settings, file)
  assertPlacementEqual(slot, preview)
  assert.deepEqual(plan.pages[0].paper,
    { size: 'Voucher240x140', orientation: 'portrait', widthMM: 140, heightMM: 240, customPaper: null, paperkind: undefined })
})

test('G-C2-3: 方向突变 portrait→landscape → paper dims 变化 + placement 重算（不只 Sumatra args）', () => {
  const file = mkInvoice()
  const pSettings = { paperSize: 'A4', landscape: false, mergeMode: 'none' }
  const lSettings = { paperSize: 'A4', landscape: true, mergeMode: 'none' }

  const planP = planPlacement(pSettings, file)
  const planL = planPlacement(lSettings, file)

  // paper dims 必须变化（needSwap）
  assert.notDeepEqual(
    { w: planP.plan.pages[0].paper.widthMM, h: planP.plan.pages[0].paper.heightMM },
    { w: planL.plan.pages[0].paper.widthMM, h: planL.plan.pages[0].paper.heightMM },
    '方向突变必须交换 paper 宽高')
  // placement 必须重算：方向突变 → offset / placedRect 变化（scale 在横票+矩形纸场景
  // 数学上可能相等——适配关系镜像，不视为违反；offset 必然变化）。
  assert.notDeepEqual(planP.slot.placement.offset, planL.slot.placement.offset,
    '方向突变必须重算 placement offset')
  assert.notDeepEqual(planP.slot.placement.placedRect, planL.slot.placement.placedRect,
    '方向突变必须重算 placement placedRect')
})

test('G-C2-1 佐证: plan.paper 几何字段完整（createPrintPlanInput 解析）', () => {
  const { files, options } = createPrintPlanInput(
    [mkInvoice()], { paperSize: 'A4', landscape: false, mergeMode: 'none', ...MARGINS }, {}, {})
  const plan = buildPrintExecutionPlan(files, options)
  assert.deepEqual(Object.keys(plan.pages[0].paper).sort(),
    ['customPaper', 'heightMM', 'orientation', 'paperkind', 'size', 'widthMM'])
  assert.equal(plan.pages[0].orientation, 'portrait')
})

test('G-C2-4: Plan round-trip — PrintSpec → ExecutionPlan → Preview render input（同 placement / paper geometry）', () => {
  const settings = {
    paperSize: 'A4', landscape: false, mergeMode: 'none',
    marginLeft: 3, marginRight: 3, marginTop: 3, marginBottom: 3,
  }
  const file = mkInvoice()
  // usePrint 模式：placements 先算（resolvePaperSpec → resolveContentPlacement）
  const preview = previewPlacement(settings, file)
  const placements = { [file.key]: preview }
  const { files, options } = createPrintPlanInput([file], settings, {}, placements)
  const plan = buildPrintExecutionPlan(files, options)
  // Preview render input（buildPrintPreviewModel 消费 plan）
  const m = buildPrintPreviewModel(plan, { files: [file], settings, backendUrl: '' })
  assert.ok(m.valid, `预览构建失败: ${m.reason}`)
  const p = m.pages[0]
  const planPage = plan.pages[0]
  const planSlot = planPage.slots[0]
  const s = p.slots[0]
  // paper geometry 一致（C-2 Step 2：Preview 消费 plan.paper）
  assert.equal(p.paperSizeMM.widthMM, planPage.paper.widthMM, 'paperSizeMM.widthMM')
  assert.equal(p.paperSizeMM.heightMM, planPage.paper.heightMM, 'paperSizeMM.heightMM')
  assert.equal(p.requestedPaperOrientation, planPage.orientation, 'requestedPaperOrientation')
  // placement 一致：Preview resolver 输出 == plan 携带（同一 resolveContentPlacement + 同一 physicalPaper）
  assert.ok(planSlot.placement, 'plan slot.placement 非空')
  assert.ok(s.placement, 'preview slot.placement 非空')
  assert.equal(s.placement.scale, planSlot.placement.scale, 'scale')
  assert.deepEqual(s.placement.offset, planSlot.placement.offset, 'offset')
  assert.deepEqual(s.placement.placedRect, planSlot.placement.placedRect, 'placedRect')
})

test('G-C2-4b: Plan round-trip（A4 landscape 横打）→ 一致', () => {
  const settings = {
    paperSize: 'A4', landscape: true, mergeMode: 'none',
    marginLeft: 3, marginRight: 3, marginTop: 3, marginBottom: 3,
  }
  const file = mkInvoice()
  const preview = previewPlacement(settings, file)
  const { files, options } = createPrintPlanInput([file], settings, {}, { [file.key]: preview })
  const plan = buildPrintExecutionPlan(files, options)
  const m = buildPrintPreviewModel(plan, { files: [file], settings, backendUrl: '' })
  assert.ok(m.valid)
  const p = m.pages[0]
  assert.equal(p.paperSizeMM.widthMM, plan.pages[0].paper.widthMM)
  assert.equal(p.paperSizeMM.heightMM, plan.pages[0].paper.heightMM)
  assert.equal(p.slots[0].placement.scale, plan.pages[0].slots[0].placement.scale)
  assert.deepEqual(p.slots[0].placement.placedRect, plan.pages[0].slots[0].placement.placedRect)
})
