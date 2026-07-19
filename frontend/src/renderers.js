// ============================
// Canvas / PDF / 图片渲染函数
// ============================
import * as pdfjs from 'pdfjs-dist'
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PREVIEW_DPI } from './config'
import { createLayout, normalizeLayoutItem, normalizeLayoutItems, getPaperPixels, PRINT_SAFE_MARGIN_MM, PRINTER_PROFILES, getPrintableArea } from './layout'
import { isDocumentEngineEnabled } from './documentEngine.js'  // P2C 统一入口门面（v12 契约 JS 实现；路线见 v14 §6/§13）
import { createPlacement } from './compose/composePlacement.js'  // [B1 p2] Virtual Paper 几何（contentRect fit）：Preview/Print 共用唯一几何来源
import { drawRenderCommand } from './layout/renderDraw.js'  // [C3-2] 与 Worker 共用唯一 executor（drawRenderCommand 纯执行、DOM-free）
import { buildSingleFileRenderCommand } from './layout/singleFileRenderCommand.js'  // [D1-2] 单文件预览 RenderCommand Producer（与 Compose/Print 同契约）
// ✅ renderModel.js 为死代码，renderMultipleItemsToCanvas 直接做 transform，不经过 RenderModel
// import { createRenderModels, applyTransformToContext, restoreContext } from './renderModel'

// ═══════════════════════════════════════════════════════════════════════════
// P2C · Adapter 层入口（v14：路线 P2A✅→P2B✅→P2C→P3→P4→P5→P6）
// ───────────────────────────────────────────────────────────────────────────
// 本文件正从「核心实现」逐步变为「兼容层（Adapter）」。统一入口已落到
// documentEngine.js（DocumentEngine.getImage / compose）。迁移纪律（见
// merge-mode-pdfjs-migration-plan.md §13）：renderers.js 不再维护缓存状态 /
// 不再决定是否渲染 / 不再拼 cache key / 不再持有生命周期；每个导出函数最终
// 只做「参数适配 → 调用 DocumentEngine → 返回」。达到时 P6 删除本文件即零风险。
//
// ⚠️ 最后防线（原则18）：业务代码（usePreview / usePrint / printRenderer / UI）不得
//    import 本文件实现；统一入口只有 documentEngine.getImage / compose。仅本文件
//    自身（兼容层）或其内部 Renderer Adapter 可调旧实现。
//
// 灰度开关 USE_DOCUMENT_ENGINE（setUseDocumentEngine）生命周期仅限 P2C：
// 开启统一入口；异常可瞬时回退到下方旧 canvas 路径（原则⑧ 灰度可回滚）。
// ⚠️ P2C 完成、P3 启动时必须删除此开关，禁止长期遗留。
// 当前热路径（renderMultipleItemsToCanvas 的合并/打印合成）仍走旧实现，
// 待 dev/Electron build 验证后开启 USE_DOCUMENT_ENGINE（P2C 阶段内）。
// ═══════════════════════════════════════════════════════════════════════════

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
  constructor(maxSize = 20, name = 'cache', dispose = null) {
    this.maxSize = maxSize
    this.cache = new Map()
    this.name = name
    this.disposeFn = dispose  // ✅ 支持异步 dispose 回调
  }

  get(key) {
    if (!this.cache.has(key)) return null

    // 移到末尾（标记为最近使用）
    const cached = this.cache.get(key)
    this.cache.delete(key)
    this.cache.set(key, cached)

    return cached
  }

  async set(key, value) {
    if (this.cache.has(key)) {
      console.log(`[LRU] ${this.name}.set() key already exists, deleting old value`)
      await this.delete(key)  // ✅ await 异步销毁
    } else if (this.cache.size >= this.maxSize) {
      // 超出限制，删除最久未使用的（第一个）
      const oldestKey = this.cache.keys().next().value
      console.log(`[LRU] ${this.name}.set() cache full (${this.cache.size}/${this.maxSize}), deleting oldest key: ${oldestKey?.slice(0, 16)}...`)
      await this.delete(oldestKey)  // ✅ await 异步销毁
    }

    this.cache.set(key, value)
    console.log(`[LRU] ${this.name}.set() cache size: ${this.cache.size}/${this.maxSize}`)
  }

  async   delete(key) {
    if (!this.cache.has(key)) {
      console.log(`[LRU] ${this.name}.delete() key not found: ${key}`)
      return
    }

    const value = this.cache.get(key)
    this.cache.delete(key)
    console.log(`[LRU] ${this.name}.delete() destroying key: ${key}`)

    const canvas = value?.source || value?.canvas || value
    if (canvas instanceof HTMLCanvasElement) {
      console.log(`[LRU] ${this.name}.delete() returning canvas to pool: ${canvas.width}x${canvas.height}`)
      _returnPoolCanvas(canvas)
    }

    // ✅ 调用 dispose 回调（支持异步）
    if (typeof this.disposeFn === 'function') {
      try {
        await this.disposeFn(value, key)
      } catch (e) {
        console.warn(`[LRU] ${this.name}.delete() dispose error:`, e)
      }
    } else if (value) {
      // 向后兼容：如果没有 dispose 回调，用旧逻辑
      if (typeof value.cleanup === 'function') {
        try { value.cleanup() } catch (_) { /* ignore */ }
      }
      if (typeof value._destroyFn === 'function') {
        console.log(`[LRU] ${this.name}.delete() calling _destroyFn()`)
        try { await value._destroyFn() } catch (_) { /* ignore */ }
      }
    }
  }

  async clear() {
    for (const [key, value] of this.cache.entries()) {
      const canvas = value?.source || value?.canvas || value
      if (canvas instanceof HTMLCanvasElement) _returnPoolCanvas(canvas)
      if (typeof this.disposeFn === 'function') {
        try { await this.disposeFn(value, key) } catch (_) {}
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
const pdfRenderCache = new LRUCache(5, 'pdfRender')

// ✅ 单项渲染缓存（L1）：合并模式下跨文件组复用单项结果
const itemRenderCache = new LRUCache(5, 'itemRender')

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
function resolveImageSrc(src) {
  // blob URL 不需要预校验 — 浏览器 Image/createImageBitmap 可原生解码
  // 若 blob 已过期，onerror 会自然触发
  // ✅ 同步返回：原函数体无异步逻辑，async 只会多一次 Promise 分配 + 微任务调度
  return { src, expired: false }
}

/**
 * 加载 PDF Document（每次独立加载，避免并发场景下的 destroy 竞争）
 * ✅ 返回 { pdf, loadingTask, worker } — 显式暴露 loadingTask 和 worker
 * @param {Uint8Array} pdfData - PDF 数据
 * @returns {{ pdf: Promise<PDFDocumentProxy>, loadingTask, worker }}
 */
function loadPdfDocument(pdfData) {
  // 每文档独立 Worker：销毁时 worker.destroy() 彻底杀死进程，
  // 避免全局共享 Worker 内 font/image/operator list cache 持续累积
  const worker = new pdfjs.PDFWorker({ name: `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` })
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfData),
    worker,
    verbosity: 0,
    useSystemFonts: true,
    cMapUrl: PDFJS_CMAP_URL,
    standardFontDataUrl: PDFJS_STANDARD_FONT_URL,
    wasmUrl: PDFJS_WASM_URL,
  })
  return { pdf: loadingTask.promise, loadingTask, worker }
}

/**
 * ✅ pdfDocCache 的异步 dispose 函数
 * 在 LRU 淘汰时调用，彻底清理 PDF 文档、Worker、页面缓存
 * @param {Object} cacheEntry - { pdfDoc, loadingTask, worker, pages }
 * @param {string} key - PDF ID
 */
async function disposePdfDoc(cacheEntry, key) {
  const { pdfDoc, loadingTask, worker, pages } = cacheEntry

  console.log(`[LRU] 🗑️ Disposing PDF doc (start): ${key?.slice(0, 16)}...`)

  try {
    // 1️⃣ 清理所有缓存的页面
    if (pages && pages.size > 0) {
      console.log(`[LRU]   Cleaning ${pages.size} pages...`)
      for (const [pageNum, pageProxy] of pages) {
        try {
          if (typeof pageProxy.cleanup === 'function' && !pageProxy._destroyed) {
            await pageProxy.cleanup()
            console.log(`[LRU]     page ${pageNum} cleaned`)
          }
        } catch (e) {
          console.warn(`[LRU]     page ${pageNum} cleanup error: ${e.message}`)
        }
      }
      pages.clear()
    }

    // 2️⃣ cleanup() PDF document — 清理主线程 commonObjs、字体缓存
    if (pdfDoc && typeof pdfDoc.cleanup === 'function') {
      try {
        console.log(`[LRU]   Calling pdfDoc.cleanup()...`)
        await pdfDoc.cleanup()
        console.log(`[LRU]   pdfDoc.cleanup() done`)
      } catch (e) {
        console.warn(`[LRU]   pdfDoc.cleanup() error: ${e.message}`)
      }
    }

    // 3️⃣ 清理 transport 层缓存（保险措施）
    if (pdfDoc && pdfDoc._transport) {
      try {
        pdfDoc._transport.commonObjs?.clear()
      } catch (e) {}
      try {
        if (pdfDoc._transport.fontLoader && typeof pdfDoc._transport.fontLoader.cleanup === 'function') {
          pdfDoc._transport.fontLoader.cleanup()
        }
      } catch (e) {}
    }

    // 4️⃣ 销毁 loadingTask → 终止 Worker 线程（释放 Worker 内存）
    if (loadingTask) {
      try {
        console.log(`[LRU]   Calling loadingTask.destroy()...`)
        loadingTask.destroy()
      } catch (e) {
        console.warn(`[LRU]   loadingTask.destroy() error: ${e.message}`)
      }
    }

    // 5️⃣ 销毁 PDF document proxy
    if (pdfDoc && typeof pdfDoc.destroy === 'function') {
      try {
        console.log(`[LRU]   Calling pdfDoc.destroy()...`)
        await pdfDoc.destroy()
      } catch (e) {
        console.warn(`[LRU]   pdfDoc.destroy() error: ${e.message}`)
      }
    }

    // 6️⃣ 彻底杀死 Worker 进程（保险措施）
    if (worker) {
      try {
        console.log(`[LRU]   Calling worker.destroy()...`)
        worker.destroy()
      } catch (e) {
        console.warn(`[LRU]   worker.destroy() error: ${e.message}`)
      }
    }

    console.log(`[LRU] 🗑️ Disposing PDF doc (end): ${key?.slice(0, 16)}...`)
  } catch (e) {
    console.warn(`[LRU] Disposing PDF doc error:`, e)
  }
}

const pdfDocCache = new LRUCache(5, 'pdfDoc', disposePdfDoc)
const _pdfLoadingLocks = new Map()

export async function getOrLoadPdfDocument(pdfData) {
  const pdfId = getPdfId(pdfData)
  
  // ✅ 从包装对象中取出 pdfDoc
  let cached = pdfDocCache.get(pdfId)
  if (cached) return cached.pdfDoc
  
  if (_pdfLoadingLocks.has(pdfId)) {
    return _pdfLoadingLocks.get(pdfId)
  }
  
  const loadPromise = (async () => {
    try {
      const { pdf: pdfPromise, loadingTask, worker } = loadPdfDocument(pdfData)
      const pdfDoc = await pdfPromise
      const cacheEntry = { pdfDoc, loadingTask, worker, pages: new Map() }
      pdfDocCache.set(pdfId, cacheEntry)
      return pdfDoc
    } finally {
      _pdfLoadingLocks.delete(pdfId)
    }
  })()
  
  _pdfLoadingLocks.set(pdfId, loadPromise)
  return loadPromise
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

// 全局渲染任务表：按 queueKey 追踪进行中的 page.render()，
// 用于版本过期时 cancel() 终止旧渲染，避免 GPU/Worker 浪费
const _renderTasks = new Map()

async function renderPDFPageRaw(pdfData, dpi, fileKey, paperKey = null, isLandscape = false) {
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

  // 如果上一轮渲染还在进行中，立即取消（版本已递增，旧结果不会使用）
  const prevTask = _renderTasks.get(queueKey)
  if (prevTask) {
    try { prevTask.cancel() } catch (_) { /* ignore */ }
    _renderTasks.delete(queueKey)
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
    let renderTask = null
    try {
      pdf = await getOrLoadPdfDocument(pdfData)
      // 加载 pdf 文档后再次检查版本
      if (!isLatest()) {
        console.debug('[renderPDFPageRaw] 版本过期（加载后）:', { fileKey, version })
        return null
      }

      page = await pdf.getPage(1)
      // 缓存 PageProxy，LRU 淘汰时 disposePdfDoc 会清理
      const _entry = pdfDocCache.get(getPdfId(pdfData))
      if (_entry) _entry.pages.set(1, page)

      if (!isLatest()) {
        console.debug('[renderPDFPageRaw] 版本过期（获取页后）:', { fileKey, version })
        return null
      }

      // 计算目标画布尺寸
      let canvasW, canvasH

      if (paperKey) {
        // ✅ 有 paperKey：固定纸张尺寸，PDF 内容缩放适配
        const pixels = getPaperPixels(paperKey, dpi, isLandscape)
        canvasW = pixels.width
        canvasH = pixels.height
      } else {
        // 向后兼容：无 paperKey 时用 PDF 原始尺寸
        const viewport = page.getViewport({ scale: 1 })
        const scale = dpi / 72
        canvasW = Math.round(viewport.width * scale)
        canvasH = Math.round(viewport.height * scale)
      }

      // 延迟创建 canvas：在 page.render 前最后一刻再分配，减少无效分配
      if (!isLatest()) {
        console.debug('[renderPDFPageRaw] 版本过期（创建 canvas 前）:', { fileKey, version })
        return null
      }

      canvas = _getPoolCanvas(canvasW, canvasH)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvasW, canvasH)

      // page.render 前再次检查版本（此为最耗时操作）
      if (!isLatest()) {
        console.debug('[renderPDFPageRaw] 版本过期（渲染前）:', { fileKey, version })
        _returnPoolCanvas(canvas)
        return null
      }

      if (paperKey && canvasW > 0 && canvasH > 0) {
        // ✅ 按纸张尺寸渲染：缩放 PDF 内容适配并居中
        const viewport = page.getViewport({ scale: 1 })
        const scale = Math.min(canvasW / viewport.width, canvasH / viewport.height)
        const scaledViewport = page.getViewport({ scale })
        const offsetX = (canvasW - scaledViewport.width) / 2
        const offsetY = (canvasH - scaledViewport.height) / 2
        ctx.save()
        ctx.translate(offsetX, offsetY)
        renderTask = page.render({ canvasContext: ctx, viewport: scaledViewport })
        _renderTasks.set(queueKey, renderTask)
        await renderTask.promise
        ctx.restore()
      } else {
        // 向后兼容：无 paperKey，原始尺寸渲染
        const viewport = page.getViewport({ scale: 1 })
        const scale = dpi / 72
        const scaledViewport = page.getViewport({ scale })
        renderTask = page.render({ canvasContext: ctx, viewport: scaledViewport })
        _renderTasks.set(queueKey, renderTask)
        await renderTask.promise
      }

      // ✅ 渲染完成后检查版本是否仍最新（page.render 耗时几百毫秒，期间可能切换文件）
      if (!isLatest()) {
        _returnPoolCanvas(canvas)
        return null
      }

      return { canvas, width: canvasW, height: canvasH }
    } catch (e) {
      if (canvas) _returnPoolCanvas(canvas)
      // RenderingCancelledException 是主动取消导致的正常异常，不视为错误
      const isCancelled = renderTask && e?.name === 'RenderingCancelledException'
      if (!isCancelled && isLatest()) {
        console.error('[renderPDFPageRaw] PDF 渲染失败:', { fileKey, dpi, pdfDataLength: pdfData?.length, error: e.message, stack: e.stack })
      } else if (!isCancelled) {
        console.debug('[renderPDFPageRaw] 版本过期（异常时）:', { fileKey, version, error: e.message })
      }
      return null
    } finally {
      _renderTasks.delete(queueKey)
      if (page) {
        try { await page.cleanup() } catch (_) { /* ignore */ }
      }
      // ⚠️ 不再对共享缓存的 pdfDoc 调 pdf.cleanup()：会清空文档级 commonObjs/字体缓存，
      // 抵消 pdfDocCache 复用收益（性能回归），且同 pdfData 多文件并发时存在并发 cleanup 隐患。
      // 文档级清理仅由 disposePdfDoc（LRU 淘汰）负责。
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

// 归一化 Canvas 尺寸到档位，平衡「像素浪费」与「池子碎片化」
// ✅ 档位 50px（原为 100px）：最坏情况向上取整浪费由 ≈1 整档降为 ≤50px，
//    池 key 数量至多翻倍，仍在可接受范围（单 key 上限 10 个 canvas）
//    如需调回更省内存但更浪费像素，改大 _SIZE_BUCKET 即可
const _SIZE_BUCKET = 50
function _normalizeSize(w, h) {
  return {
    w: Math.ceil(w / _SIZE_BUCKET) * _SIZE_BUCKET,
    h: Math.ceil(h / _SIZE_BUCKET) * _SIZE_BUCKET,
  }
}

function _getPoolCanvas(w, h) {
  const { w: nw, h: nh } = _normalizeSize(Math.round(w), Math.round(h))
  const key = `${nw}x${nh}`
  const pool = _canvasPool.get(key)
  if (pool && pool.length > 0) {
    const c = pool.pop()
    console.debug(`[Canvas] Got canvas from pool, key=${key}, remaining: ${pool.length}`)
    // 清空内容（尺寸不变，不需要重新设置 width/height）
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, c.width, c.height)
    return c
  }
  console.debug(`[Canvas] Pool miss, creating new canvas, key=${key} (requested ${Math.round(w)}x${Math.round(h)})`)
  const c = document.createElement('canvas')
  c.width = nw
  c.height = nh
  return c
}

function _returnPoolCanvas(canvas) {
  if (!(canvas instanceof HTMLCanvasElement)) return
  const { w: nw, h: nh } = _normalizeSize(canvas.width, canvas.height)
  const key = `${nw}x${nh}`
  if (!_canvasPool.has(key)) _canvasPool.set(key, [])
  const pool = _canvasPool.get(key)
  if (pool.length < 10) {
    // ✅ 重置 Canvas 尺寸 = 丢弃旧的 2D 上下文
    //    Blink 内部释放关联的字体缓存、路径缓存、GPU 纹理
    //    下次 getContext('2d') 时创建全新上下文
    canvas.width = canvas.width
    pool.push(canvas)
    console.debug(`[Canvas] Returned canvas to pool, key=${key}, pool size: ${pool.length}`)
  } else {
    console.debug(`[Canvas] Pool full, dropping canvas, key=${key}, pool size: ${pool.length}`)
  }
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
  if (handler.timer) clearTimeout(handler.timer)  // 正常返回，撤销超时定时器

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

// ═══════════════════════════════════════════════════════════════════════════
// [B1 p2] Compose Placement 接线：Preview(_renderViaWorker) 与 Print(_renderDirect)
// 共用 createPlacement 作为唯一几何来源，不再各自内联 fit/offset/clip 数学。
//
// Compose 几何（含内缩安全边距）由上游 ComposeSlotLayoutFactory + ComposeSlotRasterizer 冻结产出；
// 本文件只消费 slot.contentRect，不重算 Compose 几何。
// 铁律（C 阶段）：Derived geometry 只跨越所有权边界一次（Layout → Renderer 单向）。

// 单一 Compose 几何来源：px slot + 内容源尺寸 + 旋转 → RenderCommand。
// 与 Worker 端 drawRenderCommand 像素级同构（offset 为左上角、clip=contentRect、
// rotatedBounds 为旋转后内容尺寸、scale 不烘焙进尺寸）。本函数只做几何→命令组装。
// 直接消费 slot.contentRect（已含内缩安全边距，由上游 ComposeSlotRasterizer 冻结产出），
// 不在 renderer 内重算 Compose 几何（ownership 泄漏）。
function _buildComposeCommand(slot, cs, rotate, paper) {
  if (!slot || !cs) return null
  const { width: contentW, height: contentH } = cs
  // slot.contentRect 已是 px（含内缩安全边距），由上游冻结产出；此处直接消费，不重算。
  const contentRect = slot.contentRect
  const p = createPlacement({ contentRect, sourceWidth: contentW, sourceHeight: contentH, rotation: rotate })
  return {
    version: 1,
    paper: paper || null,
    rotatedBounds: p.rotatedBounds,
    placement: { scale: p.scale, offsetX: p.offsetX, offsetY: p.offsetY },
    contentRotation: rotate,
    rotation: 0,
    clip: p.clip,
  }
}

/**
 * [B1 p2] 用 ComposePlacementFactory 产出 RenderCommand[] 供 Worker 纯执行。
 * 几何由 createPlacement 唯一计算；本函数只做「slot + 内容源 + 旋转 → RenderCommand」遍历组装。
 * slot.contentRect 已含内缩安全边距（单页 === slot，Merge 内缩），由上游 ComposeSlotRasterizer 冻结产出；
 * 本函数不重算 margin / dpi（Derived geometry 只跨越所有权边界一次）。
 *
 * @param {object} layout - createLayout 产出（slots: [{itemId,x,y,width,height,contentRect}, ...]）
 * @param {Map<string,{source:*,width:number,height:number}>} contentSources - itemId → 真实内容尺寸
 * @param {Object<string,number>} rotations - itemId → 旋转角(0/90/180/270)
 * @param {object} [paper] - 满足 validateRenderCommand 的 paper 必填（传 layout.page）
 * @returns {(object|null)[]} 与 slots 一一对应的 RenderCommand（缺内容源为 null）
 */
function _buildComposeCommands(layout, contentSources, rotations, paper) {
  const { slots } = layout
  // 不再计算 margin / dpi：contentRect 已含内缩，由上游产出。本函数只遍历组装。
  return slots.map((slot) => {
    const cs = slot ? contentSources.get(slot.itemId) : null
    const rotate = (slot && rotations && rotations[slot.itemId]) || 0
    return _buildComposeCommand(slot, cs, rotate, paper || layout.page)
  })
}

async function _renderViaWorker(items, paperKey, dpi, isLandscape, rotations, slotCount, layoutOptions) {
  // L2 cache key（与 _renderDirect 一致，统一由 buildCacheKey 生成）
  const _cacheKey = buildCacheKey(items, paperKey, dpi, isLandscape, rotations, slotCount, layoutOptions)

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
    const l1Key = `itemRender_${id}_${dpi}_${rotate}_${paperKey}_${isLandscape ? 'L' : 'P'}`

    const l1Hit = itemRenderCache.get(l1Key)
    if (l1Hit) {
      contentSources.set(id, l1Hit)
      return
    }

    try {
      if (item._pdfData) {
        const result = await renderPDFPageRaw(item._pdfData, dpi, item.key, paperKey, isLandscape)
        if (result) {
          const entry = { source: result.canvas, width: result.width, height: result.height }
          itemRenderCache.set(l1Key, entry)
          contentSources.set(id, entry)
        }
      } else if (item._previewImageUrl) {
        const { src: srcToLoad, expired } = resolveImageSrc(item._previewImageUrl)
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

  // [Commit A] 主线程计算 Compose 几何 → RenderCommand[]（Worker 纯执行，绝不自算 fit/rotate）
  const commands = _buildComposeCommands(layout, contentSources, rotations, layout.page)

  // ═══════════════════════════════════════════════════════
  // Phase 1.5: HTMLCanvasElement/Image → ImageBitmap
  // ═══════════════════════════════════════════════════════
  const imageBitmaps = await Promise.all(
    items.map(async (item) => {
      const id = item.id || item.key
      const cs = contentSources.get(id)
      if (!cs) return null
      try {
        const src = cs.source
        // ✅ 已是可 transfer 的零拷贝对象（ImageBitmap / OffscreenCanvas）：
        // 直接复用，避免 createImageBitmap 二次拷贝（A4@300DPI canvas ≈ 35MB）。
        // 注：当前 contentSources 缓存的 source 为 HTMLCanvasElement(renderPDFPageRaw 结果)
        // 或 HTMLImageElement(预览图)，二者均不可 transfer 且被主线程直接合成路径(_renderDirect)复用，
        // 故不能 transferControlToOffscreen（会 detach 主线程画布、破坏 LRU 缓存与直接渲染）。
        // 该分支为上游若改为产出 ImageBitmap/OffscreenCanvas 时的零拷贝快路径。
        if (src instanceof ImageBitmap || src instanceof OffscreenCanvas) {
          return src
        }
        return await createImageBitmap(src)
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
    const timer = setTimeout(() => {
      const h = _pendingRequests.get(id)
      if (!h) return
      _pendingRequests.delete(id)
      imageBitmaps.forEach(b => b?.close())
      reject(new Error('Worker 合成超时（已终止并重建 Worker）'))
      // Worker 是单例且同步执行合成，自身无法中断正在进行的操作，也无法在 hang 期间
      // 处理 cancel 消息。超时即 terminate 释放被卡死的 CPU，并置空单例使下次调用惰性重建。
      // 仅当本请求持有的 worker 仍是当前活动单例时才终止——避免重复 terminate，
      // 也避免误杀已被其他超时/重建路径替换的新 worker（否则会再次卡死其它在途请求）。
      if (_renderWorker === worker) {
        try { _renderWorker.terminate() } catch (e) { /* 已终止 */ }
        _renderWorker = null
        _workerReady = null
      }
    }, 30000)

    // 把 timer 存入 pending，正常返回路径（_dispatchWorkerMessage）据此清除，避免悬挂定时器
    _pendingRequests.set(id, { resolve, reject, version, cacheKey: _cacheKey, timer })

    worker.postMessage({
      sources: imageBitmaps,
      layout,
      commands,
      layoutOptions: { ...layoutOptions, _dpi: dpi },
      cacheKey: _cacheKey,
      id,
      version,
    }, transferables)
  })
}

// ═══════════════════════════════════════════════════════════════
// 公开 API：自动选择 Worker 路径或直接渲染路径
// ═══════════════════════════════════════════════════════════════

/**
 * 构建多项目渲染结果缓存键（L2）。
 * 三个调用点（renderMultipleItemsToCanvas / _renderViaWorker / _renderDirect）必须产出**完全一致**的字串，
 * 否则同一组参数在不同路径下无法命中同一份缓存。请勿在各调用点内联改写此逻辑——统一在此维护。
 * @param {Array} items
 * @param {string} paperKey
 * @param {number} dpi
 * @param {boolean} isLandscape
 * @param {Object} rotations
 * @param {number} [slotCount]
 * @param {Object} [layoutOptions]
 * @returns {string}
 */
function buildCacheKey(items, paperKey, dpi, isLandscape, rotations, slotCount, layoutOptions = {}) {
  const _rotKeys = Object.keys(rotations || {}).sort().map(k => `${k}:${rotations[k]}`).join(',')
  const _marginKey = layoutOptions.userMargins
    ? `m${layoutOptions.userMargins.left || 0}_${layoutOptions.userMargins.right || 0}_${layoutOptions.userMargins.top || 0}_${layoutOptions.userMargins.bottom || 0}`
    : 'm0'
  const _customKey = layoutOptions.customPaper?.widthMM ? `c${layoutOptions.customPaper.widthMM}x${layoutOptions.customPaper.heightMM}` : ''
  return `multi_${paperKey}_${dpi}_${isLandscape ? 'L' : 'P'}_${slotCount || items.length}_${layoutOptions.strategy || 'vertical'}_${_rotKeys}_${_marginKey}_${_customKey}_${items.map(i => i.key || i.id).join(',')}`
}

export async function renderMultipleItemsToCanvas(
  items, paperKey, dpi = PREVIEW_DPI, isLandscape = false, rotations = {}, slotCount, isPrint = false,
  showSafeMargin = false,
  layoutOptions = {}
) {
  // P2C 统一入口槽位（USE_DOCUMENT_ENGINE 默认 false，生命周期仅限 P2C）：开启后应委派
  // documentEngine 的 getImage×N + compose，而非在此自建 L2 缓存与合成。当前 compose 路径
  // 尚未接后端，故保持旧实现；待 dev/Electron build 验证后在此替换为 engine 调用（见 plan §13）。
  if (isDocumentEngineEnabled()) {
    console.warn('[P2C] USE_DOCUMENT_ENGINE 已开启，但 renderers.js 合并/打印合成尚未接 documentEngine；回退旧实现。P2C 完成、P3 启动前必须删除此开关。')
  }

  // L2 缓存命中检查（buildCacheKey 与 _renderDirect / _renderViaWorker 一致）
  const _cacheKey = buildCacheKey(items, paperKey, dpi, isLandscape, rotations, slotCount, layoutOptions)

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
  // （buildCacheKey 与 renderMultipleItemsToCanvas / _renderViaWorker 一致）
  // ═══════════════════════════════════════════════
  const _cacheKey = buildCacheKey(items, paperKey, dpi, isLandscape, rotations, slotCount, layoutOptions)

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
    const l1Key = `itemRender_${id}_${dpi}_${rotate}_${paperKey}_${isLandscape ? 'L' : 'P'}`

    // L1 命中：复用单项渲染结果
    const l1Hit = itemRenderCache.get(l1Key)
    if (l1Hit) {
      contentSources.set(id, l1Hit)
      return
    }

    // L1 未命中：渲染并缓存
    try {
      if (item._pdfData) {
        const result = await renderPDFPageRaw(item._pdfData, dpi, item.key, paperKey, isLandscape)
        if (result) {
          const entry = { source: result.canvas, width: result.width, height: result.height }
          itemRenderCache.set(l1Key, entry)
          contentSources.set(id, entry)
        } else {
          console.warn('[renderMultipleItemsToCanvas] PDF 渲染返回 null，将使用 fallback:', { id, fileKey: item.key, pdfDataLength: item._pdfData?.length })
        }
      } else if (item._previewImageUrl) {
        const { src: srcToLoad, expired } = resolveImageSrc(item._previewImageUrl)
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

  // dpi 已是本函数入参（调用方传入的工作 dpi，= layout.page.dpi）；margin 由上游 slot.contentRect 承载，本函数不重算。
  for (const slot of slots) {
    const cs = contentSources.get(slot.itemId)
    if (!cs) continue
    const rotate = (rotations && rotations[slot.itemId]) || 0

    // [B1 p2] 与 Preview(_buildComposeCommands) 共用唯一几何来源 createPlacement；直接消费 slot.contentRect。
    const cmd = _buildComposeCommand(slot, cs, rotate, page)
    if (!cmd) continue

    // 与 Worker 路径统一 executor：cmd 已含 clip/旋转/scale 全部几何（ratio=1：Print dpi===cmd dpi）。
    drawRenderCommand(ctx, cmd, cs.source)
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
  pdfDocCache.clear()
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

// ============================================================
// 全局预览 Canvas（应用生命周期内只创建一次）
// 预览分辨率使用 150dpi，打印使用 300dpi
// ============================================================

let _globalPreviewCanvas = null
let _globalPreviewCanvasConfig = null
let _offscreenPreviewCanvas = null
let _globalPreviewVersion = 0
let _globalPreviewLock = Promise.resolve()  // 串行化渲染锁

function _getOffscreenCanvas(width, height) {
  if (!_offscreenPreviewCanvas) {
    _offscreenPreviewCanvas = document.createElement('canvas')
    _offscreenPreviewCanvas.width = width
    _offscreenPreviewCanvas.height = height
  }
  return _offscreenPreviewCanvas
}

/**
 * 获取全局预览 Canvas。
 * 纸张尺寸、DPI 或方向变化时自动重建。
 */
export function getGlobalPreviewCanvas(paperKey, dpi, isLandscape = false, margins = null) {
  const pixels = getPaperPixels(paperKey, dpi, isLandscape)
  const config = { paperKey, dpi, isLandscape, width: pixels.width, height: pixels.height, margins }

  // 配置没变 → 返回已有 Canvas
  if (_globalPreviewCanvas &&
      _globalPreviewCanvasConfig?.paperKey === paperKey &&
      _globalPreviewCanvasConfig?.dpi === dpi &&
      _globalPreviewCanvasConfig?.isLandscape === isLandscape &&
      _globalPreviewCanvasConfig?.margins?.left === margins?.left &&
      _globalPreviewCanvasConfig?.margins?.right === margins?.right &&
      _globalPreviewCanvasConfig?.margins?.top === margins?.top &&
      _globalPreviewCanvasConfig?.margins?.bottom === margins?.bottom) {
    return _globalPreviewCanvas
  }

  // 配置变了 → 重建
  _globalPreviewCanvas = document.createElement('canvas')
  _globalPreviewCanvas.width = pixels.width
  _globalPreviewCanvas.height = pixels.height
  _globalPreviewCanvasConfig = config

  // 离屏 Canvas 也需要重建（尺寸变了）
  _offscreenPreviewCanvas = null
  return _globalPreviewCanvas
}

/**
 * 全局 Canvas 渲染基座：锁 → 清空 → 渲染 → swap → 版本号
 * @param {function} renderFn - (ctx, contentW, contentH, marginL, marginT) => Promise<void>
 * @param {AbortSignal} [signal]
 */
async function _renderToGlobalCanvas(renderFn, signal) {
  if (!_globalPreviewCanvas || !_globalPreviewCanvasConfig) {
    throw new Error('全局 Canvas 未初始化，先调用 getGlobalPreviewCanvas()')
  }

  await _globalPreviewLock
  if (signal?.aborted) { return }

  let unlock
  _globalPreviewLock = new Promise(r => { unlock = r })

  try {
    const { width, height, dpi, margins } = _globalPreviewCanvasConfig
    const offscreen = _getOffscreenCanvas(width, height)
    const ctx = offscreen.getContext('2d')

    // 清空画布（先 reset 变换矩阵，避免上一文件残留的 rotate/translate/scale 影响 fillRect 覆盖区域）
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, width, height)

    // 计算安全边距
    const marginL = (margins?.left ?? 0) * (dpi / 25.4)
    const marginR = (margins?.right ?? 0) * (dpi / 25.4)
    const marginT = (margins?.top ?? 0) * (dpi / 25.4)
    const marginB = (margins?.bottom ?? 0) * (dpi / 25.4)
    const contentW = width - marginL - marginR
    const contentH = height - marginT - marginB

    if (signal?.aborted) return

    // 执行具体渲染
    await renderFn(ctx, contentW, contentH, marginL, marginT)

    // 原子 swap 到显示 Canvas
    if (signal?.aborted) { return }
    const displayCtx = _globalPreviewCanvas.getContext('2d')
    displayCtx.drawImage(offscreen, 0, 0)

    // 递增版本号
    _globalPreviewVersion++
    return _globalPreviewVersion
  } finally {
    unlock?.()
  }
}

/**
 * 复用模块级临时 canvas（M1 修复）
 * 原实现每次 switchPreviewFile 都 document.createElement('canvas') + getContext('2d')，
 * 快速翻页时产生大量 canvas/2D 上下文分配与 GC 抖动，造成预览卡顿。
 * 这里缓存单个 canvas，仅在尺寸变化时重新分配 backing store；同尺寸（同页/同分辨率切换）零重分配。
 * 安全性：_renderToGlobalCanvas 通过 _globalPreviewLock 串行化所有预览渲染，任意时刻仅一个临时 canvas 在使用中。
 * @param {number} w
 * @param {number} h
 * @returns {HTMLCanvasElement}
 */
let _previewPdfTempCanvas = null
function _getPreviewPdfTempCanvas(w, h) {
  if (!_previewPdfTempCanvas) _previewPdfTempCanvas = document.createElement('canvas')
  if (_previewPdfTempCanvas.width !== w) _previewPdfTempCanvas.width = w
  if (_previewPdfTempCanvas.height !== h) _previewPdfTempCanvas.height = h
  return _previewPdfTempCanvas
}

/**
 * 切换 PDF 文件到全局 Canvas（双缓冲，防闪烁）
 *
 * [D1-2] 单文件 PDF 预览统一收敛到 RenderCommand：
 *  • 几何由 buildSingleFileRenderCommand（createPlacement）单一决策，drawRenderCommand 纯执行；
 *    Renderer 不再自算 fit / offset / rotation（ownership 收敛到 Layout/Placement 层）。
 *  • 源必须「非预旋」：PDF 在 rotation:0 光栅化，旋转由 executor 的 contentRotation 施加，
 *    与 Compose/Print 同一模型（消除旧 switchPreviewFile 把旋转烤进 bitmap 的特例）。
 *  • fitScale 仅决定 PDF 采样分辨率(device px)，使 source 像素 ≈ 落盘像素（1:1，画质等同旧实现）；
 *    落盘 placement / clip / rotation 仍完全由 createPlacement → drawRenderCommand 计算。
 */
export async function switchPreviewFile(pdfDoc, pageNum = 1, signal, rotation = 0) {
  const { width: paperW, height: paperH } = _globalPreviewCanvasConfig || {}
  const paper = { width: paperW || 0, height: paperH || 0 }
  const v = await _renderToGlobalCanvas(async (ctx, contentW, contentH, marginL, marginT) => {
    if (signal?.aborted) return
    const page = await pdfDoc.getPage(pageNum)

    const baseViewport = page.getViewport({ scale: 1, rotation: 0 })
    const baseW = baseViewport.width
    const baseH = baseViewport.height
    // 旋转感知栅格化比例：让 source 像素 ≈ 落盘像素（1:1，画质等同旧 switchPreviewFile）。
    // 仅决定 PDF 采样分辨率，落盘几何仍由 createPlacement → drawRenderCommand 计算（非 Renderer 重算）。
    const fitScale = (baseW > 0 && baseH > 0)
      ? (rotation % 180 === 0
        ? Math.min(contentW / baseW, contentH / baseH)
        : Math.min(contentW / baseH, contentH / baseW))
      : 0
    if (!(fitScale > 0)) { await page.cleanup(); return }

    const renderViewport = page.getViewport({ scale: fitScale, rotation: 0 }) // 始终 rotation:0 → 源非预旋
    const tw = Math.max(1, Math.ceil(renderViewport.width))
    const th = Math.max(1, Math.ceil(renderViewport.height))
    // ✅ 复用模块级临时 canvas（M1 修复）：仅尺寸变化时重分配 backing store，同尺寸零重分配。
    const tempCanvas = _getPreviewPdfTempCanvas(tw, th)
    const tctx = tempCanvas.getContext('2d')
    // ✅ 复用前必须 reset 变换矩阵 + 清空旧像素（pdf.js 不主动 clearRect，残留变换会致错位）。
    tctx.setTransform(1, 0, 0, 1, 0, 0)
    tctx.clearRect(0, 0, tw, th)
    await page.render({ canvasContext: tctx, viewport: renderViewport }).promise

    const sourceWidth = tw
    const sourceHeight = th
    const contentRect = { x: marginL, y: marginT, width: contentW, height: contentH }
    const cmd = buildSingleFileRenderCommand({ sourceWidth, sourceHeight, contentRect, rotation, paper })
    // executor 纯执行：fit/居中/旋转/clip 全部来自 cmd，Renderer 不再碰几何。
    drawRenderCommand(ctx, cmd, tempCanvas, sourceWidth, sourceHeight, 1)

    await page.cleanup()
  }, signal)
  return v
}

/**
 * 切换图片/OFD 到全局 Canvas（双缓冲，防闪烁）
 * @param {HTMLImageElement|HTMLCanvasElement} image - 已加载的图片元素
 *
 * [D1-2] 与 switchPreviewFile 同一模型：源（image 固有尺寸，非预旋）交给
 * buildSingleFileRenderCommand 生成 RenderCommand，drawRenderCommand 纯执行。
 * 不再用 ctx.rotate / document.createElement 现转旋转（旧不一致模型已消除）。
 */
export async function switchPreviewImage(image, signal, rotation = 0) {
  const { width: paperW, height: paperH } = _globalPreviewCanvasConfig || {}
  const paper = { width: paperW || 0, height: paperH || 0 }
  return _renderToGlobalCanvas(async (ctx, contentW, contentH, marginL, marginT) => {
    if (signal?.aborted) return

    const imgW = image.naturalWidth || image.width
    const imgH = image.naturalHeight || image.height
    if (!(imgW > 0) || !(imgH > 0)) return

    const contentRect = { x: marginL, y: marginT, width: contentW, height: contentH }
    const cmd = buildSingleFileRenderCommand({ sourceWidth: imgW, sourceHeight: imgH, contentRect, rotation, paper })
    drawRenderCommand(ctx, cmd, image, imgW, imgH, 1)
  }, signal)
}

/** 获取当前全局 Canvas 版本号（用于 React 重绘触发） */
export function getGlobalPreviewVersion() {
  return _globalPreviewVersion
}
