import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyWheelZoom } from './continuousZoom.mjs'

test('向上滚（deltaY<0）放大：结果大于当前值', () => {
  assert.ok(applyWheelZoom(100, -100) > 100)
})

test('向下滚（deltaY>0）缩小：结果小于当前值', () => {
  assert.ok(applyWheelZoom(100, 100) < 100)
})

test('零 delta 不变', () => {
  assert.strictEqual(applyWheelZoom(137, 0), 137)
})

test('默认 sensitivity 下普通鼠标一格（±100）约 8~13% 变化', () => {
  const up = applyWheelZoom(100, -100)
  const ratio = up / 100
  assert.ok(ratio > 1.08 && ratio < 1.13, `ratio=${ratio}`)
  const down = applyWheelZoom(100, 100)
  assert.ok(down / 100 < 0.93 && down / 100 > 0.87, `ratio=${down / 100}`)
})

test('上边界 clamp：已到 max 继续放大不超 max', () => {
  assert.strictEqual(applyWheelZoom(500, -1000, { max: 500 }), 500)
})

test('下边界 clamp：已到 min 继续缩小不低于 min', () => {
  assert.strictEqual(applyWheelZoom(10, 1000, { min: 10 }), 10)
})

test('夹取边界时结果等于输入（供调用方判断「无变化」）', () => {
  assert.strictEqual(applyWheelZoom(500, -1000, { max: 500 }), 500)
  assert.strictEqual(applyWheelZoom(10, 1000, { min: 10 }), 10)
})

test('自定义 sensitivity 生效', () => {
  const slow = applyWheelZoom(100, -100, { sensitivity: 0.0005 })
  const fast = applyWheelZoom(100, -100, { sensitivity: 0.005 })
  assert.ok(fast > slow, '更大 sensitivity 应放大更多')
})

test('幂等：连续两次相同 delta 的乘积一致', () => {
  const a = applyWheelZoom(100, -50)
  const b = applyWheelZoom(a, -50)
  // 两次 -50 应等价于一次 -100（指数相乘）
  const once = applyWheelZoom(100, -100)
  assert.ok(Math.abs(b - once) < 1e-9)
})
