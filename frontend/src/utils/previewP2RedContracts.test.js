/**
 * previewP2RedContracts.test.js — P2-X2 契约红测试（2026-09-04）
 *
 * 状态：🔴 本文件在 X2 最小实现落地前保持「红」——这是预期，不是事故。
 *   X2 的生产逻辑现在内联在 usePreview.js（debounce L2102-2124），没有可测纯 seam。
 *   本文件先钉住「将新增到 previewScheduler.js 决策层」的纯函数契约：
 *     - resolveDebouncePrecedence(pending, incoming) → { intent, key }
 *   seam 落地前：每测抛 `TypeError: sched.resolveDebouncePrecedence is not a function`
 *   （导入正常、调用缺失导出）= 契约已钉、实现未到。
 *   seam 落地后：本文件整体转绿 = 验收。
 *
 * 运行：node --test src/utils/previewP2RedContracts.test.js
 * Runtime 依据：outputs/perf-runs/preview-r2-8files-20260904.json
 *   X2: seq 55-60 App scenario-2/3 select（docId=d8bf968f 已就绪）进 debounce
 *       → seq 61-63 auto-nav-3 refresh 同 key 后到，无脑 clearTimeout 顶掉 select → 意图丢失
 *
 * P2-GATE 决定（2026-09-04）：
 *   - seam 位置：resolveDebouncePrecedence → previewScheduler.js（debounce 意图仲裁
 *     属于 transaction intent 语义，与 select/refresh supersession 同源，放 scheduler）。
 *   - X3 的 isDisplayablePreview 已迁出本文件 → previewPolicy.js（见
 *     previewPolicyRedContracts.test.js）——避免 previewScheduler 同时承担
 *     transition / execution / debounce / displayability 四类职责。
 *
 * 契约草案（step 5 冻结）：
 *   resolveDebouncePrecedence(pending, incoming)：
 *     - pending 为 null 或 key 不同        → { intent: incoming.intent, key: incoming.key }（新 selection 覆盖）
 *     - pending select + incoming refresh（同 key）→ { intent: 'select', key }  ← 保留 select，不降级（本文件核心）
 *     - 其余（refresh→select 升级 / 同 intent）    → { intent: incoming.intent, key }
 *   hook 用法：以返回值的 intent 重排定时器（payload 一律取 incoming 最新引用），
 *   绝不直接用 incoming.intent 覆盖 pending select。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as sched from './previewScheduler.js'

// ════════════════════════════════════════════════════════════
// P2-X2 — debounce 意图优先级（同窗口 select + refresh → select 必须赢）
// ════════════════════════════════════════════════════════════

test('P2-X2-1: pending select + incoming refresh（同 key）→ 保留 select（不降级为 refresh）', () => {
  // dump seq 55-63：scenario-2/3 select(docId 就绪) 被 auto-nav-3 refresh 顶掉 → 意图丢失
  const effective = sched.resolveDebouncePrecedence(
    { intent: 'select', key: 'K' },
    { intent: 'refresh', key: 'K' },
  )
  assert.equal(effective.intent, 'select',
    'docId-ready select 是唯一能 supersede 僵尸 transaction 的意图，不得被普通 refresh 顶掉')
  assert.equal(effective.key, 'K')
})

test('P2-X2-2: pending refresh + incoming select（同 key）→ 升级为 select', () => {
  const effective = sched.resolveDebouncePrecedence(
    { intent: 'refresh', key: 'K' },
    { intent: 'select', key: 'K' },
  )
  assert.equal(effective.intent, 'select', 'select 语义（++version supersede）必须胜出')
})

test('P2-X2-3: 不同 key → incoming 覆盖（新 selection，INV-PS3）', () => {
  const effective = sched.resolveDebouncePrecedence(
    { intent: 'select', key: 'K' },
    { intent: 'select', key: 'L' },
  )
  assert.equal(effective.key, 'L', '新 key 的 selection 必须覆盖 pending')
  assert.equal(effective.intent, 'select')
})

test('P2-X2-4: 同 key 同 intent（refresh+refresh / select+select）→ last-wins incoming', () => {
  const r = sched.resolveDebouncePrecedence(
    { intent: 'refresh', key: 'K' },
    { intent: 'refresh', key: 'K' },
  )
  assert.equal(r.intent, 'refresh')
  const s2 = sched.resolveDebouncePrecedence(
    { intent: 'select', key: 'K' },
    { intent: 'select', key: 'K' },
  )
  assert.equal(s2.intent, 'select', 'INV-PS3：同 key 连续 select 仍 select')
})

test('P2-X2-5: pending 为 null（首拍）→ 直接用 incoming', () => {
  const effective = sched.resolveDebouncePrecedence(null, { intent: 'refresh', key: 'K' })
  assert.equal(effective.intent, 'refresh')
  assert.equal(effective.key, 'K')
})
