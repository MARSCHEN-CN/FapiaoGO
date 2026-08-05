/**
 * Invoice Entity Boundary Regression Freeze v1
 *
 * 运行: node --test frontend/tests/invoice_entity_boundary.integration.test.js
 *
 * 目的: 测试"不可能发生的事情"，确保 Invoice Entity Boundary Refactor 的
 * 核心约束在任何代码变更中不被破坏。
 *
 * 测试场景:
 *   1. 同号不同票不可合并
 *   2. SEALED 票不可拆
 *   3. 追加导入不覆盖
 *   4. 删除实体非页面
 *   5. SEALED 后不可重新注册
 *   6. 身份通过 resolveInvoiceIdentity 统一出口
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const {
  createImportSession,
  addDocument,
  patchDocument,
  sealDocument,
  deleteInvoiceDocument,
  isDocumentSealed,
  getSession,
  resolveDocumentInstanceKey,
} = await import('../src/stores/ImportSessionStore.js')

const {
  Lifecycle,
  assertCanRegisterDocument,
  assertCanSealDocument,
  assertCanDeleteDocument,
} = await import('../src/guards/invoiceEntityGuard.js')

const {
  resolveInvoiceIdentity,
  generateInvoiceDocumentId,
  isSameInvoiceDocument,
} = await import('../src/utils/invoiceIdentityResolver.js')

function makeDoc(overrides = {}) {
  return {
    instanceId: `inst_${Math.random().toString(36).slice(2)}`,
    docId: `doc_${Math.random().toString(36).slice(2)}`,
    pages: [{ index: 0 }],
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════
// 测试 1: 同号不同票不可合并
// ═══════════════════════════════════════════════════════════

test('边界: 同号不同源 → 各自独立 InvoiceDocument', () => {
  const s = createImportSession()

  const docA = makeDoc({
    invoiceDocumentId: generateInvoiceDocumentId({ sourceDocId: 'src-A', invoiceNumber: '123' }),
    invoiceNumber: '123',
  })
  const docB = makeDoc({
    invoiceDocumentId: generateInvoiceDocumentId({ sourceDocId: 'src-B', invoiceNumber: '123' }),
    invoiceNumber: '123',
  })

  addDocument(s.id, docA, { source: 'backend_assembly' })
  addDocument(s.id, docB, { source: 'backend_assembly' })

  const docs = getSession(s.id).documents
  assert.equal(docs.length, 2, '同号不同源 = 两张独立发票')
  assert.notEqual(
    resolveDocumentInstanceKey(docs[0]),
    resolveDocumentInstanceKey(docs[1]),
    '不同 invoiceDocumentId = 不同身份键'
  )
})

// ═══════════════════════════════════════════════════════════
// 测试 2: SEALED 票不可拆
// ═══════════════════════════════════════════════════════════

test('边界: SEALED 票据 pages 不可被替换', () => {
  const s = createImportSession()
  const doc = makeDoc({
    invoiceDocumentId: 'INV-SEALED-01',
    pages: [{ index: 0 }, { index: 1 }, { index: 2 }],
    pageCount: 3,
  })
  addDocument(s.id, doc, { source: 'backend_assembly' })
  sealDocument(s.id, resolveDocumentInstanceKey(doc))

  // 尝试通过 patch 替换 pages（应被拒绝）
  const r = patchDocument(s.id, resolveDocumentInstanceKey(doc), { pages: [{ index: 0 }] })
  assert.equal(r, false, 'SEALED 后不能 patch pages')

  // 确认 pages 未被修改
  const stored = getSession(s.id).documents[0]
  assert.equal(stored.pages.length, 3, 'pages 数组未被改动')
  assert.equal(stored.lifecycle, Lifecycle.SEALED)
})

// ═══════════════════════════════════════════════════════════
// 测试 3: 追加导入不覆盖
// ═══════════════════════════════════════════════════════════

test('边界: 追加导入不覆盖已有文档', () => {
  const s = createImportSession()

  const docA = makeDoc({ invoiceDocumentId: 'INV-A', amount: '100.00' })
  const docB = makeDoc({ invoiceDocumentId: 'INV-B', amount: '200.00' })
  const docC = makeDoc({ invoiceDocumentId: 'INV-C', amount: '300.00' })

  addDocument(s.id, docA, { source: 'backend_assembly' })
  addDocument(s.id, docB, { source: 'backend_assembly' })

  // 追加导入 C
  addDocument(s.id, docC, { source: 'backend_assembly' })

  const docs = getSession(s.id).documents
  assert.equal(docs.length, 3, 'A, B, C 共存')
  assert.equal(docs[0].amount, '100.00')
  assert.equal(docs[1].amount, '200.00')
  assert.equal(docs[2].amount, '300.00')
})

test('边界: 重复 invoiceDocumentId 被拒绝（非覆盖）', () => {
  const s = createImportSession()
  const doc = makeDoc({ invoiceDocumentId: 'INV-DUP', amount: 'original', pages: [{ index: 0 }] })
  addDocument(s.id, doc, { source: 'backend_assembly' })

  const docV2 = makeDoc({ invoiceDocumentId: 'INV-DUP', amount: 'modified', pages: [{ index: 0 }, { index: 1 }] })
  const r = addDocument(s.id, docV2, { source: 'backend_assembly' })
  assert.equal(r, false, '重复 invoiceDocumentId 被拒绝')

  const stored = getSession(s.id).documents[0]
  assert.equal(stored.amount, 'original', '旧数据未被覆盖')
  assert.equal(stored.pages.length, 1, 'pages 未被替换')
})

// ═══════════════════════════════════════════════════════════
// 测试 4: 删除实体而非页面
// ═══════════════════════════════════════════════════════════

test('边界: deleteInvoiceDocument 删除整个实体及其关联 pages', () => {
  const s = createImportSession()
  const doc = makeDoc({
    invoiceDocumentId: 'INV-MULTI-PAGE',
    pages: [{ index: 0 }, { index: 1 }, { index: 2 }],
    _pageKeys: ['page-key-1', 'page-key-2', 'page-key-3'],
  })

  // 模拟 session.files 中有这些 pages
  s.files = [
    { key: 'page-key-1', name: 'invoice_p1.pdf' },
    { key: 'page-key-2', name: 'invoice_p2.pdf' },
    { key: 'page-key-3', name: 'invoice_p3.pdf' },
    { key: 'other-file', name: 'other.pdf' },
  ]
  s.progress = { total: 4 }

  addDocument(s.id, doc, { source: 'backend_assembly' })
  const instanceKey = resolveDocumentInstanceKey(doc)

  const result = deleteInvoiceDocument(s.id, instanceKey)
  assert.equal(result.success, true, '删除成功')
  assert.equal(result.removedPageKeys.length, 3, '三个 page key 全部返回')
  assert.deepStrictEqual(result.removedPageKeys.sort(), ['page-key-1', 'page-key-2', 'page-key-3'])

  // 文档从 session.documents 移除
  const docs = getSession(s.id).documents
  assert.equal(docs.length, 0, '文档已从 documents 移除')

  // 关联 pages 从 session.files 移除
  assert.equal(s.files.length, 1, '只剩 other-file')
  assert.equal(s.files[0].key, 'other-file', '其他文件未受影响')
})

test('边界: 删除后文档 lifecycle 为 DELETED', () => {
  const s = createImportSession()
  const doc = makeDoc({ invoiceDocumentId: 'INV-DEL' })
  addDocument(s.id, doc, { source: 'backend_assembly' })
  const instanceKey = resolveDocumentInstanceKey(doc)

  deleteInvoiceDocument(s.id, instanceKey)

  // 文档已从 Store 移除，lifecycle 检查其对象本身
  assert.equal(doc.lifecycle, Lifecycle.DELETED, '软删除标记')
})

// ═══════════════════════════════════════════════════════════
// 测试 5: SEALED 后不可重新注册
// ═══════════════════════════════════════════════════════════

test('边界: SEALED 文档不可重新 register', () => {
  const s = createImportSession()
  const doc = makeDoc({ invoiceDocumentId: 'INV-SEALED' })
  addDocument(s.id, doc, { source: 'backend_assembly' })
  sealDocument(s.id, resolveDocumentInstanceKey(doc))

  // 尝试重新注册同 identity 的新对象
  const newDoc = makeDoc({ invoiceDocumentId: 'INV-SEALED' })
  const r = addDocument(s.id, newDoc, { source: 'backend_assembly' })
  assert.equal(r, false, 'SEALED 后 register 被拒')
})

// ═══════════════════════════════════════════════════════════
// 测试 6: 身份通过 resolveInvoiceIdentity 统一出口
// ═══════════════════════════════════════════════════════════

test('边界: resolveInvoiceIdentity → invoiceDocumentId 最高优先级', () => {
  assert.equal(
    resolveInvoiceIdentity({ invoiceDocumentId: 'INV-01', instanceId: 'I1', id: 'X', docId: 'H' }),
    'INV-01',
    'invoiceDocumentId 最高优先级'
  )
})

test('边界: isSameInvoiceDocument → 同 invoiceDocumentId 判定为同一实体', () => {
  const docA = { invoiceDocumentId: 'INV-A', instanceId: 'I1' }
  const docB = { invoiceDocumentId: 'INV-A', instanceId: 'I2' }
  assert.equal(isSameInvoiceDocument(docA, docB), true, '同 invoiceDocumentId = 同实体（忽略 instanceId）')
})

test('边界: isSameInvoiceDocument → 不同 invoiceDocumentId 判定为不同实体', () => {
  const docA = { invoiceDocumentId: 'INV-A' }
  const docB = { invoiceDocumentId: 'INV-B' }
  assert.equal(isSameInvoiceDocument(docA, docB), false)
})

// ═══════════════════════════════════════════════════════════
// 测试 7: guard 行为不变（运行时约束验证）
// ═══════════════════════════════════════════════════════════

test('边界: assertCanSealDocument → 拒绝空 pages', () => {
  assert.throws(
    () => assertCanSealDocument({ lifecycle: Lifecycle.REGISTERED, pages: [], id: 'X' }),
    /pages 为空/
  )
})

test('边界: assertCanDeleteDocument → 允许 SEALED 状态删除', () => {
  // SEALED 文档可以被删除（用户主动行为）
  assert.doesNotThrow(
    () => assertCanDeleteDocument({ lifecycle: Lifecycle.SEALED, id: 'X', pages: [{ index: 0 }] })
  )
})

test('边界: assertCanDeleteDocument → 拒绝 DELETED 重复删除', () => {
  assert.throws(
    () => assertCanDeleteDocument({ lifecycle: Lifecycle.DELETED }),
    /DELETED/
  )
})
