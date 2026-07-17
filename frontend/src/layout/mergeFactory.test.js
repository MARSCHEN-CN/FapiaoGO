/**
 * mergeFactory.test.js — D1 收敛护栏（golden）
 *
 * 锁定 buildMergeRenderCommands 对「具体输入」产出的精确 placement / rotatedBounds，
 * 防止 Merge 路径回归到旧内联 fit/rotate/center 数学（renderers.js L1070-1093 / render.worker.js L34-52）。
 *
 * 不变量：Renderer / Worker 严禁重算 fit/居中；它们必须原样消费本 RenderCommand。
 * 因此本 golden 也是「Merge 布局唯一来源」的契约守门员。
 *
 * oracle 函数逐字复刻旧内联算法（fitMode='fit' 的 min 分支 + 90/270 宽高交换 + 居中偏移），
 * 与工厂输出逐一比对；任一漂移即测试失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createLayout } from '../layout.js'
import { buildMergeRenderCommands } from './mergeFactory.js'
import { validateRenderCommand } from './RenderLayoutFactory.js'

const DPI = 300

// ── Oracle：冻结旧 Merge 内联绘制数学（与 _renderDirect / worker 同源）──
function oracleSlot(slot, contentW, contentH, rotate) {
  const isRotated90 = rotate === 90 || rotate === 270
  const effectiveW = isRotated90 ? contentH : contentW
  const effectiveH = isRotated90 ? contentW : contentH
  const scale = Math.min(slot.width / effectiveW, slot.height / effectiveH)
  const rotatedBounds = isRotated90
    ? { width: contentH, height: contentW }
    : { width: contentW, height: contentH }
  const drawW = rotatedBounds.width * scale
  const drawH = rotatedBounds.height * scale
  const offsetX = slot.x + (slot.width - drawW) / 2
  const offsetY = slot.y + (slot.height - drawH) / 2
  return { scale, rotatedBounds, offsetX, offsetY }
}

function buildContentMeta(layout, dims) {
  const m = new Map()
  for (const slot of layout.slots) {
    if (!slot) continue
    const d = dims[slot.itemId]
    if (d) m.set(slot.itemId, { width: d[0], height: d[1] })
  }
  return m
}

function assertClose(a, b, msg, eps = 1e-6) {
  assert.ok(Math.abs(a - b) <= eps, `${msg}: 期望 ${b}, 得到 ${a}`)
}

test('merge2 vertical portrait: 0° 与非旋转包围盒', () => {
  const items = [{ id: 'a' }, { id: 'b' }]
  const layout = createLayout(items, 'A4', DPI, false, { slotCount: 2, strategy: 'vertical' })
  const dims = { a: [600, 800], b: [600, 800] }
  const contentMeta = buildContentMeta(layout, dims)
  const rotations = { a: 0, b: 0 }

  const cmds = buildMergeRenderCommands(layout, contentMeta, rotations, { isLandscape: false })
  assert.equal(cmds.length, 2, '两项都应产出命令')

  for (let i = 0; i < cmds.length; i++) {
    const cmd = cmds[i]
    const slot = layout.slots[i]
    const [w, h] = dims[slot.itemId]
    const exp = oracleSlot(slot, w, h, 0)

    assert.deepEqual(cmd.rotatedBounds, exp.rotatedBounds, `${i}: rotatedBounds 必须匹配非旋转包围盒`)
    assertClose(cmd.placement.scale, exp.scale, `${i}.scale`)
    assertClose(cmd.placement.offsetX, exp.offsetX, `${i}.offsetX`)
    assertClose(cmd.placement.offsetY, exp.offsetY, `${i}.offsetY`)
    assert.equal(cmd.contentRotation, 0)
    assert.equal(cmd.paperLandscape, false)
    // clip 必须等于 slot 矩形
    assert.deepEqual(cmd.clip, { x: slot.x, y: slot.y, width: slot.width, height: slot.height }, `${i}: clip = slot`)
    // 通过硬契约
    assert.doesNotThrow(() => validateRenderCommand(cmd))
  }
})

test('merge2 vertical: 90° 必须交换 rotatedBounds 且 fit 重算', () => {
  const items = [{ id: 'a' }]
  const layout = createLayout(items, 'A4', DPI, false, { slotCount: 2, strategy: 'vertical' })
  const dims = { a: [600, 800] }
  const contentMeta = buildContentMeta(layout, dims)
  const rotations = { a: 90 }

  const cmds = buildMergeRenderCommands(layout, contentMeta, rotations, { isLandscape: false })
  assert.equal(cmds.length, 1)
  const cmd = cmds[0]
  const slot = layout.slots[0]
  const exp = oracleSlot(slot, 600, 800, 90)

  assert.equal(cmd.rotatedBounds.width, 800, 'rotatedBounds 必须交换 w/h')
  assert.equal(cmd.rotatedBounds.height, 600)
  assertClose(cmd.placement.scale, exp.scale, 'scale')
  assertClose(cmd.placement.offsetX, exp.offsetX, 'offsetX')
  assertClose(cmd.placement.offsetY, exp.offsetY, 'offsetY')
  assert.equal(cmd.contentRotation, 90)
})

test('merge4 grid landscape: 多 item 混合旋转 + 纸张横向派生', () => {
  const ids = ['a', 'b', 'c', 'd']
  const items = ids.map((id) => ({ id }))
  const layout = createLayout(items, 'A4', DPI, true, {
    slotCount: 4, strategy: 'grid', gridCols: 2, gridRows: 2,
  })
  const dims = { a: [600, 800], b: [400, 400], c: [800, 600], d: [500, 900] }
  const contentMeta = buildContentMeta(layout, dims)
  const rotations = { a: 0, b: 90, c: 180, d: 270 }

  const cmds = buildMergeRenderCommands(layout, contentMeta, rotations, { isLandscape: true })
  assert.equal(cmds.length, 4)
  assert.equal(cmds[0].paperLandscape, true, 'paperLandscape 应由 isLandscape 派生')

  for (let i = 0; i < ids.length; i++) {
    const cmd = cmds[i]
    const slot = layout.slots[i]
    const [w, h] = dims[ids[i]]
    const exp = oracleSlot(slot, w, h, rotations[ids[i]])

    assert.deepEqual(cmd.rotatedBounds, exp.rotatedBounds, `${ids[i]}: rotatedBounds`)
    assertClose(cmd.placement.scale, exp.scale, `${ids[i]}.scale`)
    assertClose(cmd.placement.offsetX, exp.offsetX, `${ids[i]}.offsetX`)
    assertClose(cmd.placement.offsetY, exp.offsetY, `${ids[i]}.offsetY`)
    assert.equal(cmd.contentRotation, rotations[ids[i]])
    assert.doesNotThrow(() => validateRenderCommand(cmd))
  }
})

test('缺失内容尺寸的 slot 被跳过（命令数 < slot 数）', () => {
  const items = [{ id: 'a' }, { id: 'b' }]
  const layout = createLayout(items, 'A4', DPI, false, { slotCount: 2, strategy: 'vertical' })
  const contentMeta = new Map() // 全缺
  const cmds = buildMergeRenderCommands(layout, contentMeta, {}, { isLandscape: false })
  assert.equal(cmds.length, 0, '无内容 → 无命令')
})

test('空 layout → 空数组', () => {
  assert.deepEqual(buildMergeRenderCommands(null, new Map(), {}, {}), [])
  assert.deepEqual(buildMergeRenderCommands({ page: {}, slots: [] }, new Map(), {}, {}), [])
})
