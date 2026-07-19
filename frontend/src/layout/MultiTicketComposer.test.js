/**
 * MultiTicketComposer.test.js — 回归测试（接线后保证票数→slot→command 映射正确）
 *
 * 运行方式：
 *   node --loader ./env-shim.loader.mjs --test src/layout/MultiTicketComposer.test.js
 *
 * 覆盖：
 *   1. 一票 → 一个 command，clip===usableRect
 *   2. 两票 → 两个 command，y 递增，≈等分
 *   3. 三票 → 末位 slot bottom === usable bottom（无累积误差）
 *   4. 横票（rotation=90）→ rotatedBounds 宽高交换
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePaperLayout } from '../previewState.js'
import { compose } from './MultiTicketComposer.js'

const EPS = 1e-6

/**
 * 构造标准 A4 0 边距 paperLayout
 */
function makePaperLayout() {
  return computePaperLayout({ paperSize: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } })
}

/**
 * 构造 documentState
 */
function makeDoc({ w = 1240, h = 1754, rotation = 0, pageOrientation } = {}) {
  return { pageSize: { w, h }, pageOrientation: pageOrientation || (w >= h ? 'landscape' : 'portrait'), rotation }
}

// ── 通用断言 ──
function assertNoClip(cmd, slot, label) {
  const { scale } = cmd.placement
  const { width: rbW, height: rbH } = cmd.rotatedBounds
  const drawW = rbW * scale
  const drawH = rbH * scale
  assert.ok(drawW <= slot.width + EPS, `${label}: no horizontal clip (drawW=${drawW} ≤ slotW=${slot.width})`)
  assert.ok(drawH <= slot.height + EPS, `${label}: no vertical clip (drawH=${drawH} ≤ slotH=${slot.height})`)
}

// ═══════════════════════════════════════════════
// Case 1: 一票
// ═══════════════════════════════════════════════
test('P0 Case 1: 一票 → single command, clip === usableRect', () => {
  const paperLayout = makePaperLayout()
  const documents = [makeDoc({ w: 1240, h: 1754 })]
  const result = compose({ paperLayout, documents })

  assert.equal(result.length, 1, 'commands.length === 1')
  const { renderCommand: cmd, documentState } = result[0]
  assert.ok(cmd.placement.scale > 0, 'scale > 0')

  const u = paperLayout.usableRect
  assert.equal(cmd.clip.x, u.x, 'clip.x === usable.x')
  assert.equal(cmd.clip.y, u.y, 'clip.y === usable.y')
  assert.equal(cmd.clip.width, u.w, 'clip.width === usable.w')
  assert.equal(cmd.clip.height, u.h, 'clip.height === usable.h')

  // usableRect (返回的是 {x,y,w,h})
  assert.equal(cmd.usableRect.x, u.x)
  assert.equal(cmd.usableRect.y, u.y)
  assert.equal(cmd.usableRect.w, u.w)
  assert.equal(cmd.usableRect.h, u.h)

  // 无裁切
  assertNoClip(cmd, { x: u.x, y: u.y, width: u.w, height: u.h }, 'single ticket')
})

// ═══════════════════════════════════════════════
// Case 2: 两票 A4
// ═══════════════════════════════════════════════
test('P0 Case 2: 两票 → two commands, y 递增, ≈等分', () => {
  const paperLayout = makePaperLayout()
  const documents = [makeDoc(), makeDoc({ w: 1240, h: 1754 })] // 两竖向发票
  const result = compose({ paperLayout, documents })

  assert.equal(result.length, 2, 'commands.length === 2')

  const [r0, r1] = result
  const { clip: clip0 } = r0.renderCommand
  const { clip: clip1 } = r1.renderCommand

  // 按 y 排序（下票 clip.y 更大）
  assert.ok(clip0.y < clip1.y, 'cmd[0].clip.y < cmd[1].clip.y')

  const u = paperLayout.usableRect
  // ≈ 等分
  const halfH = u.h / 2
  assert.ok(Math.abs(clip0.height - halfH) < EPS, 'cmd[0].clip.height ≈ usable.h / 2')
  assert.ok(Math.abs(clip1.height - halfH) < EPS, 'cmd[1].clip.height ≈ usable.h / 2 (or remainder)')

  // 两票都不超 margin
  assertNoClip(r0.renderCommand, clip0, 'ticket0')
  assertNoClip(r1.renderCommand, clip1, 'ticket1')

  // slot x 一致（左对齐）
  assert.equal(clip0.x, u.x)
  assert.equal(clip1.x, u.x)
})

// ═══════════════════════════════════════════════
// Case 3: 三票
// ═══════════════════════════════════════════════
test('P0 Case 3: 三票 → last slot bottom === usableRect.bottom', () => {
  const paperLayout = makePaperLayout()
  const documents = [makeDoc(), makeDoc(), makeDoc({ w: 1240, h: 1754 })]
  const result = compose({ paperLayout, documents })

  assert.equal(result.length, 3, 'commands.length === 3')

  const u = paperLayout.usableRect
  const last = result[2].renderCommand.clip

  // 最后一个 slot 不出界
  assert.ok(last.y + last.height <= u.y + u.h + EPS,
    `last slot bottom (${last.y + last.height}) ≈ usable bottom (${u.y + u.h})`)

  // 等于（末位吃余应为精确覆盖）
  assert.ok(Math.abs(last.y + last.height - (u.y + u.h)) < EPS,
    `last slot exactly ends at usable bottom`)

  // 所有票无裁切
  for (let i = 0; i < 3; i++) {
    assertNoClip(result[i].renderCommand, result[i].renderCommand.clip, `ticket${i}`)
  }
})

// ═══════════════════════════════════════════════
// Case 4: 横票（rotation=90）
// ═══════════════════════════════════════════════
test('P0 Case 4: 横票 rotation=90 → rotatedBounds 宽高交换', () => {
  const paperLayout = makePaperLayout()
  // 竖向页面上旋转 90° = 横向发票：内容原始 1240x1754，旋转 90° 后有效宽高互换
  const documents = [makeDoc({ w: 1240, h: 1754, rotation: 90 })]
  const result = compose({ paperLayout, documents })

  assert.equal(result.length, 1, 'commands.length === 1')
  const { renderCommand: cmd } = result[0]

  assert.equal(cmd.contentRotation, 90, 'contentRotation === 90')

  // rotatedBounds 在 90° 时已经交换：width === 1754, height === 1240
  assert.equal(cmd.rotatedBounds.width, 1754, 'rotatedBounds.width === sourceHeight (swapped)')
  assert.equal(cmd.rotatedBounds.height, 1240, 'rotatedBounds.height === sourceWidth (swapped)')

  // fit 后不裁切
  const u = paperLayout.usableRect
  assertNoClip(cmd, { x: u.x, y: u.y, width: u.w, height: u.h }, 'rotated 90')

  // contentRotation 存在使 builder/executor 消费旋转
  assert.equal(cmd.contentRotation, 90)
})

// ═══════════════════════════════════════════════
// Edge: 空文档 → 空数组
// ═══════════════════════════════════════════════
test('P0 Edge: 空文档数组 → 空', () => {
  const paperLayout = makePaperLayout()
  assert.deepEqual(compose({ paperLayout, documents: [] }), [])
  assert.deepEqual(compose({ paperLayout, documents: null }), [])
  assert.deepEqual(compose({ paperLayout, documents: undefined }), [])
})

// ═══════════════════════════════════════════════
// Edge: 非法 paperLayout → 空
// ═══════════════════════════════════════════════
test('P0 Edge: 非法 paperLayout → 空', () => {
  assert.deepEqual(compose({ paperLayout: null, documents: [makeDoc()] }), [])
  assert.deepEqual(compose({ paperLayout: { usableRect: { x: 0, y: 0, w: 0, h: 0 } }, documents: [makeDoc()] }), [])
})
