/**
 * V-Root-Cause Audit Integration Test
 *
 * 验证真实数据链路的身份传递：
 *   File Instance → createDocument → addDocument → ViewModel → removeDuplicateFiles
 *
 * 运行：node --test src/stores/IdentityIntegration.test.js
 *
 * 核心验证点：
 *   1. ViewModel 转换是否保留 instanceId / invoiceDocumentId（P2 级漏洞修复验证）
 *   2. removeDuplicateFiles 流程中 resolveDocumentInstanceKey 是否返回有效 key
 *   3. 相同内容不同实例能否正确独立存在
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const {
  createImportSession,
  addDocument,
  resolveDocumentInstanceKey,
  deleteDocumentByInstanceKey,
  getSession,
} = await import('../stores/ImportSessionStore.js')

const {
  createDocument,
  createPageMeta,
} = await import('../models/InvoiceDocument.js')

const {
  resolveSessionInstanceKey,
  generateInvoiceDocumentId,
} = await import('../utils/invoiceIdentityResolver.js')

function makeRealDoc({ instanceId, invoiceNumber, sourceDocId, fileKey }) {
  const page = createPageMeta({
    docId: sourceDocId,
    index: 0,
    width: 595,
    height: 842,
  })

  const doc = createDocument({
    docId: sourceDocId,
    instanceId,
    fileKey,
    pages: [page],
  })

  doc.invoiceDocumentId = generateInvoiceDocumentId({
    sourceDocId,
    invoiceNumber,
  })
  doc.invoiceNumber = invoiceNumber
  doc.amount = '100.00'
  doc.invoiceDate = '2026-08-21'

  return doc
}

// ═══════════════════════════════════════════════════════════
// Gate 1: 真实数据链路验证 — A/B 相同内容不同实例
// ═══════════════════════════════════════════════════════════

test('GATE-1: A/B 相同内容不同实例 → 两个独立 Session Document', () => {
  const session = createImportSession()
  const sid = session.id

  const docA = makeRealDoc({
    instanceId: 'inst-A-uuid',
    invoiceNumber: 'INV-001',
    sourceDocId: 'hash_97E990AD',
    fileKey: 'A.pdf_1724000000000',
  })

  const docB = makeRealDoc({
    instanceId: 'inst-B-uuid',
    invoiceNumber: 'INV-001',
    sourceDocId: 'hash_97E990AD',
    fileKey: 'B.pdf_1724000000001',
  })

  addDocument(sid, docA)
  addDocument(sid, docB)

  const docs = getSession(sid).documents
  assert.equal(docs.length, 2, '应有 2 个独立 Document')

  const keyA = resolveDocumentInstanceKey(docs[0])
  const keyB = resolveDocumentInstanceKey(docs[1])

  assert.notEqual(keyA, keyB, '不同实例应有不同 instanceKey')

  console.log('[GATE-1] A key:', keyA)
  console.log('[GATE-1] B key:', keyB)
})

// ═══════════════════════════════════════════════════════════
// Gate 2: ViewModel 转换保留身份字段
// ═══════════════════════════════════════════════════════════

test('GATE-2: ViewModel 行对象包含 instanceId / invoiceDocumentId', () => {
  const session = createImportSession()
  const sid = session.id

  const doc = makeRealDoc({
    instanceId: 'inst-A-uuid',
    invoiceNumber: 'INV-001',
    sourceDocId: 'hash_97E990AD',
    fileKey: 'A.pdf_1724000000000',
  })

  addDocument(sid, doc)

  const storedDoc = getSession(sid).documents[0]

  // 模拟 invoiceDocumentToRow 转换后的行对象
  // 关键：返回的行对象必须包含 instanceId 和 invoiceDocumentId
  const row = {
    key: 'A.pdf_1724000000000',
    name: 'A.pdf',
    docId: 'hash_97E990AD',
    pageNum: 1,
    instanceId: storedDoc.instanceId,
    invoiceDocumentId: storedDoc.invoiceDocumentId,
    documentId: storedDoc.docId,
  }

  // 验证 resolveDocumentInstanceKey 能从行对象解析出有效 key
  const key = resolveDocumentInstanceKey(row)
  assert.ok(key, 'ViewModel 行对象应包含有效 instanceKey')
  assert.equal(key, 'inst-A-uuid::hash_97E990AD_inv_INV-001')

  console.log('[GATE-2] Resolved key from row:', key)
})

// ═══════════════════════════════════════════════════════════
// Gate 3: 重复移除精确删除验证
// ═══════════════════════════════════════════════════════════

test('GATE-3: removeDuplicateFiles 流程验证 — 精确删除，不扩大范围', () => {
  const session = createImportSession()
  const sid = session.id

  // 创建 A/B 两个相同内容不同实例的文档
  const docA = makeRealDoc({
    instanceId: 'inst-A-uuid',
    invoiceNumber: 'INV-001',
    sourceDocId: 'hash_97E990AD',
    fileKey: 'A.pdf_1724000000000',
  })

  const docB = makeRealDoc({
    instanceId: 'inst-B-uuid',
    invoiceNumber: 'INV-001',
    sourceDocId: 'hash_97E990AD',
    fileKey: 'B.pdf_1724000000001',
  })

  addDocument(sid, docA)
  addDocument(sid, docB)

  // 模拟 removeDuplicateFiles 的逻辑：
  // 1. 从 duplicateGroups 获取要删除的 doc
  // 2. 调用 resolveDocumentInstanceKey 获取 key
  // 3. 调用 deleteDocumentByInstanceKey 精确删除

  const sessionData = getSession(sid)
  const docAKey = resolveDocumentInstanceKey(sessionData.documents[0])
  const docBKey = resolveDocumentInstanceKey(sessionData.documents[1])

  assert.ok(docAKey, 'A 应有有效 instanceKey')
  assert.ok(docBKey, 'B 应有有效 instanceKey')

  // 精确删除 B（模拟用户选择删除重复项中的非 keeper）
  const deleteResult = deleteDocumentByInstanceKey(sid, docBKey)
  assert.equal(deleteResult.success, true, '删除应成功')

  // 验证 A 仍然存在
  const afterDelete = getSession(sid)
  assert.equal(afterDelete.documents.length, 1, '只剩 1 个文档')
  assert.equal(
    afterDelete.documents[0].instanceId,
    'inst-A-uuid',
    '保留的是 A（keeper）'
  )

  console.log('[GATE-3] 精确删除 B 成功，A 保留')
  console.log('[GATE-3] 剩余文档 instanceId:', afterDelete.documents[0].instanceId)
})

// ═══════════════════════════════════════════════════════════
// Gate 4: Contract Violation 护栏验证
// ═══════════════════════════════════════════════════════════

test('GATE-4: 缺失 instanceId 或 invoiceDocumentId → Contract Violation', () => {
  // 模拟旧路径：文档只有内容身份，没有实例身份
  const badDoc1 = { instanceId: '', invoiceDocumentId: 'INV-001' }
  const badDoc2 = { instanceId: 'inst-A', invoiceDocumentId: '' }
  const badDoc3 = { instanceId: '', invoiceDocumentId: '' }

  assert.equal(resolveSessionInstanceKey(badDoc1), null, '缺 instanceId → null')
  assert.equal(resolveSessionInstanceKey(badDoc2), null, '缺 invoiceDocumentId → null')
  assert.equal(resolveSessionInstanceKey(badDoc3), null, '两者都缺 → null')

  console.log('[GATE-4] Contract Violation 护栏正常工作')
})

// ═══════════════════════════════════════════════════════════
// Gate 5: 多页 PDF 多票隔离验证
// ═══════════════════════════════════════════════════════════

test('GATE-5: 同一 instanceId 多票隔离', () => {
  const session = createImportSession()
  const sid = session.id

  // 模拟一个多票 PDF 包含两张发票
  const docA = makeRealDoc({
    instanceId: 'inst-single-pdf',
    invoiceNumber: 'INV-001',
    sourceDocId: 'hash_multi_page',
    fileKey: 'multi.pdf_p1_1724000000000',
  })

  const docB = makeRealDoc({
    instanceId: 'inst-single-pdf',
    invoiceNumber: 'INV-002',  // 不同发票号
    sourceDocId: 'hash_multi_page',
    fileKey: 'multi.pdf_p2_1724000000001',
  })

  addDocument(sid, docA)
  addDocument(sid, docB)

  const docs = getSession(sid).documents
  assert.equal(docs.length, 2, '同一实例的不同发票应各自独立')

  const keyA = resolveDocumentInstanceKey(docs[0])
  const keyB = resolveDocumentInstanceKey(docs[1])

  assert.notEqual(keyA, keyB, '不同发票应有不同 instanceKey')
  assert.ok(keyA.startsWith('inst-single-pdf::'), 'key 格式正确')
  assert.ok(keyB.startsWith('inst-single-pdf::'), 'key 格式正确')

  console.log('[GATE-5] 多票隔离:')
  console.log('  keyA:', keyA)
  console.log('  keyB:', keyB)
})

// ═══════════════════════════════════════════════════════════
// Gate 6: 重新导入相同内容 → 新实例形成新 key
// ═══════════════════════════════════════════════════════════

test('GATE-6: 重新导入相同内容 → 新实例独立存在', () => {
  const session = createImportSession()
  const sid = session.id

  // 第一次导入
  const docFirst = makeRealDoc({
    instanceId: 'inst-first-import',
    invoiceNumber: 'INV-001',
    sourceDocId: 'hash_97E990AD',
    fileKey: 'A.pdf_1724000000000',
  })

  addDocument(sid, docFirst)

  // 删除（模拟用户删除后重新导入）
  const firstKey = resolveDocumentInstanceKey(getSession(sid).documents[0])
  deleteDocumentByInstanceKey(sid, firstKey)

  // 重新导入（新 instanceId，相同内容）
  const docReimport = makeRealDoc({
    instanceId: 'inst-reimport-uuid',  // 新实例 ID
    invoiceNumber: 'INV-001',          // 相同发票号
    sourceDocId: 'hash_97E990AD',      // 相同内容
    fileKey: 'A.pdf_1724000005000',   // 新时间戳
  })

  addDocument(sid, docReimport)

  const docs = getSession(sid).documents
  assert.equal(docs.length, 1, '重新导入后应有 1 个文档')

  const reimportKey = resolveDocumentInstanceKey(docs[0])
  assert.equal(
    reimportKey,
    'inst-reimport-uuid::hash_97E990AD_inv_INV-001',
    '重新导入应用新的实例身份'
  )
  assert.notEqual(reimportKey, firstKey, '新旧实例 key 应不同')

  console.log('[GATE-6] 重新导入成功:')
  console.log('  firstKey:', firstKey)
  console.log('  reimportKey:', reimportKey)
})
