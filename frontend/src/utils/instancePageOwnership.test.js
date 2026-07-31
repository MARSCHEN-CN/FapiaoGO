/**
 * IS-4.2 Step 4.3: Hydration Page Ownership Fix — 验收测试
 *
 * 运行：node --test src/utils/instancePageOwnership.test.js
 * 纯函数，零依赖、零网络。
 *
 * 验收矩阵（与冻结方案一致）：
 *   Case A 同内容不同实例：A/B 共享 sourceDocId=H、instanceId 不同 → 各自只收自己的页。
 *   Case B 多页同实例：C 的 3 页共享 instanceId=M → 聚合为 3 页。
 *   Case C legacy 无 instanceId：回退 sourceDocId 过滤 + fallback 标志（调用方告警）+ 不丢数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { resolveInstancePageFiles } = await import('../utils/instancePageOwnership.js')

test('Case A：同内容不同实例 → 各自收自己的页，互不吸收', () => {
  const A = { key: 'A.pdf', instanceId: 'A', sourceDocId: 'H', docId: 'H', pageNum: 1 }
  const B = { key: 'B.pdf', instanceId: 'B', sourceDocId: 'H', docId: 'H', pageNum: 1 }
  const matchingFiles = [A, B] // 同内容同票号 → invoiceNumber 匹配到两者

  const ra = resolveInstancePageFiles(matchingFiles, { instanceId: 'A', sourceDocId: 'H', invoiceNumber: 'N' })
  assert.deepEqual(ra.files, [A], 'assembled A 只应收 A 的页')
  assert.equal(ra.fallback, 'none')

  const rb = resolveInstancePageFiles(matchingFiles, { instanceId: 'B', sourceDocId: 'H', invoiceNumber: 'N' })
  assert.deepEqual(rb.files, [B], 'assembled B 只应收 B 的页')
  assert.equal(rb.fallback, 'none')
})

test('Case B：多页同实例 → 3 页完整聚合', () => {
  const p1 = { key: 'C_p1', instanceId: 'M', sourceDocId: 'HC', docId: 'HC', pageNum: 1 }
  const p2 = { key: 'C_p2', instanceId: 'M', sourceDocId: 'HC', docId: 'HC', pageNum: 2 }
  const p3 = { key: 'C_p3', instanceId: 'M', sourceDocId: 'HC', docId: 'HC', pageNum: 3 }
  const r = resolveInstancePageFiles([p1, p2, p3], { instanceId: 'M', sourceDocId: 'HC', invoiceNumber: 'N' })
  assert.equal(r.files.length, 3, '同实例 3 页应全部聚合')
  assert.equal(r.fallback, 'none')
})

test('Case C：缺少 instanceId → legacy sourceDocId 过滤（fallback 标志，不丢数据）', () => {
  const A = { key: 'A.pdf', sourceDocId: 'H', docId: 'H', pageNum: 1 }
  const X = { key: 'X.pdf', sourceDocId: 'OTHER', docId: 'OTHER', pageNum: 1 }
  const r = resolveInstancePageFiles([A, X], { sourceDocId: 'H', invoiceNumber: 'N' })
  assert.deepEqual(r.files, [A], '应按 sourceDocId=H 过滤')
  assert.equal(r.fallback, 'missing-instanceId', '调用方据此告警')
})

test('instanceId 失配（异常态）→ 回退 sourceDocId，避免静默丢失', () => {
  const A = { key: 'A.pdf', instanceId: 'A', sourceDocId: 'H', docId: 'H', pageNum: 1 }
  const r = resolveInstancePageFiles([A], { instanceId: 'GHOST', sourceDocId: 'H', invoiceNumber: 'N' })
  assert.deepEqual(r.files, [A], '回退 sourceDocId=H 应收回 A')
  assert.equal(r.fallback, 'instance-mismatch')
})

test('边界：instanceId 与 sourceDocId 皆无 → 返回全部候选（不过滤）', () => {
  const A = { key: 'A.pdf', pageNum: 1 }
  const r = resolveInstancePageFiles([A], { invoiceNumber: 'N' })
  assert.deepEqual(r.files, [A])
  assert.equal(r.fallback, 'missing-instanceId')
})

test('健壮性：空候选 / null assembled 不崩溃', () => {
  assert.deepEqual(resolveInstancePageFiles([], { instanceId: 'A' }).files, [])
  assert.deepEqual(resolveInstancePageFiles(null, null).files, [])
})
