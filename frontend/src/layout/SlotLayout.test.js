/**
 * SlotLayout.test.js — 一页多票票位几何测试（纯函数 / node-safe）
 *
 * 覆盖：
 *   • safeRectOf：退化 / 非法输入
 *   • computeTicketSlots：2/3/1/N 票，边距，末位收口
 *   • fitIntoSlot：单源锁（placement === createPlacement）
 *
 * 纯几何测试，不依赖 config.js / previewState.js（import.meta.env），
 * 可在普通 node --test 下运行，无需 shim。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPlacement } from '../compose/composePlacement.js'
import { safeRectOf, computeTicketSlots, fitIntoSlot, slotToLandscape } from './SlotLayout.js'

// ── helper ──
function makePaper({ usableRect, contentRect } = {}) {
  return { usableRect: usableRect || { x: 0, y: 0, w: 2480, h: 3508 }, contentRect: contentRect || { w: 2480, h: 3508 } }
}

// ════════════════════════════════════════════
// safeRectOf
// ════════════════════════════════════════════
test('safeRectOf: valid paperLayout → usableRect', () => {
  const p = makePaper({ usableRect: { x: 100, y: 80, w: 2000, h: 3000 } })
  const r = safeRectOf(p)
  assert.deepEqual(r, { x: 100, y: 80, w: 2000, h: 3000 })
})

test('safeRectOf: missing usableRect → fallback contentRect', () => {
  const p = { contentRect: { w: 2480, h: 3508 } }
  const r = safeRectOf(p)
  assert.deepEqual(r, { x: 0, y: 0, w: 2480, h: 3508 })
})

test('safeRectOf: null → null', () => {
  assert.equal(safeRectOf(null), null)
  assert.equal(safeRectOf(undefined), null)
  assert.equal(safeRectOf({}), null)
})

test('safeRectOf: collapsed w/h → null', () => {
  assert.equal(safeRectOf({ usableRect: { x: 0, y: 0, w: 0, h: 100 } }), null)
  assert.equal(safeRectOf({ usableRect: { x: 0, y: 0, w: 100, h: 0 } }), null)
})

// ════════════════════════════════════════════
// computeTicketSlots
// ════════════════════════════════════════════
test('computeTicketSlots: 2 tickets on A4 portrait → 2 equal bands', () => {
  const paperLayout = makePaper({ usableRect: { x: 0, y: 0, w: 2480, h: 3508 } })
  const slots = computeTicketSlots(paperLayout, 2)
  assert.equal(slots.length, 2)
  // 等高
  assert.ok(Math.abs(slots[0].height - slots[1].height) < 1e-9, 'slots equal height')
  // 覆盖整页
  assert.equal(slots[0].x, 0)
  assert.equal(slots[0].y, 0)
  assert.equal(slots[0].width, 2480)
  assert.equal(slots[1].x, 0)
  assert.equal(slots[1].y, 3508 / 2)
  // 末位精确收口
  assert.equal(slots[1].y + slots[1].height, 3508)
  assert.equal(slots[0].index, 0)
  assert.equal(slots[1].index, 1)
})

test('computeTicketSlots: 3 tickets → floor+remainder, last exact bottom', () => {
  const paperLayout = makePaper({ usableRect: { x: 0, y: 0, w: 2480, h: 3508 } })
  const slots = computeTicketSlots(paperLayout, 3)
  assert.equal(slots.length, 3)
  // 前两个 slot = baseH (Math.floor), 最后一个吃余数
  assert.equal(slots[0].height, slots[1].height, 'slot0 == slot1 height (baseH)')
  assert.ok(slots[2].height >= slots[0].height, 'slot2 height >= baseH (eats remainder)')
  // sum === usable.h（无累积误差）
  const sumH = slots[0].height + slots[1].height + slots[2].height
  assert.equal(sumH, 3508, 'sum(slots.height) === usable.h')
  // 末位不出界
  assert.ok(slots[2].y + slots[2].height <= 3508 + 1e-6, 'last slot within bounds')
  assert.equal(slots[0].width, 2480)
})

test('computeTicketSlots: count=1 → single slot == usable', () => {
  const paperLayout = makePaper({ usableRect: { x: 0, y: 0, w: 2480, h: 3508 } })
  const slots = computeTicketSlots(paperLayout, 1)
  assert.equal(slots.length, 1)
  assert.deepEqual(slots[0], { x: 0, y: 0, width: 2480, height: 3508, index: 0 })
})

test('computeTicketSlots: count=0 / negative → clamped to 1', () => {
  const paperLayout = makePaper({ usableRect: { x: 0, y: 0, w: 2480, h: 3508 } })
  assert.equal(computeTicketSlots(paperLayout, 0).length, 1)
  assert.equal(computeTicketSlots(paperLayout, -2).length, 1)
  assert.equal(computeTicketSlots(paperLayout, NaN).length, 1)
})

test('computeTicketSlots: invalid paperLayout → []', () => {
  assert.deepEqual(computeTicketSlots(null, 2), [])
  assert.deepEqual(computeTicketSlots(undefined, 2), [])
  assert.deepEqual(computeTicketSlots({}, 2), [])
})

test('computeTicketSlots: with page margins → slots inset from clip', () => {
  const paperLayout = makePaper({ usableRect: { x: 100, y: 80, w: 2280, h: 3348 } })
  const slots = computeTicketSlots(paperLayout, 2)
  assert.equal(slots.length, 2)
  assert.equal(slots[0].x, 100)
  assert.equal(slots[0].y, 80)
  assert.equal(slots[0].width, 2280)
  assert.ok(Math.abs(slots[1].y + slots[1].height - (80 + 3348)) < 1e-6)
})

// ════════════════════════════════════════════
// slotSafeInset
// ════════════════════════════════════════════
test('computeTicketSlots: with slotSafeInset → each slot inset uniformly', () => {
  // slotSafeInset ≈ 5mm at 300dpi = 59px
  const paperLayout = makePaper({ usableRect: { x: 100, y: 80, w: 2280, h: 3348 } })
  paperLayout.slotSafeInset = 59
  const slots = computeTicketSlots(paperLayout, 2)
  assert.equal(slots.length, 2)
  // 每个 slot 内缩 inset
  assert.equal(slots[0].x, 100 + 59, 'slot0.x inset')
  assert.equal(slots[0].y, 80 + 59, 'slot0.y inset')
  assert.equal(slots[0].width, 2280 - 2 * 59, 'slot0.width inset')
  assert.equal(slots[1].x, 100 + 59, 'slot1.x inset')
  // 高度保持 floor + remainder
  const baseH = Math.floor(3348 / 2)
  assert.equal(slots[0].height, baseH - 2 * 59, 'slot0.height = baseH - 2*inset')
  // 末 slot 收口到底边
  assert.ok(Math.abs(slots[1].y + slots[1].height + 59 - (80 + 3348)) < 1e-6, 'last slot +inset bottom === usable bottom')
})

// ════════════════════════════════════════════
// fitIntoSlot
// ════════════════════════════════════════════
test('fitIntoSlot: slot placement === createPlacement (single source)', () => {
  const slotRect = { x: 0, y: 0, width: 1240, height: 1754 }
  const result = fitIntoSlot({ slotRect, sourceWidth: 1240, sourceHeight: 1754, rotation: 0 })
  const expected = createPlacement({ contentRect: { x: 0, y: 0, width: 1240, height: 1754 }, sourceWidth: 1240, sourceHeight: 1754, rotation: 0 })
  assert.deepEqual(result, expected)
})

test('fitIntoSlot: degenerate slot → scale=0', () => {
  const r = fitIntoSlot({ slotRect: { x: 0, y: 0, width: 0, height: 100 }, sourceWidth: 1240, sourceHeight: 1754 })
  assert.equal(r.scale, 0)
})

// ════════════════════════════════════════════
// slotToLandscape
// ════════════════════════════════════════════
test('slotToLandscape: portrait slot → landscape coords (axis swap)', () => {
  // 假设自然可用区原点 (mL=100,mT=80)，内尺寸 2280×3348。
  // portrait 全域票位 (x=100,y=80,w=1140,h=3348) → landscape 票位应为
  //   x = 100 + (80-80)=100, y = 80+(100-100)=80, width=3348, height=1140
  // 验证：portrait x=100 映射到 landscape y=mT+(x-mL)=80+(100-100)=80 (y)
  //        portrait y=80 映射到 landscape x=mL+(y-mT)=100+(80-80)=100 (x)
  //        w=1140→landscape height=1140, h=3348→landscape width=3348
  const result = slotToLandscape({ x: 100, y: 80, width: 1140, height: 3348 }, { mL: 100, mT: 80 })
  assert.deepEqual(result, { x: 100, y: 80, width: 3348, height: 1140 })
})

test('slotToLandscape: non-zero slot offset in natural space', () => {
  // portrait slot at (x=200,y=180,w=1000,h=1800) with margins (mL=100,mT=80)
  // landscape x = mL+(y-mT)=100+(180-80)=200, y=mT+(x-mL)=80+(200-100)=180
  // width=1800, height=1000
  const result = slotToLandscape({ x: 200, y: 180, width: 1000, height: 1800 }, { mL: 100, mT: 80 })
  assert.deepEqual(result, { x: 200, y: 180, width: 1800, height: 1000 })
})
