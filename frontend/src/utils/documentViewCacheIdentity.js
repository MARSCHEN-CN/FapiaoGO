/**
 * documentViewCacheIdentity — documentView 缓存签名身份（Decision Layer，纯函数）
 *
 * 依据：2026-08-23 根因判定（P1-P4 闭环审计）
 *
 * 背景（运行时铁证）：
 *   FileContext 的 documentView 签名缓存用 `invoiceDocs.map(d => d.key)` 计算 docsSig，
 *   但 InvoiceDocument（createDocument，InvoiceDocument.js:83-92）**没有 key 字段**。
 *   → d.key 恒为 undefined → docsSig 恒为 '' → 与「无文档」时相同 →
 *   combinedSig 不变 → 缓存永不失效 → buildDocumentViewModel 永远用首次降级结果 →
 *   displayFiles 永远降级裸行 → DisplayAdapter storeDocument=null → DocumentViewer 永久 Loading。
 *
 * 冻结契约：
 *   缓存签名必须基于 InvoiceDocument 的 canonical identity，而不是碰巧不存在的 `key`。
 *
 * @module utils/documentViewCacheIdentity
 */

import { resolveDocumentIdentity } from '../stores/DocumentStore.js'

/**
 * 文档缓存身份（canonical → fallback stable → fileKey）。
 *
 * 语义（用户冻结 2026-08-23）：
 *   canonical document identity（复合键 instanceId::invoiceDocumentId，最稳定）
 *     → fallback stable document identity（invoiceDocumentId / instanceId / docId）
 *     → fileKey（最后的稳定兜底，仍不同于 UI key）
 *
 * @param {Object|null} doc - InvoiceDocument
 * @returns {string} 缓存身份键（永不返回空字符串）
 */
export function getDocumentCacheIdentity(doc) {
  if (!doc) return ''
  // 1. canonical identity（resolveDocumentIdentity 优先级：复合键 → invoiceDocumentId → instanceId → docId → id）
  const canonical = resolveDocumentIdentity(doc)
  if (canonical) return canonical
  // 2. fallback stable identity（resolveDocumentIdentity 未覆盖的字段）
  const stable = doc.fileKey || doc.sourceDocId || doc.id
  if (stable) return stable
  // 3. 最后的稳定兜底：docId
  return doc.docId || ''
}

/**
 * 计算 docsSig（缓存签名的一部分）。
 *
 * 与 FileContext 的旧协议对比（旧协议用 d.key，本函数用 getDocumentCacheIdentity）：
 *   - 旧：invoiceDocs.map(d => d.key).sort().join('‖')  → InvoiceDocument 无 key → 恒 ''
 *   - 新：invoiceDocs.map(getDocumentCacheIdentity).sort().join('‖') → canonical identity
 *
 * @param {Object[]|null} invoiceDocs
 * @returns {string}
 */
export function computeDocsSig(invoiceDocs) {
  if (!Array.isArray(invoiceDocs) || invoiceDocs.length === 0) return ''
  return invoiceDocs.map(getDocumentCacheIdentity).sort().join('‖')
}

/**
 * 旧协议复刻（仅供 Red 测试证明缺陷，不用于生产）。
 */
export function legacyComputeDocsSig(invoiceDocs) {
  if (!Array.isArray(invoiceDocs) || invoiceDocs.length === 0) return ''
  return invoiceDocs.map(d => d.key).sort().join('‖')
}
