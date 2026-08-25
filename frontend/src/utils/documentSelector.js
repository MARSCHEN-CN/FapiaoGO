/**
 * documentSelector — RENDER 路径中 groupDocuments 的唯一允许入口
 *
 * Invoice Entity Boundary Contract §八：
 *   本模块是 groupFilesByDocument/groupFilesByInstance 在 RENDER/PREVIEW 路径
 *   中的唯一允许调用点。禁止在 LIST/STORE/IDENTITY 路径中使用。
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
 *     旧路径 groupFilesByDocument 仅作为 RENDER fallback，不参与 Store 注册。
 *
 * @module utils/documentSelector
 */

import { groupFilesByDocument, groupFilesByInstance } from './groupDocuments.js'

/**
 * 选择 document-level 展示条目。
 *
 * 单一收敛点，取代散落在 App.jsx / Sidebar.jsx 的重复分支：
 *   if (!isSearching && documentView?.documents?.length) return documentView.documents
 *   else return groupFilesByDocument(...)
 *
 * 行为（刻意与既有实现保持一致）：
 *   - 非搜索态且有装配结果 → 直接返回 InvoiceDocument[]（不转 row，保持 document 身份）
 *   - 搜索态 / 无装配结果 → 先用 groupFilesByInstance 增强分组，再回退到 groupFilesByDocument
 *
 * @param {Object} params
 * @param {Object[]} [params.invoiceDocs] - 装配结果 InvoiceDocument[]（documentView.documents）
 * @param {Object[]} params.files - page-level fileObj[]（FileContext.files）
 * @param {Object[]} [params.filteredFiles] - 搜索态过滤后的 files
 * @param {boolean} [params.isSearching] - 是否搜索态（搜索态强制 page-level）
 * @returns {Object[]} document-level 展示条目（InvoiceDocument[] 或 page-group rows）
 */
export function selectDocumentRows({ invoiceDocs, files, filteredFiles, isSearching }) {
  const hasAssembly = Array.isArray(invoiceDocs) && invoiceDocs.length > 0

  if (hasAssembly) {
    if (!isSearching) {
      // ── 非搜索态：直接返回 InvoiceDocument[]（不转 row，保持 document 身份） ──
      return sortInvoiceDocsByFiles(invoiceDocs, files)
    }

    // ── 搜索态：从 invoiceDocs 中筛选匹配的文档，而非降级到分组文件路径 ──
    // 原因：分组文件条目是 spread 复制对象，丢失了 invoiceDocumentId/instanceId 复合身份，
    // 导致 DocumentStore 查找失败 → activeDocument 为 null → 展示区空白。
    // 从 invoiceDocs 筛选可保留正确的文档身份，同时确保多页文档返回完整页面。
    const matchedDocIds = collectMatchedDocIds(filteredFiles || files)
    const matchedDocs = filterInvoiceDocs(invoiceDocs, matchedDocIds)

    if (matchedDocs.length > 0) {
      return sortInvoiceDocsByFiles(matchedDocs, files)
    }
    // 无匹配时回退到分组路径（可能是文件未被装配为 InvoiceDocument）
  }

  // ── 降级路径：使用 groupFilesByInstance / groupFilesByDocument ──
  const source = isSearching ? (filteredFiles || files) : files
  const groupedByInstance = groupFilesByInstance(source)
  if (groupedByInstance.some(d => d._isDocumentGroup)) {
    return groupedByInstance
  }
  return groupFilesByDocument(source)
}

/**
 * 收集 files 中所有可用于匹配 InvoiceDocument 的 ID。
 * 包括 docId、sourceDocId、fileKey，以及每页的 renderDocId。
 *
 * @param {Object[]} files - page-level fileObj[]
 * @returns {Set<string>} 匹配 ID 集合
 */
function collectMatchedDocIds(files) {
  const ids = new Set()
  if (!Array.isArray(files)) return ids
  for (const f of files) {
    if (!f) continue
    if (f.docId) ids.add(f.docId)
    if (f.sourceDocId) ids.add(f.sourceDocId)
    if (f.key) ids.add(f.key)
  }
  return ids
}

/**
 * 从 InvoiceDocument[] 中筛选出与搜索结果匹配的文档。
 * 匹配规则：docId / fileKey / pages[].renderDocId 任一命中即算。
 *
 * @param {Object[]} invoiceDocs - InvoiceDocument[]
 * @param {Set<string>} matchedIds - 搜索结果相关的 ID 集合
 * @returns {Object[]} 匹配的 InvoiceDocument[]
 */
function filterInvoiceDocs(invoiceDocs, matchedIds) {
  return invoiceDocs.filter(doc => {
    // 直接匹配文档级 ID
    if (doc.docId && matchedIds.has(doc.docId)) return true
    if (doc.fileKey && matchedIds.has(doc.fileKey)) return true
    // 匹配页面级 renderDocId（用于同票多页场景）
    if (Array.isArray(doc.pages)) {
      return doc.pages.some(p => p.renderDocId && matchedIds.has(p.renderDocId))
    }
    return false
  })
}

/**
 * 按 files 顺序重排 InvoiceDocument[]：使 UI 文件列表顺序 = 用户排序后的 files 顺序。
 * invoiceDocs 来自装配管线（documentView.documents），其顺序不一定反映 files 的当前排序。
 * 为每个文档找到其在 files 中首个出现页的位置，按该位置排序。
 *
 * @param {Object[]} docs - InvoiceDocument[]
 * @param {Object[]} files - page-level fileObj[]
 * @returns {Object[]} 排序后的 InvoiceDocument[]
 */
function sortInvoiceDocsByFiles(docs, files) {
  const orderMap = new Map()
  for (let i = 0; i < (files?.length || 0); i++) {
    const f = files[i]
    if (!f) continue
    const id = f.docId || f.sourceDocId
    if (id && !orderMap.has(id)) {
      orderMap.set(id, i)
    }
    if (f.key && !orderMap.has(f.key)) {
      orderMap.set(f.key, i)
    }
  }
  const sorted = [...docs].sort((a, b) => {
    const posA = orderMap.get(a.documentId) ?? orderMap.get(a.key) ?? orderMap.get(a.docId) ?? Infinity
    const posB = orderMap.get(b.documentId) ?? orderMap.get(b.key) ?? orderMap.get(b.docId) ?? Infinity
    return posA - posB
  })
  return sorted
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
