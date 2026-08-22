/**
 * printAdapter — Document 模型到打印系统的适配器
 *
 * 职责：
 *   从 InvoiceDocument 模型解析打印所需数据（路径、格式、页范围）。
 *   确保多页文档完整输出，不遗漏任何页面。
 *   不读取 Viewer 状态（zoom/pan/viewRotation）— Architecture Law D1。
 *
 * 设计（Render Print 子系统）：
 *   本适配器只服务 **Render Print 面**——把 Document/fileObj 的页模型
 *   表达为 Render Contract 栅格打印任务。
 *     Document/fileObj → buildPrintJobItem() → pages[{index,url}]
 *       → fetchPrintRaster(docId, page.index+1) → Uint8Array[] → canvas → 物理页
 *   页面身份是 `docId + page.index`，url 仅作人类可读定位，取栅格走 fetchPrintRaster。
 *
 *   另一面是 **Source 物理打印面**（`file.printPath` → Sumatra 直送，绕过 rasterization），
 *   由 PrintService 处理，不在此模块范围，也不应被 Render Contract 吞并（见 docs §10 双轨模型）。
 *
 * 所有权：
 *   由 usePrint 在构建打印队列时调用。
 *   不依赖 React / Viewer / DocumentViewer。
 *
 * @module utils/printAdapter
 */

import { getDocument } from '../stores/DocumentStore'
import { resolvePrintUrl } from './previewResourceResolver'
import { resolveInvoiceIdentity } from './invoiceIdentityResolver'

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
 * @property {string} invoiceDocumentId - 领域主键（Invoice Entity Boundary Freeze v1）
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
  const invDocId = resolveInvoiceIdentity(fileObj) || fileObj.invoiceDocumentId || ''
  // 使用 invoiceDocumentId 优先查找，与 DocumentStore 存储键一致
  const doc = (invDocId && getDocument({ invoiceDocumentId: invDocId, instanceId: fileObj.instanceId, docId })) ||
    (docId && getDocument({ instanceId: fileObj.instanceId, docId })) ||
    null

  // 有 Document：逐页构建 pages[]（Render Contract 的 /print 端点，200dpi）
  if (doc) {
    return {
      key: fileObj.key,
      printPath: fileObj.printPath || fileObj.path || '',
      fileFormat: fileObj.fileFormat || 'pdf',
      pageCount: doc.pageCount,
      docId: doc.docId,
      invoiceDocumentId: invDocId || doc.invoiceDocumentId || '',
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
    invoiceDocumentId: invDocId,
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

