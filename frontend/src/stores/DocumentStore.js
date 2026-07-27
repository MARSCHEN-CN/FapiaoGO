/**
 * DocumentStore — 前端 InvoiceDocument 注册表
 *
 * 职责：
 *   以 docId 为 key 存储 InvoiceDocument 实例。
 *   作为 Viewer 和 Print 两条路径的共享数据源。
 *   模块级 Map，与 ImportSessionStore / TaskRegistry 同级。
 *
 * 所有权：
 *   由 parseResultMapper（docId enrichment 时）或 Import Adapter 写入。
 *   由 DocumentViewer / PrintAdapter 读取。
 *   不依赖 React（纯数据层）。
 *
 * Architecture Law D1：
 *   只存业务数据（PageMeta），不存渲染资源（previewUrl）。
 *
 * @module stores/DocumentStore
 */

// 显式 .js 后缀：本模块需可被 node --test 直接加载（前端其余文件靠 bundler 解析
// extensionless，但 DocumentStore 是 13-A.3.5c 单测的入口，须 ESM 可解析）。webpack 两种写法皆兼容。
import { createDocument, createPageMeta } from '../models/InvoiceDocument.js'

/** @type {Map<string, import('../models/InvoiceDocument').InvoiceDocument>} */
const documents = new Map()

/**
 * ─── 响应式订阅（供 useSyncExternalStore 使用） ───
 *
 * DocumentStore 是模块级 Map，本身不触发 React 重渲染。
 * 通过 subscribe/notify，消费方（useDocument hook）可以在
 * Document 注册/更新/移除时自动重渲染。
 */
const listeners = new Set()

/**
 * 订阅 DocumentStore 变更。
 *
 * @param {() => void} listener - 变更回调
 * @returns {() => void} 取消订阅函数
 */
export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 通知所有订阅者（内部使用）。 */
function notify() {
  for (const listener of listeners) listener()
}

/**
 * 统一触发一次变更通知。
 *
 * 配合 ensureDocumentFromFileObj 的 silent 模式使用：
 * 大批量路径（如 hydration）在循环内静默注册，
 * 循环结束后调用本函数一次性通知，避免 N 文件 N 次通知。
 */
export function flushDocumentNotifications() {
  notify()
}

/**
 * 注册或更新一个 InvoiceDocument。
 *
 * @param {import('../models/InvoiceDocument').InvoiceDocument} doc
 * @returns {import('../models/InvoiceDocument').InvoiceDocument}
 */
export function registerDocument(doc) {
  if (!doc || !doc.docId) return doc
  documents.set(doc.docId, doc)
  notify()
  return doc
}

/**
 * 通过 docId 获取 InvoiceDocument。
 *
 * @param {string} docId
 * @returns {import('../models/InvoiceDocument').InvoiceDocument|null}
 */
export function getDocument(docId) {
  if (!docId) return null
  return documents.get(docId) || null
}

/**
 * 从 fileObj（及其同 docId 兄弟文件）确保有对应的 InvoiceDocument。
 *
 * Step 10.5 多页聚合（Display Refactor 范围，非 Coordinator）：
 *   导入拆分产生的多个分页 fileObj 共享同一 docId、各带不同 pageNum。
 *   传入 siblings（同批文件数组）后，按 docId 过滤、按 pageNum 排序，
 *   聚合为 pages[]（index = pageNum - 1），首次真正激活多页 Document。
 *   不重新解析 PDF、不做 OCR/ParseResult 合并（那些属于 Coordinator）。
 *
 * 单页兼容：未提供 siblings 时退化为单页构建。
 * 已回填的页面尺寸会被保留，避免聚合覆盖真实像素尺寸。
 *
 * @param {Object} fileObj
 * @param {Object[]} [siblings] - 同批文件数组（含所有共享 docId 的分页 fileObj）
 * @param {{silent?: boolean}} [options] - silent=true 时注册后不立即 notify，
 *   由调用方在循环结束后调用 flushDocumentNotifications() 统一通知。
 *   用于 hydration 等大批量路径，避免每文件一次通知。
 * @returns {import('../models/InvoiceDocument').InvoiceDocument|null}
 */
export function ensureDocumentFromFileObj(fileObj, siblings = null, options = {}) {
  const { silent = false } = options
  if (!fileObj?.docId) return null

  const docId = fileObj.docId
  const pool = Array.isArray(siblings) && siblings.length > 0 ? siblings : [fileObj]

  // 过滤同 docId 的分页，提取 pageNum（去重 + 升序）
  const seen = new Set()
  const pageNums = []
  for (const f of pool) {
    if (!f || f.docId !== docId) continue
    const pageNum = f.pageNum || 1
    if (!seen.has(pageNum)) {
      seen.add(pageNum)
      pageNums.push(pageNum)
    }
  }
  pageNums.sort((a, b) => a - b)

  const existing = documents.get(docId)

  // 保留已回填的页面尺寸（按 index 对应）
  const prevByIndex = new Map()
  if (existing) {
    for (const p of existing.pages) {
      if (p.width || p.height) prevByIndex.set(p.index, p)
    }
  }

  // siblings 聚合场景：
  // - pageNums.length > 1（原始多页 PDF，未拆分）：同一 docId 对应物理多页，
  //   index = pageNum - 1，renderPage = pageNum（物理页码）
  // - pageNums.length === 1（拆分后的单页文件/单页图片/OFD）：每个 docId 对应物理单页，
  //   不管 fileObj.pageNum 是多少（它是父 PDF 中的页码，用于排序），物理文件内只有 1 页，
  //   index = 0，renderPage = 1。
  const isSinglePagePhysicalDoc = pageNums.length === 1
  const pages = pageNums.map((pageNum, arrayIdx) => {
    const index = isSinglePagePhysicalDoc ? 0 : (pageNum - 1)
    const renderPage = isSinglePagePhysicalDoc ? 1 : pageNum
    const prev = prevByIndex.get(index)
    return createPageMeta({
      docId,
      index,
      width: prev?.width || 0,
      height: prev?.height || 0,
      sourceRotation: prev?.sourceRotation || 0,
      renderPage,
    })
  })

  // 与现有 Document 完全一致时直接返回，避免无意义通知
  if (
    existing &&
    existing.pageCount === pages.length &&
    existing.pages.every(
      (p, i) =>
        p.index === pages[i].index &&
        p.width === pages[i].width &&
        p.height === pages[i].height &&
        p.sourceRotation === pages[i].sourceRotation,
    )
  ) {
    return existing
  }

  const doc = createDocument({
    docId,
    fileKey: fileObj.key || '',
    sourceHash: fileObj.identity?.sourceHash || '',
    pages,
  })
  documents.set(docId, doc)
  if (!silent) notify()
  return doc
}

/**
 * 从后端 metadata 合同注册/更新 InvoiceDocument（metadata 驱动入口）。
 *
 * 13-A.3.5c：所有非 PDF 文档（OFD / 未来 TIFF / 多页图 / CAD / HTML）进入
 * DocumentStore 的唯一 metadata 驱动入口。只认后端 page contract，不感知具体
 * 格式（无 `if ofd` 分支）。命名为 FromMetadata 以区别于死代码 registerFromCoordinator。
 *
 * 与 ensureDocumentFromFileObj 的关系：
 *   - ensureDocumentFromFileObj 由 parseResultConsumer 驱动，基于 siblings 拆分页
 *     聚合（pageNum）；对单文件多页格式（OFD）会把 N 页压成 1 页，且不携带真实尺寸。
 *   - ensureDocumentFromMetadata 由 render contract 驱动，携带后端权威 pages[]
 *     （index / width / height / rotation），是页面结构 + 尺寸的最终权威来源。
 *   二者作用于同一 docId 时，本函数结果应作为最后写入（覆盖 siblings 的欠维注册）。
 *
 * 字段映射：API 层 pages[] 用 `rotation`（统一命名），PageMeta 用 `sourceRotation`，
 * 在此完成映射。metadata 缺维（width/height 为 0）时回退保留既有 Document 的真实尺寸。
 *
 * @param {Object} meta - { docId, pages: [{index, width, height, rotation}], filename? }
 * @param {{silent?: boolean}} [options] - silent=true 时注册后不立即 notify（批处理统一 flush）
 * @returns {import('../models/InvoiceDocument').InvoiceDocument|null}
 */
export function ensureDocumentFromMetadata(meta, options = {}) {
  const { silent = false } = options
  if (!meta || !meta.docId) return null
  const { docId, pages: rawPages = [], filename } = meta

  const existing = documents.get(docId)
  const prevByIndex = new Map()
  if (existing) {
    for (const p of existing.pages) {
      if (p.width || p.height || p.sourceRotation) prevByIndex.set(p.index, p)
    }
  }

  // API 层字段为 rotation；PageMeta 用 sourceRotation。metadata 缺维时保留既有真实尺寸。
  // renderPage：物理文件内页码 = index+1（metadata pages[].index 为 0-based），
  // 与 assembly 场景下每个物理文件都是单页(renderPage=1)不同，原始多页 PDF 需使用真实物理页码。
  const pages = rawPages.map((p) => {
    const index = p.index ?? 0
    const prev = prevByIndex.get(index)
    return createPageMeta({
      docId,
      index,
      width: p.width || prev?.width || 0,
      height: p.height || prev?.height || 0,
      sourceRotation: p.rotation || p.sourceRotation || prev?.sourceRotation || 0,
      renderPage: index + 1,
    })
  })

  // 与现有 Document 完全一致时直接返回，避免无意义通知
  if (
    existing &&
    existing.pageCount === pages.length &&
    existing.pages.every(
      (p, i) =>
        p.index === pages[i].index &&
        p.width === pages[i].width &&
        p.height === pages[i].height &&
        p.sourceRotation === pages[i].sourceRotation
    )
  ) {
    return existing
  }

  const doc = createDocument({
    docId,
    fileKey: existing?.fileKey || filename || '',
    sourceHash: existing?.sourceHash || '',
    pages,
  })
  documents.set(docId, doc)
  if (!silent) notify()
  return doc
}

/**
 * 更新已有 Document 的页面元数据（例如后端返回了真实尺寸）。
 *
 * @param {string} docId
 * @param {Array<{index: number, width?: number, height?: number, sourceRotation?: number}>} pages
 */
export function updatePageMeta(docId, pages) {
  const doc = documents.get(docId)
  if (!doc) return

  // metadata 回填只更新 width/height/sourceRotation，必须保留 renderDocId/renderPage 等渲染身份字段
  const oldByIndex = new Map(doc.pages.map((p) => [p.index, p]))
  const updatedPages = pages.map((p) => {
    const old = oldByIndex.get(p.index)
    return createPageMeta({
      docId,
      index: p.index,
      width: p.width || old?.width || 0,
      height: p.height || old?.height || 0,
      sourceRotation: p.sourceRotation ?? old?.sourceRotation ?? 0,
      renderDocId: old?.renderDocId,
      renderPage: old?.renderPage,
    })
  })
  documents.set(docId, { ...doc, pages: updatedPages, pageCount: updatedPages.length })
  notify()
}

/**
 * 合并更新单页元数据（不影响其他页面）。
 *
 * 主要用途：页面图片加载后，将真实像素尺寸回填到 PageMeta。
 * 与 updatePageMeta（整组替换）不同，本函数只改指定页的指定字段，
 * 其余页面与字段保持不变。pageCount 不变。
 *
 * @param {string} docId
 * @param {number} pageIndex - 0-based 页索引
 * @param {{width?: number, height?: number, sourceRotation?: number}} patch - 要合并的字段
 */
export function patchPageMeta(docId, pageIndex, patch) {
  const doc = documents.get(docId)
  if (!doc) return

  const pages = doc.pages.map((p) =>
    p.index === pageIndex
      ? createPageMeta({
          docId,
          index: p.index,
          width: patch.width ?? p.width,
          height: patch.height ?? p.height,
          sourceRotation: patch.sourceRotation ?? p.sourceRotation,
          renderDocId: p.renderDocId,
          renderPage: p.renderPage,
        })
      : p
  )
  documents.set(docId, { ...doc, pages })
  notify()
}

/**
 * 移除一个 Document（文件删除时）。
 *
 * @param {string} docId
 */
export function removeDocument(docId) {
  if (docId) {
    documents.delete(docId)
    notify()
  }
}

/**
 * 清空所有 Document（全部清除时）。
 */
export function clearAllDocuments() {
  documents.clear()
  notify()
}

/**
 * 获取当前注册的 Document 数量（调试用）。
 *
 * @returns {number}
 */
export function getDocumentCount() {
  return documents.size
}

/**
 * 获取所有已注册的 docId（生命周期 GC 用）。
 *
 * 配合 App 层的反应式清理：当 files[] 中不再有任何文件引用某 docId 时，
 * 调用 removeDocument 回收对应 Document，防止删除后残留。
 *
 * @returns {string[]}
 */
export function getRegisteredDocIds() {
  return Array.from(documents.keys())
}
