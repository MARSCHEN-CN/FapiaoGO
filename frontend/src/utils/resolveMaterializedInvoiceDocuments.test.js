/**
 * Persistent Document View Source 回归测试（S4/S5，Candidate 1-R）
 *
 * 冻结契约（INV-S1 补充）：
 *   S4：session cleanup 后（session=null），已 materialize 的文件必须仍产出富行
 *       （row.instanceId/invoiceDocumentId 有值，lookupKey === registered composite key）
 *   S5：files 是展示 membership 唯一 truth——已删除文件不能被 DocumentStore resurrect
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDocument, createPageMeta } from '../models/InvoiceDocument.js'
import { generateInvoiceDocumentId } from './invoiceIdentityResolver.js'
import { resolveMaterializedInvoiceDocuments } from './resolveMaterializedInvoiceDocuments.js'
import { buildDocumentViewModel } from './documentViewModel.js'
import {
  resolveDisplayStoreDocumentId,
  assertRowIdentityComplete,
} from './displayRowIdentity.js'

// ── 构造数据 ──
function makeOfd(fileKeySuffix) {
  const fileKey = `26447000000943604784.ofd_${fileKeySuffix}`
  const instanceId = `26447000000943604784.ofd_inst_${fileKeySuffix}`
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
  doc._pageKeys = [fileKey]
  doc.sourceDocId = sourceDocId
  const file = { key: fileKey, docId: sourceDocId, status: 'parsed', name: 'a.ofd', pageNum: 1 }
  return { doc, file, fileKey, instanceId, invDocId, sourceDocId }
}

// ════════════════════════════════════════════════════════════════
// S4：session cleanup 后，已 materialize 的文件必须仍产出富行
// ════════════════════════════════════════════════════════════════
test('S4: session=null 时 resolveMaterializedInvoiceDocuments 从 registered 恢复（当前 Red）', () => {
  const { doc, file } = makeOfd('s4-aaa')

  // session cleanup 后：sessionDocuments=null，registeredDocuments 有已 materialize 的 doc
  const resolved = resolveMaterializedInvoiceDocuments(
    [file],
    null,                    // session 没了
    [doc],                   // DocumentStore 已注册（持久）
  )

  assert.ok(Array.isArray(resolved) && resolved.length === 1,
    'S4: session 移除后必须从 registered 恢复 InvoiceDocument（当前返回 null → Red）')
  assert.equal(resolved[0].invoiceDocumentId, doc.invoiceDocumentId,
    '恢复的 doc 必须带 canonical identity')
})

test('S4b: session=null 时 buildDocumentViewModel 仍产出富行（集成）', () => {
  const { doc, file, instanceId, invDocId } = makeOfd('s4b-bbb')

  // 期望的持久视图：files + registered docs → 富行
  const resolved = resolveMaterializedInvoiceDocuments([file], null, [doc])
  const view = buildDocumentViewModel([file], resolved)
  const row = view.documents[0]

  // 集成断言：富行身份完整 + lookupKey === 注册复合键
  assert.equal(assertRowIdentityComplete(row).ok, true,
    'S4b: 行必须带完整身份（当前 Red——resolve 返回 null → 降级裸行）')
  const lookup = resolveDisplayStoreDocumentId(row)
  assert.equal(lookup, `${instanceId}::${invDocId}`,
    'S4b: lookupKey 必须等于注册复合键')
})

// ════════════════════════════════════════════════════════════════
// S5：files 是 membership 唯一 truth——已删除文件不能被 resurrect
// ════════════════════════════════════════════════════════════════
test('S5: 已删除文件（不在 files）不能被 DocumentStore resurrect', () => {
  const { doc: docA, file: fileA } = makeOfd('s5-ccc')
  const { doc: docB, file: fileB } = makeOfd('s5-ddd')

  // 两个文件都已导入并注册
  // 用户删除 A：files 只剩 B，但 DocumentStore 里 A 还没 GC
  const files = [fileB]
  const registered = [docA, docB]

  const resolved = resolveMaterializedInvoiceDocuments(files, null, registered)
  assert.ok(resolved, 'resolve 应返回（当前 Red——骨架返回 null）')
  const keys = (resolved || []).map(d => d.fileKey)
  assert.ok(keys.includes(docB.fileKey), 'B 应被保留（当前 files 成员）')
  assert.ok(!keys.includes(docA.fileKey), 'A 不得被 resurrect（不在 files 中）')
})

test('S5b: session 存在时优先用 session（过渡态），registered 不覆盖', () => {
  const { doc: sessionDoc, file } = makeOfd('s5e-eee')
  const { doc: staleRegistered } = makeOfd('s5f-fff')

  // session 存在（导入中）→ 用 session 的最新装配结果
  const resolved = resolveMaterializedInvoiceDocuments([file], [sessionDoc], [staleRegistered])
  assert.ok(Array.isArray(resolved) && resolved.length === 1, 'session 文档应优先（返回 session 数组）')
  assert.equal(resolved[0].fileKey, sessionDoc.fileKey, 'session 文档优先于 registered')
})
