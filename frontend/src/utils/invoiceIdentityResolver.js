/**
 * invoiceIdentityResolver — InvoiceDocument 统一身份出口
 *
 * Invoice Entity Boundary Contract §四：
 *   系统中所有 InvoiceDocument 身份判断必须通过本模块。
 *   禁止各处自行拼接 instanceId/docId/id/invoiceNumber 做身份判定。
 *
 * 优先级（冻结）：
 *   invoiceDocumentId — 领域主键（最终目标）
 *   id                — 旧数据兼容
 *   instanceId        — 文件实例身份（过渡）
 *   docId             — 内容哈希（兜底）
 *
 * Import Identity ≠ Invoice Identity（必须区分）:
 *   instanceId = 导入实例身份（同文件删后重导 → 不同 instanceId）
 *   invoiceDocumentId = 发票领域身份（跨导入稳定）
 *
 * @module utils/invoiceIdentityResolver
 */

/**
 * 统一 InvoiceDocument 身份解析。
 *
 * 所有 Store 的查找键、addDocument 去重键、export identity 都必须调用此函数。
 * 不再允许各处自行拼接 `doc.instanceId || doc.docId || doc.id`。
 *
 * @param {Object|string|null|undefined} docOrId
 * @returns {string|null} 统一身份键
 */
export function resolveInvoiceIdentity(docOrId) {
  if (!docOrId) return null
  if (typeof docOrId === 'string') return docOrId || null
  return (
    docOrId.invoiceDocumentId ||
    docOrId.id ||
    docOrId.instanceId ||
    docOrId.docId ||
    null
  )
}

/**
 * 为 InvoiceDocument 生成领域主键（invoiceDocumentId）。
 *
 * 生成规则：
 *   - 有后端 assembly 结果时：`${sourceDocId}_inv_${invoiceNumber}`
 *   - 无后端 assembly（fallback）：`${fileKey}_unassembled`
 *
 * 调用方：hydrateChunk（assembly 消费后）、fallback 路径。
 *
 * @param {Object} params
 * @param {string} params.sourceDocId - 源文档哈希
 * @param {string} params.invoiceNumber - 发票号
 * @param {string} [params.fileKey] - fallback 时的文件 key
 * @returns {string} invoiceDocumentId
 */
export function generateInvoiceDocumentId({ sourceDocId, invoiceNumber, fileKey }) {
  if (sourceDocId && invoiceNumber) {
    return `${sourceDocId}_inv_${invoiceNumber}`
  }
  if (fileKey) {
    return `${fileKey}_unassembled`
  }
  // 兜底（不应到达）
  return `__anon_${Date.now()}`
}

/**
 * 判断两个 doc 是否指向同一 InvoiceDocument。
 *
 * @param {Object|string} a
 * @param {Object|string} b
 * @returns {boolean}
 */
export function isSameInvoiceDocument(a, b) {
  const idA = resolveInvoiceIdentity(a)
  const idB = resolveInvoiceIdentity(b)
  if (!idA || !idB) return false
  return idA === idB
}
