// P2-L2：批量查询 + 原子发布契约
//
// 目标链路（替代旧的 runPool(6) 逐号 GET）：
//   files → 归一化号集合 → 守卫 → POST /api/import-history/batch
//   → 一次性构建全部 entries → 一次 publish → applySort 至多一次
//
// 覆盖：
//   L2-1 buildHistoryEntries：未命中（null / exists!==true）跳过
//   L2-2 首次导入不算重复报销：importCount < 2 跳过（历史记录由本次导入创建）
//   L2-3 同号多 fileKey 广播语义不变（一条 entry 携带全部 fileKeys）
//   L2-4 结果中缺失的号 / 多余的号：前者跳过，后者忽略
//   L2-5 一次性提交 → publish 恰好 1 次（对比：分批提交会多次 publish）
//   L2-6 空结果 → 不发布、不产生 entries

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHistoryEntries } from '../src/contexts/importHistoryQuery.js'
import { createImportHistoryBatcher } from '../src/contexts/importHistoryBatcher.js'

const rec = (importCount, extra = {}) => ({
  exists: true,
  invoiceDate: extra.invoiceDate ?? '2026-01-01',
  firstImportedAt: extra.firstImportedAt ?? '2026-01-01T00:00:00+08:00',
  importCount,
  dateMismatchCount: extra.dateMismatchCount ?? 0,
})

const tick = () => new Promise((r) => setTimeout(r, 5))

function makeBatcher(liveKeys = []) {
  const calls = { publish: 0, noop: 0 }
  const b = createImportHistoryBatcher({
    debounceMs: 0,
    publish: () => { calls.publish++ },
    onNoop: () => { calls.noop++ },
    onPublish: () => {},
  })
  b.setLiveKeys(new Set(liveKeys))
  return { b, calls }
}

test('L2-1 未命中（null / exists!==true）不产生 entry', () => {
  const byNumber = new Map([['A', ['k1']], ['B', ['k2']], ['C', ['k3']]])
  const entries = buildHistoryEntries(byNumber, {
    A: null,
    B: { exists: false },
    C: rec(3),
  })
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0].fileKeys, ['k3'])
})

test('L2-2 首次导入（importCount<2）不算重复报销，跳过', () => {
  const byNumber = new Map([['A', ['k1']], ['B', ['k2']], ['C', ['k3']]])
  const entries = buildHistoryEntries(byNumber, {
    A: rec(1),
    B: rec(2),
    C: rec(0),
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].value.importCount, 2)
})

test('L2-3 同号多 fileKey：一条 entry 携带全部 key（广播语义不变）', () => {
  const byNumber = new Map([['A', ['p1', 'p2', 'p3']]])
  const entries = buildHistoryEntries(byNumber, { A: rec(5) })
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0].fileKeys, ['p1', 'p2', 'p3'])
})

test('L2-4 结果缺失的号跳过、多余的号忽略', () => {
  const byNumber = new Map([['A', ['k1']], ['MISSING', ['k2']]])
  const entries = buildHistoryEntries(byNumber, {
    A: rec(2),
    EXTRA: rec(9),   // 不在 byNumber 中
  })
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0].fileKeys, ['k1'])
})

test('L2-5 一次性提交 → publish 恰好 1 次（分批提交则多次）', async () => {
  const keys = Array.from({ length: 100 }, (_, i) => `k${i}`)
  const entries = keys.map((k) => ({ fileKeys: [k], value: rec(2) }))

  // 一次性提交（P2-L2 目标形态）
  const one = makeBatcher(keys)
  for (const e of entries) one.b.enqueue(e)
  one.b.flush()
  await tick()
  assert.equal(one.calls.publish, 1, '100 条一次性提交只应发布 1 次')

  // 对照：分批到达（旧的逐号 GET 形态）→ 多次发布
  const many = makeBatcher(keys)
  for (let i = 0; i < entries.length; i++) {
    many.b.enqueue(entries[i])
    if (i % 10 === 9) { many.b.flush(); await tick() }
  }
  assert.ok(many.calls.publish >= 10, `分批提交应多次发布，实际 ${many.calls.publish}`)
})

test('L2-6 空结果不产生 entries、不发布', async () => {
  const byNumber = new Map([['A', ['k1']]])
  const entries = buildHistoryEntries(byNumber, {})
  assert.equal(entries.length, 0)
  const { b, calls } = makeBatcher(['k1'])
  b.flush()
  await tick()
  assert.equal(calls.publish, 0)
})
