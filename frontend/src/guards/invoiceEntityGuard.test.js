/**
 * invoiceEntityGuard — 生命周期约束验收测试
 *
 * 运行：node --test frontend/src/guards/invoiceEntityGuard.test.js
 * 不依赖 React / 网络：直接调用 guard 和 store 纯函数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const {
  Lifecycle,
  assertCanRegisterDocument,
  assertCanPatchDocument,
  assertCanSealDocument,
  assertCanDeleteDocument,
  assertSameInvoiceIdentity,
  canTransitionTo,
} = await import('../guards/invoiceEntityGuard.js')

const {
  createImportSession,
  addDocument,
  patchDocument,
  sealDocument,
  isDocumentSealed,
  getSession,
  resolveDocumentInstanceKey,
} = await import('../stores/ImportSessionStore.js')

function makeDoc(key = 'I1', overrides = {}) {
  return { instanceId: key, docId: `HASH_${key}`, pages: [{ index: 0 }], amount: '100.00', ...overrides }
}

// ═══════════════════════════════════════════════════════════
// 生命周期转换表
// ═══════════════════════════════════════════════════════════

test('生命周期转换合法性', () => {
  const doc = makeDoc()

  assert.equal(canTransitionTo(doc, Lifecycle.CREATED), true, '空 lifecycle → CREATED')
  doc.lifecycle = Lifecycle.CREATED
  assert.equal(canTransitionTo(doc, Lifecycle.REGISTERED), true, 'CREATED → REGISTERED')
  assert.equal(canTransitionTo(doc, Lifecycle.SEALED), false, 'CREATED → SEALED 非法')
  assert.equal(canTransitionTo(doc, Lifecycle.DELETED), false, 'CREATED → DELETED 非法')

  doc.lifecycle = Lifecycle.REGISTERED
  assert.equal(canTransitionTo(doc, Lifecycle.SEALED), true, 'REGISTERED → SEALED')
  assert.equal(canTransitionTo(doc, Lifecycle.DELETED), true, 'REGISTERED → DELETED')
  assert.equal(canTransitionTo(doc, Lifecycle.CREATED), false, 'REGISTERED → CREATED 回退非法')

  doc.lifecycle = Lifecycle.SEALED
  assert.equal(canTransitionTo(doc, Lifecycle.DELETED), true, 'SEALED → DELETED')
  assert.equal(canTransitionTo(doc, Lifecycle.REGISTERED), false, 'SEALED → REGISTERED 回退非法')

  doc.lifecycle = Lifecycle.DELETED
  assert.equal(canTransitionTo(doc, Lifecycle.SEALED), false, 'DELETED → 任何状态非法')
  assert.equal(canTransitionTo(doc, Lifecycle.REGISTERED), false, 'DELETED → 任何状态非法')
})

// ═══════════════════════════════════════════════════════════
// Case 1: 重复注册被拒绝
// ═══════════════════════════════════════════════════════════

test('Case 1: 重复注册被拒绝', () => {
  const s = createImportSession()
  const r1 = addDocument(s.id, makeDoc('I1'))
  assert.equal(r1, true)
  const r2 = addDocument(s.id, makeDoc('I1')) // 同 instanceKey
  assert.equal(r2, false, '重复注册被拒绝')
  assert.equal(getSession(s.id).documents.length, 1)
  assert.equal(getSession(s.id).documents[0].lifecycle, Lifecycle.REGISTERED)
})

// ═══════════════════════════════════════════════════════════
// Case 2: SEALED 后 patch identity 被拒绝
// ═══════════════════════════════════════════════════════════

test('Case 2: SEALED 后 patch invoiceNumber 被拒绝', () => {
  const s = createImportSession()
  addDocument(s.id, makeDoc('I1', { invoiceNumber: '123' }))
  sealDocument(s.id, 'I1')
  assert.equal(isDocumentSealed(s.id, 'I1'), true)

  const r = patchDocument(s.id, 'I1', { invoiceNumber: '999' })
  assert.equal(r, false, 'SEALED 后 patch invoiceNumber 被拒绝')
  assert.equal(getSession(s.id).documents[0].invoiceNumber, '123', 'invoiceNumber 未被修改')
})

test('Case 2b: SEALED 后 patch docId 被拒绝', () => {
  const s = createImportSession()
  addDocument(s.id, makeDoc('I1'))
  sealDocument(s.id, 'I1')

  const r = patchDocument(s.id, 'I1', { docId: 'HACKED' })
  assert.equal(r, false, 'SEALED 后 patch docId 被拒绝')
})

test('Case 2c: SEALED 后 patch amount 被允许', () => {
  const s = createImportSession()
  addDocument(s.id, makeDoc('I1', { amount: '100.00' }))
  sealDocument(s.id, 'I1')

  const r = patchDocument(s.id, 'I1', { amount: '200.00' })
  assert.equal(r, true, 'SEALED 后 patch amount 被允许')
  assert.equal(getSession(s.id).documents[0].amount, '200.00')
})

// ═══════════════════════════════════════════════════════════
// Case 3: SEALED 后 merge 被拒绝
// ═══════════════════════════════════════════════════════════

test('Case 3: SEALED 文档不可 merge', () => {
  const docA = makeDoc('I1')
  const docB = makeDoc('I2')
  docA.lifecycle = Lifecycle.SEALED
  docB.lifecycle = Lifecycle.SEALED

  assert.throws(
    () => assertSameInvoiceIdentity(docA, docB),
    /拒绝合并/,
    'SEALED 文档 merge 抛出异常'
  )
})

// ═══════════════════════════════════════════════════════════
// Case 4: SEALED 后 re-add 被拒绝
// ═══════════════════════════════════════════════════════════

test('Case 4: SEALED 后不可重新注册', () => {
  const s = createImportSession()
  addDocument(s.id, makeDoc('I1'))
  sealDocument(s.id, 'I1')

  // 尝试重新注册同 instanceKey（模拟二次注册）
  const r = addDocument(s.id, makeDoc('I1', { pages: [{ index: 0 }, { index: 1 }] }))
  assert.equal(r, false, 'SEALED 后不可重新注册')
  assert.equal(getSession(s.id).documents.length, 1, '文档数不变')
  assert.equal(getSession(s.id).documents[0].lifecycle, Lifecycle.SEALED, '仍是 SEALED')
})

// ═══════════════════════════════════════════════════════════
// Case 5: 空 pages 不能 seal
// ═══════════════════════════════════════════════════════════

test('Case 5: 空 pages 不能 seal', () => {
  assert.throws(
    () => assertCanSealDocument({ id: 'X', pages: [], lifecycle: Lifecycle.REGISTERED }),
    /pages 为空/,
    '空 pages 不能 seal'
  )
})

test('Case 5b: 无身份不能 seal', () => {
  assert.throws(
    () => assertCanSealDocument({ lifecycle: Lifecycle.REGISTERED, pages: [{ index: 0 }] }),
    /无有效身份/,
    '无身份不能 seal'
  )
})

// ═══════════════════════════════════════════════════════════
// Case 6: lifecycle 添加到新注册文档
// ═══════════════════════════════════════════════════════════

test('Case 6: 新注册文档自动获得 REGISTERED lifecycle', () => {
  const s = createImportSession()
  addDocument(s.id, makeDoc('I1'))
  assert.equal(getSession(s.id).documents[0].lifecycle, Lifecycle.REGISTERED)
})

test('Case 6b: 已带 lifecycle 的文档不被覆盖', () => {
  const s = createImportSession()
  const doc = makeDoc('I1')
  doc.lifecycle = Lifecycle.CREATED
  addDocument(s.id, doc)
  assert.equal(getSession(s.id).documents[0].lifecycle, Lifecycle.CREATED, '保留已有 lifecycle')

  // seal 需要 REGISTERED
  const r = sealDocument(s.id, 'I1')
  assert.equal(r, false, 'CREATED 不能 seal（需要 REGISTERED）')
})

// ═══════════════════════════════════════════════════════════
// Case 7: DELETED 文档不可操作
// ═══════════════════════════════════════════════════════════

test('Case 7: DELETED 文档不可注册', () => {
  assert.throws(
    () => assertCanRegisterDocument(makeDoc('I1'), { lifecycle: Lifecycle.DELETED, instanceId: 'I1' }),
    /已 DELETED/,
    'DELETED 文档不可注册'
  )
})

test('Case 7b: DELETED 文档不可 patch', () => {
  assert.throws(
    () => assertCanPatchDocument({ lifecycle: Lifecycle.DELETED }, { amount: '100' }),
    /已 DELETED/,
    'DELETED 文档不可 patch'
  )
})

test('Case 7c: DELETED 文档不可 seal', () => {
  assert.throws(
    () => assertCanSealDocument({ lifecycle: Lifecycle.DELETED }),
    /已 DELETED/,
    'DELETED 文档不可 seal'
  )
})

// ═══════════════════════════════════════════════════════════
// Case 8: 非白名单字段不能 patch
// ═══════════════════════════════════════════════════════════

test('Case 8: pageCount 不能通过 patch 修改', () => {
  const s = createImportSession()
  addDocument(s.id, makeDoc('I1', { pageCount: 2, pages: [{ index: 0 }, { index: 1 }] }))
  const r = patchDocument(s.id, 'I1', { pageCount: 3 })
  assert.equal(r, false, '禁止 patch pageCount')
})

test('Case 8b: _pageKeys 不能通过 patch 修改', () => {
  const s = createImportSession()
  addDocument(s.id, makeDoc('I1'))
  const r = patchDocument(s.id, 'I1', { _pageKeys: ['fake'] })
  assert.equal(r, false, '禁止 patch _pageKeys')
})

// ═══════════════════════════════════════════════════════════
// Case 9: 追加导入不阻塞 SEALED 文档
// ═══════════════════════════════════════════════════════════

test('Case 9: 同一 session 可包含多个 SEALED 文档 + 新文档', () => {
  const s = createImportSession()
  addDocument(s.id, makeDoc('I1'))
  sealDocument(s.id, 'I1')
  addDocument(s.id, makeDoc('I2'))
  sealDocument(s.id, 'I2')
  addDocument(s.id, makeDoc('I3'))

  const docs = getSession(s.id).documents
  assert.equal(docs.length, 3, '3 个文档共存')
  assert.equal(docs[0].lifecycle, Lifecycle.SEALED)
  assert.equal(docs[1].lifecycle, Lifecycle.SEALED)
  assert.equal(docs[2].lifecycle, Lifecycle.REGISTERED, '新文档不受影响')
})
