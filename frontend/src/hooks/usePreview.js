import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { PREVIEW_DPI, ZOOM_STEPS, PAPER_SIZE_MAP } from '../config'
import {
  b64toBlob, getFileFormat, getExtension, isMergeMode, getMergePair,
} from '../utils'
import * as pdfjs from 'pdfjs-dist'
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { detectDocumentOrientation } from '../utils/detectOrientation'

// PDF.js worker 配置
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl
import { getForcedLandscape } from '../utils/mergeMode'

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
  const [mergePair, setMergePair] = useState(null)
  const [numPages, setNumPages] = useState(0)
  const [previewPage, setPreviewPage] = useState(1)
  const [previewCanvas, setPreviewCanvas] = useState(null)
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
  const previewUrlRef = useRef(null)
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
  // ✅ 保存 zoom menu 关闭动画的 timeout ID，用于清理
  const zoomMenuCloseTimeoutRef = useRef(null)
  // ✅ 保存 handlePreview 最新引用，避免 useEffect 闭包陷阱
  const handlePreviewRef = useRef(null)
  // ✅ L2 缓存：预渲染高清画布（通过 hover 提前填充）
  //    与 renderResultCache 共享同一 canvas 引用（无额外内存）
  const fullCacheRef = useRef(new Map())
  // ✅ 当前 hover 预加载的 AbortController（只保留最后一个）
  const currentPreloadRef = useRef(null)
  // ✅ 渲染跳过标记：handlePreview 从 fullCache 取到 canvas 时，
  //    设置此标记让 render effect 跳过，避免重复渲染
  const skipRenderRef = useRef(false)
  // ✅ previewFile 的同步 ref：解决 async handlePreview 期间 state 未更新的竞态问题
  //    handleNextFile / handlePrevFile 等依赖索引计算的逻辑通过此 ref 读取最新值
  const previewFileRef = useRef(null)
  // ✅ loadFilePreview 数据缓存：避免每次文件切换都重复 b64toBlob / IPC 读文件
  //    图片缓存 Blob 对象，PDF 缓存 Uint8Array
  //    LRU 自清理（max 50 条），文件删除后 key 自然失效
  const previewLoadCacheRef = useRef(new Map())
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
        const fitPct = Math.round(fitScaleRef.current * 100)
        return ZOOM_STEPS.find(s => s > fitPct) || ZOOM_STEPS[ZOOM_STEPS.length - 1]
      }
      return ZOOM_STEPS.find(s => s > prev) || ZOOM_STEPS[ZOOM_STEPS.length - 1]
    })
  }, [])

  const zoomOut = useCallback(() => {
    setZoomMode('manual')
    setZoomPercent(prev => {
      if (zoomModeRef.current === 'adaptive') {
        const fitPct = Math.round(fitScaleRef.current * 100)
        return [...ZOOM_STEPS].reverse().find(s => s < fitPct) || ZOOM_STEPS[0]
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

  // ============================
  // 预览渲染
  // ============================
  useEffect(() => {
    // ✅ L2 缓存旁路：fullCache 命中时跳过整个渲染流程
    if (skipRenderRef.current) { skipRenderRef.current = false; return }

    if (!previewFile) { setPreviewCanvas(null); return }

    const isImageOrOfd =
      previewFile._fileFormat === 'image' || previewFile._fileFormat === 'ofd'

    if (!isImageOrOfd && !previewFile._pdfData && !mergePair) {
      setPreviewCanvas(null); return
    }
    if (isImageOrOfd && !previewFile._previewImageUrl) {
      setPreviewCanvas(null); return
    }

    const { paperSize } = settings
    // isLandscape = paperShouldShowAsLandscape
    // 规则：纸张与内容方向不同时才 swap（让内容能铺满）
    //   横向内容+横向纸 → isLandscape=false（纸保持横向，内容不旋转直接铺）
    //   竖向内容+横向纸 → isLandscape=true （纸 swap 成竖向，内容旋转 90° 铺）
    const contentOrient = detectDocumentOrientation(previewFile)
    const paperDims = PAPER_SIZE_MAP[paperSize]
    const paperOrient = paperDims && paperDims.widthMM > paperDims.heightMM ? 'landscape' : 'portrait'
    const isLandscape = contentOrient !== paperOrient
    // ✅ renderKey 必须包含合并模式、合并组所有文件的旋转值，以确保模式切换和多文件旋转都能触发重渲染
    const mergeRotations = mergePair?.map(m => `${m?.key}:${fileRotations[m?.key] || 0}`).join(',') || ''
    const renderKey = `${previewFile.key}-${paperSize}-${isLandscape}-${currentRotation}-${settings.mergeMode || ''}-${mergePair?.map(m => m?.key).join(',') || ''}-${mergeRotations}`
    if (lastRenderKeyRef.current === renderKey) return
    lastRenderKeyRef.current = renderKey

    renderCancelledRef.current = false
    const currentRenderId = ++renderVersionRef.current

    // ✅ 在 useEffect 同步部分预先计算布局参数，确保闭包捕获正确的 mergeMode
    const mergeModeGroupSize = isMergeMode(settings.mergeMode) ? (parseInt(settings.mergeMode?.replace('merge', '')) || 2) : 1
    const mergeLayoutStrategy = mergeModeGroupSize === 4 ? 'grid' : 'vertical'

    const renderToCanvas = async () => {
      try {
        let canvas
        const isMerge = isMergeMode(settings.mergeMode) && mergePair?.some(Boolean)

        if (isMerge || isImageOrOfd || previewFile._pdfData) {
          const { renderMultipleItemsToCanvas } = await getRenderers()

          if (isMerge) {
            // ✅ 合并模式强制方向（merge2/3=竖向, merge4=横向），纸张用用户设置
            const forcedLandscape = getForcedLandscape(settings.mergeMode, isLandscape)
            canvas = await renderMultipleItemsToCanvas(
              mergePair.filter(Boolean),
              paperSize || 'A4', PREVIEW_DPI, forcedLandscape,
              fileRotations,
              mergeModeGroupSize,
              false,
              false,  // showSafeMargin
              { strategy: mergeLayoutStrategy, gridCols: 2, gridRows: 2 }
            )
          } else {
            // ✅ 单文件：旋转改为旋转画布（交换横竖），而不是旋转内容
            const effectiveLandscape = (currentRotation % 180 !== 0) ? !isLandscape : isLandscape
            const effectiveRotation = currentRotation

            const items = [{ ...previewFile }]
            canvas = await renderMultipleItemsToCanvas(
              items,
              paperSize || 'A4', PREVIEW_DPI, effectiveLandscape,
              { [previewFile.key]: effectiveRotation },
              1,
              false,
              { strategy: 'vertical' }
            )
          }
        }

        if (renderCancelledRef.current) return
        if (currentRenderId !== renderVersionRef.current) return
        if (canvas) {
          // ✅ 不清空旧 canvas：与 renderResultCache 共享同一对象，clearRect 会污染缓存
          unrotatedCanvasRef.current = canvas
          setPreviewCanvas(canvas)
        }
      } catch (e) {
        console.error('Canvas 渲染失败:', e)
        if (!renderCancelledRef.current && currentRenderId === previewVersionRef.current) {
          setPreviewCanvas(null)
        }
      }
    }
    renderToCanvas()
    return () => { renderCancelledRef.current = true }
  }, [previewFile, mergePair, settings.paperSize, currentRotation, fileRotations, settings.mergeMode])

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

  const displayInfo = useMemo(() => {
    if (!previewCanvas || !containerSize.width || !containerSize.height) return null
    const PAD = 64, LABEL_H = 36, MIN_MARGIN = 28
    const availW = containerSize.width - PAD - MIN_MARGIN * 2
    const availH = containerSize.height - PAD - LABEL_H - MIN_MARGIN * 2
    if (availW <= 0 || availH <= 0) return null

    const canvasW = previewCanvas.width
    const canvasH = previewCanvas.height

    const fitScale = Math.min(availW / canvasW, availH / canvasH)
    const scale = zoomMode === 'adaptive' ? fitScale : zoomPercent / 100
    return {
      displayWidth: Math.round(canvasW * scale),
      displayHeight: Math.round(canvasH * scale),
      scale,
      fitScale,
    }
  }, [previewCanvas, containerSize, zoomMode, zoomPercent])

  useEffect(() => { if (displayInfo) fitScaleRef.current = displayInfo.fitScale }, [displayInfo])

  // ── 自动居中滚动（内容溢出时初始视图居中）──
  useEffect(() => {
    const el = previewContainerRef.current
    if (!el || !displayInfo || !previewCanvas) return
    // 用 rAF 确保 DOM 已完成布局
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2)
      el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2)
    })
  }, [previewCanvas, displayInfo, previewContainerRef])

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
   * @returns {Promise<Object>} 包含 _previewImageUrl 或 _pdfData 的文件对象
   */
  const loadFilePreview = useCallback(async (fObj, currentKey = null, currentUrl = null) => {
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
        // 复用已加载的 blob URL
        if (fObj.key === currentKey && currentUrl) {
          _previewImageUrl = currentUrl
        }
        // 从 previewImage 加载（带 Blob 缓存，避免重复 b64toBlob）
        else if (fObj.previewImage) {
          const cacheKey = 'blob_' + fObj.key
          let blob = previewLoadCacheRef.current.get(cacheKey)
          if (!blob || blob.size === 0) {
            blob = b64toBlob(fObj.previewImage, 'image/png')
            if (blob.size > 0) {
              if (previewLoadCacheRef.current.size >= 50) {
                const firstKey = previewLoadCacheRef.current.keys().next().value
                previewLoadCacheRef.current.delete(firstKey)
              }
              previewLoadCacheRef.current.set(cacheKey, blob)
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
          if (fd.success) {
            const blob = new Blob([new Uint8Array(fd.data)])
            _previewImageUrl = URL.createObjectURL(blob)
            pendingBlobUrlsRef.current.push(_previewImageUrl)
          }
        }

        // 提取图片/OFD 尺寸用于方向检测（带缓存）
        if (_previewImageUrl && !fObj._imageWidth && !fObj.previewWidth) {
          const dimsKey = 'dims_' + fObj.key
          const cachedDims = previewLoadCacheRef.current.get(dimsKey)
          if (cachedDims) {
            fObj._imageWidth = cachedDims.w
            fObj._imageHeight = cachedDims.h
          } else {
            try {
              const img = new Image()
              const dims = await new Promise((resolve) => {
                img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
                img.onerror = () => resolve(null)
                img.src = _previewImageUrl
              })
              if (dims) {
                fObj._imageWidth = dims.w
                fObj._imageHeight = dims.h
                previewLoadCacheRef.current.set(dimsKey, dims)
              }
            } catch (e) { /* 尺寸提取失败 fallback portrait */ }
          }
        }

        return { ...fObj, _previewImageUrl, _fileFormat: fmt }
      }

      if (fmt === 'pdf') {
        let buffer = null
        // ✅ 尝试从缓存取 Uint8Array（_pdfData），避免重复 IPC read-file + pdfjs 解析
        const pdfKey = 'pdf_' + fObj.key
        const cachedPdfData = previewLoadCacheRef.current.get(pdfKey)
        if (cachedPdfData) {
          _pdfData = cachedPdfData
        } else {
          if (fObj.file) {
            buffer = await fObj.file.arrayBuffer()
          } else if (electronAPIRef.current?.ipcRenderer && fObj.printPath) {
            const fd = await electronAPIRef.current.ipcRenderer.invoke('read-file', fObj.printPath)
            if (fd.success) {
              buffer = fd.data.buffer
            }
          }
          if (buffer) {
            _pdfData = new Uint8Array(buffer)
            if (previewLoadCacheRef.current.size >= 50) {
              const firstKey = previewLoadCacheRef.current.keys().next().value
              previewLoadCacheRef.current.delete(firstKey)
            }
            previewLoadCacheRef.current.set(pdfKey, _pdfData)
          }
        }
        if (_pdfData) {
          // 提取第一页尺寸用于方向检测（带缓存）
          const dimsKey = 'pdfDims_' + fObj.key
          const cachedDims = previewLoadCacheRef.current.get(dimsKey)
          if (cachedDims) {
            fObj._pdfPageWidth = cachedDims.w
            fObj._pdfPageHeight = cachedDims.h
          } else {
            // ⚠️ 必须传副本：pdfjs.getDocument 会接管 ArrayBuffer，后续 destroy 会 detached buffer
            try {
              const pdfDoc = await pdfjs.getDocument({ data: new Uint8Array(_pdfData) }).promise
              const page = await pdfDoc.getPage(1)
              const vp = page.getViewport({ scale: 1 })
              fObj._pdfPageWidth = vp.width
              fObj._pdfPageHeight = vp.height
              pdfDoc.destroy()
              previewLoadCacheRef.current.set(dimsKey, { w: vp.width, h: vp.height })
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
  // 预览文件
  // ============================
  const handlePreview = useCallback(async (fileObj) => {
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
    // ✅ L2 缓存命中：fullCache 已有预渲染画布，直接瞬时显示
    const cachedCanvas = fullCacheRef.current.get(fileObj.key)
    if (cachedCanvas) {
      // 仍需加载文件数据以使 render effect 通过守卫条件
      const loadedFile = await loadFilePreview(fileObj)
      if (version !== previewVersionRef.current) return
      skipRenderRef.current = true
      previewFileRef.current = loadedFile
      setMergePair(null)
      setPreviewFile(loadedFile)
      setPreviewPage(1)
      setNumPages(loadedFile._fileFormat === 'pdf' ? 0 : 1)
      // 直接设置缓存画布，跳过整个异步渲染管线
      setPreviewCanvas(cachedCanvas)
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
    const loadedFile = await loadFilePreview(fileObj)
    // ✅ 检查版本号，确保只处理最新请求
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
  }, [settings.mergeMode, loadPairItemForPreview, loadFilePreview])

  // ============================
  // Hover 预加载：低优先级，可取消
  // ============================
  const preloadHD = useCallback(async (fileObj) => {
    if (!fileObj?.key || !fileObj.name) return
    // 已缓存，跳过
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
      const loadedFile = await loadFilePreview(fileObj)
      if (controller.signal.aborted) return

      // 计算渲染参数（与 render effect 中单文件逻辑保持一致）
      const contentOrient = detectDocumentOrientation(loadedFile)
      const paperDims = PAPER_SIZE_MAP[settings.paperSize || 'A4']
      const paperOrient = paperDims && paperDims.widthMM > paperDims.heightMM ? 'landscape' : 'portrait'
      const isLandscape = contentOrient !== paperOrient
      const rotation = fileRotations[fileObj.key] || 0
      const effectiveLandscape = (rotation % 180 !== 0) ? !isLandscape : isLandscape

      if (controller.signal.aborted) return

      const { renderMultipleItemsToCanvas } = await getRenderers()
      const canvas = await renderMultipleItemsToCanvas(
        [{ ...loadedFile }],
        settings.paperSize || 'A4', PREVIEW_DPI, effectiveLandscape,
        { [fileObj.key]: rotation },
        1, false,
        { strategy: 'vertical' }
      )

      if (controller.signal.aborted) return
      if (canvas) {
        fullCacheRef.current.set(fileObj.key, canvas)
      }
    } catch (e) {
      // 预加载失败非关键错误，静默处理
    }
  }, [loadFilePreview, settings.paperSize, fileRotations])

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

  // 文件列表键集合（用于稳定比较，包含 status 以感知解析完成）
  const filesKeyStr = useMemo(() => {
    return files.map(f => `${f.key}:${f.status || ''}`).join(',')
  }, [files])
  const filesKeySet = useMemo(() => {
    return new Set(files.map(f => f.key))
  }, [filesKeyStr])

  // ✅ 用 ref 跟踪上一次的 filesKeyStr，仅在文件列表实际变化时才触发合并更新
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
      // ✅ 清理 fullCache（预渲染画布在 renderResultCache 中已有引用，此处只是清空映射）
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
    }
  }, [cleanupAllBlobUrls])

  // 当前预览文件的旋转值（供外部使用）
  const previewRotation = fileRotations[previewFile?.key] || 0

  return {
    /**
     * 预览状态
     */
    state: {
      previewFile,
      mergePair,
      numPages,
      previewPage,
      previewCanvas,
      containerSize,
      previewRotation,
      fileRotations,
      showLeftArrow,
      showRightArrow,
      displayInfo,
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
    },
  }
}
