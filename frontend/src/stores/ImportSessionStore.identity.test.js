/**
 * IS-4.2 Step 4.2: ImportSessionStore Identity Switch — 验收测试
 *
 * 运行：node --test src/stores/ImportSessionStore.identity.test.js
 * 不依赖 React / 网络：直接调用 ImportSessionStore 纯函数。
 *
 * 核心验收：addDocument 去重键 = invoiceDocumentId || instanceId || docId || id。
 *   - 同内容 A/B（同 docId，不同 instanceId）→ 各自保留（length 2）。
 *   - 同 instanceKey 重复 → 拒绝覆盖（length 1, addDocument 返回 false）。
 *   - docId 优先于 id（发票实体边界合同 §四，2026-08-05 统一）。
 *
 * ⚠️ 2026-08-05 变更：
 *   - addDocument 从 overwrite 变为 append-only（拒绝覆盖已存在条目）
 *   - 身份回退顺序统一为 instanceId || docId || id（docId 优先于 id）
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const {
  createImportSession,
  addDocument,
  getSession,
  resolveDocumentInstanceKey,
} = await import('../stores/ImportSessionStore.js')

const docsOf = (sessionId) => getSession(sessionId).documents

test('resolveDocumentInstanceKey：instanceId 优先，回退 docId || id', () => {
  assert.equal(resolveDocumentInstanceKey({ instanceId: 'I1', id: 'X', docId: 'H' }), 'I1')
  assert.equal(resolveDocumentInstanceKey({ id: 'X', docId: 'H' }), 'H', 'docId 优先于 id（统一后）')
  assert.equal(resolveDocumentInstanceKey({ id: 'X' }), 'X')
  assert.equal(resolveDocumentInstanceKey({ docId: 'H' }), 'H')
  assert.equal(resolveDocumentInstanceKey(null), null)
  assert.equal(resolveDocumentInstanceKey({}), null)
})

test('Case A/B：同 docId 不同 instanceId → documents.length === 2', () => {
  const s = createImportSession()
  addDocument(s.id, { instanceId: 'I1', docId: 'HASH', pages: [{}] })
  addDocument(s.id, { instanceId: 'I2', docId: 'HASH', pages: [{}] })
  assert.equal(docsOf(s.id).length, 2, '同内容 A/B 应各自保留')
})

test('同 instanceKey 重复：addDocument 拒绝覆盖 → length === 1', () => {
  const s = createImportSession()
  const r1 = addDocument(s.id, { instanceId: 'I1', docId: 'HASH', pages: [{}] })
  const r2 = addDocument(s.id, { instanceId: 'I1', docId: 'HASH', pages: [{}] })
  assert.equal(r1, true, '首次添加应成功')
  assert.equal(r2, false, '重复添加应拒绝')
  assert.equal(docsOf(s.id).length, 1, '覆盖被拒绝后仍为 1')
})

test('append-only：同 instanceKey 文档不会替换旧版本', () => {
  const s = createImportSession()
  addDocument(s.id, { instanceId: 'I1', docId: 'HASH', pages: [{ index: 0 }], amount: '100.00' })
  // 尝试覆盖（应被拒绝）
  const r = addDocument(s.id, { instanceId: 'I1', docId: 'HASH', pages: [{ index: 0 }, { index: 1 }], amount: '999.00' })
  assert.equal(r, false, '覆盖被拒绝')
  assert.equal(docsOf(s.id).length, 1)
  assert.equal(docsOf(s.id)[0].amount, '100.00', '旧版本数据未被覆盖')
  assert.equal(docsOf(s.id)[0].pages.length, 1, '页数未被替换')
})

test('legacy：无 instanceId 按 docId 去重（旧行为不变）', () => {
  const s = createImportSession()
  addDocument(s.id, { docId: 'HASH', pages: [{}] })
  addDocument(s.id, { docId: 'HASH', pages: [{}] })
  assert.equal(docsOf(s.id).length, 1, '同 docId 应去重为 1')
  addDocument(s.id, { docId: 'OTHER', pages: [{}] })
  assert.equal(docsOf(s.id).length, 2)
})

test('legacy：docId 优先于 id（统一后语义）', () => {
  const s = createImportSession()
  addDocument(s.id, { id: 'X', docId: 'H1', pages: [{}] })
  addDocument(s.id, { id: 'X', docId: 'H2', pages: [{}] }) // 同 id 但不同 docId → docId 优先 → 不同键
  assert.equal(docsOf(s.id).length, 2, 'docId 优先 → 不同 docId = 不同键')
})

test('来源检查：拒绝 file_update 来源', () => {
  const s = createImportSession()
  const r = addDocument(s.id, { instanceId: 'I1', docId: 'HASH', pages: [{}] }, { source: 'file_update' })
  assert.equal(r, false, 'file_update 来源应被拒绝')
  assert.equal(docsOf(s.id).length, 0)
})
