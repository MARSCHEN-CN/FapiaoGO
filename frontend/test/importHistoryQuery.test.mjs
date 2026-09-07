// P2-L1：import-history 查询目标构建 + 去重守卫契约
//
// 目的：把「什么时候需要重查」从 React effect 生命周期里剥离出来，
//      绑定且仅绑定到「归一化发票号码集合是否变化」。
//
// 背景（回归根因）：FileContext.jsx 的 [files] effect cleanup 无条件执行
//   firedSigRef.current = ''
// 而 useSort 因「重复报销置顶」触发的 applySort → setFiles **只改变数组顺序**
//   （applySort 分区+索引排序+合并，file 对象引用原样搬移，见 utils.js:436-530），
// 号码集合实则未变 → 守卫本应命中跳过，却因签名被清空而整轮重查。
// 实测 200 文件场景：importHistoryQuery = 738 ≈ 3.5 轮 × ~200 唯一号。
//
// 覆盖：
//   L1-1 纯排序（同集合不同顺序）→ sig 不变 → 不重查
//   L1-2 新增文件（新号码）      → sig 变 → 重查一次
//   L1-3 删除文件                → sig 变 → 重查一次
//   L1-4 字段更新不改号码        → sig 不变 → 不重查
//   L1-5 归一化等价（大小写/空白）→ 视为同号 → 不重查
//   L1-6 status 未 parsed / 无号码 → 不进查询目标
//   L1-7 空集合 → sig 为 ''，无查询目标
//   L1-8 同号多 fileKey 聚合（多页发票广播语义不变）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeInvoiceNumber,
  buildQueryTargets,
  shouldFireQuery,
} from '../src/contexts/importHistoryQuery.js'

const f = (key, invoiceNumber, extra = {}) => ({
  key,
  status: 'parsed',
  invoiceNumber,
  ...extra,
})

test('L1-1 纯排序（同集合不同顺序）不触发重查', () => {
  const files = [f('a', 'INV001'), f('b', 'INV002'), f('c', 'INV003')]
  const first = buildQueryTargets(files)
  shouldFireQuery('', first.sig) === true // 首轮必查
  const reordered = [f('c', 'INV003'), f('a', 'INV001'), f('b', 'INV002')]
  const second = buildQueryTargets(reordered)
  assert.equal(second.sig, first.sig, '排序不得改变签名')
  assert.equal(shouldFireQuery(first.sig, second.sig), false, '同集合不得重查')
})

test('L1-2 新增文件（新号码）触发一次重查', () => {
  const before = buildQueryTargets([f('a', 'INV001')])
  const after = buildQueryTargets([f('a', 'INV001'), f('b', 'INV002')])
  assert.notEqual(after.sig, before.sig)
  assert.equal(shouldFireQuery(before.sig, after.sig), true)
})

test('L1-3 删除文件触发一次重查', () => {
  const before = buildQueryTargets([f('a', 'INV001'), f('b', 'INV002')])
  const after = buildQueryTargets([f('a', 'INV001')])
  assert.notEqual(after.sig, before.sig)
  assert.equal(shouldFireQuery(before.sig, after.sig), true)
})

test('L1-4 非号码字段更新（金额/日期/状态内变化）不触发重查', () => {
  const before = buildQueryTargets([f('a', 'INV001', { amount: '1.00' })])
  const after = buildQueryTargets([
    f('a', 'INV001', { amount: '2.00', invoiceDate: '2026-01-01' }),
  ])
  assert.equal(after.sig, before.sig)
  assert.equal(shouldFireQuery(before.sig, after.sig), false)
})

test('L1-5 归一化等价（大小写 / 内部空白）视为同一号码', () => {
  const a = buildQueryTargets([f('a', 'inv 001')])
  const b = buildQueryTargets([f('a', 'INV001')])
  assert.equal(a.sig, b.sig)
  assert.equal(normalizeInvoiceNumber(' inv 001 '), 'INV001')
})

test('L1-6 未 parsed 或无号码的文件不进查询目标', () => {
  const targets = buildQueryTargets([
    f('a', 'INV001'),
    f('b', 'INV002', { status: 'parsing' }),
    f('c', ''),
    f('d', null),
    f('e', '   '),
  ])
  assert.equal(targets.byNumber.size, 1)
  assert.deepEqual(targets.byNumber.get('INV001'), ['a'])
})

test('L1-7 空集合 → 无查询目标，签名为空串', () => {
  const targets = buildQueryTargets([])
  assert.equal(targets.byNumber.size, 0)
  assert.equal(targets.sig, '')
  assert.equal(shouldFireQuery('', targets.sig), false)
})

test('L1-8 同号多 fileKey 聚合（多页发票广播语义不变）', () => {
  const targets = buildQueryTargets([
    f('p1', 'INV001'),
    f('p2', 'INV001'),
    f('p3', 'INV002'),
  ])
  assert.equal(targets.byNumber.size, 2)
  assert.deepEqual(targets.byNumber.get('INV001'), ['p1', 'p2'])
  assert.deepEqual(targets.byNumber.get('INV002'), ['p3'])
})
