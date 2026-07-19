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

/**
 * 将 ParseResult 映射为 files[] 的更新字段。
 *
 * @param {import('../models/ParseResult').ParseResultData} result - 解析结果
 * @param {Object} fileObj - 原始文件对象（用于获取 name, key 等）
 * @returns {Object} 可合并到 files[] 的更新字段
 */
export function mapParseResultToFileUpdate(result, fileObj) {
  const { fields, raw } = result

  return {
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
}
