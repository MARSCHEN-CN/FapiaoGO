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

  // _pageKeys 是 assembly 阶段精确记录的页面 fileObj key 列表（强身份），
  // 直接对 allFiles 命中，不依赖可能被 per-page render id 覆盖的 docId。
  // 这避免了「session.files[].docId 被逐页身份改写 → candidates 为空 → 整票被过滤」的断链。
  let pageFiles
  if (Array.isArray(invoiceDoc._pageKeys) && invoiceDoc._pageKeys.length) {
    pageFiles = allFiles.filter((f) => invoiceDoc._pageKeys.includes(f.key))
  } else {
    // 弱身份回退：旧路径兼容（无 _pageKeys 时按 sourceDocId/docId 匹配）
    // E-2.2: InvoiceDocument.docId = 组装 identity（sourceDocId_inv_invoiceNumber），
    // 而 session.files[].docId = 原始导入文件 identity（sourceDocId），
    // 因此匹配字段使用 sourceDocId，回退到 docId。
    const matchDocId = invoiceDoc.sourceDocId || invoiceDoc.docId
    pageFiles = allFiles.filter((f) => f.docId === matchDocId && f.key)
  }

  // 无匹配 fileObj → 异常状态，不产生条目
  if (pageFiles.length === 0) return null

  if (pageFiles.length > 1) {
    // 多页 → group 条目（_isDocumentGroup: true）
    // pageNum 可能为 0（第一页），0 是 falsy，不能用 || 1 导致排序错乱
    const sorted = [...pageFiles].sort(
      (a, b) => (a.pageNum ?? 0) - (b.pageNum ?? 0)
    )
    const rep = sorted[0]
    return {
      ...rep,
      name: restoreOriginalName(rep.name),
      // identity bridge：让 DisplayAdapter 通过业务 documentId 找到 InvoiceDocument
      documentId: invoiceDoc.docId,
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
 * 顺序保证：documents 按其首个 page 在排序后 allFiles 中的位置排序，
 * 确保与用户选择的文件列表排序（文件名/日期/金额/类型）一致。
 *
 * @param {import('../models/InvoiceDocument').InvoiceDocument[]} invoiceDocs
 * @param {import('../models/ImportSession').SessionFile[]} allFiles
 * @returns {Object[]} FileCardRow 条目数组
 */
export function invoiceDocumentsToRows(invoiceDocs, allFiles) {
  if (!Array.isArray(invoiceDocs) || invoiceDocs.length === 0) return []
  if (!Array.isArray(allFiles)) return []

  // 构建 page key → 在排序后 files 中的索引位置（O(n)，一次性）
  const pageIndex = new Map()
  for (let i = 0; i < allFiles.length; i++) {
    const f = allFiles[i]
    if (f?.key && !pageIndex.has(f.key)) {
      pageIndex.set(f.key, i)
    }
  }

  // 先转换所有 docs，附带排序键（首个 page 的位置）
  const withOrder = []
  for (const doc of invoiceDocs) {
    const row = invoiceDocumentToRow(doc, allFiles)
    if (!row) continue

    // 找到该 document 所有 pages 在排序后列表中的最小索引
    let orderIdx = Number.MAX_SAFE_INTEGER
    const pages = (row._isDocumentGroup && row._pages) ? row._pages : [row]
    for (const p of pages) {
      const idx = pageIndex.get(p.key)
      if (idx !== undefined && idx < orderIdx) {
        orderIdx = idx
      }
    }
    withOrder.push({ orderIdx: orderIdx === Number.MAX_SAFE_INTEGER ? 0 : orderIdx, row })
  }

  // 按首个 page 出现位置稳定排序
  withOrder.sort((a, b) => a.orderIdx - b.orderIdx)
  return withOrder.map((item) => item.row)
}
