/**
 * printAdapter — Document 模型到打印系统的适配器
 *
 * 职责：
 *   从 InvoiceDocument 模型解析打印所需数据（路径、格式、页范围）。
 *   确保多页文档完整输出，不遗漏任何页面。
 *   不读取 Viewer 状态（zoom/pan/viewRotation）— Architecture Law D1。
 *
 * 设计：
 *   打印系统有两种模式：
 *   - Source 模式：直接发送文件路径给 Sumatra，原生处理多页
 *   - Legacy 模式：读取二进制 → canvas 渲染 → PNG → 打印
 *
 *   对于多页 InvoiceDocument：
 *   - Source 模式：printPath 指向原始文件，Sumatra 自动打印所有页
 *   - Legacy 模式：需要逐页渲染（通过 buildPrintJobItem().pages 获取每页引用，
 *     再 fetchPrintRaster(docId, page.index + 1) 取栅格 → 每页一 canvas → 一物理页）
 *
 * 所有权：
 *   由 usePrint 在构建打印队列时调用。
 *   不依赖 React / Viewer / DocumentViewer。
 *
 * @module utils/printAdapter
 */

import { getDocument } from '../stores/DocumentStore'
import { resolvePrintUrl } from './previewResourceResolver'

/**
 * @typedef {Object} PrintPageRef
 * @property {number} index - 0-based 页码
 * @property {string} url - 该页 Render Contract 打印端点（/print/{docId}?page=index+1）
 */

/**
 * @typedef {Object} PrintJobItem
 * @property {string} key - 文件标识
 * @property {string} printPath - 文件系统路径（Source 模式用）
 * @property {string} fileFormat - 文件格式
 * @property {number} pageCount - 总页数
 * @property {string} docId - 文档 ID
 * @property {PrintPageRef[]} pages - 每页引用（Render Print 逐页渲染用）
 */

/**
 * 从 fileObj 构建 Render Print 任务项（pages[] 富对象模型）。
 *
 * 如果 fileObj 有 docId 且 DocumentStore 中存在对应 Document，则逐页构建 pages[]，
 * 每项携带 0-based index 与该页 Render Contract 打印端点 URL。真正的页面身份是
 * `docId + page.index`，下游应通过 `fetchPrintRaster(docId, page.index + 1)` 取栅格，
 * 而非直接 fetch(page.url)——url 仅作人类可读定位。
 *
 * 无 docId / Document 不存在：pages 为空，由 usePrint 走 read-file / previewImage 兜底。
 *
 * @param {Object} fileObj - 前端文件对象
 * @returns {PrintJobItem}
 */
export function buildPrintJobItem(fileObj) {
  const docId = fileObj.docId || fileObj.documentId || ''
  const doc = docId ? getDocument(docId) : null

  // 有 Document：逐页构建 pages[]（Render Contract 的 /print 端点，200dpi）
  if (doc) {
    return {
      key: fileObj.key,
      printPath: fileObj.printPath || fileObj.path || '',
      fileFormat: fileObj.fileFormat || 'pdf',
      pageCount: doc.pageCount,
      docId: doc.docId,
      pages: doc.pages.map((page, index) => ({
        index,
        url: resolvePrintUrl(page, doc.docId),
      })),
    }
  }

  // 无 Document / 无 docId：保持现有行为（pages 空，usePrint 走兜底）
  return {
    key: fileObj.key,
    printPath: fileObj.printPath || fileObj.path || '',
    fileFormat: fileObj.fileFormat || 'pdf',
    pageCount: 1,
    docId,
    pages: [],
  }
}

/**
 * 从 Render Contract 取单页打印栅格（docId-first）。
 *
 * GET /print/{docId}?page=N（print preset, 200dpi WebP/PNG）→ Blob。
 * 替代旧链 previewImage(base64) 作为打印源；OFD 无前端可读字节，必须走此路径。
 *
 * @param {string} docId - 文档 ID
 * @param {number} [pageNum=1] - 1-based 页码
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<Blob>}
 */
export async function fetchPrintRaster(docId, pageNum = 1, { signal } = {}) {
  if (!docId) throw new Error('fetchPrintRaster: docId 缺失，无法走 Render Contract')
  const url = resolvePrintUrl({ index: pageNum - 1 }, docId)
  const res = await fetch(url, { signal })
  if (!res.ok) {
    throw new Error(`fetchPrintRaster HTTP ${res.status} for ${docId} page=${pageNum}`)
  }
  return res.blob()
}

/**
 * 判断打印任务是否需要逐页渲染（Legacy 模式多页）。
 *
 * Source 模式下 Sumatra 原生处理多页，不需要逐页。
 * Legacy 模式下多页需要逐页获取图像（pages[] 非空即表示有可渲染页）。
 *
 * @param {PrintJobItem} item
 * @param {'source'|'legacy'} pipelineMode
 * @returns {boolean}
 */
export function needsPerPageRender(item, pipelineMode) {
  if (pipelineMode === 'source') return false
  const pages = item.pages || []
  return item.pageCount > 1 && pages.length > 0
}

/**
 * 获取多页文档的所有页预览 URL（Legacy 模式逐页渲染用）。
 *
 * @param {PrintJobItem} item
 * @returns {string[]} - 每页的预览 URL
 */
export function getPageUrlsForPrint(item) {
  return (item.pages || []).map((p) => p.url)
}

/**
 * 验证打印任务完整性。
 *
 * Architecture Law D1：打印不读 Viewer 状态。
 * 此函数确认打印数据完全来自 Document 模型（pages[]）+ fileObj 路径。
 *
 * @param {PrintJobItem} item
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validatePrintJob(item) {
  const pages = item.pages || []
  if (!item.printPath && pages.length === 0) {
    return { valid: false, reason: '无打印路径且无页面引用' }
  }
  if (item.pageCount > 1 && pages.length === 0 && !item.printPath) {
    return { valid: false, reason: '多页文档缺少页面引用和打印路径' }
  }
  return { valid: true }
}
