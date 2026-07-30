/**
 * IS-4.2 Step 4.2: ImportSessionStore Identity Switch — 验收测试
 *
 * 运行：node --test src/stores/ImportSessionStore.identity.test.js
 * 不依赖 React / 网络：直接调用 ImportSessionStore 纯函数。
 *
 * 核心验收：addDocument 去重键 = instanceId || id || docId。
 *   - 同内容 A/B（同 docId，不同 instanceId）→ 各自保留（length 2）。
 *   - 同 instanceId 重复 → 去重（length 1）。
 *   - 无 instanceId 的旧数据 → 回退 id || docId，行为不变。
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

test('resolveDocumentInstanceKey：instanceId 优先，回退 id || docId', () => {
  assert.equal(resolveDocumentInstanceKey({ instanceId: 'I1', id: 'X', docId: 'H' }), 'I1')
  assert.equal(resolveDocumentInstanceKey({ id: 'X', docId: 'H' }), 'X')
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

test('同 instance 重复：相同 instanceId 两次 → length === 1', () => {
  const s = createImportSession()
  addDocument(s.id, { instanceId: 'I1', docId: 'HASH', pages: [{}] })
  addDocument(s.id, { instanceId: 'I1', docId: 'HASH', pages: [{}] })
  assert.equal(docsOf(s.id).length, 1, '同实例应去重')
})

test('legacy：无 instanceId 按 docId 去重（旧行为不变）', () => {
  const s = createImportSession()
  addDocument(s.id, { docId: 'HASH', pages: [{}] })
  addDocument(s.id, { docId: 'HASH', pages: [{}] })
  assert.equal(docsOf(s.id).length, 1, '同 docId 应去重为 1')
  addDocument(s.id, { docId: 'OTHER', pages: [{}] })
  assert.equal(docsOf(s.id).length, 2)
})

test('legacy：id 优先于 docId（沿用旧口径 d.id || d.docId）', () => {
  const s = createImportSession()
  addDocument(s.id, { id: 'X', docId: 'H1', pages: [{}] })
  addDocument(s.id, { id: 'X', docId: 'H2', pages: [{}] }) // 同 id → 去重
  assert.equal(docsOf(s.id).length, 1, 'id 相同应去重（即使 docId 不同）')
})
