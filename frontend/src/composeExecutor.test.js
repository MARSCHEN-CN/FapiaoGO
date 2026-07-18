/**
 * composeExecutor.test.js — A.5 Worker command/source index alignment hardening
 *
 * 背景（B1 p2 review 发现的 blocker）：
 *   render.worker.js 原用 `let _ci` 作为第二个 cursor 取 command，
 *   但 sources / commands / slots 三者按 items 索引对齐（缺内容时均为 null）。
 *   一旦中间 slot 的 source 为 null（渲染失败），`continue` 不推进 _ci，
 *   导致下一 slot 误读失败 slot 的 null command 而被连带静默丢弃。
 *   抽出 iterateSlots 后，固定用同一索引 i 取 source 与 command，
 *   契约恢复为 index-aligned：缺源 slot 不影响后续 slot 绘制。
 *
 * 本测试直接 import config-free 的 composeExecutor（不依赖浏览器/配置），
 * 用 spy 记录每次 draw 的 (cmd, source)，断言绘制顺序与 sources 完全一致。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { iterateSlots } from './composeExecutor.js'
import { createPlacement } from './compose/composePlacement.js'

const calls = []
function spyDraw(ctx, cmd, source) {
  calls.push({ source, cmd })
}

// 用真实的 PlacementFactory 构造一条合法的 RenderCommand（与 renderer 同源）。
function makeCmd(slot) {
  const p = createPlacement({
    contentRect: { x: slot.x, y: slot.y, width: slot.width, height: slot.height },
    sourceWidth: slot.width,
    sourceHeight: slot.height,
    rotation: 0,
  })
  return {
    version: 1,
    paper: {}, // validateRenderCommand 要求 paper truthy
    rotatedBounds: p.rotatedBounds,
    placement: { scale: p.scale, offsetX: p.offsetX, offsetY: p.offsetY },
    contentRotation: 0,
    clip: { x: slot.x, y: slot.y, width: slot.width, height: slot.height },
  }
}

function runWith(sources, commands) {
  const slots = sources.map((_, i) => ({ x: 0, y: i * 100, width: 100, height: 100 }))
  calls.length = 0
  iterateSlots({}, slots, sources, commands, spyDraw)
  return calls.map((c) => c.source)
}

test('A.5: middle source failure must not drop subsequent slot', () => {
  const A = { id: 'A' }
  const C = { id: 'C' }
  const sources = [A, null, C]
  const commands = [
    makeCmd({ x: 0, y: 0, width: 100, height: 100 }),
    null,
    makeCmd({ x: 0, y: 200, width: 100, height: 100 }),
  ]
  assert.deepEqual(runWith(sources, commands), [A, C])
})

test('A.5: head source failure must not drop subsequent slots', () => {
  const B = { id: 'B' }
  const C = { id: 'C' }
  const sources = [null, B, C]
  const commands = [
    null,
    makeCmd({ x: 0, y: 100, width: 100, height: 100 }),
    makeCmd({ x: 0, y: 200, width: 100, height: 100 }),
  ]
  assert.deepEqual(runWith(sources, commands), [B, C])
})

test('A.5: happy path draws every present source in index order', () => {
  const A = { id: 'A' }
  const B = { id: 'B' }
  const C = { id: 'C' }
  const sources = [A, B, C]
  const commands = [
    makeCmd({ x: 0, y: 0, width: 100, height: 100 }),
    makeCmd({ x: 0, y: 100, width: 100, height: 100 }),
    makeCmd({ x: 0, y: 200, width: 100, height: 100 }),
  ]
  assert.deepEqual(runWith(sources, commands), [A, B, C])
})
