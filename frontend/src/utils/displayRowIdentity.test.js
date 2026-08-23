/**
 * Display Row Identity Contract 回归测试（D1-D5）
 *
 * 冻结依据（2026-08-23 用户拍板）：
 *   - 修复方向 B：行构建链透传 canonical Store identity
 *   - 不实施 A 的 includes() 反查兜底
 *   - D5：缺 identity 时是可见 contract violation，不静默 fallback 裸 file.key
 *
 * 判定矩阵：
 *   D1  assembled OFD 完整身份 → instanceId::invoiceDocumentId
 *   D2  placeholder _unassembled → 自身 canonical id
 *   D3  普通 PDF/image → 保持现有 canonical identity
 *   D4  display row → adapter lookup key 与注册 key 完全一致
 *   D5  缺 identity → 禁止静默 fallback 裸 file.key
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { invoiceDocumentToRow, invoiceDocumentsToRows } from './invoiceDocumentViewModel.js'
import {
  resolveDisplayStoreDocumentId,
  assertRowIdentityComplete,
} from './displayRowIdentity.js'
import { resolveDocumentIdentity } from '../stores/DocumentStore.js'
import { generateInvoiceDocumentId } from './invoiceIdentityResolver.js'

// ── 构造测试数据 ──
function makeFile({ key, docId, sourceDocId, pageNum, name, status = 'parsed', invoiceNumber }) {
  const f = { key, docId, pageNum, name, status }
  if (sourceDocId) f.sourceDocId = sourceDocId
  if (invoiceNumber) f.invoiceNumber = invoiceNumber
  return f
}

// 模拟一个 backend assembly 产出的 OFD InvoiceDocument（单页，带复合身份）
function makeOfdInvoiceDocument() {
  const fileKey = '26447000000943604784.ofd_1787479863361_cb93123a-dcd1-443c-ac2c-9aa924f93627'
  const sourceDocId = 'ca82b1c6dabfc311f680155a'
  const invoiceNumber = '26447000000943604784'
  const invDocId = generateInvoiceDocumentId({ sourceDocId, invoiceNumber, fileKey })
  const instanceId = '26447000000943604784.ofd_1787479863361_84cae201-0ef8-4e4a-b1b2-cb29b3d70241'
  const doc = {
    docId: invDocId,
    invoiceDocumentId: invDocId,
    instanceId,
    fileKey,
    sourceDocId,
    invoiceNumber,
    _pageKeys: [fileKey],
    pageCount: 1,
    amount: '100.00',
    invoiceDate: '2026-08-23',
    _source: 'backend_assembly',
  }
  return { doc, fileKey, sourceDocId, invDocId, instanceId }
}

// 模拟普通单页图片（无发票号 → 走 fallback / _unassembled）
function makePlainImageDoc() {
  const fileKey = 'pix.png_1787396851234_abc-1234'
  const sourceDocId = 'fe5d28313c2c4f8140109657'
  const invDocId = generateInvoiceDocumentId({ sourceDocId: fileKey, invoiceNumber: '', fileKey })
  const doc = {
    docId: invDocId,
    invoiceDocumentId: invDocId,
    instanceId: fileKey, // 图片单页：instanceId 通常 = key
    fileKey,
    _pageKeys: [fileKey],
    pageCount: 1,
    _source: 'fallback',
  }
  return { doc, fileKey, sourceDocId, invDocId }
}

// ════════════════════════════════════════════════════════════════
// D1：assembled OFD 完整身份 → instanceId::invoiceDocumentId
// ════════════════════════════════════════════════════════════════
test('D1: assembled OFD 完整身份 → resolveDisplayStoreDocumentId 返回复合键', () => {
  const { doc, fileKey } = makeOfdInvoiceDocument()
  const file = makeFile({ key: fileKey, docId: 'ca82b1c6dabfc311f680155a', name: 'a.ofd' })
  const row = invoiceDocumentToRow(doc, [file], null)

  assert.ok(row, 'invoiceDocumentToRow 必须成功构建 OFD 行')
  // 行必须透传复合身份（修复目标：invoiceDocumentToRow 已透传）
  assert.equal(row.instanceId, doc.instanceId, '行应透传 instanceId')
  assert.equal(row.invoiceDocumentId, doc.invoiceDocumentId, '行应透传 invoiceDocumentId')

  // canonical store id = 注册复合键
  const storeId = resolveDisplayStoreDocumentId(row)
  assert.equal(storeId, `${doc.instanceId}::${doc.invoiceDocumentId}`)
  // 与注册键（resolveDocumentIdentity 同算法）严格一致
  assert.equal(storeId, resolveDocumentIdentity({ instanceId: doc.instanceId, invoiceDocumentId: doc.invoiceDocumentId }))
})

// ════════════════════════════════════════════════════════════════
// D2：placeholder _unassembled → 自身 canonical id
// ════════════════════════════════════════════════════════════════
test('D2: placeholder _unassembled → canonical id 为 _unassembled 键', () => {
  const { doc, fileKey } = makePlainImageDoc()
  const file = makeFile({ key: fileKey, docId: 'fe5d28313c2c4f8140109657', name: 'pix.png' })
  const row = invoiceDocumentToRow(doc, [file], null)

  assert.ok(row, 'invoiceDocumentToRow 必须成功构建 placeholder 行')
  const storeId = resolveDisplayStoreDocumentId(row)
  // placeholder 的 canonical id = 注册侧算法（复合键 instanceId::invoiceDocumentId，
  // 其中 instanceId=fileKey 时 → 'key::key_unassembled'），必须与注册键一致
  const registrationKey = resolveDocumentIdentity({
    invoiceDocumentId: doc.invoiceDocumentId,
    instanceId: doc.instanceId,
    docId: doc.docId,
  })
  assert.equal(storeId, registrationKey, 'placeholder lookup key 必须等于注册键')
  assert.ok(storeId.endsWith('_unassembled'), 'placeholder 键应含 _unassembled 后缀')
  assert.ok(storeId.includes('::'), `placeholder 复合键应含 :: 分隔: ${storeId}`)
})

// ════════════════════════════════════════════════════════════════
// D3：普通 PDF/image → 保持现有 canonical identity（不回归）
// ════════════════════════════════════════════════════════════════
test('D3: 普通 PDF/image → resolveDisplayStoreDocumentId 保持现有 canonical identity', () => {
  // 普通文件：仅 docId，无复合身份（解析前的 page-level）
  const plainRow = { key: 'inv.pdf_123_abc', docId: 'pdf_hash_123', status: 'parsed' }
  // 修复契约下：缺复合身份 → resolveDisplayStoreDocumentId 返回 null（不猜 docId）
  assert.equal(resolveDisplayStoreDocumentId(plainRow), null,
    '缺 instanceId/invoiceDocumentId 时不得用裸 docId 冒充 store 键')
  // 但装配后：documentId 透传
  const assembledRow = { key: 'inv.pdf_123_abc', docId: 'inv.pdf_123_abc',
    instanceId: 'inst-1', invoiceDocumentId: 'hash_inv_123' }
  assert.equal(resolveDisplayStoreDocumentId(assembledRow), 'inst-1::hash_inv_123')
})

// ════════════════════════════════════════════════════════════════
// D4：display row → adapter lookup key 与注册 key 完全一致
// ════════════════════════════════════════════════════════════════
test('D4: display row lookup key 与注册 key 严格一致（Registration === Lookup）', () => {
  const { doc, fileKey } = makeOfdInvoiceDocument()
  const file = makeFile({ key: fileKey, docId: 'ca82b1c6dabfc311f680155a', name: 'a.ofd' })
  const row = invoiceDocumentToRow(doc, [file], null)

  // 注册键（ensureDocumentFromFileObj / registerDocument 同算法）
  const registrationKey = resolveDocumentIdentity({
    invoiceDocumentId: doc.invoiceDocumentId,
    instanceId: doc.instanceId,
    docId: doc.docId,
  })
  // Display 查找键（修复后 = 行透传的 canonical store id）
  const lookupKey = resolveDisplayStoreDocumentId(row)
  assert.equal(lookupKey, registrationKey,
    'lookup key 必须严格等于注册 key，禁止猜测/fallback')
  // 注册键必须是复合键（instanceId::invoiceDocumentId）
  assert.ok(registrationKey.includes('::'), `注册键应为复合键: ${registrationKey}`)
})

// ════════════════════════════════════════════════════════════════
// D5：缺 identity → 禁止静默 fallback 裸 file.key（contract violation 可见）
// ════════════════════════════════════════════════════════════════
test('D5: 缺 identity 时禁止静默 fallback 裸 file.key', () => {
  // 当前 DisplayAdapter 的静默 fallback 链：resolveDocumentIdentity || resolveDocId || file.key
  // 这条链在缺身份时返回裸 file.key —— 正是本次 OFD 故障的机制（E-store: storeDocId=裸key）
  const degradedRow = { key: '26447000000943604784.ofd_1787479863361_cb93123a-...' } // 无任何身份

  // 断言：degradedRow 无法解析 canonical store id
  assert.equal(resolveDisplayStoreDocumentId(degradedRow), null,
    '缺 identity 时 resolveDisplayStoreDocumentId 必须返回 null，不得 fallback 裸 key')

  // 断言：assertRowIdentityComplete 明确报告 violation
  const verdict = assertRowIdentityComplete(degradedRow)
  assert.equal(verdict.ok, false, '缺身份必须判定为 contract violation')
  assert.equal(verdict.reason, 'identity-missing-but-fake-fallback-available',
    '存在裸 key/docId 伪身份时，reason 应明确指出禁止静默 fallback')

  // 有完整身份的行 → ok
  const { doc, fileKey } = makeOfdInvoiceDocument()
  const file = makeFile({ key: fileKey, docId: 'ca82b1c6dabfc311f680155a', name: 'a.ofd' })
  const row = invoiceDocumentToRow(doc, [file], null)
  assert.equal(assertRowIdentityComplete(row).ok, true, '完整身份行必须通过契约')
})

// ════════════════════════════════════════════════════════════════
// D4b：invoiceDocumentsToRows 批量透传（多文档不丢身份）
// ════════════════════════════════════════════════════════════════
test('D4b: invoiceDocumentsToRows 批量转换不丢身份', () => {
  const { doc: ofdDoc, fileKey: ofdKey } = makeOfdInvoiceDocument()
  const { doc: imgDoc, fileKey: imgKey } = makePlainImageDoc()
  const files = [
    makeFile({ key: ofdKey, docId: 'ca82b1c6dabfc311f680155a', name: 'a.ofd' }),
    makeFile({ key: imgKey, docId: 'fe5d28313c2c4f8140109657', name: 'pix.png' }),
  ]
  const rows = invoiceDocumentsToRows([ofdDoc, imgDoc], files)
  assert.equal(rows.length, 2, '两个文档都应生成行')
  for (const row of rows) {
    assert.equal(assertRowIdentityComplete(row).ok, true,
      `每行都必须携带完整身份: key=${row.key?.slice(0, 20)}`)
    const lookup = resolveDisplayStoreDocumentId(row)
    assert.ok(lookup, `lookup key 必须可解析: key=${row.key?.slice(0, 20)}`)
    assert.ok(!lookup.includes('|') && lookup.length > 10, 'lookup key 格式异常')
  }
})
