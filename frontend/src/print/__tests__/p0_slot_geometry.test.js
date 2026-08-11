/**
 * p0_slot_geometry.test — P0 修复后 slot 级 placement 几何验证
 *
 * P0 目标：resolveContentPlacement 的 target 从「整页 paper」改为「slot（virtual paper）」，
 * 使每个 invoice 的 placement 落在各自 slot 内，且跨 slot 不重叠。
 *
 * 验证公式（关键）：SVG `<image width=W height=H transform="translate(tx,ty) scale(s) rotate(rd,cx,cy)">`
 *   - 内容本地尺寸 W×H（已含 contentRotation，未含 layoutRotation）
 *   - 旋转 rd（90/270）后包围盒宽高互换，故旋转后 bbox = (rd%180==90 ? H : W) × (rd%180==90 ? W : H)
 *   - 缩放 s 作用于旋转后的几何
 *   - 平移 (tx,ty) 作用于坐标系最外层，中心点 = (tx + s·W/2, ty + s·H/2)
 *
 * @module print/__tests__/p0_slot_geometry
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrintPreviewModel } from '../PrintPreviewModel.js'
import { createPrintPlanInput, buildPrintExecutionPlan } from '../buildPrintExecutionPlan.js'

function buildModelForFiles(rawFiles, settings = { paperSize: 'A4' }) {
  const { files, options } = createPrintPlanInput(rawFiles, { landscape: false, ...settings })
  const plan = buildPrintExecutionPlan(files, options)
  return buildPrintPreviewModel(plan, { files, settings, backendUrl: '' })
}

// 内容尺寸以 mm 给出，转 PDF points（_pdfPageWidth/_pdfPageHeight 单位 = 1/72"）
function makeFile(key, wMm, hMm) {
  return {
    key,
    docId: key,
    name: key,
    fileFormat: 'pdf',
    status: 'parsed',
    printPath: `/files/${key}.pdf`,
    _pdfPageWidth: Math.round((wMm / 25.4) * 72),
    _pdfPageHeight: Math.round((hMm / 25.4) * 72),
  }
}

// 计算内容在纸面上的旋转后包围盒（mm），返回 {left,right,top,bottom}
function contentBBox(rt) {
  const W = rt.contentBoxWidth
  const H = rt.contentBoxHeight
  const s = rt.scale
  const deg = ((Math.round(rt.rotationDeg) % 180) + 180) % 180
  const rotated = deg === 90
  const bw = (rotated ? H : W) * s
  const bh = (rotated ? W : H) * s
  const cx = rt.translateX + s * (W / 2)
  const cy = rt.translateY + s * (H / 2)
  return {
    left: cx - bw / 2,
    right: cx + bw / 2,
    top: cy - bh / 2,
    bottom: cy + bh / 2,
  }
}

function boxesOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

// 验证单个 page 的所有 slot：placement 存在、内容 bbox 在该 slot 内、slot 间互不重叠
function assertPageSlotsValid(page, label, eps = 0.5) {
  const slots = page.slots
  assert.ok(slots.length > 0, `${label}: 无 slot`)
  const boxes = []
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const rt = slot.placement?.renderTransformMM
    assert.ok(rt, `${label}: slot[${i}] (${slot.source}) placement 为 null`)
    const bb = contentBBox(rt)
    boxes.push(bb)
    assert.ok(
      bb.left >= slot.x - eps && bb.right <= slot.x + slot.width + eps,
      `${label}: slot[${i}] 内容 bbox X [${bb.left.toFixed(2)},${bb.right.toFixed(2)}] 越出 slot X [${slot.x.toFixed(2)},${(slot.x + slot.width).toFixed(2)}]`,
    )
    assert.ok(
      bb.top >= slot.y - eps && bb.bottom <= slot.y + slot.height + eps,
      `${label}: slot[${i}] 内容 bbox Y [${bb.top.toFixed(2)},${bb.bottom.toFixed(2)}] 越出 slot Y [${slot.y.toFixed(2)},${(slot.y + slot.height).toFixed(2)}]`,
    )
  }
  // 跨 slot 互不重叠（P0 核心目标）
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      assert.ok(
        !boxesOverlap(boxes[a], boxes[b]),
        `${label}: slot[${a}] 与 slot[${b}] 内容重叠`,
      )
    }
  }
}

const LAND_CONTENT = [200, 140] // landscape 内容
const PORT_CONTENT = [120, 180] // portrait 内容

// ── 单文件 ──

test('single portrait + landscape content (layoutRotation=-90)', () => {
  const model = buildModelForFiles([makeFile('F1', ...LAND_CONTENT)])
  assert.equal(model.valid, true)
  assertPageSlotsValid(model.pages[0], 'single-port-land')
})

test('single portrait + portrait content (layoutRotation=0)', () => {
  const model = buildModelForFiles([makeFile('F1', ...PORT_CONTENT)])
  assertPageSlotsValid(model.pages[0], 'single-port-port')
})

test('single landscape + landscape content (layoutRotation=0)', () => {
  const model = buildModelForFiles([makeFile('F1', ...LAND_CONTENT)], { paperSize: 'A4', landscape: true })
  assertPageSlotsValid(model.pages[0], 'single-land-land')
})

test('single portrait + landscape content + userRotation=90', () => {
  const model = buildModelForFiles([{ ...makeFile('F1', ...LAND_CONTENT), }], { paperSize: 'A4' })
  // rotation 通过 slotDef.rotation 注入：构造带 rotation 的文件对象
  const file = makeFile('F1', ...LAND_CONTENT)
  file.rotation = 90
  const m2 = buildModelForFiles([file])
  assertPageSlotsValid(m2.pages[0], 'single-rot90')
})

test('single portrait + landscape content + userRotation=180', () => {
  const file = makeFile('F1', ...LAND_CONTENT)
  file.rotation = 180
  const model = buildModelForFiles([file])
  assertPageSlotsValid(model.pages[0], 'single-rot180')
})

test('single portrait + landscape content + userRotation=270', () => {
  const file = makeFile('F1', ...LAND_CONTENT)
  file.rotation = 270
  const model = buildModelForFiles([file])
  assertPageSlotsValid(model.pages[0], 'single-rot270')
})

// ── 合并模式 ──

test('merge2 portrait + landscape content', () => {
  const model = buildModelForFiles(
    [makeFile('F1', ...LAND_CONTENT), makeFile('F2', ...LAND_CONTENT)],
    { paperSize: 'A4', mergeMode: 'merge2' },
  )
  assert.equal(model.pages.length, 1, 'merge2 应为 1 物理页')
  assertPageSlotsValid(model.pages[0], 'merge2')
})

test('merge3 portrait + landscape content', () => {
  const model = buildModelForFiles(
    [
      makeFile('F1', ...LAND_CONTENT),
      makeFile('F2', ...LAND_CONTENT),
      makeFile('F3', ...LAND_CONTENT),
    ],
    { paperSize: 'A4', mergeMode: 'merge3' },
  )
  assert.equal(model.pages.length, 1, 'merge3 应为 1 物理页')
  assertPageSlotsValid(model.pages[0], 'merge3')
})

test('merge4 portrait + landscape content (vertical)', () => {
  const model = buildModelForFiles(
    Array.from({ length: 4 }, (_, i) => makeFile(`F${i + 1}`, ...LAND_CONTENT)),
    { paperSize: 'A4', mergeMode: 'merge4' },
  )
  assert.equal(model.pages.length, 1, 'merge4 应为 1 物理页')
  assertPageSlotsValid(model.pages[0], 'merge4-port')
})

test('merge4 landscape + landscape content (grid)', () => {
  const model = buildModelForFiles(
    Array.from({ length: 4 }, (_, i) => makeFile(`F${i + 1}`, ...LAND_CONTENT)),
    { paperSize: 'A4', mergeMode: 'merge4', landscape: true },
  )
  assertPageSlotsValid(model.pages[0], 'merge4-land')
})

// ── 对照：旧行为应失败（整页 target）— 仅作文档性对照，不作为断言 ──
// 旧代码中 placement 以整页 A4 为 target，merge2 下 invoice 会被缩放到整页尺寸，
// 旋转后 bbox 必超出单个 slot → 这正是 P0 修复前 bug。
