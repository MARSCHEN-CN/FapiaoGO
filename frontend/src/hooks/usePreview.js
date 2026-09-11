import { useState, useCallback, useEffect, useRef, useMemo, useLayoutEffect } from 'react'
import { PREVIEW_DPI, GLOBAL_PREVIEW_DPI, ZOOM_STEPS, USE_RENDER_ENGINE_PREVIEW, buildPreviewUrl, BACKEND_URL } from '../config'
import {
  getFileFormat, getExtension, isMergeMode, getMergePair, isImageLikeFormat,
} from '../utils'
import { detectDocumentOrientation } from '../utils/detectOrientation'
import { getForcedLandscape } from '../utils/mergeMode'
import { buildPreviewCacheKey } from '../utils/previewCacheKey'
import { getRenderEnginePreviewUrl } from '../utils/previewTarget'
import { emptyContentLayout, initialRenderState, computePaperLayout, getDocNaturalOrientation } from '../previewState'
import { buildRenderCommand } from '../layout/RenderLayoutFactory.js'
import { buildRenderSpec, RENDER_SPEC_VERSION, renderSpecSignature } from '../layout/renderSpec.js'
import { resolvePaper, paperKeyFragment } from '../layout/resolvePaper.js'
import { buildPreviewGeometry } from '../geometry/PreviewGeometryBuilder.js'
import { extractContentPx } from '../geometry/extractContentPx.js'
import { computeInitialDocFacts } from '../layout/docFacts.js'
import { nextZoomStep } from './zoomStep.mjs'
import { applyWheelZoom } from './continuousZoom.mjs'
import { resolvePreviewTransition, resolveRefreshExecution, resolveBoundary, advanceLoadingStep, resolveCommittedClear, resolveDebouncePrecedence } from '../utils/previewScheduler'
import { isDisplayablePreview } from '../utils/previewPolicy'
import { perfProbe } from '../perf/importPerfProbe'
import { previewTrace } from '../perf/previewTrace'

// ── 滚轮缩放常量（Ctrl/⌘ + wheel，跟随光标锚点）── V16.1 平滑增强 ──
// 连续缩放：deltaY 走指数映射（乘性），rAF 合并高频事件为每帧一次更新；
// 不再用离散档位 + 冷却/阈值（那套会「跳格 + 迟滞」）。sensitivity 偏小，避免普通鼠标一格冲太猛。
const WHEEL_SENSITIVITY = 0.0012
const WHEEL_ZOOM_MIN = 10     // 最小 10%（相对 fit）
const WHEEL_ZOOM_MAX = 500    // 最大 500%

// ✅ 懒加载 PDF 渲染模块，避免首屏加载 1.4 MB 的 pdfjs-dist + react-pdf
// ── Legacy boundary (Step 12.3) ──────────────────────────────────
// renderers.js 仍有 3 个活跃消费者，不可移除：
//   1. merge PreviewCanvas（renderMultipleItemsToCanvas 合成画布）
//   2. image/OFD canvas（switchPreviewImage 绘制）
//   3. PDF RE-blocked fallback（switchPreviewFile 回退渲染）
// 打印链独立导入 renderers.js（usePrint / printRenderer），不经过此处。
let _renderers = null
async function getRenderers() {
  if (!_renderers) {
    _renderers = await import('../renderers')
  }
  return _renderers
}

// ✅ 使用统一的 PREVIEW_DPI，移除重复的 PREVIEW_DPI_VALUE
// PREVIEW_DPI 用于渲染，也用于旋转计算，保持一致

export function usePreview({ files, settings, electronAPIRef }) {
  // ── Preview state ──
  const [previewFile, setPreviewFile] = useState(null)
  const [selectedFileKey, setSelectedFileKey] = useState(null)  // 文件列表高亮用，立即更新，不进 render effect
  const [mergePair, setMergePair] = useState(null)
  const [numPages, setNumPages] = useState(0)
  const [previewPage, setPreviewPage] = useState(1)
  const [previewCanvas, setPreviewCanvas] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)  // Render Engine <img> URL
  // ✅ <img> 模式下图片的自然像素尺寸（naturalWidth/Height），用于内容布局计算
  const [previewImgDims, setPreviewImgDims] = useState(null)
  // ✅ 全局 Canvas 渲染版本号：每次 switchPreviewFile 后递增，
  //    用于 PreviewCanvas 的 L1 缓存失效，确保内容更新后重绘
  const [previewRenderVersion, setPreviewRenderVersion] = useState(0)
  // ✅ Stage 0.8 — 加载中标记：仅用于 Overlay 显示，绝不参与"可显示态"判定。
  //    切文件/重渲染时置 true，commit 成功后置 false；旧 committed 帧始终保留，绝不清空。
  const [previewLoading, setPreviewLoading] = useState(false)
  // ✅ RE 预览不可用（doc 未注册且重注册失败 / 渲染错误）时标记该 docId，
  //    触发 Canvas 容灾回退。切换文件时重置（见下方 effect），保证 registry 恢复后可自愈。
  const [reBlockedDocId, setReBlockedDocId] = useState(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  // ✅ 移除多余的 previewRotation state，所有旋转都通过 fileRotations 管理
  const [fileRotations, setFileRotations] = useState({})
  const fileRotationsRef = useRef(fileRotations)
  useEffect(() => { fileRotationsRef.current = fileRotations }, [fileRotations])
  // [DIAG-2] 监控 fileRotations 变化
  useEffect(() => {
    const keys = Object.keys(fileRotations).filter(k => (fileRotations[k] || 0) !== 0)
    if (keys.length > 0) {
      console.log('[DIAG-2 fileRotations changed]', keys.length, 'non-zero entries:', fileRotations)
    }
  }, [fileRotations])
  const [showLeftArrow, setShowLeftArrow] = useState(false)
  const [showRightArrow, setShowRightArrow] = useState(false)

  // ── Commit C：纸张方向 Fact（自动/横向/纵向），per doc_id 持久化 ──
  // 🔧 2026-08-09 产品决策：旋转/纸张方向不跨重启保留——主进程启动清空 DocFacts.json，
  //    本持久化仅服务会话内（切换文件恢复 + L2 缓存键一致），重启后全部回 auto。
  const [requestedPaperOrientation, setRequestedPaperOrientation] = useState('portrait')
  const [autoActive, setAutoActive] = useState(true)
  const requestedPaperOrientationRef = useRef('portrait')
  const applyRequestedPaperOrientation = useCallback((v, isAuto) => {
    requestedPaperOrientationRef.current = v
    if (documentStateRef.current) documentStateRef.current.requestedPaperOrientation = v
    setRequestedPaperOrientation(v)
    setAutoActive(!!isAuto)
  }, [])

  // ── Zoom state ──
  const [zoomPercent, setZoomPercent] = useState(100)
  const [zoomMode, setZoomMode] = useState('adaptive')
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false)
  const [zoomMenuClosing, setZoomMenuClosing] = useState(false)

  // ── Refs ──
  const previewCanvasRef = useRef(null)
  const previewUrlRef = useRef(null)           // blob URL (revoke on cleanup)
  const renderEngineUrlRef = useRef(null)      // Render Engine HTTP URL (no revoke needed)
  const previewVersionRef = useRef(0)
  // P4 Contract（2026-08-23）：最近一次 commit 的 execution.version。
  // clearCommitted 用它判定「当前 committed preview」是否拥有 transaction 的清理权
  // （旧 render cleanup 不得取消新 transaction）。
  const committedPreviewVersionRef = useRef(null)
  // Preview Scheduler transaction（Contract v2 §1.1）：单一 selection 的 { key, version, snapshot }
  const previewTransactionRef = useRef(null)
  // Preview Scheduler execution（Contract v2 §1.2）：snapshot consumer ownership
  // { id, key, version, phase, consumingSnapshot } — 与 transaction 分离（INV-PS8）
  const previewExecutionRef = useRef(null)
  const executionIdRef = useRef(0)   // execution identity 计数器（INV-PS9/PS10）
  const renderVersionRef = useRef(0)  // 专供 render effect 使用，与 handlePreview 隔离
  const renderLogIdRef = useRef(0)    // 仅用于日志 token，与 renderVersionRef 解耦（避免一处自增干扰另一处）
  const previewContainerRef = useRef(null)
  const unrotatedCanvasRef = useRef(null)
  const lastRenderKeyRef = useRef('')
  const isRenderingRef = useRef(false)
  const zoomModeRef = useRef('adaptive')
  const fitScaleRef = useRef(1)
  // ── 滚轮缩放（Ctrl/⌘ + wheel，跟随光标锚点）── V16.1 UX 增强：只改 ViewportTransform，不碰 RenderLayout ──
  const wheelAccumRef = useRef(0)                       // deltaY 累加器（rAF 帧内合并）
  const wheelRafRef = useRef(null)                      // 待处理的 rAF 句柄（合并高频 wheel 事件）
  const wheelCursorRef = useRef(null)                   // { cx, cy } 事件同步捕获的光标（rAF 内事件对象不可靠）
  const wheelAnchorRef = useRef(null)                   // { contentX, contentY, cx, cy, oldScale } 缩放前光标下的内容坐标 + 实际视口 scale
  const zoomPercentRef = useRef(100)                    // 镜像 zoomPercent，供 rAF 滚轮回调读最新值（避免闭包过期）
  const userViewportLockRef = useRef(false)             // 用户是否主动接管 viewport（滚轮缩放后为真；文件切换/适应窗口时释放）
  const paperScaleRef = useRef(1)                       // 镜像 computedContentLayout.paperDisplayScale，供 wheel handler 读当前视口 scale
  const zoomDropdownRef = useRef(null)
  const pendingBlobUrlsRef = useRef([])
  const lastFilesKeyRef = useRef('')
  const renderCancelledRef = useRef(false)
  // ✅ <img> 尺寸探测：防止过期回调覆盖（仅最新 token 可提交）
  const imgLoadTokenRef = useRef(0)
  // ── [PREVIEW FLOW] 生命周期 token：连接 doLoadPreview 与 render effect 的统一追踪 ID ──
  //    导入在 doLoadPreview START 写入 PRV-xxx，render effect 读取它，使一次导入的全链路
  //    （load → render effect → RE probe / canvas → commit）共用同一 token，便于复现卡 Loading 时定位最后节点。
  const flowTokenRef = useRef(null)
  // ✅ 保存 zoom menu 关闭动画的 timeout ID，用于清理
  const zoomMenuCloseTimeoutRef = useRef(null)
  // ✅ 保存 handlePreview 最新引用，避免 useEffect 闭包陷阱
  const handlePreviewRef = useRef(null)
  // ✅ L2 缓存：预渲染高清画布（通过 hover 提前填充）
  //    与 renderResultCache 共享同一 canvas 引用（无额外内存）
  const fullCacheRef = useRef(new Map())
  // ✅ 有上限的 fullCache setter：超 10 项时淘汰最旧并释放 canvas 内存
  const setFullCache = useCallback((key, canvas) => {
    const map = fullCacheRef.current
    // 覆盖旧值：先释放旧 canvas
    if (map.has(key)) {
      const old = map.get(key)
      if (old instanceof HTMLCanvasElement) { old.width = 0; old.height = 0 }
      map.delete(key)
    }
    map.set(key, canvas)
    // 限制 10 项，超限时淘汰最旧的
    if (map.size > 10) {
      const firstKey = map.keys().next().value
      const first = map.get(firstKey)
      if (first instanceof HTMLCanvasElement) { first.width = 0; first.height = 0 }
      map.delete(firstKey)
    }
  }, [])
  // ✅ 当前 hover 预加载的 AbortController（只保留最后一个）
  const currentPreloadRef = useRef(null)
  // ✅ 渲染跳过标记：handlePreview 从 fullCache 取到 canvas 时，
  //    设置此标记让 render effect 跳过，避免重复渲染
  const skipRenderRef = useRef(false)
  // ✅ previewFile 的同步 ref：解决 async handlePreview 期间 state 未更新的竞态问题
  //    handleNextFile / handlePrevFile 等依赖索引计算的逻辑通过此 ref 读取最新值
  const previewFileRef = useRef(null)
  // ✅ 切换防抖：快速连击时只渲染最后一次，跳过中间帧
  const switchTimeoutRef = useRef(null)
  const lastSwitchTimeRef = useRef(0)
  // P2-X2（2026-09-04）：debounce 窗口内 pending 意图仲裁结果 { intent, key }，与 switchTimeoutRef 同生命周期
  const pendingDebounceRef = useRef(null)
  // ✅ settings 的同步引用：doLoadPreview 的 useCallback 闭包未把 paperSize/margins 列入 deps，
  //    直接用闭包 settings 会拿到陈旧值，导致读写缓存 key 不一致。统一走 settingsRef.current 取最新布局。
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // ── V16 Preview State Model ──
  const documentStateRef = useRef(null)
  // ✅ PaperLayout 是纯派生状态（V16 模型）：settings → computePaperLayout(useMemo)。
  //    不再用 ref + useEffect 间接层维护（消除 ref/effect 双状态 + margin 一拍滞后）。
  //    deps 仅含 PaperSpec 字段（纸张/边距/custom），不含 previewFile → 切文件不重建（Stage 0 验收）。
  const paperLayout = useMemo(
    () => computePaperLayout({
      paperSize: settings.paperSize,
      customPaper: settings.customPaper,
      margins: {
        top: settings.marginTop, right: settings.marginRight,
        bottom: settings.marginBottom, left: settings.marginLeft,
      },
    }),
    [settings.paperSize, settings.customPaper?.widthMM, settings.customPaper?.heightMM,
     settings.marginTop, settings.marginRight, settings.marginBottom, settings.marginLeft]
  )
  const [contentLayout, setContentLayout] = useState(null)
  const [renderState, setRenderState] = useState(initialRenderState())

  // ── V16 Stage 0.8 — CommittedPreview：当前正式显示的内容（Consumer 只消费它）──
  // 结构 = { url, dims, canvas, layout, timestamp }。
  // 它是"最后一次成功提交"的镜像：加载候选（probe/render）未完成前绝不写入，
  // 因此 Consumer 永远看到最后一帧有效画面，而非正在构建的中间态（A→null→B 的 null 被消除）。
  const committedPreviewRef = useRef({ url: null, dims: null, canvas: null, layout: null, timestamp: 0 })
  // 清空 committed（切到无预览文件 / 文件无预览数据时调用）
  // ✅ Step 10.6：释放 = 清空 + 取消在途。只清 committed 不够——删除流程自身会
  //    handlePreview(已被删除的文件)，其在途 doLoadPreview 会复活 previewFile 并派发新的
  //    RE probe / canvas 渲染；这些异步提交若在清空之后回写 previewUrl/previewCanvas，
  //    就会在空状态页下残留旧帧。先递增三个 token，使所有在途任务的提交守卫失效。
  const clearCommitted = useCallback(() => {
    // ── P4 Contract（2026-08-23 冻结）：旧 render cleanup 不得拥有新 transaction 的取消权 ──
    // 背景：导入后旧裸 previewFile（占位对象）的 render effect 触发 clearCommitted，
    //   无条件清 transaction/execution + ++version → 把新 handlePreview（富 execution）
    //   一起取消（[PREVIEW FLOW] 铁证：v9 superseded 但无 v10 START）→ 富对象永不 commit。
    // 决策：仅当 transaction 属于「当前 committed preview」（version 匹配）时才清；
    //   否则只清旧展示帧，保留在途 execution（resolveCommittedClear，previewScheduler.js）。
    const txn = previewTransactionRef.current
    const commitDecision = resolveCommittedClear({
      transaction: txn,
      committedVersion: committedPreviewVersionRef.current,
    })
    if (commitDecision.action === 'preserve-transaction') {
      // 旧 committed preview 无权取消新 transaction：保留 transaction/execution + version 守卫，
      // 只清旧展示帧（属于已过时的 committed preview），loading 标记留给在途 execution 管理。
      committedPreviewRef.current = { url: null, dims: null, canvas: null, layout: null, timestamp: 0 }
      setPreviewUrl(null)
      setPreviewImgDims(null)
      setPreviewCanvas(null)
      return
    }
    previewVersionRef.current++        // 在途 doLoadPreview 的 version 守卫失效，阻止复活 previewFile
    // V-3 修复（Contract v2）：invalidate 显式清 transaction + execution，消除幽灵状态（INV-PS8）
    previewTransactionRef.current = null
    previewExecutionRef.current = null
    imgLoadTokenRef.current++          // 在途 RE probe 的 commit 守卫失效，阻止回写 previewUrl
    renderVersionRef.current++         // 在途 canvas 渲染的提交守卫失效
    renderCancelledRef.current = true  // 双保险：标记当前渲染已取消
    committedPreviewRef.current = { url: null, dims: null, canvas: null, layout: null, timestamp: 0 }
    setPreviewUrl(null)
    setPreviewImgDims(null)
    setPreviewCanvas(null)
    setPreviewLoading(false)
  }, [])
  // 同步 committed.layout（contentLayout 是派生显示态，commit 后随其更新）
  useEffect(() => { committedPreviewRef.current.layout = contentLayout }, [contentLayout])

  // ✅ V16 契约守卫（修正）：旋转应用后，显示图像的「纸张方向」应与 PaperLayout.paperRect 方向一致。
  //    旧版误把 DocumentState.pageOrientation(内容方向) 与图像方向比较 —— 在 rotation=90
  //    （横向内容放竖纸）下恒假，属 Stage 0.5「grep 确认无 orientation 读取后删字段」未做的残骸，已修正。
  //    正确不变式：rotation 应用后，图像方向 == 纸张方向（而非内容方向）；
  //    若后端未按 spec.rotation 出图，此处仍会触发，作为 Stage 1（RE 消费 RenderCommand）的契约守卫。
  useEffect(() => {
    if (!previewImgDims || previewImgDims.w <= 0 || previewImgDims.h <= 0) return
    const pl = paperLayout
    if (!pl || !pl.paperRect?.w) return
    // 🆕 V17：图像方向应与「有效纸张方向(paperLandscape)」一致（纸随内容）。
    // 旧逻辑比的是 paperRect 固定方向，在 paperLandscape 模型下恒错，已改为比 paperLandscape。
    const paperLandscape = renderCommand?.paperLandscape
      ?? (documentStateRef.current?.pageOrientation !== (pl.paperRect.w > pl.paperRect.h ? 'landscape' : 'portrait'))
    const imgOrient = previewImgDims.w > previewImgDims.h ? 'landscape' : 'portrait'
    const effOrient = paperLandscape ? 'landscape' : 'portrait'
    if (imgOrient !== effOrient) {
      console.warn('[V17 ASSERT] 图像方向(%s) 与有效纸张方向(paperLandscape=%s) 不一致 dims=%dx%d',
        imgOrient, paperLandscape, previewImgDims.w, previewImgDims.h)
    }
  }, [previewImgDims, paperLayout])

  /** 从 loadedFile 提取 DocumentState */
  function computeDocumentState(loadedFile) {
    const pageW = loadedFile._pdfPageWidth || loadedFile._imageWidth || 0
    const pageH = loadedFile._pdfPageHeight || loadedFile._imageHeight || 0
    return {
      // Stage4.1.4：DocumentState 身份源从 UI key 切换到 Document docId。
      // 优先 identity.docId（4.1.3 注入）；兼容旧数据回退 docId；永不使用 key。
      id: loadedFile.identity?.docId || loadedFile.docId || '',
      pageCount: loadedFile._pdfPageCount || 1,
      pageSize: { w: pageW, h: pageH },
      pageOrientation: getDocNaturalOrientation({ w: pageW, h: pageH }),
      sourceType: loadedFile._fileFormat || 'pdf',
      // [M1-c D20/C8 · frozen] pageNum 是 1-based SOURCE evidence
      //   (app.py split_pdf emit / fileHelpers.buildFileObj)。1-based Source →
      //   1-based render locator 是 IDENTITY，不需要 ±1。禁止再补 +1。
      //    不要在消费者代码里检查 pageNum 真假值——改用 src/layout/docFacts.js 的
      //    shouldAppendPageSuffix(doc)（检查 pageCount>1）。
      pageNum: loadedFile.pageNum ?? 1,
    }
  }

  // ✅ computePaperLayout 已迁移为 previewState.js 的纯工厂函数（F3+F5），
  //    仅依赖 PaperSpec，不再读 docState/container，方向 swap 移出 PaperLayout。
  // ──
  // ✅ loadFilePreview 数据缓存：避免每次文件切换都重复 b64toBlob / IPC 读文件
  //    图片缓存 Blob 对象，PDF 缓存 Uint8Array
  //    LRU 自清理（max 50 条 + 200MB 内存限制），文件删除后主动清理
  const previewLoadCacheRef = useRef(new Map())
  // ✅ 缓存总内存估算（字节），避免每次遍历 Map 计算
  const previewLoadCacheSizeRef = useRef(0)

  const MAX_CACHE_ENTRIES = 50
  const MAX_CACHE_MEMORY_BYTES = 200 * 1024 * 1024

  const estimateSize = (val) => {
    if (val instanceof Blob) return val.size
    if (val instanceof Uint8Array) return val.byteLength
    if (val instanceof ArrayBuffer) return val.byteLength
    return 1024
  }

  const lruSet = (map, key, value) => {
    const entrySize = estimateSize(value)

    if (map.has(key)) {
      const oldVal = map.get(key)
      previewLoadCacheSizeRef.current -= estimateSize(oldVal)
      map.delete(key)
    }

    while (map.size >= MAX_CACHE_ENTRIES || previewLoadCacheSizeRef.current + entrySize > MAX_CACHE_MEMORY_BYTES) {
      const firstKey = map.keys().next().value
      const oldVal = map.get(firstKey)
      previewLoadCacheSizeRef.current -= estimateSize(oldVal)
      if (oldVal?.close) oldVal.close()
      map.delete(firstKey)
    }

    map.set(key, value)
    previewLoadCacheSizeRef.current += entrySize
  }

  const lruGet = (map, key) => {
    if (!map.has(key)) return undefined
    const value = map.get(key)
    map.delete(key)
    map.set(key, value)
    return value
  }

  /** 从图像 URL 提取自然尺寸（带 LRU 缓存 + 超时回退）—— image/ofd 路径与 RE pdf 路径共用 */
  const fetchImageDims = async (url, key, timeoutMs = 8000) => {
    const map = previewLoadCacheRef.current
    const dimsKey = 'dims_' + key
    const cached = lruGet(map, dimsKey)
    if (cached) return { w: cached.w, h: cached.h }
    try {
      const img = new Image()
      const dims = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), timeoutMs)
        img.onload = () => { clearTimeout(timeout); resolve({ w: img.naturalWidth, h: img.naturalHeight }) }
        img.onerror = () => { clearTimeout(timeout); resolve(null) }
        img.src = url
      })
      if (dims && dims.w > 0 && dims.h > 0) {
        lruSet(map, dimsKey, dims)
        return dims
      }
    } catch (_) { /* 提取失败 fallback null */ }
    return null
  }

  const clearFilePreviewCache = useCallback((fileKey) => {
    const map = previewLoadCacheRef.current
    ;[`blob_${fileKey}`, `dims_${fileKey}`, `pdf_${fileKey}`, `pdfDims_${fileKey}`]
      .forEach(k => {
        if (map.has(k)) {
          const val = map.get(k)
          previewLoadCacheSizeRef.current -= estimateSize(val)
          if (val?.close) val.close()
          map.delete(k)
        }
      })
  }, [])

  const clearAllPreviewCache = useCallback(() => {
    previewLoadCacheRef.current.clear()
    previewLoadCacheSizeRef.current = 0
  }, [])
  // ✅ App 在删除文件并直接调用 handlePreview 时，设置此标记跳过 useEffect 自动导航
  const skipAutoNavRef = useRef(false)
  const filesRef = useRef(files)
  const fileIndexMapRef = useRef(new Map())
  useEffect(() => {
    filesRef.current = files
    const map = new Map()
    files.forEach((f, i) => map.set(f.key, i))
    fileIndexMapRef.current = map
  }, [files])

  // ── Ref sync ──
  useEffect(() => { zoomModeRef.current = zoomMode }, [zoomMode])

  // ── 翻页 ──
  const prevPage = useCallback(() => {
    setPreviewPage(p => Math.max(1, p - 1))
  }, [])

  const nextPage = useCallback(() => {
    setPreviewPage(p => Math.min(numPages, p + 1))
  }, [numPages])

  const handleRotate = useCallback((targetKey) => {
    const key = targetKey || previewFileRef.current?.key
    if (!key) return
    const deg = ((fileRotations[key] || 0) + 90) % 360
    setFileRotations(prev => ({ ...prev, [key]: deg }))
    // 🔧 P1 修复：同步 documentStateRef，L2 缓存命中路径（doLoadPreview 内 buildRenderCommand
    //    `paperLayout, documentStateRef.current`，无 previewRotation 显式覆盖）才能拿到最新 rotation。
    //    仅当旋转的是当前预览文件时同步；否则 documentStateRef 属其他文件，不可污染。
    if (previewFileRef.current?.key === key && documentStateRef.current) {
      documentStateRef.current.contentRotation = deg
      documentStateRef.current.rotation = deg // [LEGACY 镜像] = contentRotation
    }
    // 持久化 contentRotation（纸张方向 Fact 之一），requestedPaperOrientation 取当前 Fact
    // 4.1.5：写入键严格用 Document 身份 docId，不回退 path/key（uiKey 永不入持久层）
    // 🔧 修复（2026-08-09）：factKey 必须取「旋转目标文件」而非 previewFileRef.current——
    //    从文件列表旋转非当前预览文件时，旧逻辑把旋转值写到当前预览文件的 docId 下，
    //    污染其持久层记录（contentRotation 残留 90 的根因）。
    const target = filesRef.current.find(f => f.key === key) || previewFileRef.current
    const factKey = target?.identity?.docId || target?.docId
    if (!factKey) return
    const api = electronAPIRef.current
    if (!api) return
    // 统一 saveDocFacts（含 deg=0）：与旧代码语义一致，保留 requestedPaperOrientation 记录。
    // 旋转回 0° 会把 stale 的 contentRotation=90 覆盖成 0，同样根治 re-import 复活问题，
    // 但不像 clearDocFacts 那样把整条记录（含用户手动选的纸张方向）删除。
    if (api.saveDocFacts) {
      api.saveDocFacts(factKey, {
        // ⚠️ 必须保留 requestedPaperOrientation：主进程 save-doc-facts 整体覆盖 map[factKey]，
        //    缺该字段会被归一化成 'portrait'，冲掉纸张方向记录。
        requestedPaperOrientation: requestedPaperOrientationRef.current,
        contentRotation: deg,
      }).catch((e) => console.warn('[Rotation] saveDocFacts failed:', e))
    }
  }, [fileRotations, electronAPIRef])

  // ── Commit C：纸张方向切换（自动/横向/纵向）──
  // 自动 = 删除持久记录，方向回落文档天然方向（下次加载重新推导并写回）；
  // 横向/纵向 = 覆盖持久记录。contentRotation 保持不变（来自当前 Fact）。
  // 🔧 2026-08-09：持久层仅会话内有效（主进程启动清空 DocFacts.json，不跨重启保留）。
  const handlePaperOrientationChange = useCallback((mode) => {
    const f = previewFileRef.current
    // 4.1.5：写入键严格用 Document 身份 docId，不回退 path/key
    const factKey = f?.identity?.docId || f?.docId
    if (!factKey) console.warn('[DocFacts] skip persist: missing docId (image/OFD 尚无 docId)')
    const api = electronAPIRef.current
    if (mode === 'auto') {
      const ds = documentStateRef.current
      const nat = ds?.pageSize ? getDocNaturalOrientation(ds.pageSize) : null
      const natural = nat || 'portrait'
      applyRequestedPaperOrientation(natural, true)
      if (factKey && api && api.clearDocFacts) api.clearDocFacts(factKey).catch(() => {})
      return
    }
    if (mode !== 'portrait' && mode !== 'landscape') return
    applyRequestedPaperOrientation(mode, false)
    if (factKey && api && api.saveDocFacts) {
      api.saveDocFacts(factKey, { requestedPaperOrientation: mode, contentRotation: fileRotations[f?.key] || 0 }).catch(() => {})
    }
  }, [electronAPIRef, fileRotations])

  // ── 清理预览 URL ──
  const cleanupPreviewUrl = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setPreviewUrl(null)
  }, [])

  // ── 清理所有 blob URL ──
  const cleanupAllBlobUrls = useCallback(() => {
    pendingBlobUrlsRef.current.forEach(url => {
      try {
        URL.revokeObjectURL(url)
      } catch (e) {
        // 忽略已失效的 URL
      }
    })
    pendingBlobUrlsRef.current = []
  }, [])

  // ── Zoom ──
  const handleCloseZoomMenu = useCallback(() => {
    if (zoomMenuClosing || !zoomMenuOpen) return
    setZoomMenuClosing(true)
    // ✅ 使用 ref 保存 timeout ID，便于清理
    if (zoomMenuCloseTimeoutRef.current) {
      clearTimeout(zoomMenuCloseTimeoutRef.current)
    }
    zoomMenuCloseTimeoutRef.current = setTimeout(() => {
      zoomMenuCloseTimeoutRef.current = null
      setZoomMenuClosing(false)
      setZoomMenuOpen(false)
    }, 150)
  }, [zoomMenuClosing, zoomMenuOpen])

  useEffect(() => {
    if (!zoomMenuOpen) return
    const handleClickOutside = (e) => {
      if (zoomDropdownRef.current && !zoomDropdownRef.current.contains(e.target)) {
        handleCloseZoomMenu()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [zoomMenuOpen, handleCloseZoomMenu])

  const zoomIn = useCallback(() => {
    setZoomMode('manual')
    // 档位推进统一走 nextZoomStep（adaptive 锚点视为 100 = fit）
    setZoomPercent(prev => nextZoomStep(zoomModeRef.current === 'adaptive' ? 100 : prev, 'in', ZOOM_STEPS))
  }, [])

  const zoomOut = useCallback(() => {
    setZoomMode('manual')
    setZoomPercent(prev => nextZoomStep(zoomModeRef.current === 'adaptive' ? 100 : prev, 'out', ZOOM_STEPS))
  }, [])

  const setAdaptive = useCallback(() => {
    setZoomMode('adaptive')
    userViewportLockRef.current = false   // 🆕 适应窗口 = 释放 viewport 接管，恢复框架自动居中
  }, [])
  const setManualScale = useCallback((pct) => { setZoomMode('manual'); setZoomPercent(pct) }, [])

  // 镜像 zoomPercent 到 ref，供 rAF 滚轮回调读取最新值（避免闭包过期导致连续缩放卡顿）
  useEffect(() => { zoomPercentRef.current = zoomPercent }, [zoomPercent])

  // ── 滚轮缩放（Ctrl/⌘ + wheel，跟随光标锚点）── V16.1 UX 增强 ──
  // 只改 ViewportTransform.zoom（paperScale），不碰 RenderLayout / RenderSpec / Export / Print。
  // 关键点（架构评审定稿）：锚点记录「实际视口 scale」而非 zoomPercent，语义对齐 V16。
  const handleWheelZoom = useCallback((e) => {
    // 仅 Ctrl/⌘ + wheel 触发缩放；普通 wheel 保留滚动平移
    if (!(e.ctrlKey || e.metaKey)) return
    // 排除控件区（与现有 click-outside 同口径）
    if (e.target.closest?.('.canvas-zoom-control, .status-indicator, .canvas-arrow')) return
    // 阻止 Electron/Chromium 把 Ctrl+wheel 当成整页缩放
    e.preventDefault()

    // 光标坐标必须在事件同步捕获：rAF 回调执行时事件对象可能已被浏览器回收，clientX 不可靠。
    const el0 = previewContainerRef.current
    if (el0) {
      const r = el0.getBoundingClientRect()
      wheelCursorRef.current = { cx: e.clientX - r.left, cy: e.clientY - r.top }
    }

    // rAF 批处理：合并一帧内的所有 wheel 事件为「一次」缩放更新（Electron 高频事件友好），
    // 取代原先的 60ms 冷却 + 30 阈值（那套会迟滞 + 跳格）。
    wheelAccumRef.current += e.deltaY
    if (wheelRafRef.current != null) return
    wheelRafRef.current = requestAnimationFrame(() => {
      wheelRafRef.current = null
      const delta = wheelAccumRef.current
      wheelAccumRef.current = 0

      // adaptive 锚点视为 100（= fit 比例 1.0），与 nextZoomStep 语义一致；manual 用实际百分比。
      const curPct = zoomModeRef.current === 'adaptive' ? 100 : zoomPercentRef.current
      const targetPct = applyWheelZoom(curPct, delta, {
        sensitivity: WHEEL_SENSITIVITY,
        min: WHEEL_ZOOM_MIN,
        max: WHEEL_ZOOM_MAX,
      })
      // 已夹取到边界（无变化）则清空锚点直接返回，避免残留锚点误补偿后续布局变化
      if (targetPct === curPct) {
        wheelAnchorRef.current = null
        return
      }

      // 记录光标下的内容坐标 + 当前「实际视口 scale」（变的是 ViewportTransform，不是 zoomPercent）
      const el = previewContainerRef.current
      let anchor = null
      if (el && wheelCursorRef.current) {
        anchor = {
          contentX: el.scrollLeft + wheelCursorRef.current.cx,
          contentY: el.scrollTop + wheelCursorRef.current.cy,
          cx: wheelCursorRef.current.cx,
          cy: wheelCursorRef.current.cy,
          oldScale: paperScaleRef.current,
        }
      }
      wheelAnchorRef.current = anchor
      userViewportLockRef.current = true   // 用户主动接管 viewport
      setManualScale(targetPct)            // 连续百分比（按钮仍走 nextZoomStep 离散档位）
    })
  }, [setManualScale])

  // 当前预览文件的旋转值（用于优化依赖）
  const currentRotation = fileRotations[previewFile?.key] || 0


  // ✅ 当 mergeMode 变化时，重置 lastRenderKeyRef 以确保 render effect 不会被旧 renderKey 跳过
  useEffect(() => {
    lastRenderKeyRef.current = ''
  }, [settings.mergeMode])

  // ✅ 切换文件时重置 RE 阻断标记：registry 恢复（如重新打开文件注册）后，
  //    再次访问该文件会重新尝试 RE，而非永久困在 Canvas 容灾。
  useEffect(() => {
    setReBlockedDocId(null)
  }, [previewFile?.docId])

  // ============================
  // RenderCommand 唯一派生点（F3/F5）—— 上移到首个消费它的 effect 之前
  // 原位置在 contentLayout memo 之前，但其 useMemo 在首次渲染时被 line 380 的预览渲染
  // effect 依赖数组提前求值，触发 "Cannot access 'renderCommand' before initialization"
  // （TDZ）。移到此处后，所有消费方（含 preview 渲染 effect）都能拿到已初始化的 const。
  // ✅ previewRotation 必须在 contentLayout memo 之前声明（useMemo 首次渲染立即执行，不能闭包捕获尚未初始化的 const）
  const previewRotation = fileRotations[previewFile?.key] || 0
  // [DIAG-3] Viewer 消费 rotation — 条件日志，仅 rotation≠0 时触发

  // ── Stage 1：RenderCommand 唯一派生点（F3/F5）──
  // Preview 消费其 placement/rotation/clip，不再自算 fit/scale/swap（消除第二套算法）。
  // 输入 documentState 合并 previewRotation（documentStateRef 不含 rotation 字段）；
  // 依赖 paperLayout(纸张/边距派生，useMemo) + previewRotation(旋转) + previewFile(切文件→documentState 重建)。
  // paperLayout 在 Render 阶段随 settings 同步派生 → margin 修改当帧即生效，无 effect 滞后。
  const renderCommand = useMemo(
    () => {
      const cmd = buildRenderCommand(paperLayout, { ...(documentStateRef.current || {}), contentRotation: previewRotation })
      return cmd
    },
    [paperLayout, previewRotation, previewFile, requestedPaperOrientation]
  )
  // renderCommand 就绪（placement.scale>0）才用 Factory 派生；否则回退旧 bitmap 拟合，行为不变。
  const renderCommandReady = !!(renderCommand && renderCommand.placement && renderCommand.placement.scale > 0)

  // ============================
  // 预览渲染
  // ============================
  // Commit 3 fix: 当旋转 ≠ 0 时，RE 后端不消费 content_rotation，需走 Canvas 路径。
  // Canvas 路径需要 _pdfData，此处独立 effect 预加载（避免主 render effect 中的 async 时序问题）。
  useEffect(() => {
    if (!previewFile || previewRotation === 0) return
    // 🔴 P0 fix (2026-08-20)：_pdfData 是 PDF 专用契约——渲染 effect 会把它交给
    //    getOrLoadPdfDocument (pdfjs) 解析。本 effect 从 printPath 读原始字节，
    //    若文件非 PDF（OFD=ZIP / 图片），字节不是 PDF → pdfjs 抛 "Invalid PDF structure"。
    //    非 PDF 的旋转由图片路径处理（switchPreviewImage canvas 变换），无需 _pdfData，
    //    因此只有 _fileFormat==='pdf' 才预载。_fileFormat 缺省时按 PDF 处理（与
    //    `_fileFormat || 'pdf'` 的既有约定一致），不改变旧行为。
    if (previewFile._fileFormat && previewFile._fileFormat !== 'pdf') return
    if (previewFile._pdfData) return  // 已有数据，无需加载
    if (!previewFile.printPath) return

    let cancelled = false
    const load = async () => {
      try {
        const ipc = electronAPIRef.current?.ipcRenderer
        if (!ipc) return
        const fd = await ipc.invoke('read-file', previewFile.printPath)
        if (cancelled) return
        if (fd?.success) {
          previewFile._pdfData = new Uint8Array(fd.data)
          console.log('[DIAG-9 pdfData loaded] size=%d for canvas rotation render', previewFile._pdfData.length)
          // 🔧 触发重渲染：previewFile._pdfData 是直接 mutation，不触发 React。
          //    旧写法 setPreviewRenderVersion(v+1) 依赖 render effect 的 previewRenderVersion 依赖
          //    → 渲染完成又 setPreviewRenderVersion → 无限循环（rotation≠0 Canvas 路径必现）。
          //    改用 setPreviewFile 新引用：render effect 依赖 previewFile → 重跑一次，且不会自触发。
          setPreviewFile(prev => (prev ? { ...prev } : prev))
        }
      } catch (e) {
        if (!cancelled) console.warn('[DIAG-9 pdfData load failed]', e.message)
      }
    }
    load()
    return () => { cancelled = true }
  }, [previewFile?.key, previewRotation])

  useEffect(() => {
    if (!previewFile) { clearCommitted(); return }

    // ✅ 渲染生命周期 token
    const renderToken = `RND-${Date.now()}-${++renderLogIdRef.current}`
    // ✅ 统一生命周期 token：优先用 doLoadPreview 写入的 PRV-xxx，使一次导入全链路共用同一 ID
    const flowToken = flowTokenRef.current ?? renderToken

    // NOTE: Render dispatch must always execute before any cache bypass.
    //       Cache may provide render results, but must not choose the renderer.
    //       skipRenderRef only skips the Canvas pipeline; it does not skip
    //       the render strategy decision. (V6 — Engineering Discipline Law #8)
    // ── Render Dispatcher：独立于 L2 缓存，始终评估 RE 可用性 ──
    // 解析后拆分页：RE 预览使用 sourceDocId + pageNum，而非业务 docId + previewPage
    const isParsedSplitPage = !!(previewFile.sourceDocId && previewFile.docId !== previewFile.sourceDocId)
    const reDocId = isParsedSplitPage ? previewFile.sourceDocId : previewFile.docId
    const rePage = isParsedSplitPage ? ((previewFile.pageNum ?? 0) + 1) : previewPage
    const previewSpec = renderCommandReady
      ? buildRenderSpec(renderCommand, {
          docId: reDocId,
          page: rePage,
          dpi: PREVIEW_DPI,
          marginsMm: { top: settings.marginTop, right: settings.marginRight, bottom: settings.marginBottom, left: settings.marginLeft },
        })
      : null
    const reUrl = getRenderEnginePreviewUrl(previewFile, USE_RENDER_ENGINE_PREVIEW, previewSpec)

  // [DIAG-7] RE URL 中的 content_rotation — 条件日志，仅 rotation≠0 时触发（不刷屏）

    // ✅ L2 缓存旁路：有缓存 Canvas 时跳过 Canvas 渲染，但不阻止 Render Dispatcher 决策
    // Commit 3 fix: 旋转 ≠ 0 时不走 L2 缓存（缓存不包含 contentRotation），
    // 也不设 reUrl（RE 不消费 content_rotation），强制走 Canvas 路径重渲染。
    if (skipRenderRef.current && previewRotation === 0) {
      skipRenderRef.current = false
      if (reUrl) { setPreviewUrl(reUrl) }  // RE 可用 → 优先使用（不受缓存影响）
      return  // 不执行 Canvas 渲染（缓存内容已就绪或 RE 已设）
    }
    // 旋转 ≠ 0 时也清掉 skipRenderRef
    if (skipRenderRef.current) {
      skipRenderRef.current = false
    }

    const isImageOrOfd = isImageLikeFormat(previewFile._fileFormat)

    const hasRenderEngineUrl = !!reUrl
    if (!isImageOrOfd && !previewFile._pdfData && !mergePair && !hasRenderEngineUrl) {
      clearCommitted(); return
    }
    if (isImageOrOfd && !previewFile._previewImageUrl && !hasRenderEngineUrl) {
      clearCommitted(); return
    }

    const { paperSize } = settings
    // orientationMismatch = paperShouldShowAsLandscape
    // 规则：纸张与内容方向不同时才 swap（让内容能铺满）
    //   横向内容+横向纸 → orientationMismatch=false（纸保持横向，内容不旋转直接铺）
    //   竖向内容+横向纸 → orientationMismatch=true （纸 swap 成竖向，内容旋转 90° 铺）
    const paper = resolvePaper(paperSize, settings.customPaper)
    const paperOrient = paper.widthMM > paper.heightMM ? 'landscape' : 'portrait'
    // Gate 2 (PreviewGeometryBuilder)：orientation-mismatch 决策统一委托 Policy，
    // 不再手算 contentOrient !== paperOrient（消除第二套算法）。值等价，缓存键不变。
    // 2026-08-20 Fix: 对 0 尺寸做防御——当 extractContentPx 返回 0/无效尺寸时，
    // 用 A4 默认尺寸（595x842 pt @ 72dpi）安全降级，避免 PrintAutoRotationPolicy 抛错。
    const rawContentGeom = extractContentPx(previewFile)
    const safeGeom = (rawContentGeom.widthPx > 0 && rawContentGeom.heightPx > 0)
      ? rawContentGeom
      : { widthPx: 595, heightPx: 842 }  // A4 默认
    if (rawContentGeom.widthPx <= 0 || rawContentGeom.heightPx <= 0) {

    }
    const previewGeometry = buildPreviewGeometry({
      rawDocumentGeometry: safeGeom,
      requestedPaperGeometry: { orientation: paperOrient },
      userRotation: { degrees: previewRotation },
    })
    const orientationMismatch = previewGeometry.orientationMismatch
    // ✅ renderKey 必须包含合并模式、合并组所有文件的旋转值，以确保模式切换和多文件旋转都能触发重渲染
    const mergeRotations = mergePair?.map(m => `${m?.key}:${fileRotations[m?.key] || 0}`).join(',') || ''
    const paperFrag = paperKeyFragment(paper)
    const renderKey = `${previewFile.key}-${paperSize}-${orientationMismatch}-${currentRotation}-${settings.mergeMode || ''}-${mergePair?.map(m => m?.key).join(',') || ''}-${mergeRotations}-m${settings.marginLeft}_${settings.marginRight}_${settings.marginTop}_${settings.marginBottom}-${paperFrag}-re${reBlockedDocId || ''}`
    // ⚡ Commit B：移除 Effect 层的 renderKey 守卫。此守卫曾阻塞整个 Effect
    // （RE/Canvas/probe/Loading 生命周期全部被阻断），导致导入后卡 Loading。
    // renderKey 的去重职责应下沉到 Canvas 渲染内部（renderToCanvas），
    // RE 路径永远不受 renderKey 影响。
    renderCancelledRef.current = false
    const currentRenderId = ++renderVersionRef.current

    // ✅ 在 useEffect 同步部分预先计算布局参数，确保闭包捕获正确的 mergeMode
    const mergeModeGroupSize = isMergeMode(settings.mergeMode) ? (parseInt(settings.mergeMode?.replace('merge', '')) || 2) : 1
    const mergeLayoutStrategy = mergeModeGroupSize === 4 ? 'grid' : 'vertical'

    // ── RE 预览：探测 + 自动恢复（doc 未注册 → 重注册 → 重试 → Canvas 容灾）──
    // 仅当本文件非 RE、或本 doc 已被标记为 RE 不可用（reBlockedDocId）时，才落入下方 canvas。
    const autoRegister = async (fileObj) => {
      // ✅ doc_id = sha256(file_bytes + filename)，filename 是 doc_id 的一部分。
      //    必须传与入库时完全一致的 filename（fObj.name），否则后端算出的 doc_id
      //    与 fObj.docId 对不上 → /preview/{fObj.docId} 仍 404。
      let file = fileObj && fileObj.file
      if (!file && fileObj && fileObj._pdfData) {
        file = new Blob([fileObj._pdfData])
      }
      if (!file) return false
      try {
        const fd = new FormData()
        fd.append('file', file, fileObj.name || 'document')
        const resp = await fetch(`${BACKEND_URL}/api/documents/open`, { method: 'POST', body: fd })
        if (!resp.ok) return false
        const data = await resp.json().catch(() => null)
        return !!(data && data.success)
      } catch (e) {
        return false
      }
    }
    const startREProbe = (probeUrl, fileObj, renderToken) => {
      setPreviewLoading(true)
      const token = ++imgLoadTokenRef.current
      const probe = new Image()
      probe.decoding = 'async'
      // ✅ 原子 commit：url + dims 同批更新，committed 帧从旧直接跳到新，不经过 null
      const commit = () => {
        if (token !== imgLoadTokenRef.current) return
        setPreviewUrl(probeUrl)
        setPreviewImgDims({ w: probe.naturalWidth, h: probe.naturalHeight })
        setPreviewLoading(false)
        committedPreviewRef.current = {
          url: probeUrl,
          dims: { w: probe.naturalWidth, h: probe.naturalHeight },
          canvas: committedPreviewRef.current.canvas,
          layout: committedPreviewRef.current.layout,
          timestamp: Date.now(),
        }
        previewUrlRef.current = probeUrl
      }
      probe.onload = () => {
        if (token !== imgLoadTokenRef.current) {
          return
        }
        if (typeof probe.decode === 'function') {
          probe.decode().then(() => {
            commit()
          }).catch(commit)
        } else {
          commit()
        }
      }
      probe.onerror = () => {
        if (token !== imgLoadTokenRef.current) {
          return
        }
        setPreviewLoading(false)
        recoverREPreview(fileObj, probeUrl, token, renderToken)
      }
      probe.src = probeUrl
    }
    const recoverREPreview = async (fileObj, probeUrl, token, renderToken) => {
      if (token !== imgLoadTokenRef.current) {
        return
      }
      // 解析后拆分页：RE 预览使用 sourceDocId（后端注册的原始 PDF ID）
      const isParsedSplitPage = !!(fileObj.sourceDocId && fileObj.docId !== fileObj.sourceDocId)
      const effectiveDocId = isParsedSplitPage ? fileObj.sourceDocId : fileObj.docId
      // 分组条目（多页聚合）：docId === sourceDocId，RE URL 使用 sourceDocId 构建，
      // 但 autoRegister 只能注册当前 fileObj 的 file（rep 的单页拆分文件），
      // 其 docId 与原 PDF 的 sourceDocId 不一致，注册后重试仍会失败。
      // 因此跳过 autoRegister，直接落入 canvas 容灾。
      const isGroupedEntry = !!fileObj._isDocumentGroup
      if (isGroupedEntry) {
        setReBlockedDocId(fileObj.docId)
        return
      }
      // 1. 探测失败原因：DOC_NOT_REGISTERED（可恢复）还是已注册但渲染错误（不可恢复）
      let reason = 'unknown'
      try {
        const metaResp = await fetch(`${BACKEND_URL}/metadata/${effectiveDocId}`, { mode: 'cors' })
        if (metaResp.status === 404) {
          const body = await metaResp.json().catch(() => ({}))
          if (body && body.error === 'DOC_NOT_REGISTERED') reason = 'DOC_NOT_REGISTERED'
        } else if (metaResp.ok) {
          reason = 'RENDER_ERROR'
        }
      } catch (e) { reason = 'unknown' }
      // 2. doc 未注册 → 自动重注册（用户无感），成功后重试 RE
      if (reason === 'DOC_NOT_REGISTERED') {
        const registered = await autoRegister(fileObj)
        if (registered) {
          startREProbe(probeUrl, fileObj, flowToken)  // 重试（新 token）
          return
        }
      }
      // 3. 容灾：标记 RE 不可用 → 落入下方 canvas 渲染，保证预览不中断
      setReBlockedDocId(fileObj.docId)
    }
    // Commit 3 fix: RE 后端目前不消费 content_rotation（Slice 1.2B 才支持）。
    // 当用户旋转了内容（previewRotation ≠ 0），强制走 Canvas 本地渲染路径，
    // 让 drawRenderCommand 正确执行旋转。旋转归零后自动切回 RE 快速路径。
    const reRotateSupported = previewRotation === 0
    if (hasRenderEngineUrl && reBlockedDocId !== previewFile.docId && reRotateSupported) {
      const url = reUrl
      renderEngineUrlRef.current = url
      // ✅ Stage 0.8 Commit Buffer（修正版）：以 committedPreviewRef.current.url 判断是否需重新探测，
      //    保留上一帧直到 decode 完成才原子 commit（消灭 A→null→B 白板）。
      if (committedPreviewRef.current.url !== url) {
        startREProbe(url, previewFile, flowToken)
      } else {
        // 已提交帧即本 url（旋转/缩放重渲染）：确保显示态与之对齐，不重新探测。
        setPreviewUrl(url)
        setPreviewImgDims(committedPreviewRef.current.dims)
        setPreviewLoading(false)
      }
      return
    }
    // 非 <img> 路径：清理可能残留的 img 尺寸（canvas 帧保留，加载期间继续显示旧图）
    setPreviewImgDims(null)
    // ✅ 不变式：非 RE 路径必须把 previewUrl 复位为 null，否则上一文件的 RE <img> 残留，
    //    被 PreviewCanvas 的 RE 路径误判为有效 Preview → 显示陈旧内容。
    //    （React 对相同值 setPreviewUrl(null) 自动 bail-out，不会额外触发渲染）
    setPreviewUrl(null)
    // ✅ Stage 0.8：canvas 帧已在 committed，加载期间保持显示 + 打 loading overlay
    committedPreviewRef.current = { ...committedPreviewRef.current, url: null, dims: null }
    setPreviewLoading(true)

    const renderToCanvas = async (signal) => {
      try {
        // PERF-WHITE-1 1B：渲染尝试起点。随 T4 重置（first-wins）→ 捕获「100% 之后的首次尝试」；
        // 缺失 = 该窗口内无 canvas 渲染尝试（A 判据）。count 记录尝试/完成比（B/C 方向）。
        //
        // ⚠️ epoch 守卫（P0）：本函数是 async，跨 T4 的**在途渲染**若把完成点写进
        // previewRenderEnd，会凭空造出一个 D「渲染完成」判定（实际触发发生在 100% 之前）。
        // 故入口捕获世代，start/end 共用；跨世代的完成点由探针作废并留证为 *_stale。
        const epoch = perfProbe.stamp()
        perfProbe.mark('previewRenderStart', epoch)
        perfProbe.count('previewRenderAttempts')
        let canvas
        const isMerge = isMergeMode(settings.mergeMode) && mergePair?.some(Boolean)

        if (isMerge || isImageOrOfd || previewFile._pdfData) {
          const { renderMultipleItemsToCanvas } = await getRenderers()

          if (isMerge) {
            // ✅ 合并模式强制方向（merge2/3=竖向, merge4=横向），纸张用用户设置
            const forcedLandscape = getForcedLandscape(settings.mergeMode, orientationMismatch)
            const userMargins = {
              left: settings.marginLeft ?? 3, right: settings.marginRight ?? 3,
              top: settings.marginTop ?? 3, bottom: settings.marginBottom ?? 3,
            }
            canvas = await renderMultipleItemsToCanvas(
              mergePair.filter(Boolean),
              paperSize || 'A4', PREVIEW_DPI, forcedLandscape,
              fileRotations,
              mergeModeGroupSize,
              false,
              false,  // showSafeMargin
              { strategy: mergeLayoutStrategy, gridCols: 2, gridRows: 2, userMargins, customPaper: settings.customPaper },
              paperLayout  // V16 slotted path: slot geometry now matches createLayout
            )
          } else {
            // ✅ 单文件：统一使用全局 Canvas（PDF / 图片 / OFD 都走此路径）
            const { getGlobalPreviewCanvas, switchPreviewFile, switchPreviewImage, getOrLoadPdfDocument } = await getRenderers()
            // 🆕 V17：canvas 回退按 paperLandscape 绘制（内容自然、横纸），与 RE 对齐
            const effectiveLandscape = renderCommand?.paperLandscape ?? orientationMismatch
            const paperKey = paperSize || 'A4'

            // 初始化全局 Canvas（配置不变则复用同一 Canvas）
            const userMargins = {
              left: settings.marginLeft ?? 3,
              right: settings.marginRight ?? 3,
              top: settings.marginTop ?? 3,
              bottom: settings.marginBottom ?? 3,
            }
            canvas = getGlobalPreviewCanvas(paperKey, GLOBAL_PREVIEW_DPI, effectiveLandscape, userMargins)

            // 按内容类型渲染
            if (previewFile._pdfData) {
              // ── Legacy fallback (Step 12.3) ────────────────────────
              // 正常 RE 注册 PDF 走 DocumentViewer（<img> 路径），不经过此处。
              // 此分支仅在 RE 被 block（reBlockedDocId 匹配）时作为回退激活。
              // 不可删除：RE 容灾场景仍需 pdf.js canvas 渲染。
              const pdfDoc = await getOrLoadPdfDocument(previewFile._pdfData)
              if (pdfDoc) {
                await switchPreviewFile(pdfDoc, 1, signal, currentRotation)
              }
            } else if (previewFile._previewImageUrl) {
              // RE 预览图加载：尝试加载 RE URL 作为图片
              let img = await new Promise((resolve) => {
                const image = new Image()
                image.onload = () => resolve(image)
                image.onerror = () => resolve(null)
                image.src = previewFile._previewImageUrl
              })
              if (!img && previewFile._fileFormat === 'pdf' && !previewFile._pdfData) {
                // RE 图片加载失败且是 PDF：回退到 pdf.js 直接渲染
                // 这是多页拆分场景的关键容灾——当 RE 服务未就绪时，
                // 用 pdf.js 直接从文件数据渲染，保证预览不中断。
                try {
                  let buffer = null
                  if (previewFile.file) {
                    buffer = await previewFile.file.arrayBuffer()
                  } else if (electronAPIRef.current?.ipcRenderer && previewFile.printPath) {
                    const fd = await electronAPIRef.current.ipcRenderer.invoke('read-file', previewFile.printPath)
                    if (fd?.success) {
                      const clean = new Uint8Array(fd.data)
                      buffer = clean.buffer
                    }
                  }
                  if (buffer && !signal?.aborted) {
                    const pdfData = new Uint8Array(buffer)
                    previewFile._pdfData = pdfData
                    const { getOrLoadPdfDocument: sharedLoadPdf } = await getRenderers()
                    const pdfDoc = await sharedLoadPdf(pdfData)
                    if (!signal?.aborted && pdfDoc) {
                      await switchPreviewFile(pdfDoc, 1, signal, currentRotation)
                      return
                    }
                  }
                } catch (_) { /* pdf.js 回退也失败，静默返回 */ }
              }
              if (img) {
                await switchPreviewImage(img, signal, currentRotation)
              }
            }
          }
        }

        if (renderCancelledRef.current) return
        if (currentRenderId !== renderVersionRef.current) return
        if (canvas) {
          // ✅ 渲染完成 → 缓存快照到 fullCache，后续切换秒开
          const rotation = (fileRotations[previewFile.key] || 0)
          const cacheKey = buildPreviewCacheKey(
            { fileKey: previewFile.key, rotation },
            {
              paperSize: settings.paperSize,
              orientationMismatch,
              // 🔴 V17 不变式：缓存身份必须包含每一个影响 RenderCommand 的 Fact。
              //    paperLandscape 由 PaperOrientation Fact 驱动绘制，缺失会导致强制方向后命中错误快照。
              paperLandscape: renderCommand?.paperLandscape ?? false,
              mergeMode: settings.mergeMode,
              customPaper: settings.customPaper,
              margins: {
                left: settings.marginLeft, right: settings.marginRight,
                top: settings.marginTop, bottom: settings.marginBottom,
              },
            }
          )
          const snapshot = document.createElement('canvas')
          snapshot.width = canvas.width
          snapshot.height = canvas.height
          snapshot.getContext('2d').drawImage(canvas, 0, 0)
          snapshot.__fileKey = previewFile.key
          snapshot.__cacheKey = cacheKey
          setFullCache(cacheKey, snapshot)

          // ✅ 不清空旧 canvas：与 renderResultCache 共享同一对象，clearRect 会污染缓存
          unrotatedCanvasRef.current = canvas
          setPreviewCanvas(canvas)
          perfProbe.mark('T7', epoch)   // 预览首帧渲染完成（PERF-WHITE-1）
          perfProbe.mark('previewRenderEnd', epoch)   // 1B：渲染完成点（与 T7 同 tick）
          perfProbe.count('previewRenderCompleted')
          // ✅ Stage 0.8 commit：渲染完成 → 原子提交新帧 + 关闭 loading
          committedPreviewRef.current = {
            url: committedPreviewRef.current.url,
            dims: committedPreviewRef.current.dims,
            canvas,
            layout: committedPreviewRef.current.layout,
            timestamp: Date.now(),
          }
          setPreviewLoading(false)
          // ✅ 递增渲染版本，通知 PreviewCanvas 内容已更新（全局 Canvas 对象引用不变时需要此标记）
          setPreviewRenderVersion(v => v + 1)
        }
      } catch (e) {
        if (!renderCancelledRef.current && currentRenderId === previewVersionRef.current) {
          setPreviewCanvas(null)
          // ✅ 当前最新渲染失败 → 关闭 loading（旧 committed 帧仍在，无白板）
          setPreviewLoading(false)
        }
      } finally {
      }
    }
    const abortController = new AbortController()
    renderToCanvas(abortController.signal)
    return () => {
      renderCancelledRef.current = true
      abortController.abort()
      // ✅ Commit A：effect cleanup 时重置 renderKey，防止跨 effect 状态污染
      // （RND-1 设了 key=A；RND-3 因 unmount→remount 触发且 renderKey=A，因 last===current 被阻塞）
      lastRenderKeyRef.current = null

      // 清理 React DevTools 注入的 PerformanceMeasure，防止开发模式下内存无限累积
      if (typeof performance.clearMeasures === 'function') {
        performance.clearMeasures()
      }
      if (typeof performance.clearMarks === 'function') {
        performance.clearMarks()
      }
    }
  }, [previewFile, mergePair, settings.paperSize, currentRotation, fileRotations, settings.mergeMode,
      settings.marginLeft, settings.marginRight, settings.marginTop, settings.marginBottom,
      settings.customPaper?.widthMM, settings.customPaper?.heightMM, reBlockedDocId,
      renderCommand, renderCommandReady])

  // ResizeObserver ✅ 使用 requestAnimationFrame 节流，避免频繁重绘
  // 补充 window resize 监听：当浏览器窗口大小变化时，ResizeObserver
  // 可能因浏览器节流机制延迟触发。直接监听 window resize 确保及时响应。
  useEffect(() => {
    const el = previewContainerRef.current
    if (!el) return
    let ticking = false
    const update = () => {
      ticking = false
      // 测量 viewport 真正内容区（clientWidth 已含 padding，必须减掉，
      // 否则 paperDisplayRect 恒超尺寸 → 自适应模式恒弹出滚动条）
      const style = getComputedStyle(el)
      const padX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
      const padY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
      setContainerSize({ width: el.clientWidth - padX, height: el.clientHeight - padY })
    }
    const observer = new ResizeObserver(() => {
      if (!ticking) {
        requestAnimationFrame(update)
        ticking = true
      }
    })
    observer.observe(el)
    // 首次立即测量
    update()
    // 补充 window resize 监听，确保窗口大小变化时及时响应
    const handleWindowResize = () => {
      if (!ticking) {
        requestAnimationFrame(update)
        ticking = true
      }
    }
    window.addEventListener('resize', handleWindowResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleWindowResize)
    }
  }, [previewFile])

  // Display 计算
  // ✅ 直接使用 previewCanvas 显示，无需转换为 img
  // 移除了 Canvas → PNG → IMG 的转换步骤，减少内存开销和渲染延迟

  // ── ContentLayout：内容在 PaperLayout.contentRect 内的位置和缩放 + 纸张→窗口 zoom ──
  const computedContentLayout = useMemo(() => {
    const pl = paperLayout
    if (!pl || !pl.contentRect?.w) return emptyContentLayout()

    // ── 纸张→窗口缩放基线（ViewportTransform，Preview 职责，永不进 Factory）──
    // swap 由 Factory 统一推导（renderCommand.rotation），此处只用于「纸张容器尺寸」的视口计算，
    // 不再双算 placement（消除第二套算法 / F4）。
    const paperOrient = pl.paperRect.w > pl.paperRect.h ? 'landscape' : 'portrait'
    const docOrient = documentStateRef.current?.pageOrientation
    // 合并模式强制方向由 renderers 内部处理，此处回退旧 orientation 逻辑避免影响合并预览。
    const isMerge = isMergeMode(settings.mergeMode)
    // 🆕 V17：容器方向由 paperLandscape 决定（纸随内容），不再读 renderCommand.rotation
    // 🆕 合并模式：容器方向必须跟随「强制纸张方向」(merge2/3=竖向, merge4=横向)，
    //    不依赖 requestedPaperOrientation 状态（可能为单文件模式遗留的 landscape），否则 2/3 票被错误翻成横向。
    const mergeForcedLandscape = isMerge ? getForcedLandscape(settings.mergeMode, false) : false
    const swapped = (renderCommandReady && !isMerge)
      ? !!renderCommand.paperLandscape
      : isMerge
        ? mergeForcedLandscape
        : (!!docOrient && docOrient !== paperOrient)
    const effW = swapped ? pl.paperRect.h : pl.paperRect.w
    const effH = swapped ? pl.paperRect.w : pl.paperRect.h
    const SHADOW_PAD = 8  // 内容区内部额外阴影边距（CSS padding 通过 getComputedStyle 动态读取；mask-image 做边缘消融）
    let paperScaleBase = 1
    if (containerSize.width && containerSize.height) {
      // 纸张铺满 canvas-scroll 内容区，SHADOW_PAD 在净内容区内再留一圈阴影缓冲
      // 减 2px 安全缓冲，避免浮点/Math.round 误差导致纸张刚好贴边触发滚动条
      // 注意：.canvas-scroll 已设 scrollbar-gutter: stable，滚动条槽位始终预留，不会因滚动条出现/消失导致宽度振荡
      let availW = containerSize.width - SHADOW_PAD * 2 - 2
      let availH = containerSize.height - SHADOW_PAD * 2 - 2
      if (availW > 0 && availH > 0) {
        paperScaleBase = Math.min(availW / effW, availH / effH)
      }
    }
    // 自适应 = 基线；手动 = 基线 × zoomPercent/100
    const paperScale = zoomMode === 'adaptive' ? paperScaleBase : paperScaleBase * (zoomPercent / 100)

    const paperDisplayW = Math.round(effW * paperScale)
    const paperDisplayH = Math.round(effH * paperScale)

    let fitScale, imageRect
    if (renderCommandReady) {
      // ✅ Stage 1：placement 完全来自 Factory（buildRenderCommand）；预览不再自算 fit/居中。
      //   imageRect = 内容盒在 contentRect 内的投影（offset + pageSize×scale）。
      fitScale = renderCommand.placement.scale
      const docW = documentStateRef.current?.pageSize?.w || 0
      const docH = documentStateRef.current?.pageSize?.h || 0
      imageRect = {
        x: renderCommand.placement.offsetX,
        y: renderCommand.placement.offsetY,
        w: Math.round(docW * fitScale),
        h: Math.round(docH * fitScale),
      }
    } else {
      // 回退：documentState 未就绪时仍用旧 bitmap 拟合（行为不变，避免首帧/加载中白板）
      let srcW = 0, srcH = 0
      if (previewCanvas) {
        srcW = previewCanvas.width
        srcH = previewCanvas.height
      } else if (previewImgDims && previewImgDims.w > 0) {
        srcW = previewImgDims.w
        srcH = previewImgDims.h
      }
      if (!srcW || !srcH) return emptyContentLayout()
      const boundsW = pl.contentRect.w
      const boundsH = pl.contentRect.h
      fitScale = Math.min(boundsW / srcW, boundsH / srcH)
      imageRect = {
        x: Math.round((boundsW - srcW * fitScale) / 2),
        y: Math.round((boundsH - srcH * fitScale) / 2),
        w: Math.round(srcW * fitScale),
        h: Math.round(srcH * fitScale),
      }
    }
    // 🛡️ DEV 断言：自适应模式下 paperDisplayRect 不应超出 viewport 预留空间
    // 预留空间 = containerSize 内容区 - SHADOW_PAD*2（阴影预留）
    // paperDisplayW > 预留空间 → padding/阴影计算不一致 → 自适应模式弹出滚动条
    // 注意：manual 模式下用户主动放大导致超出是正常行为（应出现滚动条），不触发警告
    if (
      import.meta.env.DEV &&
      zoomMode === 'adaptive' &&
      containerSize.width > 0 &&
      paperDisplayW > containerSize.width - SHADOW_PAD * 2
    ) {
      console.warn(
        `[Viewport] paperDisplayRect.w (${paperDisplayW}) exceeds viewport reserved (${containerSize.width - SHADOW_PAD * 2})`,
        { effW, paperScale, containerSize, paperDisplayRect: { w: paperDisplayW, h: paperDisplayH } }
      )
    }

    return {
      ready: true,
      fitScale,
      imageRect,
      rotation: previewRotation || 0,
      paperDisplayScale: paperScale,
      paperDisplayRect: { w: paperDisplayW, h: paperDisplayH },
    }
  }, [previewCanvas, previewImgDims, previewRotation, containerSize, zoomMode, zoomPercent, paperLayout, renderCommand, settings.mergeMode])

  // 同步到 state，使外部可消费
  useEffect(() => { setContentLayout(computedContentLayout) }, [computedContentLayout])

  // 供 zoom 控件消费的 fitScale（来自 contentLayout，只有一条依赖链）
  useEffect(() => {
    if (computedContentLayout?.ready) {
      fitScaleRef.current = computedContentLayout.fitScale
      paperScaleRef.current = computedContentLayout.paperDisplayScale   // 🆕 供 wheel handler 读当前视口 scale
    }
  }, [computedContentLayout])

  // ── 自动居中滚动（内容溢出时初始视图居中）──
  useEffect(() => {
    const el = previewContainerRef.current
    if (!el || !computedContentLayout?.paperDisplayRect || !previewCanvas) return
    // 🆕 用户已接管 viewport（滚轮缩放）时不抢滚动位置；文件切换/适应窗口会释放锁
    if (userViewportLockRef.current) return
    // 用 rAF 确保 DOM 已完成布局
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2)
      el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2)
    })
  }, [previewCanvas, computedContentLayout, previewContainerRef])

  // ── 滚轮缩放监听（Ctrl/⌘ + wheel；非 passive 以便 preventDefault 阻止整页缩放）──
  useEffect(() => {
    const el = previewContainerRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheelZoom, { passive: false })
    return () => el.removeEventListener('wheel', handleWheelZoom)
  }, [handleWheelZoom])

  // ── 滚轮缩放：跟随光标锚点补偿（DOM 更新后、绘制前）──
  // newScale 来自更新后的 computedContentLayout.paperDisplayScale（即 ViewportTransform），
  // 与 oldScale 之比即内容缩放比，保持光标下内容点稳定。
  useLayoutEffect(() => {
    const a = wheelAnchorRef.current
    if (!a) return
    wheelAnchorRef.current = null
    const el = previewContainerRef.current
    if (!el) return
    const newScale = computedContentLayout?.paperDisplayScale || 1
    if (newScale === a.oldScale) return   // 夹取边界双保险（handler 已拦截）
    const ratio = newScale / a.oldScale
    el.scrollLeft = a.contentX * ratio - a.cx   // 浏览器自动 clamp 到 [0, max]
    el.scrollTop = a.contentY * ratio - a.cy
  }, [computedContentLayout])

  // ── 手型拖拽平移（Hand Tool）──
  // 点击按住可拖拽画布，类似图片浏览软件
  useEffect(() => {
    const el = previewContainerRef.current
    if (!el) return

    // 用普通变量记录拖拽状态，不触发 re-render
    let dragging = false
    let startX = 0, startY = 0
    let scrollStartX = 0, scrollStartY = 0

    const onMouseDown = (e) => {
      // 只响应左键
      if (e.button !== 0) return
      // 不干扰按钮、链接、输入框等交互元素
      if (e.target.closest('button, a, input, select, textarea, [role="button"]')) return
      // 不干扰缩放控件、状态指示器、导航箭头
      if (e.target.closest('.canvas-zoom-control, .status-indicator, .canvas-arrow')) return

      const canScrollX = el.scrollWidth > el.clientWidth
      const canScrollY = el.scrollHeight > el.clientHeight
      if (!canScrollX && !canScrollY) return

      dragging = true
      startX = e.clientX
      startY = e.clientY
      scrollStartX = el.scrollLeft
      scrollStartY = el.scrollTop
      el.classList.add('is-dragging')
      e.preventDefault()
    }

    const onMouseMove = (e) => {
      if (!dragging) return
      el.scrollLeft = scrollStartX - (e.clientX - startX)
      el.scrollTop = scrollStartY - (e.clientY - startY)
    }

    const stopDragging = () => {
      if (!dragging) return
      dragging = false
      el.classList.remove('is-dragging')
    }

    // mousedown 绑定在滚动容器上
    el.addEventListener('mousedown', onMouseDown)
    // mousemove/mouseup 绑定在 document 上，防止拖出容器后丢失事件
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', stopDragging)
    el.addEventListener('mouseleave', stopDragging)

    return () => {
      el.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', stopDragging)
      el.removeEventListener('mouseleave', stopDragging)
    }
  }, []) // 空依赖，挂载时执行一次

  /**
   * 加载单个文件的预览数据（统一处理图片/OFD/PDF）
   * @param {Object} fObj - 文件对象
   * @param {string} [currentKey] - 当前文件key（用于版本判断）
   * @param {string} [currentUrl] - 当前blob URL（用于复用）
   * @param {AbortSignal} [signal] - 中止信号，用于取消加载
   * @returns {Promise<Object>} 包含 _previewImageUrl 或 _pdfData 的文件对象
   */
  const loadFilePreview = useCallback(async (fObj, currentKey = null, currentUrl = null, signal = null) => {
    // ✅ 优先使用后端返回的格式
    let fmt = fObj.fileFormat
    
    // 如果没有，根据文件扩展名检测
    if (!fmt && fObj.name) {
      const ext = getExtension(fObj.name)
      const formatMap = {
        'pdf': 'pdf',
        'png': 'image',
        'jpg': 'image',
        'jpeg': 'image',
        'gif': 'image',
        'bmp': 'image',
        'ofd': 'ofd',
      }
      fmt = formatMap[ext] || getFileFormat(fObj.name)
    }
    
    let _previewImageUrl = null
    let _pdfData = null

    try {
      if (isImageLikeFormat(fmt)) {
        // ✅ Render Engine Preview：优先走后端渲染 URL
        if (USE_RENDER_ENGINE_PREVIEW && fObj.docId) {
          // 多页 PDF 拆页身份判定：
          //   解析前：docId === sourceDocId → 仍指向原 PDF 文档，用 pageNum 定位页码
          //   解析后：docId !== sourceDocId → 每页是独立单页文档，
          //     但后端仍以 sourceDocId 注册原始 PDF，因此必须用 sourceDocId + pageNum
          //   非拆页文件（无 sourceDocId）：用 docId
          const isParsedSplitPage = !!(fObj.sourceDocId && fObj.docId !== fObj.sourceDocId)
          const effectiveDocId = isParsedSplitPage ? fObj.sourceDocId : fObj.docId
          // [M1-c D20/C8 · frozen] fObj.pageNum 已是 1-based SOURCE evidence；
          // 1-based Source → 1-based render locator (?page=) 是 IDENTITY，禁止 +1。
          const pageForPreview = fObj.pageNum ?? 1
          _previewImageUrl = buildPreviewUrl(effectiveDocId, pageForPreview)
          // ── P1 frontend preview fix (rev: webp 实际像素为主源) ──
          // 旧实现以 /metadata（ofd_page_dimensions PhysicalBox 启发式）为主源、webp 实际
          // 像素仅作 fallback。但 OFD 渲染器（_OFDRenderer）会对页面施加 sourceRotation，
          // 而 ofd_page_dimensions 的 PhysicalBox 启发式不应用 sourceRotation → metadata
          // 报的是「源文件物理朝向」、webp 报的是「用户实际看到的朝向」。sourceRotation≠0
          // 的 OFD（典型：物理横放、视觉纵向发票）会被错报为横 → contentPx 取错方向 →
          // 打印预览纸面/fit 框选错 → 视觉上"没有 fit"。
          //
          // 与 image 那条逻辑保持一致：image/OFD 都以 webp 实际像素(fetchImageDims)为主源，
          // /metadata 退为 fallback（仅在 webp 加载失败时使用）。这样 image/OFD 共用同一条
          // 「以用户实际看到的像素为准」的尺寸契约，与 fileContentPx 的 px@dpi 空间一致。
          // pageForPreview 1-based → pages[] 0-based，勿盲取 pages[0] 造成多页尺寸错位。
          if (isImageLikeFormat(fmt)) {
            // 主源：fetchImageDims(webp 实际像素)
            let dimsResolved = false
            let dimsSource = 'none'
            try {
              const dims = await fetchImageDims(_previewImageUrl, fObj.key)
              if (dims && dims.w > 0 && dims.h > 0) {
                fObj._imageWidth = dims.w
                fObj._imageHeight = dims.h
                dimsResolved = true
                dimsSource = 'fetchImageDims(webp)'
              }
            } catch (_) { /* webp 加载失败，降级到 metadata */ }
            // fallback：/metadata（ofd_page_dimensions / 图片 PIL 像素）
            if (!dimsResolved) {
              try {
                const { fetchDocumentMetadata } = await import('../services/renderDocument.js')
                const meta = await fetchDocumentMetadata(effectiveDocId)
                const pageDims = meta?.pages?.[pageForPreview - 1]
                if (pageDims && pageDims.width > 0 && pageDims.height > 0) {
                  fObj._imageWidth = pageDims.width
                  fObj._imageHeight = pageDims.height
                  dimsSource = 'metadata-fallback'
                }
              } catch (_) {
                // metadata 失败降级：尺寸保持 0，行为与修复前一致，不抛出
              }
            }
          }
          const __out = { ...fObj, _previewImageUrl, _fileFormat: fmt }
          return __out
        }

        // 复用已加载的 blob URL
        if (fObj.key === currentKey && currentUrl) {
          _previewImageUrl = currentUrl
        }
        // 从 file 对象加载（仅图片）
        else if (fmt === 'image' && fObj.file) {
          _previewImageUrl = URL.createObjectURL(fObj.file)
          pendingBlobUrlsRef.current.push(_previewImageUrl)
        }
        // 从文件系统加载（仅图片）
        else if (fmt === 'image' && electronAPIRef.current?.ipcRenderer && fObj.printPath) {
          const fd = await electronAPIRef.current.ipcRenderer.invoke('read-file', fObj.printPath)
          if (signal?.aborted) return fObj
          if (fd.success) {
            const blob = new Blob([fd.data])
            _previewImageUrl = URL.createObjectURL(blob)
            pendingBlobUrlsRef.current.push(_previewImageUrl)
          }
        }
        // OFD 兜底：从 previewImage base64 生成 blob URL（无 docId 的旧 session）
        else if (fmt === 'ofd' && fObj.previewImage) {
          try {
            const byteChars = atob(fObj.previewImage)
            const byteNumbers = new Array(byteChars.length)
            for (let i = 0; i < byteChars.length; i++) {
              byteNumbers[i] = byteChars.charCodeAt(i)
            }
            const byteArray = new Uint8Array(byteNumbers)
            const blob = new Blob([byteArray], { type: 'image/webp' })
            _previewImageUrl = URL.createObjectURL(blob)
            pendingBlobUrlsRef.current.push(_previewImageUrl)
          } catch (_) { /* base64 解码失败则 _previewImageUrl 保持 null */ }
        }

        // 提取图片/OFD 尺寸用于方向检测（复用 fetchImageDims）
        if (_previewImageUrl && !fObj._imageWidth && !fObj.previewWidth) {
          const dims = await fetchImageDims(_previewImageUrl, fObj.key)
          if (dims) {
            fObj._imageWidth = dims.w
            fObj._imageHeight = dims.h
          }
        }

        // 2026-08-20 Fix: 如果 blob URL 提取尺寸失败且有 docId，
        // 尝试从后端 /metadata/{doc_id} 获取图片真实尺寸（render_engine 注册表已注册图片）。
        // 这确保即使 fetchImageDims 因浏览器限制失败，尺寸仍可通过后端 metadata 获取。
        if (!fObj._imageWidth && !fObj.previewWidth && fObj.docId) {
          try {
            const metaResp = await fetch(`${BACKEND_URL}/metadata/${encodeURIComponent(fObj.docId)}`, { signal })
            if (metaResp.ok) {
              const meta = await metaResp.json()
              if (meta.success && meta.pages && meta.pages.length > 0) {
                const p = meta.pages[0]
                if (p.width > 0 && p.height > 0) {
                  fObj._imageWidth = p.width
                  fObj._imageHeight = p.height
                }
              }
            }
          } catch (_) { /* metadata 获取失败静默降级 */ }
        }

        const __out2 = { ...fObj, _previewImageUrl, _fileFormat: fmt }
        return __out2
      }

      if (fmt === 'pdf') {
        // ✅ Render Engine Preview：优先走后端渲染 URL，绕过 pdfjs + Canvas
        if (USE_RENDER_ENGINE_PREVIEW && fObj.docId) {
          // 多页 PDF 拆页身份判定：
          //   解析前：docId === sourceDocId → 仍指向原 PDF 文档，用 pageNum 定位页码
          //   解析后：docId !== sourceDocId → 每页是独立单页文档，
          //     但后端仍以 sourceDocId 注册原始 PDF，因此必须用 sourceDocId + pageNum
          //   非拆页文件（无 sourceDocId）：用 docId
          const isParsedSplitPage = !!(fObj.sourceDocId && fObj.docId !== fObj.sourceDocId)
          const effectiveDocId = isParsedSplitPage ? fObj.sourceDocId : fObj.docId
          // [M1-c D20/C8 · frozen] fObj.pageNum 已是 1-based SOURCE evidence；
          // 1-based Source → 1-based render locator (?page=) 是 IDENTITY，禁止 +1。
          const pageForPreview = fObj.pageNum ?? 1
          _previewImageUrl = buildPreviewUrl(effectiveDocId, pageForPreview)
          // 从后端 metadata 获取页面尺寸用于 DocumentState（确定性高，不依赖图片加载）
          if (!fObj._pdfPageWidth && !fObj._imageWidth) {
            try {
              const metaResp = await fetch(`${BACKEND_URL}/metadata/${effectiveDocId}`, { signal })
              if (metaResp.ok) {
                const meta = await metaResp.json()
                if (meta.success && meta.page_width > 0) {
                  // metadata 返回 points (1/72 inch) + page_rotation；应用 /Rotate 得到显示方向
                  const rot = meta.page_rotation || 0
                  fObj._pdfPageWidth = (rot % 180 === 0) ? meta.page_width : meta.page_height
                  fObj._pdfPageHeight = (rot % 180 === 0) ? meta.page_height : meta.page_width
                }
              }
            } catch (_) { /* metadata 不可用，回退 image load */ }
            // 如果 metadata 失败，回退到图片提取
            if (!fObj._pdfPageWidth) {
              const dims = await fetchImageDims(_previewImageUrl, fObj.key)
              if (dims) {
                fObj._imageWidth = dims.w
                fObj._imageHeight = dims.h
              }
            }
          }
          // 设置 _pdfPageCount：优先用行对象的 _pageCount（invoiceDocumentToRow 生成），
          // 回退用 InvoiceDocument 的 pageCount。这确保多页文档预览时页码导航正确。
          const pageCount = fObj._pageCount || fObj.pageCount || 1
          return { ...fObj, _previewImageUrl, _fileFormat: 'pdf', _pdfPageCount: pageCount }
        }

        let buffer = null
        // ✅ 尝试从缓存取 Uint8Array（_pdfData），避免重复 IPC read-file + pdfjs 解析
        const pdfKey = 'pdf_' + fObj.key
        const cachedPdfData = lruGet(previewLoadCacheRef.current, pdfKey)
        if (cachedPdfData) {
          _pdfData = cachedPdfData
        } else {
          if (fObj.file) {
            buffer = await fObj.file.arrayBuffer()
            if (signal?.aborted) return fObj
          } else if (electronAPIRef.current?.ipcRenderer && fObj.printPath) {
            const fd = await electronAPIRef.current.ipcRenderer.invoke('read-file', fObj.printPath)
            if (signal?.aborted) return fObj
            if (fd.success) {
              // fd.data 是 Node Buffer/Uint8Array（Electron IPC 自动序列化）。
              // 不能直接用 fd.data.buffer 拿底层 ArrayBuffer（Node 内部可能共用大块内存池，
              // 返回的 ArrayBuffer 远超实际数据，含垃圾字节 → PDF 尺寸解析错误 → 方向检测失败）。
              // 先复制到新 Uint8Array，再取 .buffer 得到精确尺寸的 ArrayBuffer。
              const clean = new Uint8Array(fd.data)
              buffer = clean.buffer
            }
          }
          if (buffer) {
            _pdfData = new Uint8Array(buffer)
            lruSet(previewLoadCacheRef.current, pdfKey, _pdfData)
          }
        }
        if (_pdfData) {
          // 提取第一页尺寸用于方向检测（带缓存）
          const dimsKey = 'pdfDims_' + fObj.key
          const cachedDims = lruGet(previewLoadCacheRef.current, dimsKey)
          if (cachedDims) {
            fObj._pdfPageWidth = cachedDims.w
            fObj._pdfPageHeight = cachedDims.h
          } else {
            // ✅ 使用 renderers 的 getOrLoadPdfDocument（共享 pdfDocCache），
            //    避免每次预览都独立打开 PDF 文档仅获取尺寸
            try {
              const { getOrLoadPdfDocument: sharedLoadPdf } = await getRenderers()
              if (signal?.aborted) return fObj
              const pdfDoc = await sharedLoadPdf(_pdfData)
              if (signal?.aborted) return fObj
              const page = await pdfDoc.getPage(1)
              try {
                if (signal?.aborted) return fObj
                const vp = page.getViewport({ scale: 1 })
                fObj._pdfPageWidth = vp.width
                fObj._pdfPageHeight = vp.height
                // ✅ 不调用 pdfDoc.destroy() — pdfDocCache 管理生命周期，
                //    后续 renderers 中的渲染可直接复用同一份文档
                lruSet(previewLoadCacheRef.current, dimsKey, { w: vp.width, h: vp.height })
              } finally {
                // ✅ 释放 PageProxy 资源（getPage 建立了页面级缓存）
                try { page.cleanup() } catch (_) { /* ignore */ }
              }
            } catch (pdfErr) {
              // PDF 尺寸提取失败不影响预览，仅方向检测 fallback 到 portrait
            }
          }
        }
        return { ...fObj, _pdfData, _fileFormat: 'pdf' }
      }
    } catch (e) {
      console.warn('[loadFilePreview] 预览加载失败:', fObj.key, e)
    }

    return fObj
  }, [electronAPIRef])

  // ============================
  // 加载配对文件（合并模式共用）
  // ============================
  const loadPairItemForPreview = useCallback(async (fObj, currentKey, currentUrl) => {
    if (fObj.key === currentKey && currentUrl) {
      return { ...fObj, _previewImageUrl: currentUrl, _fileFormat: 'image' }
    }
    return await loadFilePreview(fObj)
  }, [loadFilePreview])

  // ============================
  // 实际预览加载逻辑（防抖分离）
  // ============================
  const doLoadPreview = useCallback(async (fileObj, intent = 'select', source = 'unknown') => {
    lastSwitchTimeRef.current = Date.now()
    if (switchTimeoutRef.current) {
      clearTimeout(switchTimeoutRef.current)
      switchTimeoutRef.current = null
    }
    // P2-X2：任何实际执行（immediate / timer fire / restart 递归）统一在此清 pending 意图
    pendingDebounceRef.current = null

    const key = fileObj?.key

    // ── Preview Scheduler 决策（Contract v2 §5）──
    const decision = resolvePreviewTransition(
      previewTransactionRef.current,
      previewVersionRef.current,
      { intent, key, snapshot: fileObj },
    )

    // R2-2 探针：调度器每次决策（含被忽略/失效的调用）
    if (previewTrace.on) {
      previewTrace.state('SCHED_DECISION', {
        source, intent, key,
        action: decision.action,
        version: decision.version ?? null,
      }, `doLoadPreview:${source}`)
    }

    if (decision.action === 'ignore') {
      if (previewTrace.on) previewTrace.state('IGNORED', { key, intent, source }, 'scheduler:ignore')
      // stale refresh：不得 resurrect 旧 selection（INV-PS2）
      return null
    }

    if (decision.action === 'invalidate') {
      if (previewTrace.on) previewTrace.state('INVALIDATED', { key, intent, source }, 'scheduler:invalidate')
      // 防御：正常由 clearCommitted 处理（V-3）
      previewTransactionRef.current = null
      previewExecutionRef.current = null
      return null
    }

    // 统一确定 version 与 execution（select 与 idle-refresh 共用后续 load 流程）
    let version
    if (decision.action === 'merge') {
      // refresh 匹配：更新 transaction.snapshot，再决定 execution 如何消费
      previewTransactionRef.current = decision.transaction
      const execAction = resolveRefreshExecution(
        decision.transaction, previewExecutionRef.current, { key, snapshot: fileObj },
      )
      if (execAction !== 'start-execution') {
        if (previewTrace.on) previewTrace.state('MERGE_DEFERRED', { key, execAction, version: decision.version }, 'scheduler:refresh-exec')
        // update-snapshot / restart-required / ignore：
        // 在途 execution 会在它的 boundary（advanceLoadingStep / resolveBoundary）
        // 检测 consumingSnapshot 变化并自行 restart（INV-PS10）。
        return null
      }
      // idle refresh：启动唯一新 execution（INV-PS9），不 ++version，复用 load 流程
      version = decision.version
      previewExecutionRef.current = {
        id: ++executionIdRef.current, key, version,
        phase: 'loading', consumingSnapshot: decision.transaction.snapshot,
      }
    } else {
      // select：新 selection，++version（已由 resolvePreviewTransition 完成）
      version = decision.version
      previewVersionRef.current = version
      previewTransactionRef.current = decision.transaction
      previewExecutionRef.current = {
        id: ++executionIdRef.current, key, version,
        phase: 'loading', consumingSnapshot: fileObj,
      }
    }

    // R2-2 探针：正式 START（已确定 version / execution）
    if (previewTrace.on) {
      previewTrace.state('START', {
        source, intent, key, version,
        docId: previewTrace.docId(fileObj),
        ...previewTrace.flags(fileObj),
      }, `doLoadPreview:${source}`)
    }

    // ✅ 预览生命周期 token：用于追踪竞争条件
    const previewToken = `PRV-${Date.now()}-${version}`
    flowTokenRef.current = previewToken
    userViewportLockRef.current = false   // 🆕 新文档加载 = 释放 viewport 接管，恢复框架自动居中

    // ✅ 保存旧的 blob URL，在新预览加载完成后再清理
    const oldBlobUrls = [...pendingBlobUrlsRef.current]
    const oldPreviewUrl = previewUrlRef.current

    // ── 合并模式预览 ──
    if (isMergeMode(settings.mergeMode)) {
      const groupSize = parseInt(settings.mergeMode?.replace('merge', '')) || 2
      const pair = getMergePair(filesRef.current, fileObj.key, groupSize, fileIndexMapRef.current)
      if (pair && pair.length >= 1) {
        const loaded = await Promise.all(
          pair.map((item, idx) =>
            loadPairItemForPreview(item, idx === 0 ? fileObj.key : null, idx === 0 ? null : null)
          )
        )
        const validLoaded = loaded.filter(Boolean)
        // ✅ 检查版本号，确保只处理最新请求
        if (validLoaded.length > 0 && version === previewVersionRef.current) {
          if (previewTrace.on) previewTrace.state('COMMIT_MERGE', { key, version, size: validLoaded.length }, 'commit:merge')
          // 保留用户点击意图：优先用用户点击的文件作为 primary，
          // 若该文件加载失败则 fallback 到 pair[0]
          const primary = validLoaded.find(item => item.key === fileObj.key) || validLoaded[0]
          previewFileRef.current = primary
          setMergePair(validLoaded)
          setPreviewFile(primary)
          setPreviewPage(1)
          setNumPages(1)
        } else if (version !== previewVersionRef.current) {
        }
        // merge mode 分支一次性 load+commit，不走 loading loop；完成后清 execution 避免残留
        previewExecutionRef.current = null
        return
      }
    }

    // ── 单文件预览 ──
    // 先加载文件数据（含方向检测所需的页面尺寸），再用"当前"布局参数生成缓存 key。
    // key 必须包含所有影响 Canvas 的布局参数，且读写两侧用同一份 settings（settingsRef.current），
    // 否则命中陈旧缓存 + skipRenderRef 跳过纠正渲染 → 显示错误预览（正确性 Bug）。

    // ── Loading loop（Contract v2 §1.5，Direction Y）──
    // consumingSnapshot 是唯一 freshness 基准。每轮 load execution.consumingSnapshot，
    // 用 advanceLoadingStep 统一 ownership + freshness 判定，消除 shouldReload 双轨。
    const MAX_LOAD_ITERATIONS = 5
    let loadedFile = null
    let execution = previewExecutionRef.current
    for (let iter = 0; iter < MAX_LOAD_ITERATIONS; iter++) {
      if (!execution) {
        return
      }

      // R2-3 探针：loadFilePreview 进出（空壳判据在此捕获——永不返回 null 的兜底也在内）
      if (previewTrace.on) {
        previewTrace.state('LOAD_START', {
          iter, key: execution.key, version: execution.version,
          docId: previewTrace.docId(execution.consumingSnapshot),
        }, 'loadFilePreview')
      }
      loadedFile = await loadFilePreview(execution.consumingSnapshot)
      if (previewTrace.on) {
        previewTrace.state('LOAD_RETURN', {
          iter, key: loadedFile?.key ?? null, version: execution.version,
          docId: previewTrace.docId(loadedFile),
          ...previewTrace.flags(loadedFile),
        }, 'loadFilePreview')
      }

      const step = advanceLoadingStep(previewTransactionRef.current, execution)
      execution = step.execution
      previewExecutionRef.current = execution
      if (step.action === 'terminate') {
        if (previewTrace.on) previewTrace.state('TERMINATED', { iter, key, version }, 'loading-loop:terminate')
        return
      }
      if (step.action === 'post-load') {
        break
      }
      // next-iteration：snapshot 晋升，consumingSnapshot 已更新，继续下一轮
    }

    // 保险丝：持续晋升仍不稳定 / 被终止 → 禁止 commit（INV-PS6）
    if (!execution || execution.phase !== 'post-load') {
      if (previewTrace.on) previewTrace.state('FUSE_BLOCK', { key, version, phase: execution?.phase ?? null }, 'commit-fuse:INV-PS6')
      // P2-X1（2026-09-04）：禁止 commit 即 execution 使命终结 → 终态化（Contract §1.4 terminate）。
      // 否则残留非 post-load execution 会让后续 refresh 撞 restart-required → MERGE_DEFERRED 扑空
      // （R2 dump seq 45/49/65/69/73：带 docId 的 refresh 五次被僵尸 execution 吃掉）。
      previewExecutionRef.current = null
      return
    }

    // 保险丝 2（P2-X3，2026-09-04）：displayability gate——phase/freshness 已过（post-load 且
    // consumingSnapshot 新鲜），但快照不可展示 → 仍禁止 commit。
    // 依据：dump seq 43 v6 半壳（docId=null + pdfData=true）COMMIT_SUCCESS → DisplayAdapter 按
    // docId 哈希 miss → 展示空白固化。loadedFile 即本 execution 即将 commit 的 snapshot
    // （loading loop 产物，COMMIT_SUCCESS/CACHE 均消费同一对象）。
    // 出口复用 X1 既有终态机制（execution=null + return），不另设第二套。纯图像/OFD 走
    // _previewImageUrl（非 pdf-backed）→ 不依赖 docId，不被误拦。
    if (!isDisplayablePreview(loadedFile)) {
      if (previewTrace.on) previewTrace.state('FUSE_BLOCK', { key, version, phase: execution?.phase ?? null, why: 'not-displayable' }, 'commit-fuse:P2-X3')
      previewExecutionRef.current = null
      return
    }

    let rotation = (fileRotationsRef.current[loadedFile.key] || 0)
    // 与 render effect 保持一致的 orientationMismatch 计算：统一走 resolvePaper（Single Decision Point）。
    // 否则 Custom 纸型下 PAPER_SIZE_MAP 与 resolvePaper 结果不一致 → L2 缓存键与渲染键漂移 →
    // 点击命中陈旧 Canvas，与自动预览（RE）视觉不一致。
    const contentOrient = detectDocumentOrientation(loadedFile) // 仍用于 documentState.pageOrientation 派生（L1628），非 orientation-mismatch 决策
    const paper = resolvePaper(settingsRef.current.paperSize, settingsRef.current.customPaper)
    const paperOrient = paper.widthMM > paper.heightMM ? 'landscape' : 'portrait'
    // Gate 2 (PreviewGeometryBuilder)：orientation-mismatch 决策统一委托 Policy，
    // 不再手算 contentOrient !== paperOrient（消除第二套算法）。值等价，缓存键不变。
    // 2026-08-20 Fix: 对 0 尺寸做防御——当 extractContentPx 返回 0/无效尺寸时，
    // 用 A4 默认尺寸（595x842 pt @ 72dpi）安全降级，避免 PrintAutoRotationPolicy 抛错。
    const rawContentGeom = extractContentPx(loadedFile)
    const safeGeom = (rawContentGeom.widthPx > 0 && rawContentGeom.heightPx > 0)
      ? rawContentGeom
      : { widthPx: 595, heightPx: 842 }  // A4 默认
    if (rawContentGeom.widthPx <= 0 || rawContentGeom.heightPx <= 0) {

    }
    const previewGeometry = buildPreviewGeometry({
      rawDocumentGeometry: safeGeom,
      requestedPaperGeometry: { orientation: paperOrient },
      userRotation: { degrees: rotation },
    })
    const orientationMismatch = previewGeometry.orientationMismatch

    // ── PaperLayout 现在由 useMemo 纯派生（settings → computePaperLayout），此处不再重复 ──
    // PaperLayout 仅依赖 PaperSpec，与当前文档无关；文件切换不改变 PaperLayout
    // （满足验收：切换文件 / 导入新文件 不重生 PaperLayout）。

    // DocumentState（文档属性，与纸张无关）— swap 仅用于缓存 key，不污染 PaperLayout
    const docW = loadedFile._pdfPageWidth || loadedFile._imageWidth || 0
    const docH = loadedFile._pdfPageHeight || loadedFile._imageHeight || 0
    // getDocNaturalOrientation 对空/零尺寸返回 null（拒绝数学偶然）；null 时回落 contentOrient/portrait
    const naturalOrientation = (docW > 0 && docH > 0) ? getDocNaturalOrientation({ w: docW, h: docH }) : null

    // ── Commit C：按 doc_id 加载方向 Fact ──
    // 4.1.5：读取优先用 Document 身份 docId（内容哈希，稳定）；迁移期回退旧 path/key 落盘键（只读不写旧键）。
    // 🔧 2026-08-09 产品决策：旋转/纸张方向不跨重启保留——主进程启动清空 DocFacts.json，
    //    本读取/写回仅服务**会话内**（切换文件恢复 + L2 缓存键一致）；重启后持久层为空 → auto 推导。
    const docId = loadedFile.identity?.docId || loadedFile.docId || ''
    const factCandidates = [docId, loadedFile.path, loadedFile.key].filter(Boolean)
    let loadedFacts = null
    try {
      const api = electronAPIRef.current
      if (api && api.loadDocFacts) {
        for (const ck of factCandidates) {
          const rec = await api.loadDocFacts(ck)
          if (rec) { loadedFacts = rec; break }
        }
      }
    } catch (_) { /* 无持久层（Web 模式）退化为 natural 推导 */ }
    // Contract v2：loadDocFacts await 后 resolveBoundary（ownership + freshness，W2）
    {
      const b = resolveBoundary(previewTransactionRef.current, execution)
      if (b === 'abort') {
        if (previewTrace.on) previewTrace.state('ABORTED', { key, version, at: 'after-loadDocFacts' }, 'resolveBoundary')
        return
      }
      if (b === 'restart') {
        previewExecutionRef.current = null
        if (previewTrace.on) previewTrace.state('RESTART', { key, version, at: 'after-loadDocFacts' }, 'resolveBoundary')
        return doLoadPreview(previewTransactionRef.current.snapshot, 'refresh', 'restart-after-loadDocFacts')
      }
    }
    const init = computeInitialDocFacts(loadedFacts, naturalOrientation)
    // 🔧 P0 修复：内存优先。fileRotations 是会话内旋转权威（用户本会话操作过即生效），
    //    持久层 DocFacts 仅用于「内存无该 file.key 记录」时的会话内恢复。
    //    旧逻辑无条件用 init.contentRotation 覆盖内存 → 旋转后切文件再切回，若 saveDocFacts
    //    异步未完成/失败（P2），loadDocFacts 读到旧值 → 旋转丢失（验收场景失败）。
    const memoryRotation = fileRotationsRef.current[loadedFile.key]
    const effectiveRotation = memoryRotation != null ? memoryRotation : init.contentRotation
    // 恢复 contentRotation 到实时镜象（fileRotations），保证 previewRotation / L2 / full cache 一致
    setFileRotations(prev => ({ ...prev, [loadedFile.key]: effectiveRotation }))
    rotation = effectiveRotation // 修正上方 rotation（cacheKey 用）
    applyRequestedPaperOrientation(init.requestedPaperOrientation, init.isAuto)
    if (init.shouldPersist) {
      // Contract v2：saveDocFacts 副作用前 resolveBoundary（W3）
      {
        const b = resolveBoundary(previewTransactionRef.current, execution)
        if (b === 'abort') {
          if (previewTrace.on) previewTrace.state('ABORTED', { key, version, at: 'before-saveDocFacts' }, 'resolveBoundary')
          return
        }
        if (b === 'restart') {
          previewExecutionRef.current = null
          if (previewTrace.on) previewTrace.state('RESTART', { key, version, at: 'before-saveDocFacts' }, 'resolveBoundary')
          return doLoadPreview(previewTransactionRef.current.snapshot, 'refresh', 'restart-before-saveDocFacts')
        }
      }
      try {
        const api = electronAPIRef.current
        // 写入严格用 docId（不回退 path/key），无 docId 时跳过落盘。
        // 🔧 P0 配套：写 effectiveRotation（内存优先值）。若用户已旋转（内存=90）但持久层
        //    无记录（保存失败），此处把内存状态固化，避免把 90 冲成 init 推导的 0。
        if (docId && api && api.saveDocFacts) await api.saveDocFacts(docId, { requestedPaperOrientation: init.requestedPaperOrientation, contentRotation: effectiveRotation })
      } catch (_) { /* 忽略落盘失败，不影响预览 */ }
      // Contract v2：saveDocFacts await 后 resolveBoundary（W3）
      {
        const b = resolveBoundary(previewTransactionRef.current, execution)
        if (b === 'abort') {
          if (previewTrace.on) previewTrace.state('ABORTED', { key, version, at: 'after-saveDocFacts' }, 'resolveBoundary')
          return
        }
        if (b === 'restart') {
          previewExecutionRef.current = null
          if (previewTrace.on) previewTrace.state('RESTART', { key, version, at: 'after-saveDocFacts' }, 'resolveBoundary')
          return doLoadPreview(previewTransactionRef.current.snapshot, 'refresh', 'restart-after-saveDocFacts')
        }
      }
    }

    const docOrientation = naturalOrientation || contentOrient || 'portrait'
    documentStateRef.current = {
      // Stage4.1.4：DocumentState 身份源从 UI key 切换到 Document docId。
      // 优先 identity.docId（4.1.3 注入）；兼容旧数据回退 docId；永不使用 key。
      id: loadedFile.identity?.docId || loadedFile.docId || '',
      pageCount: loadedFile._pdfPageCount || 1,
      pageSize: { w: docW, h: docH },
      pageOrientation: docOrientation,
      // 【Page Placement Pipeline Fact】纸张方向：加载时确定。
      // 持久层（会话内）有记录则以记录为准；无记录时以文档天然方向初始化。
      // 🔧 2026-08-09：不跨重启保留（主进程启动清空 DocFacts.json），重启后回 auto。
      requestedPaperOrientation: init.requestedPaperOrientation,
      // 🔧 P0 修复：用 effectiveRotation（内存优先）而非 init.contentRotation。
      //    documentStateRef 是 L2 缓存命中路径 buildRenderCommand 的直接输入（无 previewRotation
      //    显式覆盖），若仍写 init 值，旋转后切回文件 L2 spec 用陈旧角度。
      contentRotation: effectiveRotation, // Legacy 迁移：旧 fileRotations 作为 contentRotation 来源
      rotation: effectiveRotation, // [LEGACY 镜像] = contentRotation
      sourceType: loadedFile._fileFormat || 'pdf',
      // [M1-c D20/C8 · frozen] pageNum 是 1-based SOURCE evidence
      //   (app.py split_pdf emit / fileHelpers.buildFileObj)。1-based Source →
      //   1-based render locator 是 IDENTITY，不需要 ±1。禁止再补 +1。
      //    不要在消费者代码里检查 pageNum 真假值——改用 src/layout/docFacts.js 的
      //    shouldAppendPageSuffix(doc)（检查 pageCount>1）。
      pageNum: loadedFile.pageNum ?? 1,
    }
    // 🔴 V17 不变式：缓存身份必须包含每一个影响 RenderCommand 的 Fact。
    //    paperLandscape 由 PaperOrientation Fact 驱动绘制（renderCommand.paperLandscape），
    //    但旧缓存键只用 orientationMismatch（内容 vs 纸张）→ 强制方向后键不变、canvas 变 → 命中错误快照。
    //    此处用与渲染路径完全一致的 buildRenderCommand 派生 paperLandscape，喂给缓存键；
    //    同时复用同一 l2Command 构造 L2 命中的 RE URL（contentRotation 以 documentStateRef.current 为真值，不覆盖）。
    let paperLandscape = false
    let l2Command = null
    if (paperLayout) {
      l2Command = buildRenderCommand(paperLayout, documentStateRef.current)
      paperLandscape = !!l2Command.paperLandscape
    }
    const cacheKey = buildPreviewCacheKey(
      { fileKey: loadedFile.key, rotation },
      {
        paperSize: settingsRef.current.paperSize,
        orientationMismatch,
        // 🔴 V17 不变式：paperLandscape 必须进缓存身份（见上方说明）
        paperLandscape,
        mergeMode: settingsRef.current.mergeMode,
        customPaper: settingsRef.current.customPaper,
        margins: {
          left: settingsRef.current.marginLeft, right: settingsRef.current.marginRight,
          top: settingsRef.current.marginTop, bottom: settingsRef.current.marginBottom,
        },
      }
    )
    // INV-PS11：commit 前 freshness 闸门（consumingSnapshot === transaction.snapshot）
    {
      const b = resolveBoundary(previewTransactionRef.current, execution)
      if (b === 'abort') {
        if (previewTrace.on) previewTrace.state('ABORTED', { key, version, at: 'before-commit' }, 'resolveBoundary')
        return
      }
      if (b === 'restart') {
        previewExecutionRef.current = null
        if (previewTrace.on) previewTrace.state('RESTART', { key, version, at: 'before-commit' }, 'resolveBoundary')
        return doLoadPreview(previewTransactionRef.current.snapshot, 'refresh', 'restart-before-commit')
      }
    }

    const cachedCanvas = fullCacheRef.current.get(cacheKey)
    if (cachedCanvas) {
      // R2-3 探针：L2 全缓存命中 commit（空壳判据同样适用）
      if (previewTrace.on) {
        previewTrace.state('COMMIT_CACHE', {
          key: loadedFile?.key ?? null, version,
          docId: previewTrace.docId(loadedFile),
          ...previewTrace.flags(loadedFile),
        }, 'commit:full-cache')
      }
      // 直接设置缓存画布，跳过整个异步渲染管线
      skipRenderRef.current = true
      previewFileRef.current = loadedFile
      setMergePair(null)
      // P4：记录 commit 对应的 execution.version（clearCommitted 清理权判定依据）
      committedPreviewVersionRef.current = previewExecutionRef.current?.version ?? version
      setPreviewFile(loadedFile)
      // ✅ 跳过 render effect（skipRenderRef=true）时，L323 不会执行，
      //    lastRenderKeyRef 残留旧值，后续切换到新文件时可能被 L322 误拦。
      //    清空它以允许新文件的 render effect 正常进入渲染管线。
      lastRenderKeyRef.current = ''
      setPreviewPage(1)
      setNumPages(loadedFile._fileFormat === 'pdf' ? 0 : 1)
          setPreviewCanvas(cachedCanvas)
          // ✅ Stage 0.8：缓存命中 = 立即提交，同步 committed + 关闭 loading
          setPreviewLoading(false)
          committedPreviewRef.current = {
            url: committedPreviewRef.current.url,
            dims: committedPreviewRef.current.dims,
            canvas: cachedCanvas,
            layout: committedPreviewRef.current.layout,
            timestamp: Date.now(),
          }
          // ✅ cachedCanvas 分支会让渲染 effect 在 L290 提前 return（skipRenderRef），
      // ✅ 修复（B-2.2 调查）：L2 命中也必须按当前文件正确旋转构造 RE URL。
      //    原写法不传 spec → URL 无 ?rotation= → 后端按 rotation=0 出图 → 横向内容落竖纸错位。
      //    此处复用与主渲染路径完全一致的纯函数派生：documentStateRef.current 此时已是 loadedFile 的
      //    DS（L1197 写入），buildRenderCommand 内部由 pageOrientation 推导 rotation，故 rotation=90 进 URL。
      let l2Spec = null
      // ✅ 修复（B-2.2 调查定案，2026-07-13）：L2 HIT 在 doLoadPreview 同步阶段执行，
      //    此时 renderCommandReady（依赖 previewFile state 的 useMemo）仍是上一帧陈旧值=false，
      //    用它会把本应重建的 l2Spec 门控跳过 → URL 裸奔 → 后端 rotation=0 → 横向内容落竖纸错位。
      //    改用同步可用且与 renderCommand memo 输入一致的 paperLayout / documentStateRef.current 直接重建，
      //    不依赖尚未提交的 useMemo。这正是 V16「renderCommand 实时派生、不缓存」的设计意图。
      if (l2Command) {
        try {
          const isParsedSplitPage = !!(loadedFile.sourceDocId && loadedFile.docId !== loadedFile.sourceDocId)
          const effectiveDocId = isParsedSplitPage ? loadedFile.sourceDocId : loadedFile.docId
          const pageForPreview = (loadedFile.pageNum ?? 0) + 1
          l2Spec = buildRenderSpec(l2Command, {
            docId: effectiveDocId,
            page: pageForPreview,
            dpi: PREVIEW_DPI,
            marginsMm: {
              top: settingsRef.current.marginTop, right: settingsRef.current.marginRight,
              bottom: settingsRef.current.marginBottom, left: settingsRef.current.marginLeft,
            },
          })
        } catch (e) {
          l2Spec = null
        }
      }
      const l2Url = getRenderEnginePreviewUrl(loadedFile, USE_RENDER_ENGINE_PREVIEW, l2Spec)
      setPreviewUrl(l2Url)
      if (loadedFile._previewImageUrl) {
        previewUrlRef.current = loadedFile._previewImageUrl
      }
      // 清理旧 blob URL
      oldBlobUrls.forEach(url => { try { URL.revokeObjectURL(url) } catch (e) {} })
      pendingBlobUrlsRef.current = pendingBlobUrlsRef.current.filter(
        url => !oldBlobUrls.includes(url)
      )
      if (oldPreviewUrl && oldPreviewUrl !== previewUrlRef.current) {
        try { URL.revokeObjectURL(oldPreviewUrl) } catch (e) {}
      }
      // P2-X1（2026-09-04）：L2 全缓存 commit 完成 → execution 终态化（Contract §1.4 commit → terminated）。
      // P4 记账（committedPreviewVersionRef / committedPreviewRef）均已在上方完成，此处置 null 不改变提交顺序。
      // 模板 = merge 分支（L1715）既有清理；若残留 post-load，后续 refresh 会撞 MERGE_DEFERRED 死锁。
      previewExecutionRef.current = null
      return
    }

    // ── 正常预览加载（全缓存未命中） ──
    // R2-3 探针：commit 尝试（含版本守卫读数——supersede 雪崩的直接证据位）
    if (previewTrace.on) {
      previewTrace.state('COMMIT_ATTEMPT', {
        key: loadedFile?.key ?? null, version, currentVersion: previewVersionRef.current,
        docId: previewTrace.docId(loadedFile),
        ...previewTrace.flags(loadedFile),
      }, 'commit:normal')
    }
    if (version === previewVersionRef.current) {
      previewFileRef.current = loadedFile
      setMergePair(null)
      // P4：记录 commit 对应的 execution.version（clearCommitted 清理权判定依据）
      committedPreviewVersionRef.current = previewExecutionRef.current?.version ?? version
      setPreviewFile(loadedFile)
      if (previewTrace.on) {
        previewTrace.state('COMMIT_SUCCESS', {
          key: loadedFile.key, version,
          docId: previewTrace.docId(loadedFile),
          ...previewTrace.flags(loadedFile),
        }, 'commit:normal')
      }
      setPreviewPage(1)
      setNumPages(loadedFile._fileFormat === 'pdf' ? 0 : 1)

      if (loadedFile._previewImageUrl) {
        previewUrlRef.current = loadedFile._previewImageUrl
      }
      // P2-X1（2026-09-04）：commit 成功 → execution 终态化（Contract §1.4 commit → terminated）。
      // P4 记账（committedPreviewVersionRef）已在上方完成；必须放块内——块外是 superseded 路径，
      // 届时 previewExecutionRef.current 已指向新 execution，块外清理会误杀新在途 execution。
      // 残留 post-load 是 R2 dump 僵尸根因（v6 半壳 commit 后 refresh 五次撞 MERGE_DEFERRED）。
      previewExecutionRef.current = null
    }

    // R2-3 探针：版本已过期 → loaded 但不 commit（superseded）
    if (previewTrace.on && version !== previewVersionRef.current) {
      previewTrace.state('COMMIT_SKIPPED_VERSION', {
        key: loadedFile?.key ?? null, version, currentVersion: previewVersionRef.current,
      }, 'commit:normal')
    }

    // ✅ 新预览加载完成后清理旧的 blob URL
    if (version === previewVersionRef.current) {
      oldBlobUrls.forEach(url => {
        try {
          URL.revokeObjectURL(url)
        } catch (e) { /* ignore already revoked */ }
      })
      pendingBlobUrlsRef.current = pendingBlobUrlsRef.current.filter(
        url => !oldBlobUrls.includes(url)
      )
      if (oldPreviewUrl && oldPreviewUrl !== previewUrlRef.current) {
        try {
          URL.revokeObjectURL(oldPreviewUrl)
        } catch (e) { /* ignore already revoked */ }
      }
    }
  }, [settings.mergeMode, loadPairItemForPreview, loadFilePreview, fullCacheRef, skipRenderRef, previewFileRef, previewVersionRef, previewUrlRef, pendingBlobUrlsRef, paperLayout])

  // ============================
  // 预览文件（带防抖）
  // ============================
  const handlePreview = useCallback(async (fileObj, intent = 'select') => {
    perfProbe.count('handlePreview')   // PERF-WHITE-1：含自动预览 effect 的重复触发
    // ── 防抖层：让 UI 指示器即时响应，渲染逻辑延迟 150ms ──
    const now = Date.now()

    // R2-1 探针：入口计数 + 来源归因（skip=1 → App 自动预览 effect / FileList 点击）
    if (previewTrace.on) {
      previewTrace.log('HANDLE_PREVIEW', {
        intent,
        key: fileObj?.key ?? null,
        docId: previewTrace.docId(fileObj),
        version: previewVersionRef.current,
      }, { skip: 1 })
    }

    // 1. 立即更新 UI 指示器（文件列表高亮等），不触发 render effect
    setSelectedFileKey(fileObj.key || fileObj.id)

    // 2. 快速连击 → 延迟执行，只保留最后一次
    if (now - lastSwitchTimeRef.current < 150) {
      // R2-2 探针：防抖分支（饥饿观察——连续 <150ms 调用会不断重排此定时器）
      if (previewTrace.on) {
        previewTrace.state('DEBOUNCED', {
          key: fileObj?.key ?? null,
          intent,
          sinceLastSwitchMs: now - lastSwitchTimeRef.current,
          hadPendingTimer: !!switchTimeoutRef.current,
        }, 'handlePreview:debounce')
      }
      // P2-X2（2026-09-04）：意图仲裁——pending select 不得被同 key refresh 降级
      // （R2 dump seq 55-63：docId-ready select 进 debounce 后被 auto-nav-3 refresh 无脑顶掉）。
      // resolveDebouncePrecedence 只决 intent/key；payload 恒取最新 incoming fileObj；
      // select(++version)/refresh(merge) 的调度语义不变——仲裁只决定到期后以哪个 intent 进 doLoadPreview。
      const effective = resolveDebouncePrecedence(pendingDebounceRef.current, {
        intent,
        key: fileObj?.key ?? fileObj?.id ?? null,
      })
      pendingDebounceRef.current = effective
      // 清掉上次未执行的定时器
      if (switchTimeoutRef.current) {
        clearTimeout(switchTimeoutRef.current)
      }
      // 重新设定时器，到期后直接调用加载逻辑（不再递归 handlePreview）
      // timeout 闭包必须捕获仲裁后的 intent（Contract §1 + P2-X2：防抖不得丢失 select 意图）
      return new Promise(resolve => {
          switchTimeoutRef.current = setTimeout(async () => {
          switchTimeoutRef.current = null
          const result = await doLoadPreview(fileObj, effective.intent, 'handlePreview:timeout')
          resolve(result)
        }, 150)
      })
    }
    lastSwitchTimeRef.current = now

    // 3. 间隔足够，立即执行
    return doLoadPreview(fileObj, intent, 'handlePreview:immediate')
  }, [doLoadPreview])

  // ============================
  // Hover 预加载（已禁用）
  // ============================
  // Legacy no-op (Step 12.3)：全局 Canvas + RE <img> 路径切换零开销，无需预渲染。
  // 保留函数签名因为 App.jsx 仍作为 handleHoverFile 传入 FileList。
  // 当确认 FileList 不再消费此 prop 时可连同 App 解构一并移除。
  const preloadHD = useCallback(async () => {}, [])

  // ✅ 保存 handlePreview 最新引用，避免 useEffect 闭包陷阱
  useEffect(() => {
    handlePreviewRef.current = handlePreview
  }, [handlePreview])

  // ✅ 当 mergeMode 变化时，自动重新预览当前文件（Contract §1：refresh，保持 selection）
  useEffect(() => {
    if (previewFile && handlePreviewRef.current) {
      handlePreviewRef.current(previewFile, 'refresh')
    }
  }, [settings.mergeMode])

  // 文件列表键字符串（仅含 key，不含 status — 避免解析状态变更误触发 effect）
  const filesKeyStr = useMemo(() => {
    return files.map(f => f.key).join(',')
  }, [files])
  const filesKeySet = useMemo(() => {
    return new Set(files.map(f => f.key))
  }, [files])

  // ✅ 用 ref 跟踪上一次的 filesKeyStr，仅在文件增删时触发合并更新（status 变化不再冒泡）
  const prevFilesKeyStrRef = useRef('')

  // ============================
  // 文件列表变化时重新触发合并预览
  // ============================
  useEffect(() => {
    const filesChanged = prevFilesKeyStrRef.current !== filesKeyStr
    prevFilesKeyStrRef.current = filesKeyStr

    // ✅ 导入文件后自动预览第一个文件（纯逻辑，不关心状态）
    if (!previewFile && files.length > 0) {
      // R2-1 探针：来源 = usePreview 内置「无预览 → files[0]」分支
      if (previewTrace.on) {
        previewTrace.state('AUTO_PREVIEW', {
          branch: 'usePreview:no-preview-first', filesLen: files.length,
          firstKey: files[0]?.key ?? null,
        }, 'usePreview:files-effect')
      }
      handlePreviewRef.current?.(files[0])
      return
    }

    if (!previewFile) return

    // 当前预览的文件已不存在，切换到第一个
    if (!filesKeySet.has(previewFile.key)) {
      // ✅ App 删除文件后已直接调用 handlePreview，跳过此处的自动导航
      if (skipAutoNavRef.current) {
        skipAutoNavRef.current = false
        return
      }
      if (files.length) {
        setTimeout(() => {
          cleanupAllBlobUrls()
        }, 0)
        handlePreviewRef.current(files[0])
      } else {
        previewFileRef.current = null
        setPreviewFile(null)
        setMergePair(null)
        setPreviewCanvas(null)
      }
      return
    }

    // ✅ 合并模式下，仅当文件列表实际变化时重新计算 mergePair
    //    新导入的文件可能属于当前合并组，需要实时更新预览（Contract §1：refresh，保持 selection）
    //    注意：不能在 mergeMode 变化时触发（已有单独的 useEffect 处理）
    if (filesChanged && isMergeMode(settings.mergeMode)) {
      handlePreviewRef.current?.(previewFile, 'refresh')
    }
  }, [filesKeyStr, filesKeySet, previewFile, files, cleanupAllBlobUrls])

  // ── docId 异步就绪 → 重预览（修复「自动预览 vs 点击同文件」视觉不一致）──
  // 根因：自动预览在 files.length 增加时触发，此时预览文件还是解析中占位（docId=null），
  //       loadFilePreview 无 RE URL → 走 pdf.js Canvas；点击同文件时 docId 已就绪 → 走 RE <img>。
  //       两个后端（Canvas 按纸张 fit vs RE 默认 A4）渲染结果差异巨大（字体/缩放/边距都不同），
  //       且原代码没有任何 effect 监听 docId 变化 → 自动预览永远停留在 Canvas，直到点击才切 RE。
  // 修复：监听当前预览文件在 files 中的实时 docId，一旦就绪（且与原 previewFile.docId 不同）
  //       重走 doLoadPreview，统一到 RE 路径，使自动预览与点击渲染一致。
  //
  // V2 FIX: 增加 null → value 跃迁检测。场景：
  //   - 预览在 placeholder 阶段触发（docId='')
  //   - 解析完成后 docId 被回填（物理 docId 或业务 invDocId）
  //   - 原代码 `live.docId && live.docId !== pf.docId` 在 live.docId 非空但与 pf.docId
  //     不同时才触发；pf.docId 初始为 null/'' 时此条件成立，但如果 live.docId 恰为 falsy
  //     值会漏过。显式检查 `!pf.docId` 或 `live.docId !== pf.docId` 更稳健。
  const livePreviewDocId = useMemo(
    () => files.find(f => f.key === previewFile?.key)?.docId ?? null,
    [files, previewFile?.key]
  )
  useEffect(() => {
    const pf = previewFileRef.current
    if (!pf) {
      // R2-4 探针：docId 重试被跳过——previewFile 为 null（自动预览从未 commit 的凝固证据）
      if (previewTrace.on) {
        previewTrace.state('DOCID_RETRY_SKIP', {
          reason: 'no-previewFile', filesLen: filesRef.current.length,
        }, 'usePreview:docId-retry')
      }
      return
    }
    const live = filesRef.current.find(f => f.key === pf.key)
    if (!live) {
      if (previewTrace.on) previewTrace.state('DOCID_RETRY_SKIP', { reason: 'live-not-found', pfKey: pf.key }, 'usePreview:docid-retry')
      return
    }
    // 触发条件：docId 从 null/undefined/'' 跃迁到非空，或两个不同的非空 docId 之间切换
    const changed = live.docId !== pf.docId
    if (previewTrace.on) {
      previewTrace.state('DOCID_RETRY_EVAL', {
        pfKey: pf.key, pfDocId: pf.docId ?? null, liveDocId: live.docId ?? null, changed,
      }, 'usePreview:docid-retry')
    }
    if (changed) {
      // Contract §1：docId 晋升 = refresh（同 key snapshot 更新，不 supersede）
      handlePreviewRef.current?.(live, 'refresh')
    }
  }, [livePreviewDocId])

  // ── 文件列表变化 → 自动切换预览（纯逻辑，不关心文件状态）──
  // 职责：当文件列表变化时，确保预览目标跟随文件列表。
  //   - 文件被删除 → 切到第一个文件
  //   - 新增文件 + 无预览 → 预览第一个文件
  //   - 文件对象被替换（同一 key 新引用）→ 重新预览
  // 不处理：文件渲染、状态判定、合并逻辑（由其他 effect 负责）。
  //
  // 设计原则：自动预览不应该被文件状态（解析失败/重复报销/往年发票等）影响。
  // 它只负责「跟随文件列表」的切换，具体渲染由下游渲染引擎决定。
  //
  // 背景：原逻辑按 parsed 状态过滤，导致「解析失败文件阻断自动切换」的问题。
  //       多页文件导入时占位符先被添加，解析完成后对象引用被替换；此 effect 负责
  //       捕获引用替换事件，重新预览已就绪的对象。
  const allFileKeys = useMemo(() => {
    return files.map(f => f.key).join(',')
  }, [files])
  const prevAllKeysRef = useRef('')
  // 追踪 files 引用的变化，用于检测结构性变更（如 groupFilesByDocument → invoiceDocumentsToRows）
  const prevFilesRef = useRef([])
  useEffect(() => {
    const filesRefChanged = prevFilesRef.current !== files
    prevFilesRef.current = files

    if (prevAllKeysRef.current === allFileKeys && !filesRefChanged) return
    prevAllKeysRef.current = allFileKeys

    if (files.length === 0) return

    const pf = previewFileRef.current
    const pfKey = pf?.key
    const live = pfKey ? filesRef.current.find(f => f.key === pfKey) : null
    const pfChanged = live && live !== pf  // 引用替换场景

    // 1. 当前预览文件已不存在 → 切到第一个文件
    if (pfKey && !live) {
      if (previewTrace.on) {
        previewTrace.state('AUTO_PREVIEW', { branch: 'usePreview:auto-nav-1-gone', pfKey }, 'usePreview:files-change')
      }
      handlePreviewRef.current?.(files[0])
      return
    }

    // 2. 当前无预览 → 预览第一个文件
    if (!pf) {
      if (previewTrace.on) {
        previewTrace.state('AUTO_PREVIEW', { branch: 'usePreview:auto-nav-2-none', filesLen: files.length }, 'usePreview:files-change')
      }
      handlePreviewRef.current?.(files[0])
      return
    }

    // 3. 预览文件对象被替换（同一 key，新引用）→ 重新预览
    //    典型场景：占位符 → 解析完成，groupFilesByDocument → invoiceDocumentsToRows
    //    Contract §1：引用替换 = refresh（同 key snapshot 更新，不 supersede）
    if (pfChanged) {
      if (previewTrace.on) {
        previewTrace.state('AUTO_PREVIEW', { branch: 'usePreview:auto-nav-3-replaced', pfKey }, 'usePreview:files-change')
      }
      handlePreviewRef.current?.(live, 'refresh')
      return
    }
  }, [allFileKeys, files])

  // ── Canvas 导航箭头 ──
  const handleCanvasMouseMove = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    setShowLeftArrow(x < 120)
    setShowRightArrow(x > rect.width - 120)
  }, [])

  const handleCanvasMouseLeave = useCallback(() => {
    setShowLeftArrow(false)
    setShowRightArrow(false)
  }, [])

  const handlePrevFile = useCallback(() => {
    const currentKey = previewFileRef.current?.key
    if (!currentKey || filesRef.current.length <= 1) return

    if (isMergeMode(settings.mergeMode)) {
      const groupSize = parseInt(settings.mergeMode?.replace('merge', '')) || 2
      const pair = getMergePair(filesRef.current, currentKey, groupSize, fileIndexMapRef.current)

      if (pair && pair.length > 0) {
        const idx = fileIndexMapRef.current.get(pair[0].key) ?? -1
        const prevIdx = idx - groupSize
        if (prevIdx >= 0) handlePreview(filesRef.current[prevIdx])
        return
      }
    }

    const idx = fileIndexMapRef.current.get(currentKey) ?? -1
    if (idx > 0) handlePreview(filesRef.current[idx - 1])
  }, [settings.mergeMode, handlePreview])

  const handleNextFile = useCallback(() => {
    const currentKey = previewFileRef.current?.key
    if (!currentKey || filesRef.current.length <= 1) return

    if (isMergeMode(settings.mergeMode)) {
      const groupSize = parseInt(settings.mergeMode?.replace('merge', '')) || 2
      const pair = getMergePair(filesRef.current, currentKey, groupSize, fileIndexMapRef.current)

      if (pair && pair.length > 0) {
        const idx = fileIndexMapRef.current.get(pair[0].key) ?? -1
        const nextIdx = idx + groupSize
        if (nextIdx < filesRef.current.length) handlePreview(filesRef.current[nextIdx])
        return
      }
    }

    const idx = fileIndexMapRef.current.get(currentKey) ?? -1
    if (idx < filesRef.current.length - 1) handlePreview(filesRef.current[idx + 1])
  }, [settings.mergeMode, handlePreview])

  const onDocumentLoadSuccess = useCallback(({ numPages }) => setNumPages(numPages), [])

  // ── 组件卸载清理 ──
  useEffect(() => {
    return () => {
      cleanupAllBlobUrls()
      // ✅ 清理 preview 数据缓存（释放 Blob / Uint8Array 引用）
      previewLoadCacheRef.current.clear()
      // ✅ 清理 fullCache（释放 canvas 内存）
      for (const canvas of fullCacheRef.current.values()) {
        if (canvas instanceof HTMLCanvasElement) { canvas.width = 0; canvas.height = 0 }
      }
      fullCacheRef.current.clear()
      // ✅ 取消进行中的预加载
      if (currentPreloadRef.current) {
        currentPreloadRef.current.abort()
        currentPreloadRef.current = null
      }
      // ✅ 清理 zoom menu 关闭动画的 timeout
      if (zoomMenuCloseTimeoutRef.current) {
        clearTimeout(zoomMenuCloseTimeoutRef.current)
        zoomMenuCloseTimeoutRef.current = null
      }
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = null
      }
      if (unrotatedCanvasRef.current) {
        // ✅ 只置空引用，不清空 canvas 内容（与缓存共享同一对象）
        unrotatedCanvasRef.current = null
      }
      setPreviewCanvas(null)
      // ✅ 清理切换防抖定时器
      if (switchTimeoutRef.current) {
        clearTimeout(switchTimeoutRef.current)
        switchTimeoutRef.current = null
      }
      // P2-X2：与 timer 同生命周期清理，避免 stale pending 把 cleanup 后的普通 refresh 误升格为 select
      pendingDebounceRef.current = null
    }
  }, [cleanupAllBlobUrls])

  return {
    /**
     * 预览状态
     */
    state: {
      previewFile,
      selectedFileKey,
      mergePair,
      numPages,
      previewPage,
      previewCanvas,
      previewUrl,
      previewRenderVersion,
      containerSize,
      previewImgDims,
      previewLoading,
      previewRotation,
      requestedPaperOrientation,
      autoActive,
      fileRotations,
      showLeftArrow,
      showRightArrow,
      // V16 Preview State Model
      documentState: documentStateRef.current,
      paperLayout,
      contentLayout,
      renderState,
    },

    /**
     * 预览操作
     */
    actions: {
      handlePreview,
      preloadHD,
      handleRotate,
      handlePaperOrientationChange,
      prevPage,
      nextPage,
      handlePrevFile,
      handleNextFile,
      cleanupPreviewUrl,
      clearFilePreviewCache,
      clearAllPreviewCache,
    },

    /**
     * 缩放状态
     * ── Legacy only (Step 12.3) ──────────────────────────────────
     * 仅服务 PreviewCanvas 路径（image/OFD/merge）。
     * PDF 正常路径使用 useViewerState + ZoomToolbar（D2-4），不消费此组。
     * 当 image/OFD 迁移到后端渲染后可移除。
     */
    zoom: {
      percent: zoomPercent,
      mode: zoomMode,
      menuOpen: zoomMenuOpen,
      menuClosing: zoomMenuClosing,
      zoomIn,
      zoomOut,
      setAdaptive,
      setManualScale,
      handleCloseZoomMenu,
    },

    /**
     * Refs（供组件引用）
     */
    refs: {
      previewCanvasRef,
      previewContainerRef,
      previewUrlRef,
      unrotatedCanvasRef,
      zoomDropdownRef,
      previewVersionRef,
      zoomModeRef,
      fitScaleRef,
    },

    /**
     * 内部状态设置器（谨慎使用）
     */
    internal: {
      setPreviewFile,
      setSelectedFileKey,
      setMergePair,
      setNumPages,
      setPreviewPage,
      setPreviewCanvas,
      setFileRotations,
      setZoomPercent,
      setZoomMode,
      setZoomMenuOpen,
      onDocumentLoadSuccess,
      handleCanvasMouseMove,
      handleCanvasMouseLeave,
      skipAutoNavRef,
    },
  }
}
