/**
 * parseResultMapper — 解析结果到 UI 数据的映射
 *
 * 职责：
 *   将 ParseResult 转换为 UI files[] 所需的更新字段。
 *   解耦 API 响应格式与 React state shape。
 *
 * 不负责：
 *   - 调用 setFiles()
 *   - 管理 files[] 生命周期
 *
 * @module mappers/parseResultMapper
 */

import { getFileFormat, buildSearchText } from '../utils'
import { updateDocumentIdentity } from '../utils/identity'

/**
 * 将 ParseResult 映射为 files[] 的更新字段。
 *
 * @param {import('../models/ParseResult').ParseResultData} result - 解析结果
 * @param {Object} fileObj - 原始文件对象（用于获取 name, key 等）
 * @returns {Object} 可合并到 files[] 的更新字段
 */
export function mapParseResultToFileUpdate(result, fileObj) {
  const { fields, raw } = result

  const fileUpdate = {
    status: result.status,
    invoiceType: fields.invoiceType || raw.invoice_type || '',
    invoiceNumber: fields.invoiceNumber || raw.invoice_number || '',
    amount: fields.amount || '',
    invoiceDate: fields.invoiceDate || raw.invoice_date || '',
    newName: fields.newName || fileObj.name,
    parseMethod: fields.parseMethod || raw.parse_method || '',
    fileFormat: fields.fileFormat || raw.file_format || getFileFormat(fileObj.name),
    previewImage: fields.previewImage || null,
    failedFields: fields.failedFields || [],
    invoiceFields: fields.invoiceFields || null,
    issuer: fields.issuer || fields.invoiceFields?.kpr || '',
    amountWithoutTax: fields.amountWithoutTax || '',
    taxAmount: fields.taxAmount || '',
    lineItems: fields.lineItems || [],
    rawText: fields.rawText || '',
    searchText: buildSearchText({
      name: fileObj.name,
      invoiceNumber: fields.invoiceNumber || raw.invoice_number || '',
      invoiceType: fields.invoiceType || raw.invoice_type || '',
      amount: fields.amount || '',
      invoiceDate: fields.invoiceDate || raw.invoice_date || '',
      invoice_fields: fields.invoiceFields || {},
      rawText: fields.rawText || '',
    }),
  }

  // ── Stage 4.2.1-c：Parse Enrichment ─────────────────────────────
  // parse 产生的是 document FACT（后端回传的稳定 doc_id），不是新 identity。
  // 因此只允许 enrichment（updateDocumentIdentity），绝不重新构造 identity / 重算 hash。
  // doc_id 来源：后端 parse 响应（build_response 已新增 doc_id 字段）。
  //   - 正常 parse：result.raw.doc_id（raw = 完整后端 JSON）
  //   - 直接传顶层 doc_id（测试/兼容）：result.doc_id
  // 缺省 / OCR 失败：docId 保持 ''，绝不 fallback 到 path / key / filename。
  // 无 doc_id 时直接返回 fileUpdate，保持 immutable flow（不 mutate fileObj.identity）。
  const docId = result?.doc_id ?? raw?.doc_id ?? ''
  if (docId && fileObj) {
    // updateDocumentIdentity 返回完整新 fileObj；此处只摘 docId + identity，
    // 避免展开整个 fileObj 覆盖上面的业务字段（status / invoiceType 等）。
    const enriched = updateDocumentIdentity(fileObj, docId)
    return {
      ...fileUpdate,
      docId: enriched.docId,
      identity: enriched.identity,
    }
  }

  return fileUpdate
}
