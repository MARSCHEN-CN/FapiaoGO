/**
 * IS-4.2 Step 4.2: ImportSessionStore Identity Switch — 验收测试
 *
 * 运行：node --test src/stores/ImportSessionStore.identity.test.js
 * 不依赖 React / 网络：直接调用 ImportSessionStore 纯函数。
 *
 * Contract C: Document Instance Identity = Import Instance × Invoice Identity
 *
 * 核心验收：
 *   I-1: 相同内容、不同 instanceId → 两个独立 Document
 *   I-2: 同一 Document 重复 add → 幂等，只一个
 *   I-3: 不同内容、不同实例 → 两个独立 Document
 *   I-4: 同一 instanceId、多张不同发票 → 多个 Document
 *   I-5: 缺失 instanceId → 不得静默退化为 content identity
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const {
  createImportSession,
  addDocument,
  getSession,
  resolveDocumentInstanceKey,
  deleteDocumentByInstanceKey,
} = await import('../stores/ImportSessionStore.js')

const docsOf = (sessionId) => getSession(sessionId).documents

// ── Identity Resolver Tests ──────────────────────────────

test('resolveDocumentInstanceKey: instanceId + invoiceDocumentId → 组合 key', () => {
  const key = resolveDocumentInstanceKey({ instanceId: 'I1', invoiceDocumentId: 'INV-A' })
  assert.equal(key, 'I1::INV-A', '应为 instanceId::invoiceDocumentId 格式')
})

test('I-5: 缺失 instanceId → 返回 null（不得静默 fallback）', () => {
  const key = resolveDocumentInstanceKey({ invoiceDocumentId: 'INV-A', docId: 'HASH' })
  assert.equal(key, null, '缺失 instanceId 时应返回 null，不得退化为 content identity')
})

test('I-5: 缺失 invoiceDocumentId → 返回 null', () => {
  const key = resolveDocumentInstanceKey({ instanceId: 'I1', docId: 'HASH' })
  assert.equal(key, null, '缺失 invoiceDocumentId 时应返回 null')
})

test('I-5: 两者都缺失 → 返回 null', () => {
  const key = resolveDocumentInstanceKey({ docId: 'HASH' })
  assert.equal(key, null)
})

test('resolveDocumentInstanceKey: null/undefined/empty obj → null', () => {
  assert.equal(resolveDocumentInstanceKey(null), null)
  assert.equal(resolveDocumentInstanceKey(undefined), null)
  assert.equal(resolveDocumentInstanceKey({}), null)
})

// ── I-1: 相同内容，不同 instanceId → 两个独立 Document ──

test('I-1: 相同内容 A/B → 两个独立 Document', () => {
  const s = createImportSession()
  const r1 = addDocument(s.id, { instanceId: 'I1', invoiceDocumentId: 'INV-N001', pages: [{}] })
  const r2 = addDocument(s.id, { instanceId: 'I2', invoiceDocumentId: 'INV-N001', pages: [{}] })
  assert.equal(r1, true, 'A 添加成功')
  assert.equal(r2, true, 'B 添加成功')
  assert.equal(docsOf(s.id).length, 2, '相同内容不同实例应为两个独立 Document')
})

// ── I-2: 同一 Document 重复 add → 幂等 ──

test('I-2: 同实例重复 add → 幂等，只一个', () => {
  const s = createImportSession()
  const r1 = addDocument(s.id, { instanceId: 'I1', invoiceDocumentId: 'INV-N001', pages: [{}] })
  const r2 = addDocument(s.id, { instanceId: 'I1', invoiceDocumentId: 'INV-N001', pages: [{}] })
  assert.equal(r1, true, '首次添加成功')
  assert.equal(r2, false, '重复添加应被拒绝（幂等）')
  assert.equal(docsOf(s.id).length, 1, '幂等：仍为 1')
})

// ── I-3: 不同内容、不同实例 → 两个独立 Document ──

test('I-3: 不同内容、不同实例 → 两个独立 Document', () => {
  const s = createImportSession()
  const r1 = addDocument(s.id, { instanceId: 'I1', invoiceDocumentId: 'INV-N001', pages: [{}] })
  const r2 = addDocument(s.id, { instanceId: 'I2', invoiceDocumentId: 'INV-N002', pages: [{}] })
  assert.equal(r1, true)
  assert.equal(r2, true)
  assert.equal(docsOf(s.id).length, 2)
})

// ── I-4: 同一 instanceId，多张不同发票 → 多个 Document ──

test('I-4: 同 instanceId，多票隔离', () => {
  const s = createImportSession()
  const r1 = addDocument(s.id, { instanceId: 'I1', invoiceDocumentId: 'INV-N001', pages: [{}] })
  const r2 = addDocument(s.id, { instanceId: 'I1', invoiceDocumentId: 'INV-N002', pages: [{}] })
  assert.equal(r1, true, '第一张发票成功')
  assert.equal(r2, true, '第二张发票成功（同实例不同发票）')
  assert.equal(docsOf(s.id).length, 2, '同实例不同发票应为两个独立 Document')
})

// ── INV-I2: 不同实例 + 同发票 → different key ──

test('INV-I2: 不同实例 + 同发票 → different key', () => {
  const keyA = resolveDocumentInstanceKey({ instanceId: 'I1', invoiceDocumentId: 'INV-X' })
  const keyB = resolveDocumentInstanceKey({ instanceId: 'I2', invoiceDocumentId: 'INV-X' })
  assert.notEqual(keyA, keyB, '不同实例的相同内容应有不同的 instanceKey')
})

// ── INV-I3: 同实例 + 不同发票 → different key ──

test('INV-I3: 同实例 + 不同发票 → different key', () => {
  const keyA = resolveDocumentInstanceKey({ instanceId: 'I1', invoiceDocumentId: 'INV-N001' })
  const keyB = resolveDocumentInstanceKey({ instanceId: 'I1', invoiceDocumentId: 'INV-N002' })
  assert.notEqual(keyA, keyB, '同实例不同发票应有不同的 instanceKey')
})

// ── INV-I1: 同实例 + 同发票 → same key ──

test('INV-I1: 同实例 + 同发票 → same key（幂等）', () => {
  const key1 = resolveDocumentInstanceKey({ instanceId: 'I1', invoiceDocumentId: 'INV-X' })
  const key2 = resolveDocumentInstanceKey({ instanceId: 'I1', invoiceDocumentId: 'INV-X' })
  assert.equal(key1, key2, '相同实例相同发票应有相同的 instanceKey')
})

// ── Contract D: 删除闭包不得扩大 ──

test('R-1: deleteDocumentByInstanceKey 精确删除', () => {
  const s = createImportSession()
  addDocument(s.id, { instanceId: 'I1', invoiceDocumentId: 'INV-A', pages: [{ key: 'p1' }] })
  addDocument(s.id, { instanceId: 'I2', invoiceDocumentId: 'INV-A', pages: [{ key: 'p2' }] })
  assert.equal(docsOf(s.id).length, 2, '应先有 2 个文档')

  // 精确删除 I2 实例
  const keyB = resolveDocumentInstanceKey({ instanceId: 'I2', invoiceDocumentId: 'INV-A' })
  const result = deleteDocumentByInstanceKey(s.id, keyB)
  assert.equal(result.success, true, '删除应成功')
  assert.equal(result.deletedCount, 1, '只应删除 1 个实例')

  // I1 应保留
  assert.equal(docsOf(s.id).length, 1, 'I1 应保留')
  assert.equal(docsOf(s.id)[0].instanceId, 'I1', '保留的是 I1')
})

test('R-2: 删除不存在的 instanceKey → 不影响其他文档', () => {
  const s = createImportSession()
  addDocument(s.id, { instanceId: 'I1', invoiceDocumentId: 'INV-A', pages: [{}] })
  const result = deleteDocumentByInstanceKey(s.id, 'non_existent_key')
  assert.equal(result.success, false, '删除不存在的 key 应返回 false')
  assert.equal(result.deletedCount, 0)
  assert.equal(docsOf(s.id).length, 1, '原文档不受影响')
})

// ── append-only 行为验证 ──

test('append-only: 同 instanceKey 文档不会替换旧版本', () => {
  const s = createImportSession()
  addDocument(s.id, { instanceId: 'I1', invoiceDocumentId: 'INV-A', pages: [{ index: 0 }], amount: '100.00' })
  const r = addDocument(s.id, { instanceId: 'I1', invoiceDocumentId: 'INV-A', pages: [{ index: 0 }, { index: 1 }], amount: '999.00' })
  assert.equal(r, false, '覆盖被拒绝')
  assert.equal(docsOf(s.id).length, 1)
  assert.equal(docsOf(s.id)[0].amount, '100.00', '旧版本数据未被覆盖')
  assert.equal(docsOf(s.id)[0].pages.length, 1, '页数未被替换')
})

// ── 来源检查 ──

test('来源检查：拒绝 file_update 来源', () => {
  const s = createImportSession()
  const r = addDocument(s.id, { instanceId: 'I1', invoiceDocumentId: 'INV-A', pages: [{}] }, { source: 'file_update' })
  assert.equal(r, false, 'file_update 来源应被拒绝')
  assert.equal(docsOf(s.id).length, 0)
})
