// 纯函数 nextZoomStep 的契约测试（node --test，无框架）。
// 锁死滚轮缩放的档位推进语义，防止未来改动引入步进漂移 / 夹取 bug。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextZoomStep } from './zoomStep.mjs'

const STEPS = [25, 50, 75, 100, 125, 150, 200]

test('放大：100 → 125（adaptive 锚点视为 100）', () => {
  assert.equal(nextZoomStep(100, 'in', STEPS), 125)
})

test('放大：125 → 150 → 200 逐级推进', () => {
  assert.equal(nextZoomStep(125, 'in', STEPS), 150)
  assert.equal(nextZoomStep(150, 'in', STEPS), 200)
})

test('放大到顶夹取：200 → 200（不越界）', () => {
  assert.equal(nextZoomStep(200, 'in', STEPS), 200)
})

test('缩小：100 → 75', () => {
  assert.equal(nextZoomStep(100, 'out', STEPS), 75)
})

test('缩小：75 → 50 → 25 逐级推进', () => {
  assert.equal(nextZoomStep(75, 'out', STEPS), 50)
  assert.equal(nextZoomStep(50, 'out', STEPS), 25)
})

test('缩小到底夹取：25 → 25（不越界）', () => {
  assert.equal(nextZoomStep(25, 'out', STEPS), 25)
})

test('非档位值向上取最近：110 → 125', () => {
  assert.equal(nextZoomStep(110, 'in', STEPS), 125)
})

test('非档位值向下取最近：110 → 100', () => {
  assert.equal(nextZoomStep(110, 'out', STEPS), 100)
})
