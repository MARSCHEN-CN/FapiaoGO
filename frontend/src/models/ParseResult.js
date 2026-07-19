/**
 * ParseResult — 解析结果数据模型
 *
 * 职责：
 *   定义解析结果的标准化结构。
 *   隔离 API 响应格式与内部数据模型。
 *
 * 所有权：
 *   由 parseRunner 创建，由 ResultMapper 消费。
 *   不依赖 React / files[] / UI。
 *
 * @module models/ParseResult
 */

/**
 * @typedef {Object} InvoiceFields
 * @property {string} [kpr] - 开票人
 * @property {string} [amountJe] - 金额（不含税）
 * @property {string} [amountSe] - 税额
 * @property {Array} [line_items] - 明细行
 */

/**
 * @typedef {Object} ParseResultData
 * @property {'parsed'|'error'} status - 状态
 * @property {string|null} error - 错误信息
 * @property {Object} fields - 业务字段
 * @property {string} fields.invoiceType - 发票类型
 * @property {string} fields.invoiceNumber - 发票号码
 * @property {string} fields.amount - 价税合计
 * @property {string} fields.invoiceDate - 开票日期
 * @property {string} fields.newName - 重命名后的文件名
 * @property {string} fields.parseMethod - 解析方法
 * @property {string} fields.fileFormat - 文件格式
 * @property {string|null} fields.previewImage - 预览图 base64
 * @property {string[]} fields.failedFields - 失败字段列表
 * @property {InvoiceFields} fields.invoiceFields - 完整发票字段
 * @property {string} fields.issuer - 开票人
 * @property {string} fields.amountWithoutTax - 不含税金额
 * @property {string} fields.taxAmount - 税额
 * @property {Array} fields.lineItems - 明细行
 * @property {string} fields.rawText - 原始文本
 * @property {string} fields.searchText - 搜索文本
 * @property {Object} raw - 原始 API 响应（用于向后兼容）
 */

/**
 * 从 API 响应创建 ParseResult。
 *
 * @param {Object} data - API 响应数据
 * @param {string} [name] - 文件名（用于 searchText）
 * @returns {ParseResultData}
 */
export function createParseResult(data, name) {
  const fields = data.invoice_fields || data.invoiceFields || {}
  const status = data.success !== false ? 'parsed' : 'error'

  return {
    status,
    error: data.error || null,
    fields: {
      invoiceType: data.invoice_type || data.invoiceType || '',
      invoiceNumber: data.invoice_number || data.invoiceNumber || '',
      amount: data.amount != null ? String(data.amount) : '',
      invoiceDate: data.invoice_date || data.invoiceDate || '',
      newName: data.new_name || data.newName || name || '',
      parseMethod: data.parse_method || data.parseMethod || '',
      fileFormat: data.file_format || data.fileFormat || '',
      previewImage: data.preview_image || data.previewImage || null,
      failedFields: data.failed_fields || data.failedFields || [],
      invoiceFields: fields,
      issuer: fields?.kpr || '',
      amountWithoutTax: fields?.amountJe != null ? String(fields.amountJe) : '',
      taxAmount: fields?.amountSe != null ? String(fields.amountSe) : '',
      lineItems: fields?.line_items || [],
      rawText: data.raw_text || '',
      searchText: '',
    },
    raw: data,
  }
}
