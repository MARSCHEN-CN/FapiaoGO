import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { PREVIEW_DPI, GLOBAL_PREVIEW_DPI, ZOOM_STEPS, USE_RENDER_ENGINE_PREVIEW, buildPreviewUrl, BACKEND_URL } from '../config'
import {
  b64toBlob, getFileFormat, getExtension, isMergeMode, getMergePair,
} from '../utils'
import { detectDocumentOrientation } from '../utils/detectOrientation'
import { getForcedLandscape } from '../utils/mergeMode'
import { buildPreviewCacheKey } from '../utils/previewCacheKey'
import { getRenderEnginePreviewUrl } from '../utils/previewTarget'
import { emptyContentLayout, initialRenderState, computePaperLayout } from '../previewState'
import { buildRenderLayout } from '../layout/RenderLayoutFactory.js'
import { buildRenderSpec, RENDER_SPEC_VERSION, renderSpecSignature } from '../layout/renderSpec.js'
import { resolvePaper, paperKeyFragment } from '../layout/resolvePaper.js'

// ✅ 懒加载 PDF 渲染模块，避免首屏加载 1.4 MB 的 pdfjs-dist + react-pdf
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
  const [showLeftArrow, setShowLeftArrow] = useState(false)
  const [showRightArrow, setShowRightArrow] = useState(false)

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
  const renderVersionRef = useRef(0)  // 专供 render effect 使用，与 handlePreview 隔离
  const previewContainerRef = useRef(null)
  const unrotatedCanvasRef = useRef(null)
  const lastRenderKeyRef = useRef('')
  const isRenderingRef = useRef(false)
  const zoomModeRef = useRef('adaptive')
  const fitScaleRef = useRef(1)
  const zoomDropdownRef = useRef(null)
  const pendingBlobUrlsRef = useRef([])
  const lastFilesKeyRef = useRef('')
  const renderCancelledRef = useRef(false)
  // ✅ <img> 尺寸探测：防止过期回调覆盖（仅最新 token 可提交）
  const imgLoadTokenRef = useRef(0)
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
  const clearCommitted = useCallback(() => {
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
  //    若后端未按 spec.rotation 出图，此处仍会触发，作为 Stage 1（RE 消费 RenderLayout）的契约守卫。
  useEffect(() => {
    if (!previewImgDims || previewImgDims.w <= 0 || previewImgDims.h <= 0) return
    const pl = paperLayout
    if (!pl || !pl.paperRect?.w) return
    // 🆕 V17：图像方向应与「有效纸张方向(paperLandscape)」一致（纸随内容）。
    // 旧逻辑比的是 paperRect 固定方向，在 paperLandscape 模型下恒错，已改为比 paperLandscape。
    const paperLandscape = renderLayout?.paperLandscape
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
      id: loadedFile.key || loadedFile.id || '',
      pageCount: loadedFile._pdfPageCount || 1,
      pageSize: { w: pageW, h: pageH },
      pageOrientation: pageW > pageH ? 'landscape' : 'portrait',
      sourceType: loadedFile._fileFormat || 'pdf',
      pageNum: loadedFile.pageNum || 1,
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

  // ── 旋转 ──
  // ✅ 只更新 fileRotations，移除对 previewRotation 的更新
  const handleRotate = useCallback((targetKey) => {
    const key = targetKey || previewFileRef.current?.key
    if (!key) return
    setFileRotations(prev => ({
      ...prev,
      [key]: ((prev[key] || 0) + 90) % 360
    }))
  }, [])

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
    setZoomPercent(prev => {
      if (zoomModeRef.current === 'adaptive') {
        // 新语义：100% = fit（与 adaptive 一致），故 adaptive→manual 锚点固定为 100，而非 fitScale*100
        return ZOOM_STEPS.find(s => s > 100) || ZOOM_STEPS[ZOOM_STEPS.length - 1]
      }
      return ZOOM_STEPS.find(s => s > prev) || ZOOM_STEPS[ZOOM_STEPS.length - 1]
    })
  }, [])

  const zoomOut = useCallback(() => {
    setZoomMode('manual')
    setZoomPercent(prev => {
      if (zoomModeRef.current === 'adaptive') {
        // 同上：锚点为 100（fit），先取第一个小于 100 的步进（如 75%）
        return [...ZOOM_STEPS].reverse().find(s => s < 100) || ZOOM_STEPS[0]
      }
      return [...ZOOM_STEPS].reverse().find(s => s < prev) || ZOOM_STEPS[0]
    })
  }, [])

  const setAdaptive = useCallback(() => { setZoomMode('adaptive') }, [])
  const setManualScale = useCallback((pct) => { setZoomMode('manual'); setZoomPercent(pct) }, [])

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
  // RenderLayout 唯一派生点（F3/F5）—— 上移到首个消费它的 effect 之前
  // 原位置在 contentLayout memo 之前，但其 useMemo 在首次渲染时被 line 380 的预览渲染
  // effect 依赖数组提前求值，触发 "Cannot access 'renderLayout' before initialization"
  // （TDZ）。移到此处后，所有消费方（含 preview 渲染 effect）都能拿到已初始化的 const。
  // ✅ previewRotation 必须在 contentLayout memo 之前声明（useMemo 首次渲染立即执行，不能闭包捕获尚未初始化的 const）
  const previewRotation = fileRotations[previewFile?.key] || 0

  // ── Stage 1：RenderLayout 唯一派生点（F3/F5）──
  // Preview 消费其 placement/rotation/clip，不再自算 fit/scale/swap（消除第二套算法）。
  // 输入 documentState 合并 previewRotation（documentStateRef 不含 rotation 字段）；
  // 依赖 paperLayout(纸张/边距派生，useMemo) + previewRotation(旋转) + previewFile(切文件→documentState 重建)。
  // paperLayout 在 Render 阶段随 settings 同步派生 → margin 修改当帧即生效，无 effect 滞后。
  const renderLayout = useMemo(
    () => {
      return buildRenderLayout(paperLayout, { ...(documentStateRef.current || {}), rotation: previewRotation })
    },
    [paperLayout, previewRotation, previewFile]
  )
  // renderLayout 就绪（placement.scale>0）才用 Factory 派生；否则回退旧 bitmap 拟合，行为不变。
  const renderLayoutReady = !!(renderLayout && renderLayout.placement && renderLayout.placement.scale > 0)

  // ============================
  // 预览渲染
  // ============================
  useEffect(() => {
    if (!previewFile) { clearCommitted(); return }

    // NOTE: Render dispatch must always execute before any cache bypass.
    //       Cache may provide render results, but must not choose the renderer.
    //       skipRenderRef only skips the Canvas pipeline; it does not skip
    //       the render strategy decision. (V6 — Engineering Discipline Law #8)
    // ── Render Dispatcher：独立于 L2 缓存，始终评估 RE 可用性 ──
    const previewSpec = renderLayoutReady
      ? buildRenderSpec(renderLayout, {
          docId: previewFile.docId,
          page: previewPage,
          dpi: PREVIEW_DPI,
          marginsMm: { top: settings.marginTop, right: settings.marginRight, bottom: settings.marginBottom, left: settings.marginLeft },
        })
      : null
    const reUrl = getRenderEnginePreviewUrl(previewFile, USE_RENDER_ENGINE_PREVIEW, previewSpec)

    // ✅ L2 缓存旁路：有缓存 Canvas 时跳过 Canvas 渲染，但不阻止 Render Dispatcher 决策
    if (skipRenderRef.current) {
      skipRenderRef.current = false
      if (reUrl) { setPreviewUrl(reUrl) }  // RE 可用 → 优先使用（不受缓存影响）
      return  // 不执行 Canvas 渲染（缓存内容已就绪或 RE 已设）
    }

    const isImageOrOfd =
      previewFile._fileFormat === 'image' || previewFile._fileFormat === 'ofd'

    const hasRenderEngineUrl = !!reUrl
    if (!isImageOrOfd && !previewFile._pdfData && !mergePair && !hasRenderEngineUrl) {
      clearCommitted(); return
    }
    if (isImageOrOfd && !previewFile._previewImageUrl && !hasRenderEngineUrl) {
      clearCommitted(); return
    }

    const { paperSize } = settings
    // isLandscape = paperShouldShowAsLandscape
    // 规则：纸张与内容方向不同时才 swap（让内容能铺满）
    //   横向内容+横向纸 → isLandscape=false（纸保持横向，内容不旋转直接铺）
    //   竖向内容+横向纸 → isLandscape=true （纸 swap 成竖向，内容旋转 90° 铺）
    const contentOrient = detectDocumentOrientation(previewFile)
    const paper = resolvePaper(paperSize, settings.customPaper)
    const paperOrient = paper.widthMM > paper.heightMM ? 'landscape' : 'portrait'
    const isLandscape = contentOrient !== paperOrient
    // ✅ renderKey 必须包含合并模式、合并组所有文件的旋转值，以确保模式切换和多文件旋转都能触发重渲染
    const mergeRotations = mergePair?.map(m => `${m?.key}:${fileRotations[m?.key] || 0}`).join(',') || ''
    const paperFrag = paperKeyFragment(paper)
    const renderKey = `${previewFile.key}-${paperSize}-${isLandscape}-${currentRotation}-${settings.mergeMode || ''}-${mergePair?.map(m => m?.key).join(',') || ''}-${mergeRotations}-m${settings.marginLeft}_${settings.marginRight}_${settings.marginTop}_${settings.marginBottom}-${paperFrag}-re${reBlockedDocId || ''}`
    if (lastRenderKeyRef.current === renderKey) { return }
    lastRenderKeyRef.current = renderKey

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
    const startREProbe = (probeUrl, fileObj) => {
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
        if (token !== imgLoadTokenRef.current) return
        if (typeof probe.decode === 'function') {
          probe.decode().then(commit).catch(commit)
        } else {
          commit()
        }
      }
      probe.onerror = () => {
        if (token !== imgLoadTokenRef.current) return
        setPreviewLoading(false)
        recoverREPreview(fileObj, probeUrl, token)
      }
      probe.src = probeUrl
    }
    const recoverREPreview = async (fileObj, probeUrl, token) => {
      if (token !== imgLoadTokenRef.current) return
      // 1. 探测失败原因：DOC_NOT_REGISTERED（可恢复）还是已注册但渲染错误（不可恢复）
      let reason = 'unknown'
      try {
        const metaResp = await fetch(`${BACKEND_URL}/metadata/${fileObj.docId}`, { mode: 'cors' })
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
          startREProbe(probeUrl, fileObj)  // 重试（新 token）
          return
        }
      }
      // 3. 容灾：标记 RE 不可用 → 落入下方 canvas 渲染，保证预览不中断
      setReBlockedDocId(fileObj.docId)
    }
    if (hasRenderEngineUrl && reBlockedDocId !== previewFile.docId) {
      const url = reUrl
      renderEngineUrlRef.current = url
      // ✅ Stage 0.8 Commit Buffer（修正版）：以 committedPreviewRef.current.url 判断是否需重新探测，
      //    保留上一帧直到 decode 完成才原子 commit（消灭 A→null→B 白板）。
      if (committedPreviewRef.current.url !== url) {
        startREProbe(url, previewFile)
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
        let canvas
        const isMerge = isMergeMode(settings.mergeMode) && mergePair?.some(Boolean)

        if (isMerge || isImageOrOfd || previewFile._pdfData) {
          const { renderMultipleItemsToCanvas } = await getRenderers()

          if (isMerge) {
            // ✅ 合并模式强制方向（merge2/3=竖向, merge4=横向），纸张用用户设置
            const forcedLandscape = getForcedLandscape(settings.mergeMode, isLandscape)
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
              { strategy: mergeLayoutStrategy, gridCols: 2, gridRows: 2, userMargins, customPaper: settings.customPaper }
            )
          } else {
            // ✅ 单文件：统一使用全局 Canvas（PDF / 图片 / OFD 都走此路径）
            const { getGlobalPreviewCanvas, switchPreviewFile, switchPreviewImage, getOrLoadPdfDocument } = await getRenderers()
            // 🆕 V17：canvas 回退按 paperLandscape 绘制（内容自然、横纸），与 RE 对齐
            const effectiveLandscape = renderLayout?.paperLandscape ?? isLandscape
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
              // PDF：通过 pdfDocCache 加载 + page.render
              const pdfDoc = await getOrLoadPdfDocument(previewFile._pdfData)
              if (pdfDoc) {
                await switchPreviewFile(pdfDoc, 1, signal, currentRotation)
              }
            } else if (previewFile._previewImageUrl) {
              // 图片/OFD：加载图片后 drawImage 到全局 Canvas
              const img = await new Promise((resolve) => {
                const image = new Image()
                image.onload = () => resolve(image)
                image.onerror = () => resolve(null)
                image.src = previewFile._previewImageUrl
              })
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
              isLandscape,
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
        console.error('Canvas 渲染失败:', e)
        if (!renderCancelledRef.current && currentRenderId === previewVersionRef.current) {
          setPreviewCanvas(null)
          // ✅ 当前最新渲染失败 → 关闭 loading（旧 committed 帧仍在，无白板）
          setPreviewLoading(false)
        }
      }
    }
    const abortController = new AbortController()
    renderToCanvas(abortController.signal)
    return () => {
      renderCancelledRef.current = true
      abortController.abort()

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
      renderLayout, renderLayoutReady])

  // ResizeObserver ✅ 使用 requestAnimationFrame 节流，避免频繁重绘
  useEffect(() => {
    const el = previewContainerRef.current
    if (!el) return
    let ticking = false
    const update = () => {
      ticking = false
      setContainerSize({ width: el.clientWidth, height: el.clientHeight })
    }
    const observer = new ResizeObserver(() => {
      if (!ticking) {
        requestAnimationFrame(update)
        ticking = true
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [previewFile])

  // Display 计算
  // ✅ 直接使用 previewCanvas 显示，无需转换为 img
  // 移除了 Canvas → PNG → IMG 的转换步骤，减少内存开销和渲染延迟

  // ── ContentLayout：内容在 PaperLayout.contentRect 内的位置和缩放 + 纸张→窗口 zoom ──
  const computedContentLayout = useMemo(() => {
    const pl = paperLayout
    if (!pl || !pl.contentRect?.w) return emptyContentLayout()

    // ── 纸张→窗口缩放基线（ViewportTransform，Preview 职责，永不进 Factory）──
    // swap 由 Factory 统一推导（renderLayout.rotation），此处只用于「纸张容器尺寸」的视口计算，
    // 不再双算 placement（消除第二套算法 / F4）。
    const paperOrient = pl.paperRect.w > pl.paperRect.h ? 'landscape' : 'portrait'
    const docOrient = documentStateRef.current?.pageOrientation
    // 合并模式强制方向由 renderers 内部处理，此处回退旧 orientation 逻辑避免影响合并预览。
    const isMerge = isMergeMode(settings.mergeMode)
    // 🆕 V17：容器方向由 paperLandscape 决定（纸随内容），不再读 renderLayout.rotation
    const swapped = (renderLayoutReady && !isMerge)
      ? !!renderLayout.paperLandscape
      : (!!docOrient && docOrient !== paperOrient)
    const effW = swapped ? pl.paperRect.h : pl.paperRect.w
    const effH = swapped ? pl.paperRect.w : pl.paperRect.h
    let paperScaleBase = 1
    if (containerSize.width && containerSize.height) {
      let PAD = 64, LABEL_H = 36, MIN_MARGIN = 28
      let availW = containerSize.width - PAD - MIN_MARGIN * 2
      let availH = containerSize.height - PAD - LABEL_H - MIN_MARGIN * 2
      if (availW <= 0 || availH <= 0) {
        PAD = 20; LABEL_H = 0; MIN_MARGIN = 8
        availW = containerSize.width - PAD - MIN_MARGIN * 2
        availH = containerSize.height - PAD - LABEL_H - MIN_MARGIN * 2
      }
      if (availW > 0 && availH > 0) {
        paperScaleBase = Math.min(availW / effW, availH / effH)
      }
    }
    // 自适应 = 基线；手动 = 基线 × zoomPercent/100
    const paperScale = zoomMode === 'adaptive' ? paperScaleBase : paperScaleBase * (zoomPercent / 100)

    const paperDisplayW = Math.round(effW * paperScale)
    const paperDisplayH = Math.round(effH * paperScale)

    let fitScale, imageRect
    if (renderLayoutReady) {
      // ✅ Stage 1：placement 完全来自 Factory（buildRenderLayout）；预览不再自算 fit/居中。
      //   imageRect = 内容盒在 contentRect 内的投影（offset + pageSize×scale）。
      fitScale = renderLayout.placement.scale
      const docW = documentStateRef.current?.pageSize?.w || 0
      const docH = documentStateRef.current?.pageSize?.h || 0
      imageRect = {
        x: renderLayout.placement.offsetX,
        y: renderLayout.placement.offsetY,
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
    return {
      ready: true,
      fitScale,
      imageRect,
      rotation: previewRotation || 0,
      paperDisplayScale: paperScale,
      paperDisplayRect: { w: paperDisplayW, h: paperDisplayH },
    }
  }, [previewCanvas, previewImgDims, previewRotation, containerSize, zoomMode, zoomPercent, paperLayout, renderLayout, settings.mergeMode])

  // 同步到 state，使外部可消费
  useEffect(() => { setContentLayout(computedContentLayout) }, [computedContentLayout])

  // 供 zoom 控件消费的 fitScale（来自 contentLayout，只有一条依赖链）
  useEffect(() => {
    if (computedContentLayout?.ready) {
      fitScaleRef.current = computedContentLayout.fitScale
    }
  }, [computedContentLayout])

  // ── 自动居中滚动（内容溢出时初始视图居中）──
  useEffect(() => {
    const el = previewContainerRef.current
    if (!el || !computedContentLayout?.paperDisplayRect || !previewCanvas) return
    // 用 rAF 确保 DOM 已完成布局
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2)
      el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2)
    })
  }, [previewCanvas, computedContentLayout, previewContainerRef])

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
      if (fmt === 'image' || fmt === 'ofd') {
        // ✅ Render Engine Preview：优先走后端渲染 URL
        if (USE_RENDER_ENGINE_PREVIEW && fObj.docId) {
          // 多页 PDF 拆页后每个分页项携带真实页码 pageNum；非拆页文件为 null → 回退 1
          _previewImageUrl = buildPreviewUrl(fObj.docId, fObj.pageNum || 1)
          return { ...fObj, _previewImageUrl, _fileFormat: fmt }
        }

        // 复用已加载的 blob URL
        if (fObj.key === currentKey && currentUrl) {
          _previewImageUrl = currentUrl
        }
        // 从 previewImage 加载（带 Blob 缓存，避免重复 b64toBlob）
        else if (fObj.previewImage) {
          const cacheKey = 'blob_' + fObj.key
          let blob = lruGet(previewLoadCacheRef.current, cacheKey)
          if (!blob || blob.size === 0) {
            blob = b64toBlob(fObj.previewImage, 'image/png')
            if (blob.size > 0) {
              lruSet(previewLoadCacheRef.current, cacheKey, blob)
            }
          }
          if (blob.size > 0) {
            _previewImageUrl = URL.createObjectURL(blob)
            pendingBlobUrlsRef.current.push(_previewImageUrl)
          }
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

        // 提取图片/OFD 尺寸用于方向检测（复用 fetchImageDims）
        if (_previewImageUrl && !fObj._imageWidth && !fObj.previewWidth) {
          const dims = await fetchImageDims(_previewImageUrl, fObj.key)
          if (dims) {
            fObj._imageWidth = dims.w
            fObj._imageHeight = dims.h
          }
        }

        return { ...fObj, _previewImageUrl, _fileFormat: fmt }
      }

      if (fmt === 'pdf') {
        // ✅ Render Engine Preview：优先走后端渲染 URL，绕过 pdfjs + Canvas
        if (USE_RENDER_ENGINE_PREVIEW && fObj.docId) {
          // 多页 PDF 拆页后每个分页项携带真实页码 pageNum；非拆页文件为 null → 回退 1
          _previewImageUrl = buildPreviewUrl(fObj.docId, fObj.pageNum || 1)
          // 从后端 metadata 获取页面尺寸用于 DocumentState（确定性高，不依赖图片加载）
          if (!fObj._pdfPageWidth && !fObj._imageWidth) {
            try {
              const metaResp = await fetch(`${BACKEND_URL}/metadata/${fObj.docId}`, { signal })
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
          return { ...fObj, _previewImageUrl, _fileFormat: 'pdf' }
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
              buffer = await fd.data.arrayBuffer()
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
  const doLoadPreview = useCallback(async (fileObj, source = 'unknown') => {
    lastSwitchTimeRef.current = Date.now()
    if (switchTimeoutRef.current) {
      clearTimeout(switchTimeoutRef.current)
      switchTimeoutRef.current = null
    }

    // ✅ 在加载前先递增版本号，确保旧请求被丢弃
    const version = ++previewVersionRef.current

    // ✅ 保存旧的 blob URL，在新预览加载完成后再清理
    const oldBlobUrls = [...pendingBlobUrlsRef.current]
    const oldPreviewUrl = previewUrlRef.current

    // ── 合并模式预览 ──
    if (isMergeMode(settings.mergeMode)) {
      const groupSize = parseInt(settings.mergeMode?.replace('merge', '')) || 2
      const pair = getMergePair(filesRef.current, fileObj.key, groupSize)
      if (pair && pair.length >= 1) {
        const loaded = await Promise.all(
          pair.map((item, idx) =>
            loadPairItemForPreview(item, idx === 0 ? fileObj.key : null, idx === 0 ? null : null)
          )
        )
        const validLoaded = loaded.filter(Boolean)
        // ✅ 检查版本号，确保只处理最新请求
        if (validLoaded.length > 0 && version === previewVersionRef.current) {
          previewFileRef.current = validLoaded[0]
          setMergePair(validLoaded)
          setPreviewFile(validLoaded[0])
          setPreviewPage(1)
          setNumPages(1)
        }
        return
      }
    }

    // ── 单文件预览 ──
    // 先加载文件数据（含方向检测所需的页面尺寸），再用"当前"布局参数生成缓存 key。
    // key 必须包含所有影响 Canvas 的布局参数，且读写两侧用同一份 settings（settingsRef.current），
    // 否则命中陈旧缓存 + skipRenderRef 跳过纠正渲染 → 显示错误预览（正确性 Bug）。
    const loadedFile = await loadFilePreview(fileObj)
    if (version !== previewVersionRef.current) { return }

    const rotation = (fileRotations[loadedFile.key] || 0)
    // 与 render effect 保持一致的 isLandscape 计算：统一走 resolvePaper（Single Decision Point）。
    // 否则 Custom 纸型下 PAPER_SIZE_MAP 与 resolvePaper 结果不一致 → L2 缓存键与渲染键漂移 →
    // 点击命中陈旧 Canvas，与自动预览（RE）视觉不一致。
    const contentOrient = detectDocumentOrientation(loadedFile)
    const paper = resolvePaper(settingsRef.current.paperSize, settingsRef.current.customPaper)
    const paperOrient = paper.widthMM > paper.heightMM ? 'landscape' : 'portrait'
    const isLandscape = contentOrient !== paperOrient

    // ── PaperLayout 现在由 useMemo 纯派生（settings → computePaperLayout），此处不再重复 ──
    // PaperLayout 仅依赖 PaperSpec，与当前文档无关；文件切换不改变 PaperLayout
    // （满足验收：切换文件 / 导入新文件 不重生 PaperLayout）。

    // DocumentState（文档属性，与纸张无关）— swap 仅用于缓存 key，不污染 PaperLayout
    const docW = loadedFile._pdfPageWidth || loadedFile._imageWidth || 0
    const docH = loadedFile._pdfPageHeight || loadedFile._imageHeight || 0
    const docOrientation = (docW && docH) ? (docW > docH ? 'landscape' : 'portrait') : contentOrient
    documentStateRef.current = {
      id: loadedFile.key || loadedFile.id || '',
      pageCount: loadedFile._pdfPageCount || 1,
      pageSize: { w: docW, h: docH },
      pageOrientation: docOrientation,
      sourceType: loadedFile._fileFormat || 'pdf',
      pageNum: loadedFile.pageNum || 1,
    }
    documentStateRef.current = {
      id: loadedFile.key || loadedFile.id || '',
      pageCount: loadedFile._pdfPageCount || 1,
      pageSize: { w: docW, h: docH },
      pageOrientation: docOrientation,
      sourceType: loadedFile._fileFormat || 'pdf',
      pageNum: loadedFile.pageNum || 1,
    }
    const cacheKey = buildPreviewCacheKey(
      { fileKey: loadedFile.key, rotation },
      {
        paperSize: settingsRef.current.paperSize,
        isLandscape,
        mergeMode: settingsRef.current.mergeMode,
        customPaper: settingsRef.current.customPaper,
        margins: {
          left: settingsRef.current.marginLeft, right: settingsRef.current.marginRight,
          top: settingsRef.current.marginTop, bottom: settingsRef.current.marginBottom,
        },
      }
    )
    const cachedCanvas = fullCacheRef.current.get(cacheKey)
    if (cachedCanvas) {
      // 直接设置缓存画布，跳过整个异步渲染管线
      skipRenderRef.current = true
      previewFileRef.current = loadedFile
      setMergePair(null)
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
      //    DS（L1197 写入），buildRenderLayout 内部由 pageOrientation 推导 rotation，故 rotation=90 进 URL。
      let l2Spec = null
      // ✅ 修复（B-2.2 调查定案，2026-07-13）：L2 HIT 在 doLoadPreview 同步阶段执行，
      //    此时 renderLayoutReady（依赖 previewFile state 的 useMemo）仍是上一帧陈旧值=false，
      //    用它会把本应重建的 l2Spec 门控跳过 → URL 裸奔 → 后端 rotation=0 → 横向内容落竖纸错位。
      //    改用同步可用且与 renderLayout memo 输入一致的 paperLayout / documentStateRef.current 直接重建，
      //    不依赖尚未提交的 useMemo。这正是 V16「renderLayout 实时派生、不缓存」的设计意图。
      if (paperLayout) {
        try {
          const l2Layout = buildRenderLayout(paperLayout, {
            ...(documentStateRef.current || {}),
            rotation: fileRotations[loadedFile.key] || 0,
          })
          l2Spec = buildRenderSpec(l2Layout, {
            docId: loadedFile.docId,
            page: loadedFile.pageNum || 1,
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
      return
    }

    // ── 正常预览加载（全缓存未命中） ──
    if (version === previewVersionRef.current) {
      previewFileRef.current = loadedFile
      setMergePair(null)
      setPreviewFile(loadedFile)
      setPreviewPage(1)
      setNumPages(loadedFile._fileFormat === 'pdf' ? 0 : 1)

      if (loadedFile._previewImageUrl) {
        previewUrlRef.current = loadedFile._previewImageUrl
      }
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
  }, [settings.mergeMode, loadPairItemForPreview, loadFilePreview, fullCacheRef, skipRenderRef, previewFileRef, previewVersionRef, previewUrlRef, pendingBlobUrlsRef, fileRotations, paperLayout])

  // ============================
  // 预览文件（带防抖）
  // ============================
  const handlePreview = useCallback(async (fileObj) => {
    // ── 防抖层：让 UI 指示器即时响应，渲染逻辑延迟 150ms ──
    const now = Date.now()

    // 1. 立即更新 UI 指示器（文件列表高亮等），不触发 render effect
    setSelectedFileKey(fileObj.key || fileObj.id)

    // 2. 快速连击 → 延迟执行，只保留最后一次
    if (now - lastSwitchTimeRef.current < 150) {
      // 清掉上次未执行的定时器
      if (switchTimeoutRef.current) {
        clearTimeout(switchTimeoutRef.current)
      }
      // 重新设定时器，到期后直接调用加载逻辑（不再递归 handlePreview）
      return new Promise(resolve => {
          switchTimeoutRef.current = setTimeout(async () => {
          switchTimeoutRef.current = null
          const result = await doLoadPreview(fileObj, 'handlePreview:timeout')
          resolve(result)
        }, 150)
      })
    }
    lastSwitchTimeRef.current = now

    // 3. 间隔足够，立即执行
    return doLoadPreview(fileObj, 'handlePreview:immediate')
  }, [doLoadPreview])

  // ============================
  // Hover 预加载：低优先级，可取消
  // ============================
  const preloadHD = useCallback(async (fileObj) => {
    if (!fileObj?.key || !fileObj.name) return
    // ✅ 全局 Canvas 统一处理所有格式，切换零开销，无需预渲染
    return
    if (fullCacheRef.current.has(fileObj.key)) return
    // 取消上一个预加载
    if (currentPreloadRef.current) {
      currentPreloadRef.current.abort()
    }

    const controller = new AbortController()
    currentPreloadRef.current = controller
    const preloadVersion = Date.now()

    try {
      // 加载预览数据（填充 previewLoadCache）
      const loadedFile = await loadFilePreview(fileObj, null, null, controller.signal)
      if (controller.signal.aborted) return

      // 计算渲染参数（与 render effect 中单文件逻辑保持一致）
      const contentOrient = detectDocumentOrientation(loadedFile)
      const paper = resolvePaper(settings.paperSize, settings.customPaper)
      const paperOrient = paper.widthMM > paper.heightMM ? 'landscape' : 'portrait'
      const isLandscape = contentOrient !== paperOrient
      const rotation = fileRotations[fileObj.key] || 0
      const effectiveLandscape = (rotation % 180 !== 0) ? !isLandscape : isLandscape

      if (controller.signal.aborted) return

      const { renderMultipleItemsToCanvas } = await getRenderers()
      const userMargins = {
        left: settings.marginLeft ?? 3, right: settings.marginRight ?? 3,
        top: settings.marginTop ?? 3, bottom: settings.marginBottom ?? 3,
      }
      const canvas = await renderMultipleItemsToCanvas(
        [{ ...loadedFile }],
        settings.paperSize || 'A4', PREVIEW_DPI, effectiveLandscape,
        { [fileObj.key]: rotation },
        1, false,
        false,  // showSafeMargin
        { strategy: 'vertical', userMargins, customPaper: settings.customPaper }
      )

      if (controller.signal.aborted) return
      if (canvas) {
        setFullCache(fileObj.key, canvas)
      }
    } catch (e) {
      // 预加载失败非关键错误，静默处理
    }
  }, [loadFilePreview, settings.paperSize, fileRotations,
      settings.marginLeft, settings.marginRight, settings.marginTop, settings.marginBottom,
      settings.customPaper?.widthMM, settings.customPaper?.heightMM])

  // ✅ 保存 handlePreview 最新引用，避免 useEffect 闭包陷阱
  useEffect(() => {
    handlePreviewRef.current = handlePreview
  }, [handlePreview])

  // ✅ 当 mergeMode 变化时，自动重新预览当前文件
  useEffect(() => {
    if (previewFile && handlePreviewRef.current) {
      handlePreviewRef.current(previewFile)
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

    // ✅ 导入文件后自动进入合并模式预览
    if (!previewFile && files.length > 0) {
      const firstParsed = files.find(f => f.status === 'parsed')
      if (firstParsed) {
        handlePreviewRef.current?.(firstParsed)
      }
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
        handlePreview(files[0])
      } else {
        previewFileRef.current = null
        setPreviewFile(null)
        setMergePair(null)
        setPreviewCanvas(null)
      }
      return
    }

    // ✅ 合并模式下，仅当文件列表实际变化时重新计算 mergePair
    //    新导入的文件可能属于当前合并组，需要实时更新预览
    //    注意：不能在 mergeMode 变化时触发（已有单独的 useEffect 处理）
    if (filesChanged && isMergeMode(settings.mergeMode)) {
      handlePreviewRef.current?.(previewFile)
    }
  }, [filesKeyStr, filesKeySet, previewFile, files, handlePreview, cleanupAllBlobUrls])

  // ── docId 异步就绪 → 重预览（修复「自动预览 vs 点击同文件」视觉不一致）──
  // 根因：自动预览在 files.length 增加时触发，此时预览文件还是解析中占位（docId=null），
  //       loadFilePreview 无 RE URL → 走 pdf.js Canvas；点击同文件时 docId 已就绪 → 走 RE <img>。
  //       两个后端（Canvas 按纸张 fit vs RE 默认 A4）渲染结果差异巨大（字体/缩放/边距都不同），
  //       且原代码没有任何 effect 监听 docId 变化 → 自动预览永远停留在 Canvas，直到点击才切 RE。
  // 修复：监听当前预览文件在 files 中的实时 docId，一旦就绪（且与原 previewFile.docId 不同）
  //       重走 doLoadPreview，统一到 RE 路径，使自动预览与点击渲染一致。
  const livePreviewDocId = useMemo(
    () => files.find(f => f.key === previewFile?.key)?.docId ?? null,
    [files, previewFile?.key]
  )
  useEffect(() => {
    const pf = previewFileRef.current
    if (!pf) return
    const live = filesRef.current.find(f => f.key === pf.key)
    if (live && live.docId && live.docId !== pf.docId) {
      handlePreviewRef.current?.(live)
    }
  }, [livePreviewDocId])

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
      const pair = getMergePair(filesRef.current, currentKey, groupSize)

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
      const pair = getMergePair(filesRef.current, currentKey, groupSize)

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
