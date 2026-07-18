/**
 * composeSlot.test.js — B0 characterization 测试（C1 起 ComposeSlotLayoutFactory）
 *
 * 目的：冻结「现有 merge 几何语义」的 mm 等价表达。
 * 不依赖 config / renderers / Electron，纯 Node 可跑。
 * 数值为手算确定性结果，镜像 layout.js 的分割策略（vertical 末 slot 吃余数 / grid 2x2 row-major）。
 * C1 新增：可打印区 origin 偏移（paperXMm/paperYMm），默认 {0,0} 行为与 B0 完全一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ComposeSlotLayoutFactory, DEFAULT_SLOT_MARGIN_MM } from './composeSlot.js'

// 已解析纸张 mm 尺寸（调用方负责从 paperKey 解析，B0 不读 config）
const A5 = { widthMM: 148, heightMM: 210, isLandscape: false }
const A4_LANDSCAPE = { widthMM: 210, heightMM: 297, isLandscape: true }

test('ComposeSlotLayoutFactory preserves merge2 vertical paper partition', () => {
  const slots = ComposeSlotLayoutFactory({ paper: A5, mergeMode: 'merge2' })
  assert.equal(slots.length, 2)

  // 上半张（A5 竖向二分 → 每张 148×105）
  assert.deepEqual(slots[0].paperRect, { x: 0, y: 0, width: 148, height: 105 })
  assert.deepEqual(slots[0].contentRect, { x: 5, y: 5, width: 138, height: 95 })

  // 下半张（内容区 y 内移到 110，仍 138×95）
  assert.deepEqual(slots[1].paperRect, { x: 0, y: 105, width: 148, height: 105 })
  assert.deepEqual(slots[1].contentRect, { x: 5, y: 110, width: 138, height: 95 })
})

test('ComposeSlot preserves merge3 remainder allocation', () => {
  // A5 竖向三分：210/3=70 整除，三个 slot 均高 70
  const slots = ComposeSlotLayoutFactory({ paper: A5, mergeMode: 'merge3' })
  assert.equal(slots.length, 3)
  assert.deepEqual(slots[0].paperRect, { x: 0, y: 0, width: 148, height: 70 })
  assert.deepEqual(slots[1].paperRect, { x: 0, y: 70, width: 148, height: 70 })
  assert.deepEqual(slots[2].paperRect, { x: 0, y: 140, width: 148, height: 70 })

  // 余数归属：用不可整除高度冻结「末 slot 吃余数」策略（镜像 layout.js:103）
  const tall = { widthMM: 148, heightMM: 211, isLandscape: false }
  const r = ComposeSlotLayoutFactory({ paper: tall, mergeMode: 'merge3' })
  assert.equal(r[0].paperRect.height, 70) // floor(211/3)
  assert.equal(r[1].paperRect.height, 70)
  assert.equal(r[2].paperRect.height, 71) // 211 - 140 余数
})

test('ComposeSlot preserves merge4 grid ordering', () => {
  const slots = ComposeSlotLayoutFactory({ paper: A4_LANDSCAPE, mergeMode: 'merge4' })
  assert.equal(slots.length, 4)

  // row-major：col=index%2, row=floor(index/2)
  assert.deepEqual(slots[0].gridPosition, { col: 0, row: 0 })
  assert.deepEqual(slots[1].gridPosition, { col: 1, row: 0 })
  assert.deepEqual(slots[2].gridPosition, { col: 0, row: 1 })
  assert.deepEqual(slots[3].gridPosition, { col: 1, row: 1 })

  // 末列/末行吃余数：297/2 → 148+149；210/2 → 105+105
  assert.deepEqual(slots[0].paperRect, { x: 0, y: 0, width: 148, height: 105 })
  assert.deepEqual(slots[1].paperRect, { x: 148, y: 0, width: 149, height: 105 })
  assert.deepEqual(slots[2].paperRect, { x: 0, y: 105, width: 148, height: 105 })
  assert.deepEqual(slots[3].paperRect, { x: 148, y: 105, width: 149, height: 105 })

  // 每张都有独立 contentRect（末列宽 149 → contentRect 宽 139）
  assert.deepEqual(slots[1].contentRect, { x: 153, y: 5, width: 139, height: 95 })
})

test('ComposeSlot creates independent contentRect', () => {
  const slots = ComposeSlotLayoutFactory({ paper: A5, mergeMode: 'merge2' })
  for (const s of slots) {
    assert.ok(s.contentRect.x >= s.paperRect.x)
    assert.ok(s.contentRect.y >= s.paperRect.y)
    assert.ok(s.contentRect.width <= s.paperRect.width)
    assert.ok(s.contentRect.height <= s.paperRect.height)
    assert.equal(s.contentRect.width, s.paperRect.width - 2 * DEFAULT_SLOT_MARGIN_MM)
  }
  // 两张 contentRect 在 y 方向分离（不重叠）
  assert.ok(slots[0].contentRect.y + slots[0].contentRect.height <= slots[1].contentRect.y)
})

test('ComposeSlot rejects unresolved paper (no config dependency)', () => {
  assert.throws(() => ComposeSlotLayoutFactory({ mergeMode: 'merge2' }))
})

test('ComposeSlotLayoutFactory offsets all slots by printable-area origin (mm)', () => {
  // 外层左边距 10mm、上边距 15mm 的可打印区：所有 slot 矩形整体平移，内部 margin 规则不变
  const slots = ComposeSlotLayoutFactory({ paper: A5, mergeMode: 'merge2', paperXMm: 10, paperYMm: 15 })
  assert.equal(slots.length, 2)

  // 整张平移：paperRect 与 contentRect 都 +origin
  assert.deepEqual(slots[0].paperRect, { x: 10, y: 15, width: 148, height: 105 })
  assert.deepEqual(slots[0].contentRect, { x: 15, y: 20, width: 138, height: 95 })
  assert.deepEqual(slots[1].paperRect, { x: 10, y: 120, width: 148, height: 105 })
  assert.deepEqual(slots[1].contentRect, { x: 15, y: 125, width: 138, height: 95 })

  // 内部 margin 仍由 marginMm 推导（与 origin 无关）
  assert.equal(slots[0].contentRect.width, slots[0].paperRect.width - 2 * DEFAULT_SLOT_MARGIN_MM)
})
