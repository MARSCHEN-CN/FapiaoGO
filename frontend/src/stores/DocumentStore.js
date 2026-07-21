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

import { createDocument, createPageMeta, documentFromFileObj } from '../models/InvoiceDocument'

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
 * 从 fileObj 确保有对应的 InvoiceDocument。
 *
 * 过渡期使用：现有单页文件尚未走 Coordinator 路径时，
 * 从 fileObj 构建兼容的单页 Document 并注册。
 * 如果已存在则直接返回。
 *
 * @param {Object} fileObj
 * @returns {import('../models/InvoiceDocument').InvoiceDocument|null}
 */
export function ensureDocumentFromFileObj(fileObj) {
  if (!fileObj?.docId) return null

  const existing = documents.get(fileObj.docId)
  if (existing) return existing

  const doc = documentFromFileObj(fileObj)
  if (doc) {
    documents.set(doc.docId, doc)
    notify()
  }
  return doc
}

/**
 * 从 Coordinator 结果注册多页 Document。
 *
 * @param {Object} coordinatorResult - { docId, pages: [{index, width, height, sourceRotation}] }
 * @param {string} [fileKey='']
 * @param {string} [sourceHash='']
 * @returns {import('../models/InvoiceDocument').InvoiceDocument}
 */
export function registerFromCoordinator(coordinatorResult, fileKey = '', sourceHash = '') {
  const { docId, pages: rawPages } = coordinatorResult
  const pages = rawPages.map((p) =>
    createPageMeta({
      docId,
      index: p.index,
      width: p.width || 0,
      height: p.height || 0,
      sourceRotation: p.sourceRotation || 0,
    })
  )
  const doc = createDocument({ docId, fileKey, sourceHash, pages })
  documents.set(docId, doc)
  notify()
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

  const updatedPages = pages.map((p) =>
    createPageMeta({
      docId,
      index: p.index,
      width: p.width || 0,
      height: p.height || 0,
      sourceRotation: p.sourceRotation || 0,
    })
  )
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
