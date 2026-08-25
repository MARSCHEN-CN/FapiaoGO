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
      // ── 非搜索态：直接返回行对象（已含 _isDocumentGroup / _pageCount / _pages 等完整字段） ──
      return sortInvoiceDocsByFiles(invoiceDocs, files)
    }

    // ── 搜索态：从 invoiceDocs（行对象）中筛选匹配的文档 ──
    // 关键约束：
    //   1. 行对象已包含完整 _pages（所有页）和 _pageCount（总页数），
    //      因此 multipage-label 始终显示总页数，不受搜索命中哪一页影响。
    //   2. 行对象已包含 instanceId / invoiceDocumentId 身份字段，
    //      确保 DocumentStore 查找和预览系统正常工作。
    const sourceFiles = filteredFiles || files
    const matchedDocIds = collectMatchedDocIds(sourceFiles)
    const matchedDocs = filterInvoiceDocs(invoiceDocs, matchedDocIds)

    if (matchedDocs.length > 0) {
      // 为每个匹配的文档确定 matchedPageIndex（命中页的 0-based 索引）
      const enrichedDocs = matchedDocs.map(doc => {
        const matchedPageIndex = findMatchedPageIndex(doc, sourceFiles, matchedDocIds)
        if (matchedPageIndex < 0) return doc
        return { ...doc, matchedPageIndex }
      })
      return sortInvoiceDocsByFiles(enrichedDocs, files)
    }

    // ── 行对象无匹配时的安全回退 ──
    // 可能原因：搜索命中了文件，但这些文件尚未被装配进行对象。
    // 此时用完整 files 做文档级分组（保证多页完整性），
    // 然后筛选出包含匹配页的文档，并设置 matchedPageIndex。
    if (filteredFiles && filteredFiles.length > 0) {
      const fallbackMatchedIds = collectMatchedDocIds(filteredFiles)
      const groupedDocs = groupFilesByDocument(files)
      const filtered = filterDocumentsByPageIds(groupedDocs, fallbackMatchedIds)
      // 为筛选结果添加 matchedPageIndex，使预览从命中页开始
      return filtered.map(doc => {
        const idx = findMatchedPageIndex(doc, filteredFiles, fallbackMatchedIds)
        return idx >= 0 ? { ...doc, matchedPageIndex: idx } : doc
      })
    }
    // 搜索无结果时保持原列表
    return sortInvoiceDocsByFiles(invoiceDocs, files)
  }

  // ── 无装配结果时的降级路径 ──
  if (!isSearching) {
    // 非搜索态：直接对完整 files 做文档级分组
    const groupedByInstance = groupFilesByInstance(files)
    if (groupedByInstance.some(d => d._isDocumentGroup)) {
      return groupedByInstance
    }
    return groupFilesByDocument(files)
  }

  // 搜索态（无装配）：用完整 files 分组，然后按匹配页筛选文档
  // 关键：不能用 filteredFiles 分组——它只包含匹配的一页，
  // 会导致多页文档被错误地截断为单页。
  const fullGrouped = groupFilesByDocument(files)
  if (fullGrouped.length === 0) return []
  const matchedIds = collectMatchedDocIds(filteredFiles || files)
  const sourceForMatch = filteredFiles || files
  const filtered = filterDocumentsByPageIds(fullGrouped, matchedIds)
  // 为筛选结果添加 matchedPageIndex，使预览从命中页开始
  return filtered.map(doc => {
    const idx = findMatchedPageIndex(doc, sourceForMatch, matchedIds)
    return idx >= 0 ? { ...doc, matchedPageIndex: idx } : doc
  })
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
 * 匹配规则：docId / sourceDocId / fileKey / pages[].renderDocId / _pages[].key / _pages[].sourceDocId 任一命中即算。
 *
 * 关键修复：同票多页搜索时，匹配非首页内容（如第2页）的场景。
 * - 拆分页 PDF 每页有独立 docId（如 src_p1, src_p2），但共享同一 sourceDocId。
 * - 搜索第2页时 matchedIds 包含 src_p2, sourceDocId, page2_key。
 * - 若仅检查 doc.docId（= src_p1）会漏掉匹配，必须同时检查 sourceDocId 和 _pages。
 *
 * @param {Object[]} invoiceDocs - InvoiceDocument[] 或 row 对象（documentView.documents）
 * @param {Set<string>} matchedIds - 搜索结果相关的 ID 集合
 * @returns {Object[]} 匹配的 InvoiceDocument[]
 */
function filterInvoiceDocs(invoiceDocs, matchedIds) {
  return invoiceDocs.filter(doc => {
    // 1. 直接匹配文档级 ID（docId / documentId）
    if (doc.docId && matchedIds.has(doc.docId)) return true
    // documentId 是 invoiceDocumentToRow 显式设置的，与 InvoiceDocument.docId 一致
    if (doc.documentId && matchedIds.has(doc.documentId)) return true
    // 2. 匹配 sourceDocId（拆分页 PDF 的所有页共享同一 sourceDocId）
    //    这是修复同票多页搜索非首页的关键：第2页的 docId 不同于第1页，
    //    但它们的 sourceDocId 相同。row 对象通过 ...rep 继承了 sourceDocId。
    if (doc.sourceDocId && matchedIds.has(doc.sourceDocId)) return true
    // 3. 匹配 fileKey
    if (doc.fileKey && matchedIds.has(doc.fileKey)) return true
    // 4. 匹配 pages[].renderDocId（原生 InvoiceDocument 的 pages 数组）
    if (Array.isArray(doc.pages)) {
      if (doc.pages.some(p => p.renderDocId && matchedIds.has(p.renderDocId))) return true
    }
    // 5. 匹配 _pages（invoiceDocumentToRow 生成的 _pages 数组）
    //    _pages 中的每个 page 文件对象都有 renderDocId/sourceDocId/key
    if (Array.isArray(doc._pages)) {
      for (const p of doc._pages) {
        if (!p) continue
        if (p.renderDocId && matchedIds.has(p.renderDocId)) return true
        if (p.sourceDocId && matchedIds.has(p.sourceDocId)) return true
        if (p.docId && matchedIds.has(p.docId)) return true
        if (p.key && matchedIds.has(p.key)) return true
      }
    }
    return false
  })
}

/**
 * 在文档中找到与搜索结果匹配的页索引（0-based）。
 *
 * 当搜索命中多页发票的非首页内容时，此函数确定命中页在文档中的位置，
 * 使 DisplayAdapter/DocumentViewer 能从命中页开始显示，而非总是从首页开始。
 *
 * 匹配逻辑：
 * - 对 _pages 数组（invoiceDocumentToRow 生成的行对象）：逐页检查 key/docId/sourceDocId
 * - 对 pages 数组（原生 InvoiceDocument 的 PageMeta）：逐页检查 renderDocId
 * - 对直接的 page-level 文件：检查 file.key 是否在 matchedDocIds 中
 *
 * @param {Object} doc - 行对象（_isDocumentGroup + _pages）或 InvoiceDocument（pages）
 * @param {Object[]} sourceFiles - 搜索结果过滤后的 page-level fileObj[]
 * @param {Set<string>} matchedDocIds - 匹配 ID 集合
 * @returns {number} 0-based 匹配页索引；-1 表示未找到匹配
 */
function findMatchedPageIndex(doc, sourceFiles, matchedDocIds) {
  if (!doc) return -1

  // ⚠ 关键修复：优先匹配页面级专属标识（key/docId/renderDocId），
  // 而非共享的 sourceDocId。同票多页的所有页面共享同一 sourceDocId，
  // 若先匹配 sourceDocId，总会命中第 0 页，导致搜索第 2 页内容时
  // matchedPageIndex 错误地返回 0。
  //
  // 两轮匹配：
  //   第一轮：专属标识（key/docId/renderDocId）—— 精确命中
  //   第二轮：共享标识（sourceDocId）—— 仅在第一轮无命中时使用

  // 1. 使用 _pages（invoiceDocumentToRow 生成的行对象，包含完整 page 文件引用）
  if (Array.isArray(doc._pages) && doc._pages.length > 0) {
    // 第一轮：优先匹配专属标识
    for (let i = 0; i < doc._pages.length; i++) {
      const p = doc._pages[i]
      if (!p) continue
      if (p.key && matchedDocIds.has(p.key)) return i
      if (p.docId && matchedDocIds.has(p.docId)) return i
      if (p.renderDocId && matchedDocIds.has(p.renderDocId)) return i
    }
    // 第二轮：匹配共享的 sourceDocId（所有页面共享，仅在第一轮无精确命中时使用）
    for (let i = 0; i < doc._pages.length; i++) {
      const p = doc._pages[i]
      if (!p) continue
      if (p.sourceDocId && matchedDocIds.has(p.sourceDocId)) return i
    }
  }

  // 2. 使用 pages（原生 InvoiceDocument 的 PageMeta 数组）
  if (Array.isArray(doc.pages) && doc.pages.length > 0) {
    // 第一轮：专属标识
    for (let i = 0; i < doc.pages.length; i++) {
      const p = doc.pages[i]
      if (!p) continue
      if (p.renderDocId && matchedDocIds.has(p.renderDocId)) return i
      if (p.pageId && matchedDocIds.has(p.pageId)) return i
    }
    // 第二轮：共享标识（如果 PageMeta 有 sourceDocId）
    for (let i = 0; i < doc.pages.length; i++) {
      const p = doc.pages[i]
      if (!p) continue
      if (p.sourceDocId && matchedDocIds.has(p.sourceDocId)) return i
    }
  }

  return -1
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
 * 按页面 ID 集合筛选文档级条目。
 *
 * 设计目的：在搜索态下，先用完整 files 做文档级分组（保证多页完整性），
 * 再根据匹配到的页面 ID 筛选出包含匹配页的文档。
 * 这确保：
 *   1. 多页文档的 _pageCount 始终为总页数（不会因搜索只命中一页而变为 1）
 *   2. 多页文档的 _pages 始终包含所有页（不会因搜索只命中一页而截断）
 *   3. multipage-label 始终显示正确的总页数
 *
 * @param {Object[]} docs - 文档级条目数组（groupFilesByDocument 或 invoiceDocumentsToRows 输出）
 * @param {Set<string>} matchedIds - 匹配的页面 ID 集合（key / docId / sourceDocId）
 * @returns {Object[]} 包含至少一个匹配页的文档条目
 */
function filterDocumentsByPageIds(docs, matchedIds) {
  if (!Array.isArray(docs) || docs.length === 0) return []
  if (!matchedIds || matchedIds.size === 0) return docs

  return docs.filter(doc => {
    // 单页条目：直接检查自身 key / docId / sourceDocId
    if (!doc._isDocumentGroup || !Array.isArray(doc._pages)) {
      if (doc.key && matchedIds.has(doc.key)) return true
      if (doc.docId && matchedIds.has(doc.docId)) return true
      if (doc.sourceDocId && matchedIds.has(doc.sourceDocId)) return true
      return false
    }

    // 多页条目：检查 _pages 中是否有任一页面的 ID 在匹配集合中
    for (const page of doc._pages) {
      if (!page) continue
      if (page.key && matchedIds.has(page.key)) return true
      if (page.docId && matchedIds.has(page.docId)) return true
      if (page.sourceDocId && matchedIds.has(page.sourceDocId)) return true
    }
    return false
  })
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
