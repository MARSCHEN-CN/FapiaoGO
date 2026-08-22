/**
 * IS-4.2 Step 4.1: DocumentStore Identity Switch — 验收测试
 *
 * 运行：node --test src/stores/DocumentStore.identity.test.js
 * 不依赖 React / 网络：直接调用 DocumentStore 纯函数。
 *
 * 核心验收：同内容 A/B（同 docId=H，不同 instanceId I1/I2）落入不同键，
 * size === 2 且各自可取回；无 instanceId 的旧数据回退 docId，行为不变。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const {
  resolveDocumentIdentity,
  registerDocument,
  getDocument,
  removeDocument,
  ensureDocumentFromFileObj,
  ensureDocumentFromMetadata,
  getDocumentCount,
  getRegisteredDocIds,
  clearAllDocuments,
} = await import('../stores/DocumentStore.js')
const { createDocument, createPageMeta } = await import('../models/InvoiceDocument.js')

function makeDoc(docId, instanceId) {
  const page = createPageMeta({ docId, index: 0, width: 595, height: 842 })
  const doc = createDocument({ docId, pages: [page] })
  if (instanceId) doc.instanceId = instanceId
  return doc
}

test('resolveDocumentIdentity：instanceId 优先，回退 docId / id / 字符串透传', () => {
  // 同时有 instanceId 和 invoiceDocumentId 时，使用复合键
  assert.equal(resolveDocumentIdentity({ instanceId: 'I1', invoiceDocumentId: 'INV001', docId: 'H' }), 'I1::INV001')
  // 只有 instanceId 时，使用 instanceId
  assert.equal(resolveDocumentIdentity({ instanceId: 'I1', docId: 'H' }), 'I1')
  // 只有 invoiceDocumentId 时，使用 invoiceDocumentId
  assert.equal(resolveDocumentIdentity({ invoiceDocumentId: 'INV001', docId: 'H' }), 'INV001')
  // 都没有时，使用 docId
  assert.equal(resolveDocumentIdentity({ docId: 'H' }), 'H')
  assert.equal(resolveDocumentIdentity({ id: 'X' }), 'X')
  assert.equal(resolveDocumentIdentity('H'), 'H')
  assert.equal(resolveDocumentIdentity(null), null)
  assert.equal(resolveDocumentIdentity({}), null)
})

test('Case A/B：同 docId 不同 instanceId → size 2，各自可取回', () => {
  clearAllDocuments()
  registerDocument(makeDoc('H', 'I1'))
  registerDocument(makeDoc('H', 'I2'))
  assert.equal(getDocumentCount(), 2, '同内容 A/B 应共存为 2 个键')
  assert.equal(getDocument('I1').docId, 'H')
  assert.equal(getDocument('I2').docId, 'H')
  assert.equal(getDocument('I1').instanceId, 'I1')
  assert.equal(getDocument('I2').instanceId, 'I2')
  // 键集合应为 {I1, I2}，而非 {H}
  assert.deepEqual(getRegisteredDocIds().sort(), ['I1', 'I2'])
})

test('向后兼容：无 instanceId 的旧数据仍按 docId 键', () => {
  clearAllDocuments()
  registerDocument(makeDoc('H', ''))
  assert.equal(getDocumentCount(), 1)
  assert.equal(getDocument('H').docId, 'H')
  assert.deepEqual(getRegisteredDocIds(), ['H'])
})

test('removeDocument 按 instanceId 精准移除，不误删同内容兄弟', () => {
  clearAllDocuments()
  registerDocument(makeDoc('H', 'I1'))
  registerDocument(makeDoc('H', 'I2'))
  removeDocument('I1')
  assert.equal(getDocumentCount(), 1, '只应移除 I1')
  assert.equal(getDocument('I1'), null)
  assert.equal(getDocument('I2').docId, 'H', 'I2 应保留')
})

test('ensureDocumentFromFileObj：提供 instanceId 时按复合键存储', () => {
  clearAllDocuments()
  const fileObj = { key: 'a.pdf', docId: 'H', pageNum: 1 }
  const doc = ensureDocumentFromFileObj(fileObj, null, {}, 'I1')
  assert.equal(doc.instanceId, 'I1')
  assert.ok(doc.invoiceDocumentId, '应生成 invoiceDocumentId')
  assert.equal(getDocumentCount(), 1)
  // 使用复合键查找：${instanceId}::${invoiceDocumentId}
  const expectedKey = `I1::${doc.invoiceDocumentId}`
  const found = getDocument(expectedKey)
  assert.ok(found, `应能通过复合键 ${expectedKey} 找到文档`)
  assert.equal(found.docId, 'H')
  // 同内容第二实例
  const doc2 = ensureDocumentFromFileObj({ key: 'b.pdf', docId: 'H', pageNum: 1 }, null, {}, 'I2')
  assert.equal(getDocumentCount(), 2, '同内容 A/B 经 fileObj 路径也应共存')
  // 两个文档的 invoiceDocumentId 不同（因为 key 不同）
  assert.notEqual(doc.invoiceDocumentId, doc2.invoiceDocumentId, '不同文件应有不同 invoiceDocumentId')
})

test('ensureDocumentFromMetadata：提供 instanceId 时按复合键存储', () => {
  clearAllDocuments()
  const doc = ensureDocumentFromMetadata(
    { docId: 'H', pages: [{ index: 0, width: 2480, height: 3508, rotation: 0 }] },
    {},
    'I1',
  )
  assert.equal(doc.instanceId, 'I1')
  assert.ok(doc.invoiceDocumentId, '应生成 invoiceDocumentId')
  // 使用复合键查找
  const expectedKey = `I1::${doc.invoiceDocumentId}`
  const found = getDocument(expectedKey)
  assert.ok(found, `应能通过复合键 ${expectedKey} 找到文档`)
  assert.equal(found.pageCount, 1)
  // 同内容第二实例
  const doc2 = ensureDocumentFromMetadata(
    { docId: 'H', pages: [{ index: 0, width: 2480, height: 3508, rotation: 0 }] },
    {},
    'I2',
  )
  assert.equal(getDocumentCount(), 2, '同内容 A/B 经 metadata 路径也应共存')
  // invoiceDocumentId 可以相同（相同内容），但 instanceId 不同，所以复合键不同
  assert.notEqual(`${doc.instanceId}::${doc.invoiceDocumentId}`, `${doc2.instanceId}::${doc2.invoiceDocumentId}`, '不同实例应有不同复合键')
})

test('ensureDocumentFromMetadata：无 instanceId 回退 invoiceDocumentId', () => {
  clearAllDocuments()
  const doc = ensureDocumentFromMetadata({
    docId: 'ofd1',
    pages: [{ index: 0, width: 2480, height: 3508, rotation: 0 }],
  })
  assert.equal(doc.instanceId, '', '无 instanceId 时默认为空字符串')
  assert.ok(doc.invoiceDocumentId, '应生成 invoiceDocumentId')
  // 无 instanceId 时，存储键 = invoiceDocumentId
  const found = getDocument(doc.invoiceDocumentId)
  assert.ok(found, '应能通过 invoiceDocumentId 找到文档')
  assert.equal(found.pageCount, 1)
})
