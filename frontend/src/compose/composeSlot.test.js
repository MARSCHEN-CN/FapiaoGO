/**
 * composeSlot.test.js — B0 characterization 测试
 *
 * 目的：冻结「现有 merge 几何语义」的 mm 等价表达。
 * 不依赖 config / renderers / Electron，纯 Node 可跑。
 * 数值为手算确定性结果，镜像 layout.js 的分割策略（vertical 末 slot 吃余数 / grid 2x2 row-major）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildComposeSlots, DEFAULT_SLOT_MARGIN_MM } from './composeSlot.js'

// 已解析纸张 mm 尺寸（调用方负责从 paperKey 解析，B0 不读 config）
const A5 = { widthMM: 148, heightMM: 210, isLandscape: false }
const A4_LANDSCAPE = { widthMM: 210, heightMM: 297, isLandscape: true }

test('ComposeSlot preserves merge2 vertical paper partition', () => {
  const slots = buildComposeSlots({ paper: A5, mergeMode: 'merge2' })
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
  const slots = buildComposeSlots({ paper: A5, mergeMode: 'merge3' })
  assert.equal(slots.length, 3)
  assert.deepEqual(slots[0].paperRect, { x: 0, y: 0, width: 148, height: 70 })
  assert.deepEqual(slots[1].paperRect, { x: 0, y: 70, width: 148, height: 70 })
  assert.deepEqual(slots[2].paperRect, { x: 0, y: 140, width: 148, height: 70 })

  // 余数归属：用不可整除高度冻结「末 slot 吃余数」策略（镜像 layout.js:103）
  const tall = { widthMM: 148, heightMM: 211, isLandscape: false }
  const r = buildComposeSlots({ paper: tall, mergeMode: 'merge3' })
  assert.equal(r[0].paperRect.height, 70) // floor(211/3)
  assert.equal(r[1].paperRect.height, 70)
  assert.equal(r[2].paperRect.height, 71) // 211 - 140 余数
})

test('ComposeSlot preserves merge4 grid ordering', () => {
  const slots = buildComposeSlots({ paper: A4_LANDSCAPE, mergeMode: 'merge4' })
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
  const slots = buildComposeSlots({ paper: A5, mergeMode: 'merge2' })
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
  assert.throws(() => buildComposeSlots({ mergeMode: 'merge2' }))
})
