// ============================
// Canvas / PDF / 图片渲染函数
// ============================
import * as pdfjs from 'pdfjs-dist'
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PREVIEW_DPI } from './config'
import { rotateContentOnPaper } from './utils/canvasUtils'
import { createLayout, normalizeLayoutItem, normalizeLayoutItems, getPaperPixels, PRINT_SAFE_MARGIN_MM, PRINTER_PROFILES, getPrintableArea } from './layout'
// ✅ renderModel.js 为死代码，renderMultipleItemsToCanvas 直接做 transform，不经过 RenderModel
// import { createRenderModels, applyTransformToContext, restoreContext } from './renderModel'

// PDF.js worker 配置 — 使用 Vite 打包的本地 worker
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl

// PDF.js 字体、CMap 和 WASM 配置 — 使用 public/ 目录下的本地静态资源
// 这些资源用于渲染 PDF 中的非嵌入字体、字符映射表和图像解码（如 JBIG2）
const PDFJS_CMAP_URL = '/cmaps/'
const PDFJS_STANDARD_FONT_URL = '/standard_fonts/'
const PDFJS_WASM_URL = '/wasm/'

// ========== 缓存 ==========
// PDF 渲染缓存（LRU，最大 20 个）
class LRUCache {
  constructor(maxSize = 20, name = 'cache') {
    this.maxSize = maxSize
    this.cache = new Map()
    this.name = name
  }

  get(key) {
    if (!this.cache.has(key)) return null
    
    // 移到末尾（标记为最近使用）
    const cached = this.cache.get(key)
    this.cache.delete(key)
    this.cache.set(key, cached)
    
    return cached
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.delete(key)  // LRUCache.delete，触发 _returnPoolCanvas
    } else if (this.cache.size >= this.maxSize) {
      // 超出限制，删除最久未使用的（第一个）
      const oldestKey = this.cache.keys().next().value
      this.delete(oldestKey)
    }
    
    this.cache.set(key, value)
  }

  delete(key) {
    if (!this.cache.has(key)) return

    const value = this.cache.get(key)
    this.cache.delete(key)

    const canvas = value?.source || value?.canvas || value
    if (canvas instanceof HTMLCanvasElement) {
      _returnPoolCanvas(canvas)
    }

    if (value && typeof value._destroyFn === 'function') {
      value._destroyFn().catch(() => {})
    }
  }

  clear() {
    for (const value of this.cache.values()) {
      const canvas = value?.source || value?.canvas || value
      if (canvas instanceof HTMLCanvasElement) _returnPoolCanvas(canvas)
      if (value && typeof value._destroyFn === 'function') {
        value._destroyFn().catch(() => {})
      }
    }
    this.cache.clear()
  }

  has(key) {
    return this.cache.has(key)
  }

  get size() {
    return this.cache.size
  }
}

// ✅ 统一渲染缓存（预览和打印共享，DPI 已统一为 300）
const pdfRenderCache = new LRUCache(30, 'pdfRender')

// ✅ 单项渲染缓存（L1）：合并模式下跨文件组复���单项结果
const itemRenderCache = new LRUCache(30, 'itemRender')

// ✅ 渲染结果缓存（L2）：缓存 renderMultipleItemsToCanvas 的 Canvas 输出
// 预览和打印使用相同参数时直接命中，避免重复渲染
// 容量 30 个：对应 ~30 个 A4@300DPI 文件（~1GB 预算），大幅提升"来回切换"命中率
class RenderResultCache {
  constructor(maxSize = 10) {
    this.cache = new Map()
    this.maxSize = maxSize
  }
  get(key) {
    if (!this.cache.has(key)) return null
    const entry = this.cache.get(key)
    this.cache.delete(key)
    this.cache.set(key, entry) // move to end (LRU)
    // ✅ 直接返回缓存 canvas，跳过克隆
    //   - 所有调用方只读不写（drawImage/toDataURL）
    //   - 消除 ~35MB（A4@300DPI）的同步 drawImage 像素拷贝
    return entry
  }
  set(key, canvas) {
    if (this.cache.has(key)) {
      this._cleanup(this.cache.get(key))
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value
      this._cleanup(this.cache.get(oldest))
      this.cache.delete(oldest)
    }
    this.cache.set(key, canvas)
  }
  delete(key) {
    const c = this.cache.get(key)
    if (c) this._cleanup(c)
    this.cache.delete(key)
  }
  clear() {
    for (const c of this.cache.values()) this._cleanup(c)
    this.cache.clear()
  }
  _cleanup(canvas) {
    if (canvas instanceof HTMLCanvasElement) {
      _returnPoolCanvas(canvas)
    }
  }
  get size() { return this.cache.size }
}

const renderResultCache = new RenderResultCache(30)

// ========== 常量 ==========
const SEPARATOR_MARGIN = 20        // 分隔线边距（像素）
const DASH_PATTERN = [6, 4]        // 虚线样式

// ========== 辅助函数 ==========

/**
 * 将 Uint8Array 转换为 base64 字符串
 * @param {Uint8Array} arr - 字节数组
 * @returns {string} base64 字符串
 */
function arrayToBase64(arr) {
  let binary = ''
  const len = arr.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(arr[i])
  }
  return btoa(binary)
}

/**
 * 生成 PDF 唯一标识（使用前 32 字节 + 长度）
 * @param {Uint8Array} pdfData - PDF 数据
 * @returns {string} PDF 唯一标识
 */
function getPdfId(pdfData) {
  // 使用前 32 字节 base64 + 数据长度作为唯一标识
  const head = arrayToBase64(pdfData.slice(0, Math.min(32, pdfData.length)))
  return `${head}_${pdfData.length}`
}

/**
 * 生成 PDF 渲染缓存键
 * @param {Uint8Array} pdfData - PDF 数据
 * @param {string} paperKey - 纸张类型
 * @param {number} dpi - DPI
 * @param {boolean} isLandscape - 是否横向
 * @returns {string} 缓存键
 */
function getPdfCacheKey(pdfData, paperKey, dpi, isLandscape, rotation = 0) {
  const pdfId = getPdfId(pdfData)
  return `${paperKey}_${dpi}_${isLandscape}_${rotation}_${pdfId}`
}

// ✅ DPI 已统一，不再需要按 DPI 分流缓存

/**
 * 解析图片源
 * ✅ 优化：直接透传 blob URL，由浏览器的 Image/createImageBitmap 解码
 *   去掉了 fetch → blob → FileReader → data URI 的 3 倍内存复制。
 *   onerror 时由调用方 fallback。
 * @param {string} src - 图片源
 * @returns {{ src: string, expired: boolean }}
 */
async function resolveImageSrc(src) {
  // blob URL 不需要预校验 — 浏览器 Image/createImageBitmap 可原生解码
  // 若 blob 已过期，onerror 会自然触发
  return { src, expired: false }
}

/**
 * 加载 PDF Document（每次独立加载，避免并发场景下的 destroy 竞争）
 * @param {Uint8Array} pdfData - PDF 数据
 * @returns {{ pdf: PDFDocumentProxy, destroy: () => Promise<void> }}
 */
function loadPdfDocument(pdfData) {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfData),
    verbosity: 0,  // suppress getHexString 等 pdf 内容警告，仅保留错误
    useSystemFonts: false,
    cMapUrl: PDFJS_CMAP_URL,
    standardFontDataUrl: PDFJS_STANDARD_FONT_URL,
    wasmUrl: PDFJS_WASM_URL,
  })
  return {
    pdf: loadingTask.promise,
    destroy: () => loadingTask.destroy(),
  }
}

const pdfDocCache = new LRUCache(10, 'pdfDoc')
const _pdfLoadingLocks = new Map()

export async function getOrLoadPdfDocument(pdfData) {
  const pdfId = getPdfId(pdfData)
  
  const cachedDoc = pdfDocCache.get(pdfId)
  if (cachedDoc) return cachedDoc
  
  if (_pdfLoadingLocks.has(pdfId)) {
    return _pdfLoadingLocks.get(pdfId)
  }
  
  const loadPromise = (async () => {
    try {
      const { pdf: pdfPromise, destroy } = loadPdfDocument(pdfData)
      const pdf = await pdfPromise
      pdf._destroyFn = destroy
      pdfDocCache.set(pdfId, pdf)
      return pdf
    } finally {
      _pdfLoadingLocks.delete(pdfId)
    }
  })()
  
  _pdfLoadingLocks.set(pdfId, loadPromise)
  return loadPromise
}

/**
 * 使用 Canvas 渲染 PDF 到固定尺寸
 * ✅ 方案二：不缓存 Canvas DOM 节点，而是缓存 PDF 文档对象
 * ✅ 每次调用都生成新的 Canvas，确保画布数据不会丢失
 */
export async function renderPDFToCanvas(
  pdfData, paperKey, dpi = PREVIEW_DPI, isLandscape = false, fitMode = 'contain',
) {
  const pixels = getPaperPixels(paperKey, dpi, isLandscape)

  let pdf = null
  let page = null

  try {
    pdf = await getOrLoadPdfDocument(pdfData)
    page = await pdf.getPage(1)

    const viewport = page.getViewport({ scale: 1 })
    const vpW = viewport.width
    const vpH = viewport.height
    const contentIsLandscape = vpW > vpH

    // ✅ 内容为纵向且纸张为横向时才需要旋转
    // 内容本身是横向（如横向发票）放在横向纸上 → 不需要旋转
    const needsRotation = isLandscape && !contentIsLandscape

    const contentWidth = needsRotation ? vpH : vpW
    const contentHeight = needsRotation ? vpW : vpH

    const scaleX = pixels.width / contentWidth
    const scaleY = pixels.height / contentHeight
    const isCover = fitMode === 'cover'
    const scale = isCover ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY)
    const scaledViewport = page.getViewport({ scale })

    // ✅ Cover 模式：canvas 扩大以容纳完整缩放内容，避免裁剪
    //    内容溢出纸张的部分在后续 pngToPdf 阶段由 PDF 页面边界自然裁切
    const canvasW = isCover ? Math.max(pixels.width, Math.ceil(scaledViewport.width)) : pixels.width
    const canvasH = isCover ? Math.max(pixels.height, Math.ceil(scaledViewport.height)) : pixels.height
    const paperOffsetX = (canvasW - pixels.width) / 2
    const paperOffsetY = (canvasH - pixels.height) / 2

    const canvas = document.createElement('canvas')
    canvas.width = canvasW
    canvas.height = canvasH

    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    ctx.save()

    if (needsRotation) {
      // 将纵向内容旋转90°以适应横向纸张
      ctx.translate(paperOffsetX + pixels.width / 2, paperOffsetY + pixels.height / 2)
      ctx.rotate(Math.PI / 2)
      ctx.translate(-vpH * scale / 2, -vpW * scale / 2)
    } else {
      // 内容与纸张方向一致：居中放置
      const scaledWidth = vpW * scale
      const scaledHeight = vpH * scale
      const offsetX = paperOffsetX + (pixels.width - scaledWidth) / 2
      const offsetY = paperOffsetY + (pixels.height - scaledHeight) / 2
      ctx.translate(offsetX, offsetY)
    }

    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise
    ctx.restore()

    // ✅ 计算 1x 基准像素尺寸（PDF 页面在目标 DPI 下的自然像素尺寸）
    const baseWidth = vpW * dpi / 72
    const baseHeight = vpH * dpi / 72

    return {
      canvas,
      contentWidth: baseWidth,
      contentHeight: baseHeight,
    }
  } catch (e) {
    console.error('[renderPDFToCanvas] PDF 渲染失败:', e)
    return null
  } finally {
    if (page) {
      try {
        page.cleanup()
      } catch (e) {
        console.warn('[renderPDFToCanvas] page cleanup 失败:', e)
      }
    }
  }
}

/**
 * 渲染 PDF 页面为原始内容画布（无纸张适配、无自动旋转、无居中）
 * 画布尺寸 = PDF 页面在目标 DPI 下的实际像素尺寸
 * 专供 renderMultipleItemsToCanvas 使用，由 Layout/Slot 层统一处理放置和缩放
 *
 * @param {Uint8Array} pdfData - PDF 数据
 * @param {number} dpi - 目标 DPI
 * @returns {Promise<{canvas: HTMLCanvasElement, width: number, height: number} | null>}
 */

// ✅ PDF 渲染序列化锁：同文件串行（防止 pdfjs Canvas 竞争），不同文件并发
//    key 为 fileKey，不同文件使用独立队列
const _renderQueues = new Map()

function _getRenderQueueKey(pdfData, fileKey) {
  // fileKey 优先（显式、可预测），fallback 到数据引用
  return fileKey || pdfData
}

// ✅ 每文件渲染版本计数器：过期渲染自动跳过，解除串行锁
//    当用户快速切换 A→B→A 时，第一次 A 的渲染在队列中，
//    但版本号已被后续请求覆盖，队列中的渲染检查到版本超期即跳过
const _renderVersions = new Map()

// _renderDirect 版本控制（快速切换时跳过过期渲染）
const _directVersions = new Map()

// ✅ Worker 渲染版本控制：过期 Worker 结果直接丢弃，不绘制、不缓存
const _workerVersions = new Map()

// 版本 Map 工具：记录版本号并自动清理超过 100 项的旧条目
// 防止高频切换时 Map 无限膨胀（string→number，1000 项 ≈ 72KB）
function setVersion(map, key, value, maxSize = 100) {
  map.set(key, value)
  if (map.size > maxSize) {
    map.delete(map.keys().next().value)
  }
}

async function renderPDFPageRaw(pdfData, dpi, fileKey) {
  // 按文件隔离队列
  const queueKey = _getRenderQueueKey(pdfData, fileKey)
  let queue = _renderQueues.get(queueKey)
  if (!queue) {
    queue = Promise.resolve()
    _renderQueues.set(queueKey, queue)
  }

  // 递增版本号，使旧渲染过期
  const version = (_renderVersions.get(queueKey) || 0) + 1
  setVersion(_renderVersions, queueKey, version)

  // 控制版本 Map 大小
  if (_renderVersions.size > 100) {
    const firstKey = _renderVersions.keys().next().value
    _renderVersions.delete(firstKey)
  }

  // 检查当前版本是否仍是最新
  const isLatest = () => _renderVersions.get(queueKey) === version

  // 排队执行，同文件串行，不同文件并发
  const result = queue.then(async () => {
    // 版本已过期，跳过
    if (!isLatest()) {
      console.debug('[renderPDFPageRaw] 版本过期跳过渲染:', { fileKey, version, currentVersion: _renderVersions.get(queueKey) })
      return null
    }

    let pdf = null
    let page = null
    let canvas = null  // 提升到 try 外，catch 才能访问
    try {
      pdf = await getOrLoadPdfDocument(pdfData)
      // 加载 pdf 文档后再次检查版本
      if (!isLatest()) {
        console.debug('[renderPDFPageRaw] 版本过期（加载后）:', { fileKey, version })
        return null
      }

      page = await pdf.getPage(1)
      if (!isLatest()) {
        console.debug('[renderPDFPageRaw] 版本过期（获取页后）:', { fileKey, version })
        return null
      }

      const viewport = page.getViewport({ scale: 1 })
      const scale = dpi / 72
      const width = Math.round(viewport.width * scale)
      const height = Math.round(viewport.height * scale)

      // 延迟创建 canvas：在 page.render 前最后一刻再分配，减少无效分配
      // 先检查版本，确认需要渲染时才创建
      if (!isLatest()) {
        console.debug('[renderPDFPageRaw] 版本过期（创建 canvas 前）:', { fileKey, version })
        return null
      }

      canvas = _getPoolCanvas(width, height)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)

      // page.render 前再次检查版本（此为最耗时操作）
      if (!isLatest()) {
        console.debug('[renderPDFPageRaw] 版本过期（渲染前）:', { fileKey, version })
        _returnPoolCanvas(canvas)  // 归还到池，保持原尺寸供复用
        return null
      }

      const scaledViewport = page.getViewport({ scale })
      await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise

      // ✅ 渲染完成后检查版本是否仍最新（page.render 耗时几百毫秒，期间可能切换文件）
      if (!isLatest()) {
        _returnPoolCanvas(canvas)
        return null
      }

      return { canvas, width, height }
    } catch (e) {
      if (canvas) _returnPoolCanvas(canvas)  // ← 异常时归还到池
      if (isLatest()) {
        console.error('[renderPDFPageRaw] PDF 渲染失败:', { fileKey, dpi, pdfDataLength: pdfData?.length, error: e.message, stack: e.stack })
      } else {
        console.debug('[renderPDFPageRaw] 版本过期（异常时）:', { fileKey, version, error: e.message })
      }
      return null
    }
  })

  // 更新队列：当前任务完成后才能开始下一个（同文件内串行）
  _renderQueues.set(queueKey, result.then(() => {}).catch(() => {}))

  // 控制 Map 大小：只保留最近用过的队列
  if (_renderQueues.size > 100) {
    const firstKey = _renderQueues.keys().next().value
    _renderQueues.delete(firstKey)
  }

  return result
}

// 渲染图片到固定纸张尺寸 Canvas
// @param {string} imageSrc - 图片源（URL 或 blob URL）
// @param {string} paperKey - 纸张尺寸
// @param {number} dpi - DPI
// @param {boolean} isLandscape - 是否横向
// @returns {Promise<{canvas: HTMLCanvasElement, blobExpired: boolean}>}
export async function renderImageToCanvas(
  imageSrc, paperKey, dpi = PREVIEW_DPI, isLandscape = false, fitMode = 'contain',
) {
  const pixels = getPaperPixels(paperKey, dpi, isLandscape)
  const { src: srcToLoad, expired: blobExpired } = await resolveImageSrc(imageSrc)

  return new Promise((resolve) => {
    const img = new Image()
    img.onload = async () => {
      const { width: imgW, height: imgH } = img
      const imgIsLandscape = imgW > imgH

      // ✅ 内容为纵向且纸张为横向时才需要旋转
      const needsRotation = isLandscape && !imgIsLandscape

      const contentWidth = needsRotation ? imgH : imgW
      const contentHeight = needsRotation ? imgW : imgH

      const scaleX = pixels.width / contentWidth
      const scaleY = pixels.height / contentHeight
      const isCover = fitMode === 'cover'
      const scale = isCover ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY)

      // ✅ Cover 模式：canvas 扩大以容纳完整缩放内容
      const w = contentWidth * scale
      const h = contentHeight * scale
      const canvasW = isCover ? Math.max(pixels.width, Math.ceil(w)) : pixels.width
      const canvasH = isCover ? Math.max(pixels.height, Math.ceil(h)) : pixels.height
      const paperOffsetX = (canvasW - pixels.width) / 2
      const paperOffsetY = (canvasH - pixels.height) / 2

      const canvas = document.createElement('canvas')
      canvas.width = canvasW
      canvas.height = canvasH
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      ctx.save()

      if (needsRotation) {
        // 将纵向图片旋转90°以适应横向纸张
        ctx.translate(paperOffsetX + pixels.width / 2, paperOffsetY + pixels.height / 2)
        ctx.rotate(Math.PI / 2)
        const rw = imgH * scale
        const rh = imgW * scale
        ctx.drawImage(img, -rw / 2, -rh / 2, rw, rh)
      } else {
        // 图片与纸张方向一致：居中放置，无需旋转
        const x = paperOffsetX + (pixels.width - w) / 2
        const y = paperOffsetY + (pixels.height - h) / 2
        ctx.drawImage(img, x, y, w, h)
      }
      
      ctx.restore()
      
      img.src = ''
      resolve({ canvas, blobExpired })
    }
    img.onerror = () => {
      img.src = ''
      resolve({ canvas, blobExpired: true })
    }
    img.src = srcToLoad
  })
}

// 渲染两个 PDF 到一张 Canvas（上下各半）
export async function renderTwoPDFsToCanvas(
  pdfData1, pdfData2, paperKey, dpi = PREVIEW_DPI, isLandscape = false,
) {
  const pixels = getPaperPixels(paperKey, dpi, isLandscape)
  const halfHeight = Math.floor(pixels.height / 2)

  const canvas = document.createElement('canvas')
  canvas.width = pixels.width
  canvas.height = pixels.height
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const drawSeparator = () => {
    ctx.save()
    ctx.strokeStyle = '#cccccc'
    ctx.lineWidth = 1
    ctx.setLineDash(DASH_PATTERN)
    ctx.beginPath()
    ctx.moveTo(SEPARATOR_MARGIN, halfHeight)
    ctx.lineTo(pixels.width - SEPARATOR_MARGIN, halfHeight)
    ctx.stroke()
    ctx.restore()
  }

  // ✅ 顺序渲染，避免相同 PDF 数据的并发问题
  const renderHalf = async (pdfData, yStart, areaHeight) => {
    if (!pdfData) return
    let pdfDoc = null
    let pdfDestroy = null
    let page = null
    try {
      const loaded = await loadPdfDocument(pdfData)
      pdfDoc = loaded.pdf
      pdfDestroy = loaded.destroy
      page = await pdfDoc.getPage(1)

      const viewport = page.getViewport({ scale: 1 })
      const scaleX = pixels.width / viewport.width
      const scaleY = areaHeight / viewport.height
      const scale = Math.min(scaleX, scaleY)
      const scaledViewport = page.getViewport({ scale })
      const scaledWidth = viewport.width * scale
      const scaledHeight = viewport.height * scale
      const offsetX = (pixels.width - scaledWidth) / 2
      const offsetY = yStart + (areaHeight - scaledHeight) / 2

      ctx.save()
      ctx.translate(offsetX, offsetY)
      await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise
      ctx.restore()
    } catch (e) {
      console.error('[renderTwoPDFsToCanvas] 渲染 PDF 失败:', e)
    } finally {
      if (page) {
        try { page.cleanup() } catch (e) {
          console.warn('[renderTwoPDFsToCanvas] page cleanup 失败:', e)
        }
      }
      if (pdfDestroy) {
        try { await pdfDestroy() } catch (e) {
          console.warn('[renderTwoPDFsToCanvas] pdf destroy 失败:', e)
        }
      }
    }
  }

  // ✅ 先渲染所有内容，最后绘制分隔线
  await renderHalf(pdfData1, 0, halfHeight)
  await renderHalf(pdfData2, halfHeight, pixels.height - halfHeight)
  drawSeparator()

  return canvas
}

// ✅ renderPDFToPrintImage / renderImageToPrintImage / revokePrintBlobUrl 已移除
// 打印流程直接复用预览的 renderMultipleItemsToCanvas 渲染结果

/**
 * 创建支持高清屏的预览画布
 * @param {number} width - 画布宽度（逻辑像素）
 * @param {number} height - 画布高度（逻辑像素）
 * @returns {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}}
 */
export function createHiDPICanvas(width, height) {
  const dpr = window.devicePixelRatio || 1
  const canvas = document.createElement('canvas')
  canvas.width = width * dpr
  canvas.height = height * dpr
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  return { canvas, ctx }
}

// ═══════════════════════════════════════════════════════════════
// Worker 单例 + 请求分发（主线程封装）
// ═══════════════════════════════════════════════════════════════

let _renderWorker = null
let _workerReady = null
let _msgId = 0
const _pendingRequests = new Map()

// Canvas 复用池：同一尺寸的 canvas 不重复创建，减少 GC 压力
const _canvasPool = new Map()  // "wxh" → [canvas, ...]

function _getPoolCanvas(w, h) {
  const rw = Math.round(w)
  const rh = Math.round(h)
  const key = `${rw}x${rh}`
  const pool = _canvasPool.get(key)
  if (pool && pool.length > 0) {
    const c = pool.pop()
    // 清空内容（尺寸不变，不需要重新设置 width/height）
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, c.width, c.height)
    return c
  }
  const c = document.createElement('canvas')
  c.width = rw
  c.height = rh
  return c
}

function _returnPoolCanvas(canvas) {
  if (!(canvas instanceof HTMLCanvasElement)) return
  const key = `${canvas.width}x${canvas.height}`
  if (!_canvasPool.has(key)) _canvasPool.set(key, [])
  const pool = _canvasPool.get(key)
  if (pool.length < 10) pool.push(canvas)
}

function _dispatchWorkerMessage(e) {
  const { type, id, bitmap, cacheKey, error, version } = e.data
  if (type === 'ready') return
  if (type === 'debug') {
    console.log('[Worker]', e.data.msg)
    return
  }

  const handler = _pendingRequests.get(id)
  if (!handler) {
    bitmap?.close()
    return
  }

  _pendingRequests.delete(id)

  if (type === 'error') {
    handler.reject(new Error(error))
    return
  }

  // ✅ 版本检查：已过期则丢弃 bitmap，返回缓存（或 null）
  if (_workerVersions.get(cacheKey) !== version) {
    bitmap?.close()
    handler.resolve(renderResultCache.get(cacheKey) || null)
    return
  }

  // 版本仍最新 → 正常绘制并缓存
  const canvas = _getPoolCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  renderResultCache.set(cacheKey, canvas)
  handler.resolve(canvas)
}

function _getWorker() {
  if (!_renderWorker) {
    _renderWorker = new Worker(
      new URL('./render.worker.js?v=10', import.meta.url),
      { type: 'module' }
    )
    _renderWorker.onmessage = _dispatchWorkerMessage
    _workerReady = new Promise(resolve => {
      const listener = (e) => {
        if (e.data.type === 'ready') { resolve(); _renderWorker.removeEventListener('message', listener) }
      }
      _renderWorker.addEventListener('message', listener)
    })
  }
  return _renderWorker
}

async function _renderViaWorker(items, paperKey, dpi, isLandscape, rotations, slotCount, layoutOptions) {
  // L2 cache key（与 _renderDirect 一致）
  const _rotKeys = Object.keys(rotations || {}).sort().map(k => `${k}:${rotations[k]}`).join(',')
  const _marginKey = layoutOptions.userMargins
    ? `m${layoutOptions.userMargins.left||0}_${layoutOptions.userMargins.right||0}_${layoutOptions.userMargins.top||0}_${layoutOptions.userMargins.bottom||0}`
    : 'm0'
  const _customKey = layoutOptions.customPaper?.widthMM ? `c${layoutOptions.customPaper.widthMM}x${layoutOptions.customPaper.heightMM}` : ''
  const _cacheKey = `multi_${paperKey}_${dpi}_${isLandscape ? 'L' : 'P'}_${slotCount || items.length}_${layoutOptions.strategy || 'vertical'}_${_rotKeys}_${_marginKey}_${_customKey}_${items.map(i => i.key || i.id).join(',')}`

  // ✅ 版本控制：同 cacheKey 递增版本号
  const version = (_workerVersions.get(_cacheKey) || 0) + 1
  setVersion(_workerVersions, _cacheKey, version)
  if (_workerVersions.size > 100) {
    const firstKey = _workerVersions.keys().next().value
    _workerVersions.delete(firstKey)
  }

  const cached = renderResultCache.get(_cacheKey)
  if (cached) return cached

  // ═══════════════════════════════════════════════════════
  // Phase 1: 主线程预加载
  // ═══════════════════════════════════════════════════════
  const contentSources = new Map()

  await Promise.all(items.map(async (item) => {
    const id = item.id || item.key
    const rotate = (rotations && rotations[id]) || 0
    const l1Key = `itemRender_${id}_${dpi}_${rotate}`

    const l1Hit = itemRenderCache.get(l1Key)
    if (l1Hit) {
      contentSources.set(id, l1Hit)
      return
    }

    try {
      if (item._pdfData) {
        const result = await renderPDFPageRaw(item._pdfData, dpi, item.key)
        if (result) {
          const entry = { source: result.canvas, width: result.width, height: result.height }
          itemRenderCache.set(l1Key, entry)
          contentSources.set(id, entry)
        }
      } else if (item._previewImageUrl) {
        const { src: srcToLoad, expired } = await resolveImageSrc(item._previewImageUrl)
        if (!expired) {
          const img = await new Promise((resolve) => {
            const image = new Image()
            image.onload = () => resolve(image)
            image.onerror = () => resolve(null)
            image.src = srcToLoad
          })
          if (img) {
            const entry = { source: img, width: img.naturalWidth, height: img.naturalHeight }
            itemRenderCache.set(l1Key, entry)
            contentSources.set(id, entry)
          }
        }
      }
    } catch (e) {
      console.error('[Worker path] Phase 1 失败:', id, e)
    }
  }))

  // ✅ Phase 1 后检查：已过期则直接返回
  if (_workerVersions.get(_cacheKey) !== version) {
    return renderResultCache.get(_cacheKey) || null
  }

  // Layout（主线程计算，纯函数）
  const normalizedItems = items.map(item => {
    const id = item.id || item.key
    const cs = contentSources.get(id)
    if (cs) {
      return { id, type: item._pdfData ? 'pdf' : 'image', meta: { width: cs.width, height: cs.height } }
    }
    return normalizeLayoutItem(item, dpi)
  })

  const userMargins = layoutOptions.userMargins
  const marginMm = userMargins ? {
    top: userMargins.top || 0, bottom: userMargins.bottom || 0,
    left: userMargins.left || 0, right: userMargins.right || 0,
  } : 0

  const layout = createLayout(normalizedItems, paperKey, dpi, isLandscape, {
    slotCount,
    ...layoutOptions,
    margin: marginMm,
  })

  // ═══════════════════════════════════════════════════════
  // Phase 1.5: HTMLCanvasElement/Image → ImageBitmap
  // ═══════════════════════════════════════════════════════
  const imageBitmaps = await Promise.all(
    items.map(async (item) => {
      const id = item.id || item.key
      const cs = contentSources.get(id)
      if (!cs) return null
      try {
        return await createImageBitmap(cs.source)
      } catch (e) {
        console.error('createImageBitmap 失败:', id, e)
        return null
      }
    })
  )

  // ✅ 发送 Worker 前检查：已过期则清理 bitmaps 并返回
  if (_workerVersions.get(_cacheKey) !== version) {
    imageBitmaps.forEach(b => b?.close())
    return renderResultCache.get(_cacheKey) || null
  }

  // ═══════════════════════════════════════════════════════
  // Phase 2: 交给 Worker 合成
  // ═══════════════════════════════════════════════════════
  await _workerReady
  const worker = _getWorker()
  const id = ++_msgId

  const transferables = imageBitmaps.filter(Boolean)

  return new Promise((resolve, reject) => {
    _pendingRequests.set(id, { resolve, reject, version, cacheKey: _cacheKey })

    worker.postMessage({
      sources: imageBitmaps,
      layout,
      rotations,
      layoutOptions: { ...layoutOptions, _dpi: dpi },
      cacheKey: _cacheKey,
      id,
      version,
    }, transferables)

    // 超时保护（30s）：过期时清理 bitmaps
    setTimeout(() => {
      const h = _pendingRequests.get(id)
      if (h) {
        _pendingRequests.delete(id)
        imageBitmaps.forEach(b => b?.close())
        reject(new Error('Worker 合成超时'))
      }
    }, 30000)
  })
}

// ═══════════════════════════════════════════════════════════════
// 公开 API：自动选择 Worker 路径或直接渲染路径
// ═══════════════════════════════════════════════════════════════

export async function renderMultipleItemsToCanvas(
  items, paperKey, dpi = PREVIEW_DPI, isLandscape = false, rotations = {}, slotCount, isPrint = false,
  showSafeMargin = false,
  layoutOptions = {}
) {
  // L2 缓存命中检查
  const _rotKeys = Object.keys(rotations || {}).sort().map(k => `${k}:${rotations[k]}`).join(',')
  const _marginKey = layoutOptions.userMargins
    ? `m${layoutOptions.userMargins.left||0}_${layoutOptions.userMargins.right||0}_${layoutOptions.userMargins.top||0}_${layoutOptions.userMargins.bottom||0}`
    : 'm0'
  const _customKey = layoutOptions.customPaper?.widthMM ? `c${layoutOptions.customPaper.widthMM}x${layoutOptions.customPaper.heightMM}` : ''
  const _cacheKey = `multi_${paperKey}_${dpi}_${isLandscape ? 'L' : 'P'}_${slotCount || items.length}_${layoutOptions.strategy || 'vertical'}_${_rotKeys}_${_marginKey}_${_customKey}_${items.map(i => i.key || i.id).join(',')}`

  const cachedCanvas = renderResultCache.get(_cacheKey)
  if (cachedCanvas) return cachedCanvas

  // 打印路径或环境不支持 Worker → 直接渲染
  if (isPrint || typeof OffscreenCanvas === 'undefined') {
    return _renderDirect(items, paperKey, dpi, isLandscape, rotations, slotCount, isPrint, showSafeMargin, layoutOptions)
  }

  // 预览路径 → Worker 渲染（失败自动回退到主线程）
  try {
    return await _renderViaWorker(items, paperKey, dpi, isLandscape, rotations, slotCount, layoutOptions)
  } catch (e) {
    console.warn('[renderMultipleItemsToCanvas] Worker 失败，回退到主线程:', e.message)
    return _renderDirect(items, paperKey, dpi, isLandscape, rotations, slotCount, isPrint, showSafeMargin, layoutOptions)
  }
}

// ═══════════════════════════════════════════════════════════════
// 直接渲染路径（原 renderMultipleItemsToCanvas 代码）
// ═══════════════════════════════════════════════════════════════

// 渲染多个项目到一张 Canvas（等分纸张，支持 PDF/图片/OFD 混合）
// ✅ 两阶段架构：Phase 1 预加载内容获取真实尺寸 → Layout → Phase 2 绘制
// ✅ 预览和打印共享渲染结果缓存，相同参数直接命中，避免重复渲染
async function _renderDirect(
  items, paperKey, dpi = PREVIEW_DPI, isLandscape = false, rotations = {}, slotCount, isPrint = false,
  showSafeMargin = false,
  layoutOptions = {}
) {
  // ═══════════════════════════════════════════════
  // ✅ 渲染结果缓存（L2）：预览和打印使用相同参数时直接命中
  // ═══════════════════════════════════════════════
  const _rotKeys = Object.keys(rotations || {}).sort().map(k => `${k}:${rotations[k]}`).join(',')
  const _marginKey = layoutOptions.userMargins
    ? `m${layoutOptions.userMargins.left||0}_${layoutOptions.userMargins.right||0}_${layoutOptions.userMargins.top||0}_${layoutOptions.userMargins.bottom||0}`
    : 'm0'
  const _customKey = layoutOptions.customPaper?.widthMM ? `c${layoutOptions.customPaper.widthMM}x${layoutOptions.customPaper.heightMM}` : ''
  const _cacheKey = `multi_${paperKey}_${dpi}_${isLandscape ? 'L' : 'P'}_${slotCount || items.length}_${layoutOptions.strategy || 'vertical'}_${_rotKeys}_${_marginKey}_${_customKey}_${items.map(i => i.key || i.id).join(',')}`

  const cachedCanvas = renderResultCache.get(_cacheKey)
  if (cachedCanvas) {
    return cachedCanvas
  }

  // ✅ 版本控制：快速切换时跳过过期渲染
  const _directVer = (_directVersions.get(_cacheKey) || 0) + 1
  setVersion(_directVersions, _cacheKey, _directVer)
  const _isDirectLatest = () => _directVersions.get(_cacheKey) === _directVer
  if (_directVersions.size > 100) {
    const firstKey = _directVersions.keys().next().value
    _directVersions.delete(firstKey)
  }

  // ═══════════════════════════════════════════════
  // Phase 1: 预加载所有内容（走 L1 单项缓存，合并模式下跨组复用）
  // ═══════════════════════════════════════════════
  const contentSources = new Map() // itemId → { source, width, height }

  await Promise.all(items.map(async (item) => {
    const id = item.id || item.key
    const rotate = (rotations && rotations[id]) || 0
    const l1Key = `itemRender_${id}_${dpi}_${rotate}`

    // L1 命中：复用单项渲染结果
    const l1Hit = itemRenderCache.get(l1Key)
    if (l1Hit) {
      contentSources.set(id, l1Hit)
      return
    }

    // L1 未命中：渲染并缓存
    try {
      if (item._pdfData) {
        const result = await renderPDFPageRaw(item._pdfData, dpi, item.key)
        if (result) {
          const entry = { source: result.canvas, width: result.width, height: result.height }
          itemRenderCache.set(l1Key, entry)
          contentSources.set(id, entry)
        } else {
          console.warn('[renderMultipleItemsToCanvas] PDF 渲染返回 null，将使用 fallback:', { id, fileKey: item.key, pdfDataLength: item._pdfData?.length })
        }
      } else if (item._previewImageUrl) {
        const { src: srcToLoad, expired } = await resolveImageSrc(item._previewImageUrl)
        if (!expired) {
          const img = await new Promise((resolve) => {
            const image = new Image()
            image.onload = () => resolve(image)
            image.onerror = () => resolve(null)
            image.src = srcToLoad
          })
          if (img) {
            const entry = { source: img, width: img.naturalWidth, height: img.naturalHeight }
            itemRenderCache.set(l1Key, entry)
            contentSources.set(id, entry)
          }
        }
      }
    } catch (e) {
      console.error('[renderMultipleItemsToCanvas] 预加载失败:', id, e)
    }
  }))

  // ✅ Phase 1 完成后检查版本，过期请求不进入 Phase 2
  if (!_isDirectLatest()) {
    return renderResultCache.get(_cacheKey) || null
  }

  // 用真实内容尺寸构建 layout item
  const normalizedItems = items.map(item => {
    const id = item.id || item.key
    const cs = contentSources.get(id)
    if (cs) {
      return { id, type: item._pdfData ? 'pdf' : 'image', meta: { width: cs.width, height: cs.height } }
    }
    return normalizeLayoutItem(item, dpi) // fallback
  })

  // ═══════════════════════════════════════════════
  // Layout: 基于真实内容尺寸计算 slot
  // ═══════════════════════════════════════════════
  // 用户边距 → createLayout margin 参数（缩小内容区域，纸张大小不变）
  const _userMargins = layoutOptions.userMargins
  const _marginMm = _userMargins ? {
    top: _userMargins.top || 0, bottom: _userMargins.bottom || 0,
    left: _userMargins.left || 0, right: _userMargins.right || 0,
  } : 0

  const layout = createLayout(normalizedItems, paperKey, dpi, isLandscape, {
    slotCount,
    ...layoutOptions,
    margin: (isPrint && slotCount > 1) ? PRINT_SAFE_MARGIN_MM : _marginMm,
  })
  const { page, area, slots } = layout

  // ═══════════════════════════════════════════════
  // Phase 2: 绘制内容到 slot
  // ═══════════════════════════════════════════════
  let canvas = _getPoolCanvas(page.width, page.height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const fitMode = 'fit'

  for (const slot of slots) {
    const cs = contentSources.get(slot.itemId)
    if (!cs) continue

    const rotate = (rotations && rotations[slot.itemId]) || 0
    const { source, width: contentW, height: contentH } = cs

    // 旋转时交换宽高以匹配旋转后的包围盒
    const isRotated90 = rotate === 90 || rotate === 270
    const effectiveW = isRotated90 ? contentH : contentW
    const effectiveH = isRotated90 ? contentW : contentH

    // 缩放比例
    const scale = fitMode === 'fill'
      ? Math.max(slot.width / effectiveW, slot.height / effectiveH)
      : Math.min(slot.width / effectiveW, slot.height / effectiveH)

    // clip 到 slot 区域
    ctx.save()
    ctx.beginPath()
    ctx.rect(slot.x, slot.y, slot.width, slot.height)
    ctx.clip()

    // slot 中心 → 旋转 → 缩放 → 绘制
    ctx.translate(slot.x + slot.width / 2, slot.y + slot.height / 2)
    if (rotate) {
      ctx.rotate(rotate * Math.PI / 180)
    }
    ctx.scale(scale, scale)
    ctx.drawImage(source, -contentW / 2, -contentH / 2, contentW, contentH)

    ctx.restore()
  }

  // ═══════════════════════════════════════════════
  // 分隔线
  // ═══════════════════════════════════════════════
  const drawSeparators = () => {
    ctx.save()
    ctx.strokeStyle = '#cccccc'
    ctx.lineWidth = 1
    ctx.setLineDash(DASH_PATTERN)

    if (layoutOptions.strategy === 'grid') {
      const gridCols = layoutOptions.gridCols || 2
      const gridRows = layoutOptions.gridRows || 2
      const cellWidth = area.width / gridCols
      const cellHeight = area.height / gridRows

      for (let c = 1; c < gridCols; c++) {
        const x = area.x + c * cellWidth
        ctx.beginPath()
        ctx.moveTo(x, area.y + SEPARATOR_MARGIN)
        ctx.lineTo(x, area.y + area.height - SEPARATOR_MARGIN)
        ctx.stroke()
      }
      for (let r = 1; r < gridRows; r++) {
        const y = area.y + r * cellHeight
        ctx.beginPath()
        ctx.moveTo(area.x + SEPARATOR_MARGIN, y)
        ctx.lineTo(area.x + area.width - SEPARATOR_MARGIN, y)
        ctx.stroke()
      }
    } else {
      for (let i = 0; i < slots.length - 1; i++) {
        const y = slots[i + 1].y
        ctx.beginPath()
        ctx.moveTo(area.x + SEPARATOR_MARGIN, y)
        ctx.lineTo(area.x + area.width - SEPARATOR_MARGIN, y)
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  drawSeparators()

  // ✅ 存入缓存前检查版本，过期 canvas 归还池
  if (!_isDirectLatest()) {
    _returnPoolCanvas(canvas)
    return renderResultCache.get(_cacheKey) || null
  }

  // ✅ 缓存渲染结果，后续打印可直接命中
  renderResultCache.set(_cacheKey, canvas)

  return canvas
}

// ============================
// 渲染缓存清理函数
// ============================

/**
 * 清理指定 PDF 的渲染缓存
 */
export function clearPdfCache(pdfData, paperKey, dpi, isLandscape) {
  const cacheKey = getPdfCacheKey(pdfData, paperKey, dpi, isLandscape)
  pdfRenderCache.delete(cacheKey)
}

/**
 * 清理所有渲染缓存（PDF 页面缓存 + 渲染结果缓存）
 */
export function clearAllPdfCache() {
  pdfRenderCache.clear()
  renderResultCache.clear()
  itemRenderCache.clear()
}

/**
 * 清理渲染结果缓存（预览/打印共享）
 */
export function clearRenderCache() {
  renderResultCache.clear()
  itemRenderCache.clear()
}

/**
 * 获取当前缓存数量
 * @returns {number}
 */
export function getPdfCacheSize() {
  return pdfRenderCache.size + renderResultCache.size
}
