// PERF-WHITE-1 / P1-A：importHistory publication batching 行为契约
// 覆盖（用户批准的 4 条核心 + 边界）：
//   P1-A-1 多响应只产生一次 publication
//   P1-A-2 同 key 多次响应，latest wins（合并不丢最新结果）
//   P1-A-3 完全相同的数据不发布（noop → return prev，React bail out）
//   P1-A-4 同号多 fileKey 广播语义不变
//   边界    liveKeys 过滤（死 key 不写/剔除）、prune、dispose、跨批合并、防复活
//
// 工厂 debounceMs 用 0 → setTimeout(0) 真实排程，await 一个宏任务即触发 flush，
// 不依赖 node mock timers（避免版本差异）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyHistoryEntry,
  historyValueEquals,
  createImportHistoryBatcher,
} from '../src/contexts/importHistoryBatcher.js'

const val = (importCount, extra = {}) => ({
  exists: true,
  invoiceDate: extra.invoiceDate ?? '2026-01-01',
  firstImportedAt: extra.firstImportedAt ?? 1735689600000,
  importCount,
  dateMismatchCount: extra.dateMismatchCount ?? 0,
})

const tick = () => new Promise((r) => setTimeout(r, 5))

function makeBatcher({ publish } = {}) {
  const calls = { publish: 0, noop: 0 }
  const published = []
  const b = createImportHistoryBatcher({
    debounceMs: 0,
    publish: (map) => { calls.publish++; published.push(map) },
    onNoop: () => { calls.noop++ },
    onPublish: () => {},
    ...(publish ? { publish } : {}),
  })
  return { b, calls, published }
}

function entriesOf(map) {
  return Object.fromEntries(Array.from(map.entries()).map(([k, v]) => [k, { ...v }]))
}

// ── P1-A-1：多响应只产生一次 publication ──────────────────────
test('P1-A-1：多响应同批合并 → publish 恰 1 次，final Map 含全部 key', async () => {
  const { b, calls, published } = makeBatcher()
  b.setLiveKeys(new Set(['A', 'B', 'C']))
  b.enqueue({ fileKeys: ['A'], value: val(2) })
  b.enqueue({ fileKeys: ['B'], value: val(2) })
  b.enqueue({ fileKeys: ['C'], value: val(3) })
  await tick()
  assert.equal(calls.publish, 1, '3 条响应合并为 1 次 publication')
  assert.equal(published.length, 1)
  const final = entriesOf(published[0])
  assert.deepEqual(final.A, val(2))
  assert.deepEqual(final.B, val(2))
  assert.deepEqual(final.C, val(3))
  assert.equal(calls.noop, 0)
})

// ── P1-A-2：同 key 多次响应 latest wins ───────────────────────
test('P1-A-2：同 key 2→3→4 同批合并 → 最终 importCount=4（latest wins）', async () => {
  const { b, calls, published } = makeBatcher()
  b.setLiveKeys(new Set(['A']))
  b.enqueue({ fileKeys: ['A'], value: val(2) })
  b.enqueue({ fileKeys: ['A'], value: val(3) })
  b.enqueue({ fileKeys: ['A'], value: val(4) })
  await tick()
  assert.equal(calls.publish, 1)
  assert.equal(published[0].get('A').importCount, 4)
})

test('P1-A-2b：跨批 latest wins → 第二批仍覆盖第一批，publish=2', async () => {
  const { b, calls, published } = makeBatcher()
  b.setLiveKeys(new Set(['A']))
  b.enqueue({ fileKeys: ['A'], value: val(2) })
  await tick()
  assert.equal(calls.publish, 1)
  assert.equal(published[0].get('A').importCount, 2)
  b.enqueue({ fileKeys: ['A'], value: val(5) })
  await tick()
  assert.equal(calls.publish, 2, '第二批真实变化 → 第二次 publication')
  assert.equal(published[1].get('A').importCount, 5)
})

// ── P1-A-3：完全相同的数据不发布 ───────────────────────────────
test('P1-A-3：完全相同的 pending 数据 → 不 publish（onNoop 计数）', async () => {
  const { b, calls, published } = makeBatcher()
  b.setLiveKeys(new Set(['A']))
  b.enqueue({ fileKeys: ['A'], value: val(2) })
  await tick()
  assert.equal(calls.publish, 1, '首轮真实变化发布')
  // 热路径重复查询：同 key 同值再次到达
  b.enqueue({ fileKeys: ['A'], value: val(2) })
  await tick()
  assert.equal(calls.publish, 1, '重复数据不得再发布')
  assert.equal(calls.noop, 1, '重复数据计入 noop')
  assert.equal(published.length, 1)
})

test('P1-A-3b：批内部分条目无变化 → 整体只按真实变化发布 1 次', async () => {
  const { b, calls, published } = makeBatcher()
  b.setLiveKeys(new Set(['A', 'B']))
  b.enqueue({ fileKeys: ['A'], value: val(2) })   // 首轮：都算新
  b.enqueue({ fileKeys: ['B'], value: val(3) })
  await tick()
  assert.equal(calls.publish, 1)
  // 第二轮：A 重复、B 变化 → 必须发布（B 变了），且 final B=4
  b.enqueue({ fileKeys: ['A'], value: val(2) })
  b.enqueue({ fileKeys: ['B'], value: val(4) })
  await tick()
  assert.equal(calls.publish, 2)
  assert.equal(calls.noop, 0, '批内有真实变化 → 不是 noop')
  assert.equal(published[1].get('B').importCount, 4)
  assert.equal(published[1].get('A').importCount, 2, 'A 保持原值')
})

// ── P1-A-4：同号多 fileKey 广播语义不变 ───────────────────────
test('P1-A-4：同号 fileKeys=[A,B,C] → 全部写入同一 history 值（同一引用）', async () => {
  const { b, calls, published } = makeBatcher()
  b.setLiveKeys(new Set(['A', 'B', 'C', 'D']))
  const shared = val(7)
  b.enqueue({ fileKeys: ['A', 'B', 'C'], value: shared })
  await tick()
  assert.equal(calls.publish, 1)
  const m = published[0]
  assert.equal(m.get('A'), shared, '广播 = 同一对象引用，无逐 key 拷贝')
  assert.equal(m.get('B'), shared)
  assert.equal(m.get('C'), shared)
  assert.equal(m.has('D'), false, '未命中的 key 不受影响')
  // 与既有导出值逐一 deep-equal（值语义不变）
  assert.deepEqual(entriesOf(m).A, val(7))
})

// ── 边界：liveKeys 过滤 ────────────────────────────────────────
test('边界-1：liveKeys 之外的 key 不写入（死 key 过滤）', async () => {
  const { b, calls, published } = makeBatcher()
  b.setLiveKeys(new Set(['A']))
  b.enqueue({ fileKeys: ['A', 'DEAD'], value: val(2) })   // DEAD 已被移除
  await tick()
  assert.equal(calls.publish, 1)
  assert.ok(published[0].has('A'))
  assert.ok(!published[0].has('DEAD'), 'DEAD 不在 liveKeys → 不得写入')
})

test('边界-2：applyHistoryEntry 剔除 prev 中非存活 key（与 FileContext 原 updater 同构）', () => {
  const prev = new Map([['A', val(2)], ['GONE', val(9)]])
  const next = applyHistoryEntry(prev, { fileKeys: ['A'], value: val(3) }, new Set(['A']))
  assert.equal(next.get('A').importCount, 3)
  assert.ok(!next.has('GONE'), 'prev 中 GONE 已移除 → 剔除')
})

test('边界-3：值不同才视为变化 —— historyValueEquals', () => {
  assert.equal(historyValueEquals(val(2), val(2)), true)
  assert.equal(historyValueEquals(val(2), val(3)), false)
  assert.equal(historyValueEquals(val(2, { invoiceDate: '2026-02-01' }), val(2)), false)
  assert.equal(historyValueEquals(val(2), val(2, { dateMismatchCount: 1 })), false)
})

// ── 边界：prune（files 变化时的主动剔除，原 :218/:238 语义） ──
test('边界-4：prune 剔除已移除 key 并发布；全存活 → 不发布', async () => {
  const { b, calls, published } = makeBatcher()
  b.setLiveKeys(new Set(['A', 'B']))
  b.enqueue({ fileKeys: ['A'], value: val(2) })
  b.enqueue({ fileKeys: ['B'], value: val(3) })
  await tick()
  assert.equal(calls.publish, 1)
  // 用户删了 A → 新一轮 files effect
  b.setLiveKeys(new Set(['B']))
  const before = calls.publish
  b.prune(new Set(['B']))
  assert.equal(calls.publish, before + 1, '剔除 A → 发布')
  assert.ok(!published.at(-1).has('A'))
  // 再次全存活 → 不发布（与 :218 prev 无变化 return prev 同构）
  const before2 = calls.publish
  b.prune(new Set(['B']))
  assert.equal(calls.publish, before2, '无剔除 → 不得发布')
})

test('边界-4b：空 Map prune → 不发布（:218 prev.size===0 return prev 同构）', async () => {
  const { b, calls } = makeBatcher()
  b.prune(new Set(['A', 'B']))
  assert.equal(calls.publish, 0)
  assert.equal(calls.noop, 0)
})

// ── 边界：防复活（删除竞态） ────────────────────────────────────
test('边界-5：删除竞态 —— flush 前文件已删 → 不复活（setLiveKeys 已收敛）', async () => {
  const { b, calls, published } = makeBatcher()
  b.setLiveKeys(new Set(['A']))
  b.enqueue({ fileKeys: ['A'], value: val(2) })
  await tick()                       // A 已发布
  assert.equal(calls.publish, 1)
  // 用户在 flush 前删了 X（模拟 X 的响应 pending 中、effect#2 已跑）
  b.setLiveKeys(new Set(['A']))      // X 从未存活 —— 用另一场景
  // —— 真正竞态：X 响应在途，X 被删，flush 在 effect#2 之后
  const b2 = createImportHistoryBatcher({ debounceMs: 30, publish: () => {}, onNoop: () => {}, onPublish: () => {} })
  b2.setLiveKeys(new Set(['X']))     // 响应到达前 X 存活
  b2.enqueue({ fileKeys: ['X'], value: val(2) })
  b2.setLiveKeys(new Set([]))        // 响应到达后、flush 前 X 被删（effect#2）
  b2.prune(new Set([]))
  await new Promise((r) => setTimeout(r, 60))   // 等 30ms debounce flush
  // flush 用最新 liveKeys（空）→ X 不得复活
  const got = []
  b2.publish = (m) => got.push(m)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(got.length, 0, 'flush 不得用旧快照把已删 X 写回')
})

// ── 边界：dispose ──────────────────────────────────────────────
test('边界-6：dispose 后 enqueue/prune 静默忽略（组件卸载防御）', async () => {
  const { b, calls } = makeBatcher()
  b.dispose()
  b.enqueue({ fileKeys: ['A'], value: val(2) })
  b.prune(new Set(['A']))
  await tick()
  assert.equal(calls.publish, 0)
  assert.equal(calls.noop, 0)
})

// ── 纯函数快照：applyHistoryEntry 与 FileContext 原 updater 等价 ──
test('纯函数：多条目顺序应用 = 逐条 setState 的最终态（同构证据）', () => {
  const live = new Set(['A', 'B', 'C'])
  let cur = new Map()
  cur = applyHistoryEntry(cur, { fileKeys: ['A'], value: val(2) }, live)
  cur = applyHistoryEntry(cur, { fileKeys: ['B', 'C'], value: val(4) }, live)  // 同号广播
  cur = applyHistoryEntry(cur, { fileKeys: ['A'], value: val(5) }, live)        // latest wins
  assert.equal(cur.get('A').importCount, 5)
  assert.equal(cur.get('B').importCount, 4)
  assert.equal(cur.get('C').importCount, 4)
  assert.equal(cur.size, 3)
})
