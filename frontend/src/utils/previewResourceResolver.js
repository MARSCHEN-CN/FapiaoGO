/**
 * PreviewResourceResolver — 预览资源 URL 解析
 *
 * 职责：
 *   从 PageMeta（纯业务数据）解析出渲染资源 URL。
 *   隔离 Document 模型与渲染实现（Architecture Law D1）。
 *
 * 设计：
 *   Document 模型不含 previewUrl / thumbnailUrl。
 *   Viewer 通过本模块获取资源 URL。
 *   未来渲染端点变化（/preview → /render/image → blob:）只改这里，Document 不动。
 *
 * 所有权：
 *   由 DocumentViewer / ThumbnailStrip 调用。
 *   不依赖 React / 状态管理。
 *
 * @module utils/previewResourceResolver
 */

import { BACKEND_URL } from '../config'

/**
 * 解析页面大图预览 URL。
 *
 * @param {import('../models/InvoiceDocument').PageMeta} page - 页面元数据
 * @param {string} docId - 文档 ID
 * @returns {string} - 150dpi WebP 预览 URL
 */
export function resolvePreviewUrl(page, docId) {
  return `${BACKEND_URL}/preview/${docId}?page=${page.index + 1}`
}

/**
 * 解析页面缩略图 URL。
 *
 * @param {import('../models/InvoiceDocument').PageMeta} page - 页面元数据
 * @param {string} docId - 文档 ID
 * @returns {string} - 400px 宽 WebP 缩略图 URL
 */
export function resolveThumbnailUrl(page, docId) {
  return `${BACKEND_URL}/preview/${docId}?page=${page.index + 1}&size=thumb`
}

/**
 * 批量解析文档所有页面的缩略图 URL。
 *
 * @param {import('../models/InvoiceDocument').InvoiceDocument} doc
 * @returns {string[]} - 按页索引排列的缩略图 URL 数组
 */
export function resolveAllThumbnailUrls(doc) {
  if (!doc || !doc.pages) return []
  return doc.pages.map((page) => resolveThumbnailUrl(page, doc.docId))
}
