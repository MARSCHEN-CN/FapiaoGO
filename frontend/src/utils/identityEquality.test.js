/**
 * INV-S2 End-to-End Identity Equality 回归测试
 *
 * 冻结（2026-08-23，Step S7）：
 *   对于当前展示中的每一个 materialized InvoiceDocument：
 *     Display lookup key === DocumentStore registration key
 *     且 getDocument(displayId) 必须命中。
 *
 * 完整链（唯一可接受路径）：
 *   registeredDocument（DocumentStore）
 *     → resolveMaterializedInvoiceDocuments（1-R 恢复）
 *     → buildDocumentViewModel / invoiceDocumentToRow
 *     → displayFiles row
 *     → resolveDisplayStoreDocumentId(row)
 *     → getDocument(displayId)
 *
 * 三互斥根因判定：
 *   A. invoiceDoc → row 已丢 identity        → 行构建问题
 *   B. row identity 正确但 displayId≠registeredId → Display identity resolution 问题
 *   C. displayId===registeredId 但 getDocument=null → DocumentStore 生命周期/GC 问题
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDocument, createPageMeta } from '../models/InvoiceDocument.js'
import { generateInvoiceDocumentId } from './invoiceIdentityResolver.js'
import {
  registerDocument,
  getDocument,
  getRegisteredDocIds,
  clearAllDocuments,
} from '../stores/DocumentStore.js'
import { resolveDocumentIdentity } from '../stores/DocumentStore.js'
import { buildDocumentViewModel } from './documentViewModel.js'
import { resolveMaterializedInvoiceDocuments } from './resolveMaterializedInvoiceDocuments.js'
import { resolveDisplayStoreDocumentId } from './displayRowIdentity.js'

function makeOfdDocAndFile() {
  const fileKey = '26447000000943604784.ofd_1787479863361_cb93123a-...'
  const instanceId = '26447000000943604784.ofd_1787479863361_84cae201-...'
  const sourceDocId = 'ca82b1c6dabfc311f680155a'
  const invDocId = generateInvoiceDocumentId({
    sourceDocId, invoiceNumber: '26447000000943604784', fileKey,
  })
  const doc = createDocument({
    docId: invDocId,
    instanceId,
    fileKey,
    sourceHash: sourceDocId,
    pages: [createPageMeta({ docId: invDocId, index: 0, renderDocId: sourceDocId, renderPage: 1 })],
  })
  doc.invoiceDocumentId = invDocId
  doc.sourceDocId = sourceDocId
  doc._pageKeys = [fileKey]  // assembly 精确记录
  const file = { key: fileKey, docId: sourceDocId, status: 'parsed', name: 'a.ofd', pageNum: 1 }
  return { doc, file, fileKey, instanceId, invDocId, sourceDocId }
}

// ════════════════════════════════════════════════════════════════
// INV-S2 核心：完整链 identity equality
// ════════════════════════════════════════════════════════════════
test('INV-S2: display lookup key === registration key，且 getDocument 命中', () => {
  clearAllDocuments()
  const { doc, file } = makeOfdDocAndFile()
  registerDocument(doc)  // 持久注册（assembly 时发生）

  // 1. 1-R 恢复（模拟 session cleanup 后）
  const registered = getRegisteredDocIds().map((id) => getDocument(id)).filter(Boolean)
  const materialized = resolveMaterializedInvoiceDocuments([file], null, registered)
  assert.ok(materialized && materialized.length === 1, '1-R 必须恢复文档（INV-S1）')

  // 2. 行构建
  const view = buildDocumentViewModel([file], materialized)
  const row = view.documents[0]
  assert.ok(row, '行必须存在')

  // 3. Display lookup key
  const displayId = resolveDisplayStoreDocumentId(row)

  // 4. 注册 key
  const registeredId = resolveDocumentIdentity(doc)

  // INV-S2 断言 1：equality
  assert.equal(displayId, registeredId,
    `INV-S2: display lookup (${displayId}) 必须 === 注册 key (${registeredId})`)

  // INV-S2 断言 2：hit
  const hit = getDocument(displayId)
  assert.ok(hit, `INV-S2: getDocument(${displayId}) 必须命中（当前 null → Red）`)
})

// ════════════════════════════════════════════════════════════════
// 根因判别 A：invoiceDoc → row 不丢 identity
// ════════════════════════════════════════════════════════════════
test('INV-S2-A: 行必须透传 canonical identity（instanceId + invoiceDocumentId）', () => {
  const { doc, file, instanceId, invDocId } = makeOfdDocAndFile()
  const view = buildDocumentViewModel([file], [doc])
  const row = view.documents[0]
  assert.equal(row.instanceId, instanceId, '行应透传 instanceId')
  assert.equal(row.invoiceDocumentId, invDocId, '行应透传 invoiceDocumentId')
})

// ════════════════════════════════════════════════════════════════
// 根因判别 C：displayId 命中后 storeDocument 应可查（生命周期完整）
// ════════════════════════════════════════════════════════════════
test('INV-S2-C: displayId 命中时 getDocument 必须返回完整 document（含 pageCount）', () => {
  clearAllDocuments()
  const { doc, file } = makeOfdDocAndFile()
  registerDocument(doc)

  const registered = getRegisteredDocIds().map((id) => getDocument(id)).filter(Boolean)
  const materialized = resolveMaterializedInvoiceDocuments([file], null, registered)
  const view = buildDocumentViewModel([file], materialized)
  const row = view.documents[0]
  const displayId = resolveDisplayStoreDocumentId(row)

  const hit = getDocument(displayId)
  assert.ok(hit, 'INV-S2-C: 必须命中')
  assert.ok(hit.pageCount > 0, 'document.pageCount > 0（DocumentViewer isLoading 依赖它）')
})
