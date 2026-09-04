/**
 * previewScheduler.test.js — Preview Scheduler 决策层三态回归测试
 *
 * 依据：PreviewScheduler-Final-Contract-v1.md §7（T1–T10）+ §8（INV-PS1~PS6）
 * 运行：node --test src/utils/previewScheduler.test.js
 *
 * 注意：T10（OFD 端到端）是 UI 回归，不在本 Node 测试覆盖；T1–T9 在此覆盖。
 * 旧实现红：legacyResolvePreviewTransition 复现当前缺陷（任何调用都 ++version），
 *   用断言证明其在 T3（同 key 晋升不 ++version）与 T5（stale refresh 不 resurrect）失败。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const {
  resolvePreviewTransition,
  ownsTransaction,
  shouldReload,
  legacyResolvePreviewTransition,
  resolveRefreshExecution,
  resolveBoundary,
  advanceExecution,
  advanceLoadingStep,
  legacyResolveRefreshExecution,
  resolveCommittedClear,
  legacyResolveCommittedClear,
} = await import('./previewScheduler.js')

// ════════════════════════════════════════════════════════════
// T1 — 正常 Selection Supersession
// ════════════════════════════════════════════════════════════
test('T1: select(A) → select(B) → B supersede A', () => {
  const sA = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA' })
  assert.equal(sA.action, 'start')
  assert.equal(sA.version, 1)
  assert.equal(sA.transaction.key, 'A')

  const sB = resolvePreviewTransition(sA.transaction, sA.version, { intent: 'select', key: 'B', snapshot: 'snapB' })
  assert.equal(sB.action, 'start')
  assert.equal(sB.version, 2, 'select(B) 必须 ++version')
  assert.equal(sB.transaction.key, 'B')

  // A 的异步结果回来：ownership 判定必须为 false
  assert.equal(ownsTransaction(sB.transaction, 1, 'A'), false, 'A 已失去 ownership，不得 commit')
  assert.equal(ownsTransaction(sB.transaction, 2, 'B'), true, 'B 拥有 ownership，可 commit')
})

// ════════════════════════════════════════════════════════════
// T2 — 同 key 用户显式重新点击 = select（INV-PS3）
// ════════════════════════════════════════════════════════════
test('T2: select(A) → select(A) 同 key 仍 supersede', () => {
  const s1 = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA1' })
  const s2 = resolvePreviewTransition(s1.transaction, s1.version, { intent: 'select', key: 'A', snapshot: 'snapA2' })
  assert.equal(s2.action, 'start', '同 key 点击必须是新 select，不是 merge')
  assert.equal(s2.version, 2, '同 key 点击必须 ++version（INV-PS3）')
  assert.equal(s2.transaction.snapshot, 'snapA2')

  // 第一次 A 的异步结果不得 commit
  assert.equal(ownsTransaction(s2.transaction, 1, 'A'), false, '第一次 A 已 superseded')
})

// ════════════════════════════════════════════════════════════
// T3 — Placeholder → Resolved Promotion（本次根因）
// ════════════════════════════════════════════════════════════
test('T3: refresh(A-resolved) 同 key 晋升不 ++version，reload resolved', () => {
  // select(A-placeholder)
  const s1 = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snap-placeholder' })
  assert.equal(s1.version, 1)

  // refresh(A-resolved)
  const s2 = resolvePreviewTransition(s1.transaction, s1.version, { intent: 'refresh', key: 'A', snapshot: 'snap-resolved' })
  assert.equal(s2.action, 'merge', '同 key refresh 应 merge')
  assert.equal(s2.version, 1, 'INV-PS1: refresh 不得 ++version')
  assert.equal(s2.transaction.snapshot, 'snap-resolved')

  // promotion：snapshot 引用已变 → 必须 reload（INV-PS6）
  assert.equal(shouldReload(s2.transaction, 'snap-placeholder'), true, 'snapshot 晋升必须 reload resolved')
  // reload 后 snapshot 稳定 → 不再 reload
  assert.equal(shouldReload(s2.transaction, 'snap-resolved'), false, 'snapshot 稳定后不 reload')
})

// 旧实现红：证明 legacy 无法满足 T3
test('T3-red: 旧实现（每次 ++version）在 refresh 时错误递增 version', () => {
  const s1 = legacyResolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snap-placeholder' })
  const s2 = legacyResolvePreviewTransition(s1.transaction, s1.version, { intent: 'refresh', key: 'A', snapshot: 'snap-resolved' })
  assert.notEqual(s2.version, 1, '旧实现在 refresh 时递增了 version（这就是根因）')
  assert.equal(s2.version, 2, '旧实现错误地 ++version')
})

// ════════════════════════════════════════════════════════════
// T4 — 同 key 多次 Refresh 合并
// ════════════════════════════════════════════════════════════
test('T4: 多次 refresh 同 key 合并，只保留最新 snapshot', () => {
  const s1 = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA1' })
  const s2 = resolvePreviewTransition(s1.transaction, s1.version, { intent: 'refresh', key: 'A', snapshot: 'snapA2' })
  const s3 = resolvePreviewTransition(s2.transaction, s2.version, { intent: 'refresh', key: 'A', snapshot: 'snapA3' })
  assert.equal(s2.version, 1)
  assert.equal(s3.version, 1, '多次 refresh 不得 ++version')
  assert.equal(s3.transaction.snapshot, 'snapA3', '只保留最新 snapshot')
  assert.equal(s3.action, 'merge')
})

// ════════════════════════════════════════════════════════════
// T5 — Stale Refresh 不得 Resurrection（INV-PS2）
// ════════════════════════════════════════════════════════════
test('T5: select(A)→select(B)→refresh(A) 必须 ignore', () => {
  const sA = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA' })
  const sB = resolvePreviewTransition(sA.transaction, sA.version, { intent: 'select', key: 'B', snapshot: 'snapB' })
  const staleRefresh = resolvePreviewTransition(sB.transaction, sB.version, { intent: 'refresh', key: 'A', snapshot: 'snapA-new' })

  assert.equal(staleRefresh.action, 'ignore', 'stale refresh(A) 必须 ignore')
  assert.equal(staleRefresh.version, 2, 'stale refresh 不得 ++version')
  assert.equal(staleRefresh.transaction.key, 'B', 'stale refresh 不得覆盖 B')
  assert.equal(staleRefresh.transaction.snapshot, 'snapB', 'B 的 snapshot 不被 A 污染')
})

// 旧实现红：证明 legacy 无法满足 T5
test('T5-red: 旧实现把 stale refresh(A) 误当成新 selection', () => {
  const sA = legacyResolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA' })
  const sB = legacyResolvePreviewTransition(sA.transaction, sA.version, { intent: 'select', key: 'B', snapshot: 'snapB' })
  const staleRefresh = legacyResolvePreviewTransition(sB.transaction, sB.version, { intent: 'refresh', key: 'A', snapshot: 'snapA-new' })
  assert.equal(staleRefresh.transaction.key, 'A', '旧实现把 stale refresh(A) 反向拉回（resurrection bug）')
  assert.equal(staleRefresh.version, 3, '旧实现错误 ++version')
})

// ════════════════════════════════════════════════════════════
// T6 — loadDocFacts 异步期间发生 Supersession（ownership 判定）
// ════════════════════════════════════════════════════════════
test('T6: await 期间 select(B) → A 失去 ownership', () => {
  const sA = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA' })
  // A 在 await loadDocFacts 期间，B 被选中
  const sB = resolvePreviewTransition(sA.transaction, sA.version, { intent: 'select', key: 'B', snapshot: 'snapB' })
  // A resume 后校验 ownership
  assert.equal(ownsTransaction(sB.transaction, 1, 'A'), false, 'A 在 B 选中后失去 ownership')
  assert.equal(ownsTransaction(sB.transaction, 2, 'B'), true)
})

// ════════════════════════════════════════════════════════════
// T7 — saveDocFacts 前后 Ownership（INV-PS5）
// ════════════════════════════════════════════════════════════
test('T7: 副作用前后都要校验 ownership', () => {
  const sA = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA' })
  // 副作用前：A 仍 owns
  assert.equal(ownsTransaction(sA.transaction, 1, 'A'), true, '副作用前 A owns')
  // 副作用 await 期间 B 被选中
  const sB = resolvePreviewTransition(sA.transaction, sA.version, { intent: 'select', key: 'B', snapshot: 'snapB' })
  // 副作用后：A 不再 owns，不得 commit
  assert.equal(ownsTransaction(sB.transaction, 1, 'A'), false, '副作用后 A 不得继续 commit')
})

// ════════════════════════════════════════════════════════════
// T8 — Snapshot 持续变化（保险丝语义，通过 shouldReload 表达）
// ════════════════════════════════════════════════════════════
test('T8: snapshot 持续变化时 shouldReload 持续为 true，稳定后为 false', () => {
  const s1 = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snap1' })
  // 连续晋升
  const s2 = resolvePreviewTransition(s1.transaction, s1.version, { intent: 'refresh', key: 'A', snapshot: 'snap2' })
  const s3 = resolvePreviewTransition(s2.transaction, s2.version, { intent: 'refresh', key: 'A', snapshot: 'snap3' })
  // 每次晋升后，以旧的 snapshotAtStart 判定都应 reload
  assert.equal(shouldReload(s3.transaction, 'snap1'), true)
  assert.equal(shouldReload(s3.transaction, 'snap2'), true)
  // 稳定后（snapshotAtStart === 当前 snapshot）不 reload
  assert.equal(shouldReload(s3.transaction, 'snap3'), false)
})

// ════════════════════════════════════════════════════════════
// T9 — 删除当前 Preview（invalidate）
// ════════════════════════════════════════════════════════════
test('T9: invalidate → ++version，transaction=null，A 不得 commit', () => {
  const sA = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA' })
  const inv = resolvePreviewTransition(sA.transaction, sA.version, { intent: 'invalidate' })
  assert.equal(inv.action, 'invalidate')
  assert.equal(inv.version, 2, 'invalidate 必须 ++version')
  assert.equal(inv.transaction, null)
  // A 返回后 ownership 判定：transaction 为 null → 不 owns
  assert.equal(ownsTransaction(inv.transaction, 1, 'A'), false, '删除后 A 不得 commit')
})

// ════════════════════════════════════════════════════════════
// Execution 层（Contract v2 §4，INV-PS7/PS8/PS9）
// ════════════════════════════════════════════════════════════

// 构造 execution 的辅助
const exec = (over = {}) => ({
  id: 1,
  key: 'A',
  version: 1,
  phase: 'loading',
  consumingSnapshot: 'snapA',
  ...over,
})

// ════════════════════════════════════════════════════════════
// T10 — W5：refresh 时 execution idle → 必须启动新 execution
// ════════════════════════════════════════════════════════════
test('T10: W5 idle refresh → start-execution（旧实现 merge-only 为红）', () => {
  const s1 = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snap-placeholder' })
  // execution 已结束（idle，null）
  const action = resolveRefreshExecution(s1.transaction, null, { key: 'A', snapshot: 'snap-resolved' })
  assert.equal(action, 'start-execution', 'idle refresh 必须启动新 execution（INV-PS7）')

  // 旧实现红：Step 3 merge 只更新 snapshot、从不启动 execution
  const legacy = legacyResolveRefreshExecution(s1.transaction, null, { key: 'A', snapshot: 'snap-resolved' })
  assert.equal(legacy, 'merge-only', '旧实现 idle refresh 不启动 execution（这就是 OFD Loading 断点）')
  assert.notEqual(legacy, 'start-execution')
})

// ════════════════════════════════════════════════════════════
// T11 — W1：refresh 时 execution 在 loading → 只更新 snapshot
// ════════════════════════════════════════════════════════════
test('T11: W1 loading refresh → update-snapshot（在途 loop shouldReload 消费）', () => {
  const s1 = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA' })
  const e = exec({ phase: 'loading', consumingSnapshot: 'snapA' })
  const action = resolveRefreshExecution(s1.transaction, e, { key: 'A', snapshot: 'snapA2' })
  assert.equal(action, 'update-snapshot')
})

// ════════════════════════════════════════════════════════════
// T12 — W2/W3/W4：refresh 时 execution 已过 loading → restart-required
// ════════════════════════════════════════════════════════════
test('T12: W2/W3/W4 post-load/committing refresh → restart-required', () => {
  const s1 = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA' })
  for (const phase of ['post-load', 'committing']) {
    const e = exec({ phase, consumingSnapshot: 'snapA' })
    const action = resolveRefreshExecution(s1.transaction, e, { key: 'A', snapshot: 'snapA2' })
    assert.equal(action, 'restart-required', `phase=${phase} 时 refresh 必须触发 restart，而非静默丢弃`)
  }
})

// ════════════════════════════════════════════════════════════
// T13 — INV-PS9：同一 (key,version) 永不重复启动 execution
// ════════════════════════════════════════════════════════════
test('T13: INV-PS9 single execution — 存在同 (key,version) execution 时不重复 start', () => {
  const s1 = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA' })
  for (const phase of ['loading', 'post-load', 'committing']) {
    const e = exec({ phase, consumingSnapshot: 'snapA' })
    const action = resolveRefreshExecution(s1.transaction, e, { key: 'A', snapshot: 'snapA2' })
    assert.notEqual(action, 'start-execution', `phase=${phase} 时不得启动第二个 execution（INV-PS9）`)
  }
})

// ════════════════════════════════════════════════════════════
// T14 — stale refresh：transaction 不匹配 → ignore
// ════════════════════════════════════════════════════════════
test('T14: stale refresh → ignore（不启动 execution，不 resurrect）', () => {
  const sB = resolvePreviewTransition(null, 0, { intent: 'select', key: 'B', snapshot: 'snapB' })
  const action = resolveRefreshExecution(sB.transaction, null, { key: 'A', snapshot: 'snapA-new' })
  assert.equal(action, 'ignore')
})

// ════════════════════════════════════════════════════════════
// T15 — boundary：ownership 有效 + snapshot 新鲜 → continue
// ════════════════════════════════════════════════════════════
test('T15: boundary continue（ownership 有效 + snapshot 新鲜）', () => {
  const s1 = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA' })
  const e = exec({ phase: 'post-load', consumingSnapshot: 'snapA' })
  assert.equal(resolveBoundary(s1.transaction, e), 'continue')
})

// ════════════════════════════════════════════════════════════
// T16 — boundary：snapshot 已变 → restart（W2/W3/W4 的统一检测）
// ════════════════════════════════════════════════════════════
test('T16: boundary restart（execution 消费的 snapshot ≠ transaction 最新）', () => {
  // transaction.snapshot 已被 refresh 更新为 snapA2，但 execution 仍在消费 snapA
  const transaction = { key: 'A', version: 1, snapshot: 'snapA2' }
  const e = exec({ phase: 'post-load', consumingSnapshot: 'snapA' })
  assert.equal(resolveBoundary(transaction, e), 'restart')
})

// ════════════════════════════════════════════════════════════
// T17 — boundary：ownership 失效 → abort（supersede / invalidate）
// ════════════════════════════════════════════════════════════
test('T17: boundary abort（supersede / invalidate）', () => {
  const e = exec({ phase: 'loading', consumingSnapshot: 'snapA' })
  // supersede：transaction 变成 B
  const sB = resolvePreviewTransition(null, 0, { intent: 'select', key: 'B', snapshot: 'snapB' })
  assert.equal(resolveBoundary(sB.transaction, e), 'abort', 'supersede 后 A 的 execution 必须 abort')
  // invalidate：transaction 为 null
  assert.equal(resolveBoundary(null, e), 'abort', 'invalidate 后 execution 必须 abort')
})

// ════════════════════════════════════════════════════════════
// T18 — post-load refresh → restart，execution.id 不变（INV-PS10）
// ════════════════════════════════════════════════════════════
test('T18: post-load refresh → restart，execution.id 不变（INV-PS10）', () => {
  const s1 = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA' })
  const e = exec({ id: 10, phase: 'post-load', consumingSnapshot: 'snapA' })
  // refresh 到达 → restart-required（不是 start-execution）
  const action = resolveRefreshExecution(s1.transaction, e, { key: 'A', snapshot: 'snapA2' })
  assert.equal(action, 'restart-required')
  // transaction.snapshot 已更新 → boundary restart → advanceExecution 回 loading，id 不变
  const transaction2 = { key: 'A', version: 1, snapshot: 'snapA2' }
  const boundary = resolveBoundary(transaction2, e)
  assert.equal(boundary, 'restart')
  const next = advanceExecution(e, boundary, transaction2.snapshot)
  assert.equal(next.id, 10, 'restart 不得 fork，id 必须不变（INV-PS10）')
  assert.equal(next.phase, 'loading', 'restart 必须回到 loading')
})

// ════════════════════════════════════════════════════════════
// T19 — restart 不 fork 第二个 execution（INV-PS9/PS10）
// ════════════════════════════════════════════════════════════
test('T19: restart 不产生第二个 execution（INV-PS9/PS10）', () => {
  const s1 = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA' })
  const e = exec({ id: 10, phase: 'post-load', consumingSnapshot: 'snapA' })
  // 多次 refresh：execution 存在 → 永不 start-execution
  const a1 = resolveRefreshExecution(s1.transaction, e, { key: 'A', snapshot: 'snapA2' })
  const a2 = resolveRefreshExecution({ ...s1.transaction, snapshot: 'snapA2' }, e, { key: 'A', snapshot: 'snapA3' })
  assert.equal(a1, 'restart-required')
  assert.equal(a2, 'restart-required', 'execution 存在时永不 start-execution（INV-PS9）')
  // advanceExecution restart 返回同 id（不新建 execution 对象）
  const next = advanceExecution(e, 'restart', 'snapA3')
  assert.equal(next.id, e.id, 'restart 后仍是同一个 execution（INV-PS10）')
})

// ════════════════════════════════════════════════════════════
// T20 — committing 前 snapshot changed → 禁止 commit（INV-PS11）
// ════════════════════════════════════════════════════════════
test('T20: committing 前 snapshot changed → restart，禁止 commit（INV-PS11）', () => {
  const e = exec({ id: 10, phase: 'committing', consumingSnapshot: 'snapA' })
  // transaction.snapshot 已被 refresh 更新
  const transaction = { key: 'A', version: 1, snapshot: 'snapA2' }
  // commit 前 boundary：snapshot 已变 → restart，不是 continue
  assert.equal(resolveBoundary(transaction, e), 'restart', 'commit 前 snapshot 变了必须 restart，禁止 commit 旧 snapshot')
  // 且 freshness 不满足时，consumingSnapshot !== snapshot → 不得 commit
  assert.notEqual(e.consumingSnapshot, transaction.snapshot)
})

// ════════════════════════════════════════════════════════════
// T21 — restart 后 execution 重新绑定最新 consumingSnapshot
// ════════════════════════════════════════════════════════════
test('T21: restart 后 execution 重新绑定最新 consumingSnapshot', () => {
  const e = exec({ id: 10, phase: 'post-load', consumingSnapshot: 'snapA' })
  const next = advanceExecution(e, 'restart', 'snapA2')
  assert.equal(next.consumingSnapshot, 'snapA2', 'restart 后 consumingSnapshot 必须更新为最新')
  assert.equal(next.id, 10, 'id 不变')
  assert.equal(next.phase, 'loading', 'phase 回 loading')
})

// ════════════════════════════════════════════════════════════
// T22 — W1：loading 中 placeholder → resolved，第1轮 restart + consumingSnapshot 晋升
// ════════════════════════════════════════════════════════════
test('T22: W1 第1轮 loading 消费 placeholder、refresh resolved → next-iteration + 同 id 晋升 consumingSnapshot', () => {
  // transaction.snapshot 已被 refresh 更新为 resolved
  const transaction = { key: 'A', version: 1, snapshot: 'snap-resolved' }
  // execution 仍在第1轮 loading，consumingSnapshot 还是 placeholder
  const e = exec({ id: 10, phase: 'loading', consumingSnapshot: 'snap-placeholder' })
  const step = advanceLoadingStep(transaction, e)
  assert.equal(step.action, 'next-iteration', 'snapshot 变了必须回到下一轮，而不是 post-load')
  assert.equal(step.execution.id, 10, 'restart 不得 fork，id 不变（INV-PS10）')
  assert.equal(step.execution.phase, 'loading', '仍在 loading')
  assert.equal(step.execution.consumingSnapshot, 'snap-resolved', 'consumingSnapshot 晋升为最新 snapshot')
})

// ════════════════════════════════════════════════════════════
// T23 — W1：第2轮消费 resolved 后 → continue + post-load（不伪 restart）
// ════════════════════════════════════════════════════════════
test('T23: W1 第2轮消费 resolved 后 consumingSnapshot===snapshot → post-load（不伪 restart）', () => {
  const transaction = { key: 'A', version: 1, snapshot: 'snap-resolved' }
  // 第2轮：consumingSnapshot 已同步为 resolved
  const e = exec({ id: 10, phase: 'loading', consumingSnapshot: 'snap-resolved' })
  // freshness 基准一致 → resolveBoundary continue（不是 restart）
  assert.equal(resolveBoundary(transaction, e), 'continue', 'consumingSnapshot 已同步时不得伪 restart')
  const step = advanceLoadingStep(transaction, e)
  assert.equal(step.action, 'post-load', 'snapshot 新鲜 → 进入 post-load')
  assert.equal(step.execution.phase, 'post-load')
  assert.equal(step.execution.id, 10, 'id 不变')
})

// ════════════════════════════════════════════════════════════
// T24 — loading 阶段 abort（supersede / invalidate）→ terminate
// ════════════════════════════════════════════════════════════
test('T24: loading 阶段 supersede / invalidate → terminate', () => {
  const e = exec({ id: 10, phase: 'loading', consumingSnapshot: 'snapA' })
  // supersede：transaction 变成 B
  const sB = resolvePreviewTransition(null, 0, { intent: 'select', key: 'B', snapshot: 'snapB' })
  const stepSupersede = advanceLoadingStep(sB.transaction, e)
  assert.equal(stepSupersede.action, 'terminate', 'supersede 后 loading 的 execution 必须 terminate')
  assert.equal(stepSupersede.execution, null)
  // invalidate：transaction 为 null
  const stepInvalidate = advanceLoadingStep(null, e)
  assert.equal(stepInvalidate.action, 'terminate', 'invalidate 后 execution 必须 terminate')
  assert.equal(stepInvalidate.execution, null)
})

// ════════════════════════════════════════════════════════════
// P4 — Preview Transaction Ownership Contract（2026-08-23 冻结）
// 核心：旧 render cleanup 不得拥有新 transaction 的取消权。
//   clearCommitted(renderVersion) 只能清理属于「当前 committed preview」的 transaction；
//   不得因为过时 previewFile 的 render effect 取消更新版本、仍在执行中的 handlePreview。
// ════════════════════════════════════════════════════════════

// ── P4-1 RED：legacy 无条件清 → 取消新 transaction（当前缺陷复刻）──
test('P4-1-RED: legacy clearCommitted 无条件清 → 违反 P4（取消在途新 transaction）', () => {
  // v6 已 commit（裸 preview），v9 新 handlePreview 在途（transaction.version=9）
  // 旧裸 previewFile 的 render effect 触发 clearCommitted
  const decision = legacyResolveCommittedClear({
    transaction: { key: 'K', version: 9, snapshot: 'rich' },
    committedVersion: 6,
  })
  assert.equal(decision.action, 'clear',
    'legacy 无条件清（复刻当前 clearCommitted）→ 会把 v9 transaction 一起取消（违反 P4）')
})

// ── P4-1：旧 render cleanup 遇到新 transaction → preserve（不得取消在途 execution）──
test('P4-1: 旧 committed preview（v6）不得取消新 transaction（v9）→ preserve-transaction', () => {
  const decision = resolveCommittedClear({
    transaction: { key: 'K', version: 9, snapshot: 'rich' },
    committedVersion: 6,
  })
  assert.equal(decision.action, 'preserve-transaction',
    '旧 render cleanup 必须保留新 transaction 的在途 execution（P4-1）')
})

// ── P4-1b：从未 commit（committedVersion=null）也不得取消在途 transaction ──
test('P4-1b: 从未 commit 的 cleanup 不得取消在途 transaction → preserve-transaction', () => {
  const decision = resolveCommittedClear({
    transaction: { key: 'K', version: 3, snapshot: 'rich' },
    committedVersion: null,
  })
  assert.equal(decision.action, 'preserve-transaction',
    '无 committed preview 时旧 cleanup 更无权取消在途 execution（P4-1b）')
})

// ── P4-2：真正 supersede（新 select）仍必须取消旧 execution（Scheduler 语义不回归）──
test('P4-2: 新 select 覆盖旧 select → 旧 execution 仍 superseded，新 execution active', () => {
  const sA = resolvePreviewTransition(null, 0, { intent: 'select', key: 'A', snapshot: 'snapA' })
  const sB = resolvePreviewTransition(sA.transaction, sA.version, { intent: 'select', key: 'B', snapshot: 'snapB' })
  assert.equal(ownsTransaction(sB.transaction, sA.version, 'A'), false, 'A 被 supersede（P4-2 必须保持）')
  assert.equal(ownsTransaction(sB.transaction, sB.version, 'B'), true, 'B 保持 active（P4-2 必须保持）')
  // 当前 committed preview 自己的 cleanup：同版本 → 正常清理
  const decision = resolveCommittedClear({
    transaction: sB.transaction,
    committedVersion: sB.version,
  })
  assert.equal(decision.action, 'clear', '当前 committed preview 自己的 cleanup 正常清理（P4-2）')
})

// ── P4-3：无 transaction 时清理是幂等安全 ──
test('P4-3: 无 transaction → clear（无 execution 可杀，幂等安全）', () => {
  const decision = resolveCommittedClear({
    transaction: null,
    committedVersion: 6,
  })
  assert.equal(decision.action, 'clear', '无 transaction 时清理不影响任何 execution')
})

// ════════════════════════════════════════════════════════════
// P2 — X1 僵尸死锁（2026-09-04，R2 runtime 取证：MERGE_DEFERRED 扑空）
// 背景：commit 后 usePreview.js 从不清理 previewExecutionRef（COMMIT_SUCCESS/
//       COMMIT_CACHE 只 setPreviewFile；FUSE_BLOCK 连清都不清），execution 恒残留
//       phase='post-load'。后续同 key refresh → resolveRefreshExecution 见同绑定
//       execution 且 phase!=='loading' → 'restart-required' → hook MERGE_DEFERRED
//       return null，依赖「在途 execution 会在 boundary 自行 restart」——但该 execution
//       的异步代码已返回，永远不再经过 boundary → INV-PS7 悬空（dump seq 45/49/65/69/73
//       五个带 docId 的 refresh 全部被吃）。
// 契约提案（v2.1 delta）：execution 增加终态 'committed'；终态不是「有效 consumer」，
//       refresh 必须 start-execution（INV-PS9 豁免），不得 defer 给已死 execution。
// 运行：node --test src/utils/previewScheduler.test.js
// 预期：P2-X1-RED-1 红（现返回 restart-required）；P2-X1-CTRL-1 绿（在途语义不回归）。
// ════════════════════════════════════════════════════════════

// ── P2-X1-RED-1：终态 committed execution 遇同 key refresh → 必须 start-execution ──
test('P2-X1-RED-1: committed 终态（代码已返回）refresh → start-execution，禁 defer 给已死 execution', () => {
  // 场景复刻 dump：v6 已 commit（半壳），docId 后到 → refresh 带最新 snapshot 到达
  const transaction = { key: 'A', version: 6, snapshot: 'snapA-docId-ready' }
  // 僵尸：commit 后残留的 execution（phase 未终态化，consumingSnapshot 还是旧快照）
  const zombie = exec({ id: 6, key: 'A', version: 6, phase: 'committed', consumingSnapshot: 'snapA-halfshell' })
  const action = resolveRefreshExecution(transaction, zombie, { key: 'A', snapshot: 'snapA-docId-ready' })
  assert.equal(action, 'start-execution',
    '终态 committed execution 不是有效 consumer（INV-PS9 豁免）——refresh 必须启动新 execution 消费最新 snapshot，'
    + '不得返回 restart-required defer 给一个永远不会再经过 boundary 的 execution')
})

// ── P2-X1-CTRL-1：在途 post-load（异步代码仍在跑，还会经过 boundary）→ 仍 restart-required ──
// 边界锁定：X1 修复只针对「终态」，不得把在途 post-load 的 restart-required 语义一并改掉（T12 不回归）
test('P2-X1-CTRL-1: 在途 post-load（真在 await docFacts）refresh → 仍 restart-required（T12 不回归）', () => {
  const transaction = { key: 'A', version: 6, snapshot: 'snapA2' }
  const inflight = exec({ id: 6, key: 'A', version: 6, phase: 'post-load', consumingSnapshot: 'snapA' })
  const action = resolveRefreshExecution(transaction, inflight, { key: 'A', snapshot: 'snapA2' })
  assert.equal(action, 'restart-required',
    '在途 post-load execution 会经过下一个 resolveBoundary 并自行 restart（INV-PS10），语义不变')
})
