/**
 * renderLayoutFactorySlot.test.js — buildRenderCommand(slotRect) 验收
 *
 * 运行方式：
 *   node --loader ./env-shim.loader.mjs --test src/layout/renderLayoutFactorySlot.test.js
 * （config.js 依赖 import.meta.env，需 shim；验证后删除 shim，不进 VCS）
 *
 * 验收范围（4 组）：
 *   A. A4 两票：无裁切 + 居中 + 边距一致
 *   B. A4 三票：等高 + 末位收口
 *   C. 横票（宽）：scale 自动缩小 (<1)，无裁切
 *   D. 竖票（正常）：无裁切、居中
 *   附加：单票向后兼容（slotRect=null ≡ slotRect=fullUsable）
 *   附加：横向纸张 + 票位（slotToLandscape 轴交换锁）
 *
 * 所有 buildRenderCommand(paperLayout, docState, slotRect) 的 placement
 * 必须 == createPlacement({contentRect: targetRect, ...})，证明单源。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePaperLayout } from '../previewState.js'
import { buildRenderCommand } from './RenderLayoutFactory.js'
import { computeTicketSlots, slotToLandscape } from './SlotLayout.js'
import { createPlacement } from '../compose/composePlacement.js'

// ── 公差 ──
const EPS = 1e-6

/**
 * 单源锁断言：buildRenderCommand(slot) 的 placement === createPlacement(slot)。
 * @param {object} cmd     - buildRenderCommand 输出
 * @param {{x:number,y:number,width:number,height:number}} targetRect - fit 输入（已 landscape-aware）
 * @param {{w:number,h:number}} pageSize
 * @param {number} rotation
 */
function assertSingleSourceLock(cmd, targetRect, pageSize, rotation) {
  const expected = createPlacement({
    contentRect: targetRect,
    sourceWidth: pageSize.w,
    sourceHeight: pageSize.h,
    rotation,
  })
  assert.deepEqual(
    cmd.placement,
    { scale: expected.scale, offsetX: expected.offsetX, offsetY: expected.offsetY },
    `single-source lock: placement must === createPlacement(slot)\n` +
    `  got:      ${JSON.stringify(cmd.placement)}\n` +
    `  expected: ${JSON.stringify({ scale: expected.scale, offsetX: expected.offsetX, offsetY: expected.offsetY })}`
  )
}

/**
 * 无裁切 + 居中断言（人可读，独立于单源锁）。
 */
function assertFitNoClip(cmd, targetRect, label) {
  const { scale, offsetX, offsetY } = cmd.placement
  const { width: rbW, height: rbH } = cmd.rotatedBounds
  const drawW = rbW * scale
  const drawH = rbH * scale

  // 无裁切
  assert.ok(drawW <= targetRect.width + EPS, `${label}: no horizontal clip (drawW=${drawW} ≤ slotW=${targetRect.width})`)
  assert.ok(drawH <= targetRect.height + EPS, `${label}: no vertical clip (drawH=${drawH} ≤ slotH=${targetRect.height})`)

  // 居中
  const expX = targetRect.x + (targetRect.width - drawW) / 2
  const expY = targetRect.y + (targetRect.height - drawH) / 2
  assert.ok(Math.abs(offsetX - expX) < EPS, `${label}: centered X (offset=${offsetX} ≈ exp=${expX})`)
  assert.ok(Math.abs(offsetY - expY) < EPS, `${label}: centered Y (offset=${offsetY} ≈ exp=${expY})`)
}

// ════════════════════════════════════════════
// Group A: A4 two tickets
// ════════════════════════════════════════════
test('A4 two tickets: slot geometry (inset, floor+remainder)', () => {
  const paperLayout = computePaperLayout({ paperSize: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } })
  const slots = computeTicketSlots(paperLayout, 2)
  assert.equal(slots.length, 2)
  const u = paperLayout.usableRect
  const inset = paperLayout.slotSafeInset || 0
  const baseH = Math.floor(u.h / 2)

  // 内缩 inset
  assert.equal(slots[0].x, u.x + inset, 'slot0.x = usable.x + inset')
  assert.equal(slots[0].y, u.y + inset, 'slot0.y = usable.y + inset')
  assert.equal(slots[0].width, u.w - 2 * inset, 'slot0.width = usable.w - 2*inset')
  // height = baseH - 2*inset
  assert.equal(slots[0].height, baseH - 2 * inset, 'slot0.height = baseH - 2*inset')
  // slot1 位置
  assert.equal(slots[1].x, u.x + inset)
  assert.equal(slots[1].y, u.y + baseH + inset, 'slot1.y = usable.y + baseH + inset')
  // 末位收口：last content bottom = usable.h - inset
  assert.ok(Math.abs(slots[1].y + slots[1].height - (u.y + u.h - inset)) < EPS,
    'last slot content bottom == usable.h - inset')
  // 两 slot 间 gap = 2*inset（raw 边界处留安全空隙）
  assert.equal(slots[1].y - (slots[0].y + slots[0].height), 2 * inset, 'gap between slots = 2*inset')
})

test('A4 two tickets: invoice A in slot0 — no clip, centered', () => {
  const paperLayout = computePaperLayout({ paperSize: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } })
  const slots = computeTicketSlots(paperLayout, 2)
  const pageSize = { w: 1240, h: 1754 } // 标准竖向发票
  const cmd = buildRenderCommand(paperLayout, { pageSize, pageOrientation: 'portrait' }, slots[0])

  assert.ok(cmd.placement.scale > 0, 'scale > 0')
  // targetRect for slot0 = slots[0] (portrait, no landscape swap)
  assertSingleSourceLock(cmd, slots[0], pageSize, 0)
  assertFitNoClip(cmd, slots[0], 'A slot0')
})

test('A4 two tickets: invoice B in slot1 — no clip, centered', () => {
  const paperLayout = computePaperLayout({ paperSize: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } })
  const slots = computeTicketSlots(paperLayout, 2)
  const pageSize = { w: 1240, h: 1754 }
  const cmd = buildRenderCommand(paperLayout, { pageSize, pageOrientation: 'portrait' }, slots[1])

  assert.ok(cmd.placement.scale > 0, 'scale > 0')
  assertSingleSourceLock(cmd, slots[1], pageSize, 0)
  assertFitNoClip(cmd, slots[1], 'A slot1')
})

test('A4 two tickets: margins consistent (both slots share x+width)', () => {
  const paperLayout = computePaperLayout({ paperSize: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } })
  const slots = computeTicketSlots(paperLayout, 2)
  assert.equal(slots[0].x, slots[1].x, 'same x origin')
  assert.equal(slots[0].width, slots[1].width, 'same width')
})

// ════════════════════════════════════════════
// Group B: A4 three tickets
// ════════════════════════════════════════════
test('A4 three tickets: slot geometry (≈equal height, no overflow)', () => {
  const paperLayout = computePaperLayout({ paperSize: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } })
  const slots = computeTicketSlots(paperLayout, 3)
  assert.equal(slots.length, 3)

  const h0 = slots[0].height; const h1 = slots[1].height; const h2 = slots[2].height
  assert.ok(Math.abs(h0 - h1) < EPS, 'slot0 == slot1 height')
  assert.ok(Math.abs(h1 - h2) < EPS || h2 > h1, 'slot1 ≈ slot2 height (or last eats remainder)')

  // 末位不越界
  const u = paperLayout.usableRect
  assert.ok(slots[2].y + slots[2].height <= u.y + u.h + EPS, 'last slot no overflow')
  // 覆盖全 usable
  assert.ok(Math.abs(slots[0].y + slots[2].y + slots[2].height - (u.y + u.h)) < EPS * 10, 'slots sum equals usable height')
})

test('A4 three tickets: ticket in each slot — no clip, centered', () => {
  const paperLayout = computePaperLayout({ paperSize: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } })
  const slots = computeTicketSlots(paperLayout, 3)
  const pageSize = { w: 1240, h: 1754 }
  for (let i = 0; i < 3; i++) {
    const cmd = buildRenderCommand(paperLayout, { pageSize, pageOrientation: 'portrait' }, slots[i])
    assert.ok(cmd.placement.scale > 0, `slot${i} scale > 0`)
    assertSingleSourceLock(cmd, slots[i], pageSize, 0)
    assertFitNoClip(cmd, slots[i], `B slot${i}`)
  }
})

// ════════════════════════════════════════════
// Group C: Wide ticket (landscape, wider than slot)
// ════════════════════════════════════════════
test('wide ticket in portrait slot → scale auto-shrinks (<1)', () => {
  const paperLayout = computePaperLayout({ paperSize: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } })
  const slots = computeTicketSlots(paperLayout, 2)
  const wideSize = { w: 3000, h: 1200 } // 明显宽于 slot (slot.w≈2480)
  const cmd = buildRenderCommand(paperLayout, { pageSize: wideSize, pageOrientation: 'portrait' }, slots[0])

  // 自动缩小
  assert.ok(cmd.placement.scale < 1 - EPS, `wide ticket scale<1 (got ${cmd.placement.scale})`)
  assertFitNoClip(cmd, slots[0], 'C wide')
})

// ════════════════════════════════════════════
// Group D: Tall ticket (portrait, normal)
// ════════════════════════════════════════════
test('tall ticket in portrait slot — no clip, centered, scale>0', () => {
  const paperLayout = computePaperLayout({ paperSize: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } })
  const slots = computeTicketSlots(paperLayout, 2)
  const tallSize = { w: 1240, h: 1754 }
  const cmd = buildRenderCommand(paperLayout, { pageSize: tallSize, pageOrientation: 'portrait' }, slots[1])

  assert.ok(cmd.placement.scale > 0, 'scale > 0')
  assertFitNoClip(cmd, slots[1], 'D tall')
  assertSingleSourceLock(cmd, slots[1], tallSize, 0)
})

// ════════════════════════════════════════════
// Backward compat: slotRect=null ≡ slotRect=fullUsable
// ════════════════════════════════════════════
test('backward compat: buildRenderCommand(null) == buildRenderCommand(fullSlot)', () => {
  const paperLayout = computePaperLayout({ paperSize: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } })
  const pageSize = { w: 1240, h: 1754 }
  const fullSlot = computeTicketSlots(paperLayout, 1)[0] // = 整页 usable

  const cmdNoSlot = buildRenderCommand(paperLayout, { pageSize, pageOrientation: 'portrait' })
  const cmdSlot = buildRenderCommand(paperLayout, { pageSize, pageOrientation: 'portrait' }, fullSlot)

  // placement、rotatedBounds、usableRect 全等
  assert.deepEqual(cmdNoSlot.placement, cmdSlot.placement, 'placement identical')
  assert.deepEqual(cmdNoSlot.rotatedBounds, cmdSlot.rotatedBounds, 'rotatedBounds identical')
  assert.deepEqual(cmdNoSlot.usableRect, cmdSlot.usableRect, 'usableRect identical')
  assert.deepEqual(cmdNoSlot.clip, cmdSlot.clip, 'clip identical')
})

// ════════════════════════════════════════════
// Landscape paper + slot (slotToLandscape integration)
// ════════════════════════════════════════════
test('landscape paper + portrait slot → axis-swapped placement, no clip', () => {
  const paperLayout = computePaperLayout({ paperSize: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } })
  const slots = computeTicketSlots(paperLayout, 2) // portrait 自然空间
  const pageSize = { w: 1240, h: 1754 }

  // paperOrientation='landscape' → paperLandscape=true → slot 需轴交换
  const cmd = buildRenderCommand(paperLayout, { pageSize, pageOrientation: 'landscape' }, slots[0])

  // 期望 targetRect：自然票位 slots[0] → landscape 空间
  const { x: mL, y: mT } = paperLayout.usableRect
  const targetRect = slotToLandscape(slots[0], { mL, mT })

  assert.ok(cmd.placement.scale > 0, 'landscape slot scale > 0')
  assertSingleSourceLock(cmd, targetRect, pageSize, 0)
  assertFitNoClip(cmd, targetRect, 'landscape slot')
})
