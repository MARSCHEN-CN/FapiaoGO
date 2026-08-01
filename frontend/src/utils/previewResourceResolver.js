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
 * Architecture Law D1 — Split Page Render Identity：
 *   对拆分页（sourceDocId 存在且 docId !== sourceDocId），
 *   渲染资源仍挂载在父 PDF 的 sourceDocId 下（split_pdf 以 sourceDocId 打开 registry，
 *   extract_page_pdf 产出 page_bytes 仅按 sourceDocId 注册）。
 *   而 parse 返回的 per-page docId 是新的内容哈希，后端 render_engine 并未注册该身份，
 *   直接用它拼 URL 会命中 /preview/{docId} 404，导致 ViewerViewport 无限加载。
 *
 *   因此本函数必须：
 *     - 拆分页：effectiveDocId = sourceDocId（父 PDF 注册身份）
 *              pageNum        = pageNum + 1（文件在父 PDF 中的 1-based 页序）
 *     - 其它：  effectiveDocId = renderDocId || docId
 *              pageNum        = renderPage || index + 1
 *
 *   这与 legacy usePreview.js 中 `isParsedSplitPage → sourceDocId + pageNum` 的
 *   判据保持一致，确保 DocumentViewer 与 PreviewCanvas 走同一条后端服务路径。
 *
 * @param {import('../models/InvoiceDocument').PageMeta} page - 页面元数据
 * @param {string} docId - 文档 ID
 * @param {Object} [fileCtx] - 可选的 fileObj 上下文，用于拆分页身份判定
 * @param {string} [fileCtx.sourceDocId] - 拆分页所属父 PDF 的 sourceDocId
 * @param {number} [fileCtx.pageNum] - 拆分页在父 PDF 中的页序（0-based）
 * @param {string} [fileCtx.docId] - fileObj 自身的 docId（与 page.docId 对比判定拆分页）
 * @returns {string} - 150dpi WebP 预览 URL
 */
export function resolvePreviewUrl(page, docId, fileCtx = null) {
  const isParsedSplitPage = !!(
    fileCtx?.sourceDocId &&
    fileCtx?.docId &&
    fileCtx.docId !== fileCtx.sourceDocId
  )

  if (isParsedSplitPage) {
    // 拆分页：使用父 PDF 的 sourceDocId + 文件自身的 pageNum（1-based）
    const effectiveDocId = fileCtx.sourceDocId
    const pageNum = (fileCtx.pageNum ?? 0) + 1
    return `${BACKEND_URL}/preview/${effectiveDocId}?page=${pageNum}`
  }

  // renderDocId 优先：PageMeta 携带的物理渲染身份（assembly 多页路径），
  // 使预览 URL 命中后端 `/preview/{renderDocId}?page=N` 而非业务 invDocId。
  // renderPage 优先：物理文件内的真实页码（单页文件为 1，原始多页 PDF 为 index+1）。
  const effectiveDocId = page?.renderDocId || docId
  const pageNum = page?.renderPage || (page?.index + 1)
  return `${BACKEND_URL}/preview/${effectiveDocId}?page=${pageNum}`
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
  const pageNum = page?.renderPage || (page?.index + 1)
  return `${BACKEND_URL}/print/${effectiveDocId}?page=${pageNum}`
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
  const pageNum = page?.renderPage || (page?.index + 1)
  return `${BACKEND_URL}/thumbnail/${effectiveDocId}?page=${pageNum}`
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
