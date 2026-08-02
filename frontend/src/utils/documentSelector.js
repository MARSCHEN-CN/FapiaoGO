/**
 * documentSelector — 文档级选择的唯一收敛点（DocumentSelector）
 *
 * 职责：
 *   消灭「每个消费者自己从 files[] 猜 Document」的 Page 泄漏点。所有业务动作
 *   （Sidebar / Rename / Pack / Excel / PDF Export / Confirm Modal / History）
 *   都应通过本模块选择文档，而不是各自内联 groupFilesByDocument(files) 或
 *   files.filter(f => f.status === 'parsed')。
 *
 * 领域边界（与 Print703 迁移铁律一致）：
 *   - Page/File 层不得决定业务输出；InvoiceDocument 是唯一业务入口。
 *   - 装配结果（documentView.documents = InvoiceDocument[]）优先；
 *     旧路径 groupFilesByDocument 仅作为 fallback，待全消费者迁移完成后清理。
 *
 * @module utils/documentSelector
 */

import { groupFilesByDocument } from './groupDocuments.js'

/**
 * 选择 document-level 展示条目。
 *
 * 单一收敛点，取代散落在 App.jsx / Sidebar.jsx 的重复分支：
 *   if (!isSearching && documentView?.documents?.length) return documentView.documents
 *   else return groupFilesByDocument(...)
 *
 * 行为（刻意与既有实现保持一致）：
 *   - 非搜索态且有装配结果 → 直接返回 InvoiceDocument[]（不转 row，保持 document 身份）
 *   - 搜索态 / 无装配结果 → 退回 groupFilesByDocument（page-level 兼容）
 *
 * @param {Object} params
 * @param {Object[]} [params.invoiceDocs] - 装配结果 InvoiceDocument[]（documentView.documents）
 * @param {Object[]} params.files - page-level fileObj[]（FileContext.files）
 * @param {Object[]} [params.filteredFiles] - 搜索态过滤后的 files
 * @param {boolean} [params.isSearching] - 是否搜索态（搜索态强制 page-level）
 * @returns {Object[]} document-level 展示条目（InvoiceDocument[] 或 page-group rows）
 */
export function selectDocumentRows({ invoiceDocs, files, filteredFiles, isSearching }) {
  if (!isSearching && Array.isArray(invoiceDocs) && invoiceDocs.length > 0) {
    return invoiceDocs
  }
  const source = isSearching ? (filteredFiles || files) : files
  return groupFilesByDocument(source)
}

/**
 * 选择已解析（status === 'parsed'）的 page-level 文件。
 *
 * 取代散落的 files.filter(f => f.status === 'parsed')，统一「可打印/可导出」
 * 的判定入口。
 *
 * @param {Object[]} [files] - page-level fileObj[]
 * @returns {Object[]} status === 'parsed' 的文件数组（空/非数组安全）
 */
export function selectParsedFiles(files) {
  if (!Array.isArray(files)) return []
  return files.filter((f) => f?.status === 'parsed')
}

/**
 * 选择属于某个 document（按 docId）的 page-level 文件。
 *
 * 取代散落的 files.filter(f => f.docId === docId)，供「按文档取页」类动作
 * （预览/打包/导出）统一获取成员页。
 *
 * @param {string} [docId] - 目标 document 的 docId
 * @param {Object[]} [files] - page-level fileObj[]
 * @returns {Object[]} 匹配 docId 的文件数组（空/非数组/无 docId 安全）
 */
export function getDocumentFiles(docId, files) {
  if (!docId || !Array.isArray(files)) return []
  return files.filter((f) => f?.docId === docId && f.key)
}
