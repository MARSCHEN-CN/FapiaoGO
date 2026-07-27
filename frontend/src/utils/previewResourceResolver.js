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
  // renderDocId 优先：PageMeta 携带的物理渲染身份（assembly 多页路径），
  // 使预览 URL 命中后端 `/preview/{renderDocId}?page=N` 而非业务 invDocId。
  const effectiveDocId = page?.renderDocId || docId
  return `${BACKEND_URL}/preview/${effectiveDocId}?page=${page.index + 1}`
}

/**
 * 解析页面打印栅格 URL（Render Contract 打印端点）。
 *
 * 指向后端 /print 端点（'print' preset：200dpi 高质 WebP/PNG），
 * 与 /preview 不同——/print 用于打印输出，分辨率更高。
 * 这是文档脱离旧链 base64 预览图后统一经 docId 栅格的唯一打印来源（原生文档无前端可读字节）。
 *
 * @param {import('../models/InvoiceDocument').PageMeta} page - 页面元数据
 * @param {string} docId - 文档 ID
 * @returns {string} - print preset WebP/PNG 打印栅格 URL
 */
export function resolvePrintUrl(page, docId) {
  const effectiveDocId = page?.renderDocId || docId
  return `${BACKEND_URL}/print/${effectiveDocId}?page=${page.index + 1}`
}

/**
 * 解析页面缩略图 URL。
 *
 * 指向后端 /thumbnail 端点（'thumbnail' preset：低 dpi 小图，默认 WebP），
 * 而非 /preview——/preview 会忽略 size 参数返回 150dpi 全尺寸预览图。
 *
 * @param {import('../models/InvoiceDocument').PageMeta} page - 页面元数据
 * @param {string} docId - 文档 ID
 * @returns {string} - thumbnail preset WebP 缩略图 URL
 */
export function resolveThumbnailUrl(page, docId) {
  const effectiveDocId = page?.renderDocId || docId
  return `${BACKEND_URL}/thumbnail/${effectiveDocId}?page=${page.index + 1}`
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
