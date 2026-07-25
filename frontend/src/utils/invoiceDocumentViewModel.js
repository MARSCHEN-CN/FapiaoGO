/**
 * invoiceDocumentViewModel — InvoiceDocument → FileCardRow 适配层
 *
 * 职责：
 *   将 InvoiceDocument（业务实体）转换为 FileCardRow 消费的展示条目。
 *   保持与 groupFilesByDocument 的输出结构兼容，使 FileCardRow 零改动。
 *
 * 转换规则：
 *   - pageCount > 1 → group 条目（{...rep, _pages, _pageCount, _isDocumentGroup}）
 *   - pageCount === 1 → 直接返回匹配到的 fileObj（非 group）
 *   - 无匹配 fileObj → 过滤掉（异常状态，不应出现在 UI 中）
 *
 * 与 groupFilesByDocument 的关系：
 *   本模块是它的替代品，输入从 page-level files[] 变为
 *   InvoiceDocument[]（session.documents），输出结构保持兼容。
 *
 * @module utils/invoiceDocumentViewModel
 */

/**
 * 从拆分页文件名还原原始文件名。
 * "invoice_p1.pdf" → "invoice.pdf"
 *
 * @param {string} pageName
 * @returns {string}
 */
function restoreOriginalName(pageName) {
  if (!pageName) return pageName
  return pageName.replace(/_p\d+\.pdf$/i, '.pdf')
}

/**
 * 将单个 InvoiceDocument 转换为 FileCardRow 展示条目。
 *
 * @param {import('../models/InvoiceDocument').InvoiceDocument} invoiceDoc
 * @param {import('../models/ImportSession').SessionFile[]} allFiles - session.files[]
 * @returns {Object|null} FileCardRow 条目，或 null（无匹配文件时）
 */
export function invoiceDocumentToRow(invoiceDoc, allFiles) {
  if (!invoiceDoc?.docId) return null

  // 通过 sourceDocId 匹配该 InvoiceDocument 对应的页面 fileObj。
  // E-2.2: InvoiceDocument.docId = 组装 identity（sourceDocId_inv_invoiceNumber），
  // 而 session.files[].docId = 原始导入文件 identity（sourceDocId），
  // 因此匹配字段使用 sourceDocId，回退到 docId（旧路径兼容）。
  const matchDocId = invoiceDoc.sourceDocId || invoiceDoc.docId
  const pageFiles = allFiles.filter(
    (f) => f.docId === matchDocId && f.key
  )

  // 无匹配 fileObj → 异常状态，不产生条目
  if (pageFiles.length === 0) return null

  if (pageFiles.length > 1) {
    // 多页 → group 条目（_isDocumentGroup: true）
    const sorted = [...pageFiles].sort(
      (a, b) => (a.pageNum || 1) - (b.pageNum || 1)
    )
    const rep = sorted[0]
    return {
      ...rep,
      name: restoreOriginalName(rep.name),
      _pages: sorted,
      _pageCount: sorted.length,
      _isDocumentGroup: true,
    }
  }

  // 单页 → 直接返回匹配到的 fileObj（非 group）
  return pageFiles[0]
}

/**
 * 将 InvoiceDocument[] 批量转换为 FileCardRow 展示条目数组。
 *
 * @param {import('../models/InvoiceDocument').InvoiceDocument[]} invoiceDocs
 * @param {import('../models/ImportSession').SessionFile[]} allFiles
 * @returns {Object[]} FileCardRow 条目数组
 */
export function invoiceDocumentsToRows(invoiceDocs, allFiles) {
  if (!Array.isArray(invoiceDocs) || invoiceDocs.length === 0) return []
  if (!Array.isArray(allFiles)) return []

  return invoiceDocs
    .map((doc) => invoiceDocumentToRow(doc, allFiles))
    .filter(Boolean)
}
