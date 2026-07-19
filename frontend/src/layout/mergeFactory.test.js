/**
 * mergeFactory.test.js — C3-1 contract 护栏（node-safe，不依赖 config / createLayout）
 *
 * 锁定 buildMergeRenderCommands 对「具体输入」产出的精确 placement / rotatedBounds / clip，
 * 并锁定几何 ownership：mergeFactory 必须 fit 进 slot.contentRect，绝不用裸 slot.x/y/w/h。
 *
 * 不变量：mergeFactory 是 Export 的几何来源，必须与 Preview(live _buildComposeCommand) 共用
 * 同一套 slot.contentRect → createPlacement → RenderCommand 契约，否则 Preview≠Export。
 *
 * 手工构造 layout（makeLayout）而非走 createLayout，避免经 layout.js → config.js 拉入
 * import.meta.env（纯 node 不可跑）；与 C2 的 composeSlotRasterContract 测试同思路。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildMergeRenderCommands } from './mergeFactory.js'

// ── Oracle：冻结「fit 进 contentRect」的居中数学（与 createPlacement 逐字同源）──
function oracleSlot(rect, contentW, contentH, rotate) {
  const isRotated90 = rotate === 90 || rotate === 270
  const effectiveW = isRotated90 ? contentH : contentW
  const effectiveH = isRotated90 ? contentW : contentH
  const scale = Math.min(rect.width / effectiveW, rect.height / effectiveH)
  const rotatedBounds = isRotated90
    ? { width: contentH, height: contentW }
    : { width: contentW, height: contentH }
  const drawW = rotatedBounds.width * scale
  const drawH = rotatedBounds.height * scale
  const offsetX = rect.x + (rect.width - drawW) / 2
  const offsetY = rect.y + (rect.height - drawH) / 2
  return { scale, rotatedBounds, offsetX, offsetY }
}

// 用手工 slot 组装最小 layout（不依赖 config.js / createLayout，保证 node 可跑）
function makeLayout(slots, pageW = 2000, pageH = 2000) {
  return {
    page: { width: pageW, height: pageH },
    area: { x: 0, y: 0, width: pageW, height: pageH },
    slots,
  }
}

function buildContentMeta(slots, dims) {
  const m = new Map()
  for (const slot of slots) {
    const d = dims[slot.itemId]
    if (d) m.set(slot.itemId, { width: d[0], height: d[1] })
  }
  return m
}

function assertClose(a, b, msg, eps = 1e-6) {
  assert.ok(Math.abs(a - b) <= eps, `${msg}: 期望 ${b}, 得到 ${a}`)
}

// ── Golden：merge2 vertical，0° ──
test('merge2 vertical: 0° fit 进 contentRect，clip===slot.contentRect', () => {
  const slots = [
    { itemId: 'a', x: 0, y: 0, width: 1000, height: 500, contentRect: { x: 20, y: 20, width: 960, height: 460 } },
    { itemId: 'b', x: 0, y: 500, width: 1000, height: 500, contentRect: { x: 20, y: 520, width: 960, height: 460 } },
  ]
  const layout = makeLayout(slots)
  const dims = { a: [600, 800], b: [600, 800] }
  const cmds = buildMergeRenderCommands(layout, buildContentMeta(slots, dims), { a: 0, b: 0 }, { isLandscape: false })
  assert.equal(cmds.length, 2)
  for (let i = 0; i < 2; i++) {
    const cmd = cmds[i]
    const slot = slots[i]
    const [w, h] = dims[slot.itemId]
    const exp = oracleSlot(slot.contentRect, w, h, 0)
    assert.deepEqual(cmd.rotatedBounds, exp.rotatedBounds, `${i}: rotatedBounds`)
    assertClose(cmd.placement.scale, exp.scale, `${i}.scale`)
    assertClose(cmd.placement.offsetX, exp.offsetX, `${i}.offsetX`)
    assertClose(cmd.placement.offsetY, exp.offsetY, `${i}.offsetY`)
    assert.equal(cmd.contentRotation, 0)
    assert.equal(cmd.paperLandscape, false)
    // C3-1 ownership 锁：clip 必须 === slot.contentRect（非裸 slot）
    assert.deepEqual(cmd.clip, slot.contentRect, `${i}: clip 必须 === slot.contentRect`)
  }
})

// ── Golden：90° 交换 rotatedBounds ──
test('merge2: 90° 必须交换 rotatedBounds 且 fit 重算', () => {
  const slots = [
    { itemId: 'a', x: 0, y: 0, width: 1000, height: 500, contentRect: { x: 20, y: 20, width: 960, height: 460 } },
  ]
  const layout = makeLayout(slots)
  const cmds = buildMergeRenderCommands(layout, buildContentMeta(slots, { a: [600, 800] }), { a: 90 }, { isLandscape: false })
  assert.equal(cmds.length, 1)
  const cmd = cmds[0]
  const exp = oracleSlot(slots[0].contentRect, 600, 800, 90)
  assert.equal(cmd.rotatedBounds.width, 800, 'rotatedBounds 必须交换 w/h')
  assert.equal(cmd.rotatedBounds.height, 600)
  assertClose(cmd.placement.scale, exp.scale, 'scale')
  assertClose(cmd.placement.offsetX, exp.offsetX, 'offsetX')
  assertClose(cmd.placement.offsetY, exp.offsetY, 'offsetY')
  assert.equal(cmd.contentRotation, 90)
  assert.deepEqual(cmd.clip, slots[0].contentRect, 'clip === contentRect')
})

// ── Golden：merge4 grid 横向，混合旋转 ──
test('merge4 grid landscape: 多 item 混合旋转 + paperLandscape 派生', () => {
  const slots = [
    { itemId: 'a', x: 0, y: 0, width: 1000, height: 1000, contentRect: { x: 20, y: 20, width: 960, height: 960 } },
    { itemId: 'b', x: 1000, y: 0, width: 1000, height: 1000, contentRect: { x: 1020, y: 20, width: 960, height: 960 } },
    { itemId: 'c', x: 0, y: 1000, width: 1000, height: 1000, contentRect: { x: 20, y: 1020, width: 960, height: 960 } },
    { itemId: 'd', x: 1000, y: 1000, width: 1000, height: 1000, contentRect: { x: 1020, y: 1020, width: 960, height: 960 } },
  ]
  const layout = makeLayout(slots, 2000, 2000)
  const dims = { a: [600, 800], b: [400, 400], c: [800, 600], d: [500, 900] }
  const rotations = { a: 0, b: 90, c: 180, d: 270 }
  const cmds = buildMergeRenderCommands(layout, buildContentMeta(slots, dims), rotations, { isLandscape: true })
  assert.equal(cmds.length, 4)
  assert.equal(cmds[0].paperLandscape, true, 'paperLandscape 应由 isLandscape 派生')
  for (let i = 0; i < 4; i++) {
    const cmd = cmds[i]
    const slot = slots[i]
    const [w, h] = dims[slot.itemId]
    const exp = oracleSlot(slot.contentRect, w, h, rotations[slot.itemId])
    assert.deepEqual(cmd.rotatedBounds, exp.rotatedBounds, `${slot.itemId}: rotatedBounds`)
    assertClose(cmd.placement.scale, exp.scale, `${slot.itemId}.scale`)
    assertClose(cmd.placement.offsetX, exp.offsetX, `${slot.itemId}.offsetX`)
    assertClose(cmd.placement.offsetY, exp.offsetY, `${slot.itemId}.offsetY`)
    assert.equal(cmd.contentRotation, rotations[slot.itemId])
    // C3-1 ownership 锁：clip 必须 === slot.contentRect
    assert.deepEqual(cmd.clip, slot.contentRect, `${slot.itemId}: clip === contentRect`)
  }
})

// ── 缺失内容尺寸 → 跳过 ──
test('缺失内容尺寸的 slot 被跳过（命令数 < slot 数）', () => {
  const slots = [
    { itemId: 'a', x: 0, y: 0, width: 1000, height: 500, contentRect: { x: 20, y: 20, width: 960, height: 460 } },
    { itemId: 'b', x: 0, y: 500, width: 1000, height: 500, contentRect: { x: 20, y: 520, width: 960, height: 460 } },
  ]
  const layout = makeLayout(slots)
  const cmds = buildMergeRenderCommands(layout, new Map(), {}, { isLandscape: false })
  assert.equal(cmds.length, 0, '无内容 → 无命令')
})

// ── 空 layout → 空数组 ──
test('空 layout → 空数组', () => {
  assert.deepEqual(buildMergeRenderCommands(null, new Map(), {}, {}), [])
  assert.deepEqual(buildMergeRenderCommands({ page: {}, slots: [] }, new Map(), {}, {}), [])
})

// ── C3-1 ownership 锁（用户指定形态：slot.x/y/w/h 变动不影响几何）──
test('C3-1 ownership lock: clip===slot.contentRect 且不受 slot.x/y/w/h 变动影响', () => {
  const slot = {
    itemId: 'a',
    x: 0, y: 0, width: 1000, height: 1000,
    contentRect: { x: 50, y: 50, width: 900, height: 900 },
  }
  const layout = makeLayout([slot])
  const contentMeta = new Map([['a', { width: 600, height: 800 }]])
  const rotations = { a: 0 }

  const cmds = buildMergeRenderCommands(layout, contentMeta, rotations, { isLandscape: false })
  assert.equal(cmds.length, 1)
  // ① clip 必须 === slot.contentRect（ownership 锁）
  assert.deepEqual(cmds[0].clip, slot.contentRect, 'clip 必须 === slot.contentRect（非裸 slot）')

  // ② 有人偷偷改 slot.x/y（模拟 slot.x + margin 重算尝试）：contentRect 不变 → clip 与几何不变
  slot.x = 999
  slot.y = 888
  const cmds2 = buildMergeRenderCommands(layout, contentMeta, rotations, { isLandscape: false })
  assert.deepEqual(cmds2[0].clip, slot.contentRect, 'slot.x/y 变动后 clip 仍 === slot.contentRect')
  assertClose(cmds2[0].placement.offsetX, cmds[0].placement.offsetX, 'offsetX 不受 slot.x 影响（来自 contentRect.x）')
  assertClose(cmds2[0].placement.offsetY, cmds[0].placement.offsetY, 'offsetY 不受 slot.y 影响（来自 contentRect.y）')
})
