/**
 * InvoiceDocument — 发票文档数据模型
 *
 * 职责：
 *   定义发票文档的标准化结构（Document + PageMeta）。
 *   作为 Viewer 和 Print 两条路径的共享数据源。
 *   纯业务数据，不含渲染资源（previewUrl 由 PreviewResourceResolver 解析）。
 *
 * 所有权：
 *   由 Coordinator（后端）或 Import Adapter（前端）创建。
 *   由 DocumentViewer / PrintAdapter 消费。
 *   不依赖 React / UI / 渲染实现。
 *
 * Architecture Law D1：
 *   Document 是业务数据，previewUrl 是渲染资源，二者生命周期不同。
 *   PageMeta 不含任何 URL。资源解析见 utils/previewResourceResolver.js。
 *
 * @module models/InvoiceDocument
 */

/**
 * @typedef {Object} PageMeta
 * @property {number} index - 页索引（0-based）
 * @property {string} pageId - 稳定身份标识: `${docId}:p${index}`
 * @property {number} width - 页面自然宽度（px，后端 raster 尺寸）
 * @property {number} height - 页面自然高度（px）
 * @property {number} sourceRotation - 文件真实方向（PDF Rotate 值: 0/90/180/270）
 */

/**
 * @typedef {Object} InvoiceDocument
 * @property {string} docId - 内容寻址的文档 ID（sha256(file_bytes+filename)[:24]）
 * @property {string} fileKey - 前端 UI 列表中的文件标识
 * @property {string} sourceHash - 源文件哈希（用于去重/缓存身份）
 * @property {number} pageCount - 总页数
 * @property {PageMeta[]} pages - 页面元数据数组
 */

/**
 * 创建单页 PageMeta。
 *
 * @param {Object} opts
 * @param {string} opts.docId - 文档 ID
 * @param {number} opts.index - 页索引（0-based）
 * @param {number} [opts.width=0] - 自然宽度
 * @param {number} [opts.height=0] - 自然高度
 * @param {number} [opts.sourceRotation=0] - 文件真实方向
 * @returns {PageMeta}
 */
export function createPageMeta({ docId, index, width = 0, height = 0, sourceRotation = 0 }) {
  return {
    index,
    pageId: `${docId}:p${index}`,
    width,
    height,
    sourceRotation,
  }
}

/**
 * 创建 InvoiceDocument。
 *
 * @param {Object} opts
 * @param {string} opts.docId - 文档 ID
 * @param {string} [opts.fileKey=''] - 前端文件标识
 * @param {string} [opts.sourceHash=''] - 源文件哈希
 * @param {PageMeta[]} opts.pages - 页面元数据数组
 * @returns {InvoiceDocument}
 */
export function createDocument({ docId, fileKey = '', sourceHash = '', pages }) {
  return {
    docId,
    fileKey,
    sourceHash,
    pageCount: pages.length,
    pages,
  }
}

/**
 * 从后端 Coordinator 结果构建 InvoiceDocument。
 *
 * Coordinator 返回格式（预期）：
 *   { docId, pages: [{ index, width, height, sourceRotation }] }
 *
 * @param {Object} coordinatorResult - 后端 Coordinator 输出
 * @param {string} coordinatorResult.docId
 * @param {Array<{index: number, width?: number, height?: number, sourceRotation?: number}>} coordinatorResult.pages
 * @param {string} [fileKey=''] - 前端文件标识
 * @param {string} [sourceHash=''] - 源文件哈希
 * @returns {InvoiceDocument}
 */
export function documentFromCoordinator(coordinatorResult, fileKey = '', sourceHash = '') {
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
  return createDocument({ docId, fileKey, sourceHash, pages })
}

/**
 * 从现有 fileObj 构建兼容的单页 InvoiceDocument。
 *
 * 用于过渡期：现有单页文件尚未走 Coordinator 路径时，
 * 从 fileObj 的 docId/pageNum 构建一个单页 Document，
 * 使 Viewer 可以统一消费。
 *
 * @param {Object} fileObj - 现有前端文件对象
 * @param {string} fileObj.docId - 文档 ID（可能为 null）
 * @param {string} fileObj.key - 文件标识
 * @param {number} [fileObj.pageNum] - 页码（1-based，拆分模式）
 * @returns {InvoiceDocument|null} - 无 docId 时返回 null（走 canvas fallback）
 */
export function documentFromFileObj(fileObj) {
  if (!fileObj || !fileObj.docId) return null

  const docId = fileObj.docId
  const pageIndex = (fileObj.pageNum || 1) - 1

  const page = createPageMeta({
    docId,
    index: pageIndex,
    width: 0,
    height: 0,
    sourceRotation: 0,
  })

  return createDocument({
    docId,
    fileKey: fileObj.key || '',
    sourceHash: fileObj.identity?.sourceHash || '',
    pages: [page],
  })
}

/**
 * 获取指定页的 PageMeta。
 *
 * @param {InvoiceDocument} doc
 * @param {number} index - 0-based 页索引
 * @returns {PageMeta|null}
 */
export function getPage(doc, index) {
  if (!doc || index < 0 || index >= doc.pageCount) return null
  return doc.pages[index]
}

/**
 * 计算有效旋转角度。
 *
 * Architecture Law D1 旋转命名纪律：
 *   effectiveRotation = sourceRotation + viewRotation
 *
 * @param {PageMeta} page
 * @param {number} viewRotation - 用户临时查看旋转（0/90/180/270）
 * @returns {number} - 归一化到 0/90/180/270
 */
export function effectiveRotation(page, viewRotation) {
  return ((page.sourceRotation || 0) + (viewRotation || 0)) % 360
}
