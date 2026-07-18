/**
 * layout-compose-delegation.test.js — C1 step2 护栏
 *
 * 锁定 createLayout 已将 slot 分区 OWNERSHIP 移交给 ComposeSlotLayoutFactory
 * （逻辑 mm 来源）+ SlotDiscretizer（px 离散化 + 余数保留）。
 *
 * 重点：验收「委托后仍保旧 px characterization」——即与重构前 createLayout 的
 * px 输出字节级一致（Preview≡Print 不漂移）。特别是：
 *   - merge2 边界亚 mm 级无漂移（旧 1695/1695，非 mm-floor 的 1689/1701）
 *   - merge3 余数 1169/1169/1170（A4@300 整页高 3508px → floor(3508/3) 余数落在某 slot）
 *   - merge4 row-major 2×2 且铺满整页
 *
 * 纯 Node 可跑；不依赖 config / renderers / Electron。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLayout } from '../layout.js'

const DPI = 300

function heights(layout) {
  return layout.slots.map((s) => s.height)
}
function widths(layout) {
  return layout.slots.map((s) => s.width)
}

test('merge2 (A4 portrait, 5mm margin): 无亚 mm 漂移，contentRect 内缩', () => {
  const items = [{ id: 'a' }, { id: 'b' }]
  const layout = createLayout(items, 'A4', DPI, false, { slotCount: 2, strategy: 'vertical', margin: 5 })
  assert.equal(layout.slots.length, 2)

  // 旧 px 分区：area.height = 3508 - round(10 * 3508/297) = 3390；floor(3390/2) = 1695
  // 关键护栏：mm-floor 会得到 1689/1701（漂移 ~6px），委托后必须仍是 1695/1695
  assert.deepEqual(heights(layout), [1695, 1695])

  // 每个 slot 的 contentRect 不等于整 slot（内部 5mm 内缩，C2 启用；step2 renderer 仍自算）
  for (const slot of layout.slots) {
    assert.ok(slot.contentRect.x > slot.x, 'contentRect.x 应内缩')
    assert.ok(slot.contentRect.y > slot.y, 'contentRect.y 应内缩')
    assert.ok(slot.contentRect.width < slot.width, 'contentRect.width 应小于 slot')
    assert.ok(slot.contentRect.height < slot.height, 'contentRect.height 应小于 slot')
  }
  // itemId 按位置映射
  assert.equal(layout.slots[0].itemId, 'a')
  assert.equal(layout.slots[1].itemId, 'b')
})

test('merge3 (A4 portrait, margin 0): 余数 1169/1169/1170', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const layout = createLayout(items, 'A4', DPI, false, { slotCount: 3, strategy: 'vertical' })
  assert.equal(layout.slots.length, 3)

  // 整页高 3508px：floor(3508/3)=1169，末 slot 吃余数 → 1169/1169/1170（顺序无关，集合锁）
  const hs = heights(layout).slice().sort((a, b) => a - b)
  assert.deepEqual(hs, [1169, 1169, 1170])

  // 全宽（portrait 整页宽 2480px @300dpi，单反倒角钉死）
  assert.deepEqual(widths(layout), [2480, 2480, 2480])
})

test('merge4 (A4 landscape, margin 0): row-major 2×2 铺满整页', () => {
  const ids = ['a', 'b', 'c', 'd']
  const items = ids.map((id) => ({ id }))
  const layout = createLayout(items, 'A4', DPI, true, {
    slotCount: 4, strategy: 'grid', gridCols: 2, gridRows: 2,
  })
  assert.equal(layout.slots.length, 4)

  // row-major：index → (col,row) = (0,0),(1,0),(0,1),(1,1)
  assert.deepEqual(layout.slots[0].gridPosition, { col: 0, row: 0 })
  assert.deepEqual(layout.slots[1].gridPosition, { col: 1, row: 0 })
  assert.deepEqual(layout.slots[2].gridPosition, { col: 0, row: 1 })
  assert.deepEqual(layout.slots[3].gridPosition, { col: 1, row: 1 })

  // 铺满整页：宽 3508 / 高 2480（landscape），2×2 各 1754 × 1240
  assert.deepEqual(widths(layout), [1754, 1754, 1754, 1754])
  assert.deepEqual(heights(layout), [1240, 1240, 1240, 1240])
})

test('单页 (slotCount 1): 整页不内缩，contentRect === slot', () => {
  const items = [{ id: 'solo' }]
  const layout = createLayout(items, 'A4', DPI, false, { slotCount: 1, strategy: 'vertical' })
  assert.equal(layout.slots.length, 1)
  const slot = layout.slots[0]
  // 整页 2480 × 3508 @300dpi
  assert.equal(slot.width, 2480)
  assert.equal(slot.height, 3508)
  // 单页不走内部边距：contentRect 与 slot 重合
  assert.deepEqual(slot.contentRect, { x: slot.x, y: slot.y, width: slot.width, height: slot.height })
})
