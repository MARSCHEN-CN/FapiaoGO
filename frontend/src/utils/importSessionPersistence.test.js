/**
 * INV-S1 Completed Import Persistence 回归测试（生命周期契约）
 *
 * 冻结（2026-08-23）：
 *   一个已成功 materialize 到 application display state 的 document，
 *   其 originating ImportSession 被 remove 后，
 *   display row / canonical identity / DocumentStore lookup 必须仍然有效。
 *
 * 背景（Step S1 静态地图，Case S1 实锤）：
 *   removeSession 只删 session（sessions.delete + activeSessionId=null），
 *   不碰 files / DocumentStore。但 FileContext 的 documentView 在 invoiceDocs=null
 *   （session 没了）时降级 groupFilesByDocument → 裸行无 canonical identity →
 *   Display lookup miss → 空白。files 仍在，但身份无法恢复。
 *
 * 本测试证明当前实现 Red：session remove 后富行消失（降级裸行），
 * 而期望契约是从 DocumentStore（持久，registerDocument 已注册复合键）恢复。
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
import { buildDocumentViewModel } from './documentViewModel.js'
import { resolveMaterializedInvoiceDocuments } from './resolveMaterializedInvoiceDocuments.js'
import {
  resolveDisplayStoreDocumentId,
  assertRowIdentityComplete,
} from './displayRowIdentity.js'

// ── 测试数据构造（复刻 useFileOps assembly 路径）──
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
  doc.sourceDocId = sourceDocId  // 复刻 useFileOps assembly 路径（doc.sourceDocId = repFile.docId）
  const file = { key: fileKey, docId: sourceDocId, status: 'parsed', name: '26447000000943604784.ofd', pageNum: 1 }
  return { doc, file, fileKey, instanceId, invDocId, sourceDocId }
}

// ════════════════════════════════════════════════════════════════
// Red 1：session remove 后（invoiceDocs=null），buildDocumentViewModel 降级
// 产出裸行——无 canonical identity，Display 无法 lookup（当前缺陷）
// ════════════════════════════════════════════════════════════════
test('INV-S1-Red1: session 移除后经持久源恢复仍产出富行（修复后 Green）', () => {
  const { doc, file } = makeOfdDocAndFile()
  // 模拟：session 存在时的富文档
  const viewWithSession = buildDocumentViewModel([file], [doc])
  const richRow = viewWithSession.documents[0]
  assert.equal(assertRowIdentityComplete(richRow).ok, true,
    'session 存在时行应有完整身份（富行）')

  // 修复后：session remove（invoiceDocs=null）→ 从持久 DocumentStore 恢复（S6）
  const resolved = resolveMaterializedInvoiceDocuments([file], null, [doc])
  assert.ok(resolved && resolved.length === 1, '持久源必须恢复已 materialize 文档（INV-S1）')
  const viewWithoutSession = buildDocumentViewModel([file], resolved)
  const restoredRow = viewWithoutSession.documents[0]
  assert.equal(assertRowIdentityComplete(restoredRow).ok, true,
    'session 移除后经持久源恢复的行必须有完整身份（INV-S1：completed import survives cleanup）')
})

// ════════════════════════════════════════════════════════════════
// Red 2：DocumentStore 已持久注册复合键，但降级路径不会从 store 恢复
// → Display 即使有 store，也无法从裸行找回 identity（契约期望：应能恢复）
// ════════════════════════════════════════════════════════════════
test('INV-S1-Red2: DocumentStore 有复合键，但降级行无法恢复 lookup（契约缺口）', () => {
  clearAllDocuments()
  const { doc, file, fileKey, instanceId, invDocId } = makeOfdDocAndFile()

  // DocumentStore 已持久注册（registerDocument 在 assembly 时发生，session 无关）
  registerDocument(doc)

  // store 确实有复合键
  const keys = getRegisteredDocIds()
  const compositeKey = `${instanceId}::${invDocId}`
  assert.ok(keys.includes(compositeKey), `store 应含复合键 ${compositeKey}`)

  // 但降级行（session remove 后）无法解析出 canonical identity
  const viewWithoutSession = buildDocumentViewModel([file], null)
  const degradedRow = viewWithoutSession.documents[0]
  const lookupFromRow = resolveDisplayStoreDocumentId(degradedRow)
  assert.equal(lookupFromRow, null,
    '降级裸行无法解析 canonical identity（期望：能从持久 store 恢复，当前做不到 → Red）')

  // 期望契约：Display 应能从 file.key/docId 反查 store 恢复复合键
  // 当前 resolveDisplayStoreDocumentId 明确禁止 includes 反查（D5），
  // 所以正确修复方向是「行构建从持久源恢复身份」而非消费侧反查。
  const byDocId = getDocument({ invoiceDocumentId: invDocId, instanceId, docId: doc.docId })
  assert.ok(byDocId, 'DocumentStore 按复合身份查询应命中（持久数据存在，只是行没带出来）')
})

// ════════════════════════════════════════════════════════════════
// Red 3：完整生命周期模拟——session 存在时富行 ok，remove 后裸行 fail
//（INV-S1 的直接表述）
// ════════════════════════════════════════════════════════════════
test('INV-S1-Red3: completed import 的 session 被 remove 后，display row 必须仍有效（修复后 Green）', () => {
  clearAllDocuments()
  const { doc, file, instanceId, invDocId } = makeOfdDocAndFile()
  registerDocument(doc)  // assembly 时已 materialize 到 DocumentStore（持久）

  // session 存在：富行
  const rich = buildDocumentViewModel([file], [doc]).documents[0]
  assert.equal(assertRowIdentityComplete(rich).ok, true)

  // session remove（模拟）：invoiceDocs=null → 从持久 DocumentStore 恢复（S6）
  const registered = getRegisteredDocIds().map((id) => getDocument(id)).filter(Boolean)
  const resolved = resolveMaterializedInvoiceDocuments([file], null, registered)
  assert.ok(resolved && resolved.length === 1, '持久源必须恢复（INV-S1）')
  const afterRemove = buildDocumentViewModel([file], resolved).documents[0]
  const verdict = assertRowIdentityComplete(afterRemove)
  assert.equal(verdict.ok, true,
    `INV-S1：completed import 的 document 在 session remove 后行身份必须仍有效（当前 ${verdict.reason}）`)
})
