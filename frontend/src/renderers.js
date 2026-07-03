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
      // 已存在，移到末尾
      this.cache.delete(key)
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

    // 清理 Canvas 资源
    // 缓存值可能是 HTMLCanvasElement 或 { canvas, width, height } 对象
    const canvas = value?.canvas || value
    if (canvas instanceof HTMLCanvasElement) {
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
      canvas.width = 0
      canvas.height = 0
    }
  }

  clear() {
    // 清理所有 Canvas 资源
    for (const canvas of this.cache.values()) {
      if (canvas) {
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
        canvas.width = 0
        canvas.height = 0
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

// ✅ 渲染结果缓存：缓存 renderMultipleItemsToCanvas 的 Canvas 输出
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
    if (this.cache.has(key)) this.cache.delete(key)
    else if (this.cache.size >= this.maxSize) {
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
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
      canvas.width = 0; canvas.height = 0
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

// PDF 文档缓存（缓存 PDFDocumentProxy 对象）
const pdfDocCache = new LRUCache(10, 'pdfDoc')

/**
 * 获取或加载 PDF 文档（带缓存）
 * @param {Uint8Array} pdfData - PDF 数据
 * @returns {Promise<PDFDocumentProxy>} PDF 文档对象
 */
async function getOrLoadPdfDocument(pdfData) {
  const pdfId = getPdfId(pdfData)
  
  // 检查是否有缓存的 PDF 文档
  const cachedDoc = pdfDocCache.get(pdfId)
  if (cachedDoc) {
  
    return cachedDoc
  }
  
  // 加载新的 PDF 文档
  const { pdf } = await loadPdfDocument(pdfData)
  pdfDocCache.set(pdfId, pdf)

  
  return pdf
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
  _renderVersions.set(queueKey, version)

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
    if (!isLatest()) return null

    let pdf = null
    let page = null
    try {
      pdf = await getOrLoadPdfDocument(pdfData)
      // 加载 pdf 文档后再次检查版本
      if (!isLatest()) { return null }

      page = await pdf.getPage(1)
      if (!isLatest()) { return null }

      const viewport = page.getViewport({ scale: 1 })
      const scale = dpi / 72
      const width = Math.round(viewport.width * scale)
      const height = Math.round(viewport.height * scale)

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height

      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)

      // page.render 前再次检查版本（此为最耗时操作）
      if (!isLatest()) { return null }

      const scaledViewport = page.getViewport({ scale })
      await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise

      return { canvas, width, height }
    } catch (e) {
      if (isLatest()) {
        console.error('[renderPDFPageRaw] PDF 渲染失败:', e)
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

// 渲染多个项目到一张 Canvas（等分纸张，支持 PDF/图片/OFD 混合）
// ✅ 两阶段架构：Phase 1 预加载内容获取真实尺寸 → Layout → Phase 2 绘制
// ✅ 预览和打印共享渲染结果缓存，相同参数直接命中，避免重复渲染
export async function renderMultipleItemsToCanvas(
  items, paperKey, dpi = PREVIEW_DPI, isLandscape = false, rotations = {}, slotCount, isPrint = false,
  showSafeMargin = false,
  layoutOptions = {}
) {
  // ═══════════════════════════════════════════════
  // ✅ 渲染结果缓存：预览和打印使用相同参数时直接命中
  // ═══════════════════════════════════════════════
  const _rotKeys = Object.keys(rotations || {}).sort().map(k => `${k}:${rotations[k]}`).join(',')
  const _cacheKey = `multi_${paperKey}_${dpi}_${isLandscape ? 'L' : 'P'}_${slotCount || items.length}_${layoutOptions.strategy || 'vertical'}_${_rotKeys}_${items.map(i => i.key || i.id).join(',')}`

  const cachedCanvas = renderResultCache.get(_cacheKey)
  if (cachedCanvas) {
    return cachedCanvas
  }

  // ═══════════════════════════════════════════════
  // Phase 1: 预加载所有内容，获取真实尺寸
  // ═══════════════════════════════════════════════
  const contentSources = new Map() // itemId → { source, width, height }

  await Promise.all(items.map(async (item) => {
    const id = item.id || item.key
    try {
      if (item._pdfData) {
        // PDF: 用 renderPDFPageRaw 渲染原始内容（目标 DPI 像素，无纸张适配）
        const result = await renderPDFPageRaw(item._pdfData, dpi, item.key)
        if (result) {
          contentSources.set(id, { source: result.canvas, width: result.width, height: result.height })
        }
      } else if (item._previewImageUrl) {
        // 图片/OFD: 加载获取原始像素尺寸
        const { src: srcToLoad, expired } = await resolveImageSrc(item._previewImageUrl)
        if (!expired) {
          const img = await new Promise((resolve) => {
            const image = new Image()
            image.onload = () => resolve(image)
            image.onerror = () => resolve(null)
            image.src = srcToLoad
          })
          if (img) {
            contentSources.set(id, { source: img, width: img.naturalWidth, height: img.naturalHeight })
          }
        }
      }
    } catch (e) {
      console.error('[renderMultipleItemsToCanvas] 预加载失败:', id, e)
    }
  }))

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
  const layout = createLayout(normalizedItems, paperKey, dpi, isLandscape, {
    slotCount,
    margin: (isPrint && slotCount > 1) ? PRINT_SAFE_MARGIN_MM : 0,
    ...layoutOptions
  })
  const { page, area, slots } = layout

  // ═══════════════════════════════════════════════
  // Phase 2: 绘制内容到 slot
  // ═══════════════════════════════════════════════
  const canvas = document.createElement('canvas')
  canvas.width = page.width
  canvas.height = page.height
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
}

/**
 * 清理渲染结果缓存（预览/打印共享）
 */
export function clearRenderCache() {
  renderResultCache.clear()
}

/**
 * 获取当前缓存数量
 * @returns {number}
 */
export function getPdfCacheSize() {
  return pdfRenderCache.size + renderResultCache.size
}
