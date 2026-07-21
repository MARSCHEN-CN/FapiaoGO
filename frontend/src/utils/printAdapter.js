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
 *   - Source 模式：printPath 指向原始 PDF，Sumatra 自动打印所有页
 *   - Legacy 模式：需要逐页渲染（通过 resolvePreviewUrl 获取每页图像）
 *
 * 所有权：
 *   由 usePrint 在构建打印队列时调用。
 *   不依赖 React / Viewer / DocumentViewer。
 *
 * @module utils/printAdapter
 */

import { getDocument } from '../stores/DocumentStore'
import { resolvePreviewUrl } from './previewResourceResolver'

/**
 * @typedef {Object} PrintJobItem
 * @property {string} key - 文件标识
 * @property {string} printPath - 文件系统路径（Source 模式用）
 * @property {string} fileFormat - 文件格式
 * @property {number} pageCount - 总页数
 * @property {string[]} pageUrls - 每页预览 URL（Legacy 模式用）
 * @property {string} docId - 文档 ID
 */

/**
 * 从 fileObj 构建打印任务项。
 *
 * 如果 fileObj 有关联的 InvoiceDocument（多页），则从 Document 模型获取页信息。
 * 否则回退到单页模式（现有行为不变）。
 *
 * @param {Object} fileObj - 前端文件对象
 * @returns {PrintJobItem}
 */
export function buildPrintJobItem(fileObj) {
  const docId = fileObj.docId || fileObj.documentId || ''
  const doc = docId ? getDocument(docId) : null

  // 多页文档：从 Document 模型获取页信息
  if (doc && doc.pageCount > 1) {
    return {
      key: fileObj.key,
      printPath: fileObj.printPath || fileObj.path || '',
      fileFormat: fileObj.fileFormat || 'pdf',
      pageCount: doc.pageCount,
      pageUrls: doc.pages.map((page) => resolvePreviewUrl(page, doc.docId)),
      docId: doc.docId,
    }
  }

  // 单页 / 无 Document：保持现有行为
  return {
    key: fileObj.key,
    printPath: fileObj.printPath || fileObj.path || '',
    fileFormat: fileObj.fileFormat || 'pdf',
    pageCount: 1,
    pageUrls: [],
    docId,
  }
}

/**
 * 判断打印任务是否需要逐页渲染（Legacy 模式多页）。
 *
 * Source 模式下 Sumatra 原生处理多页，不需要逐页。
 * Legacy 模式下多页需要逐页获取图像。
 *
 * @param {PrintJobItem} item
 * @param {'source'|'legacy'} pipelineMode
 * @returns {boolean}
 */
export function needsPerPageRender(item, pipelineMode) {
  if (pipelineMode === 'source') return false
  return item.pageCount > 1 && item.pageUrls.length > 0
}

/**
 * 获取多页文档的所有页预览 URL（Legacy 模式逐页渲染用）。
 *
 * @param {PrintJobItem} item
 * @returns {string[]} - 每页的预览 URL
 */
export function getPageUrlsForPrint(item) {
  return item.pageUrls || []
}

/**
 * 验证打印任务完整性。
 *
 * Architecture Law D1：打印不读 Viewer 状态。
 * 此函数确认打印数据完全来自 Document 模型 + fileObj 路径。
 *
 * @param {PrintJobItem} item
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validatePrintJob(item) {
  if (!item.printPath && item.pageUrls.length === 0) {
    return { valid: false, reason: '无打印路径且无页面 URL' }
  }
  if (item.pageCount > 1 && item.pageUrls.length === 0 && !item.printPath) {
    return { valid: false, reason: '多页文档缺少页面 URL 和打印路径' }
  }
  return { valid: true }
}
