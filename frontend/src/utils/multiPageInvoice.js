/**
 * multiPageInvoice — 多页发票判定规则（2026-07-27 冻结）
 *
 * 职责：
 *   仅判定「后端 assembly 的结果是否构成真正的多页发票」。
 *   不做 assembly、不做合并、不做消费。
 *
 * 三层模型（2026-07-27 冻结）：
 *   ① SourceDocument（物理来源，由 sourceDocId 标识）
 *   ② InvoiceDocument（业务发票，由 invoiceNumber + 分页标识共同判定）
 *   ③ Page 文件（展示/打印单位，始终保留 page-level files）
 *
 * 多页判定规则（必须同时满足）：
 *   1. invoiceNumber 存在且不为空
 *   2. 至少 2 个 pageKey（_pageKeys.length >= 2）
 *   3. 至少一页有有效分页标识（pageNum + totalPages > 1）
 *
 * 反例：两个单页 PDF 意外同号 → 有 invoiceNumber、但无 pageNum/totalPages
 *   → isMultiPageInvoiceDocument() 返回 false
 *   → fallback 为独立文件 → 展示为两个文件 + 重复组提示
 *
 * @module utils/multiPageInvoice
 */

/**
 * 判断后端 assembly 结果是否为真正的多页发票。
 *
 * @param {Object} assembledDoc - 后端 assembly 输出的文档元信息
 * @param {string} assembledDoc.invoiceNumber - 发票号码
 * @param {string[]} pageKeys - 该组装涉及的所有页面 fileObj key 列表
 * @param {Object[]} filesPool - 全局文件池（含 pageNum/totalPages 的 fileObj 数组）
 * @returns {boolean}
 */
export function isMultiPageInvoiceDocument(assembledDoc, pageKeys, filesPool) {
  // ── 规则 1：必须存在发票号码 ──
  if (!assembledDoc?.invoiceNumber) {
    return false
  }

  // ── 规则 2：必须不少于 2 个页面 key ──
  if (!Array.isArray(pageKeys) || pageKeys.length < 2) {
    return false
  }

  // ── 规则 3：至少一页有有效分页标识（pageNum + totalPages > 1） ──
  const pageFiles = filesPool.filter((f) => pageKeys.includes(f.key))
  const hasPageMarker = pageFiles.some(
    (f) => f.pageNum && f.totalPages && f.totalPages > 1,
  )

  return hasPageMarker
}
