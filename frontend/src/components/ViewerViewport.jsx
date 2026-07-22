/**
 * ViewerViewport — 图片变换渲染层 + 视口尺寸唯一来源
 *
 * 职责：
 *   渲染当前页 <img> + CSS transform（zoom/pan/rotate）。
 *   处理交互手势：Ctrl+wheel zoom、拖拽 pan、双击 fit。
 *   通过内置 ResizeObserver 自测量视口内容区尺寸（D2-1），
 *   以测量值驱动 fitScale 计算，不依赖外层 prop 传入的 containerSize。
 *   不管理 zoom/pan 状态（由 useViewerState 驱动），纯渲染 + 事件上报。
 *
 * Architecture Law D1：
 *   只消费 resolvePreviewUrl 产出的 URL，不碰纸张/边距。
 *
 * D2-1：
 *   ResizeObserver 监听自身 .viewer-viewport 元素，
 *   测量 clientWidth/Height 减去 padding 得到真实图片可用区域。
 *   窗口 resize → 自动重算 fitScale → 图片实时适配。
 *
 * @module components/ViewerViewport
 */

import React, { useRef, useState, useCallback, useEffect, memo } from 'react'
import { buildTransformString, computeFitScale, computeDisplaySize, rotatedDimensions } from '../utils/viewerTransform'
import { effectiveRotation } from '../models/InvoiceDocument'
import { wheelZoomFactor } from '../hooks/continuousZoom.mjs'

/**
 * @param {Object} props
 * @param {import('../models/InvoiceDocument').PageMeta|null} props.page - 当前页 PageMeta
 * @param {string|null} props.previewUrl - 当前页预览 URL（由 PreviewResourceResolver 解析）
 * @param {number} props.zoom - ⚠️ 旧模型缩放百分比（100=fit）。仅在未传 mode 时（DevDemo 回退路径）生效。
 * @param {number} props.panX - 水平平移
 * @param {number} props.panY - 垂直平移
 * @param {number} props.viewRotation - 用户查看旋转
 * @param {{ width: number, height: number }} [props.containerSize] - ⚠️ D2-1 起不再用于 fitScale 计算
 *   （已由内置 ResizeObserver 自测量替代）。保留 prop 接口供 useViewerState pan clamp 使用，D2-2 移除。
 * @param {boolean} props.grayscale - 灰度模式
 * @param {boolean} props.loading - 加载中
 * @param {(deltaY: number) => void} props.onWheelZoom - ⚠️ 旧模型滚轮缩放回调（未传 mode 时生效）。
 * @param {(panX: number, panY: number) => void} props.onPanChange - 平移回调
 * @param {() => void} props.onDoubleClick - 双击适应回调
 * @param {(pageIndex: number, width: number, height: number) => void} [props.onNaturalSize] -
 *   图片加载后上报自然像素尺寸（用于回填 0×0 的 PageMeta）
 * @param {React.ReactNode} [props.overlaySlot] - Overlay 插槽（OCR/字段高亮）
 * @param {'fit'|'manual'} [props.mode] - D2-3 缩放模式。传入即启用新模型（fit/manual 分离）；
 *   未传（undefined）则回退旧 zoom 模型。ViewerViewport 是纯消费者，不拥有 mode（由 useViewerState 驱动）。
 * @param {number|null} [props.scale] - D2-3 manual 模式冻结的绝对渲染比例（fit 模式为 null）。
 * @param {(nextScale: number) => void} [props.onEnterManual] - D2-3 滚轮进入/更新 manual 模式回调，
 *   参数为 currentScale × wheelZoomFactor 后的新绝对 scale。
 */
function ViewerViewportInner({
  page,
  previewUrl,
  zoom,
  panX,
  panY,
  viewRotation,
  containerSize,
  grayscale,
  loading,
  onWheelZoom,
  onPanChange,
  onDoubleClick,
  onNaturalSize,
  overlaySlot,
  // D2-3：fit/manual 新模型 prop（传入 mode 即启用；未传则回退旧 zoom 模型）
  mode,
  scale: manualScale,
  onEnterManual,
}) {
  const viewportRef = useRef(null)
  const dragState = useRef({ dragging: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0 })

  // 图片自然像素尺寸（PageMeta 为 0×0 时的渲染回退 + 回填来源）。
  // 切换页面（previewUrl 变化）时重置，等待新图加载。
  const [naturalDims, setNaturalDims] = useState(null)
  // 加载重试计数：渲染引擎对文档的注册（autoRegister）可能略晚于首次加载，
  // 首次 404 后短暂延迟重试，覆盖该时间窗。通过 key 变更强制 img 重新加载。
  const [loadAttempt, setLoadAttempt] = useState(0)
  const retryRef = useRef(0)
  useEffect(() => {
    setNaturalDims(null)
    retryRef.current = 0
  }, [previewUrl])

  // ─── D2-1：ResizeObserver 自测量视口内容区 ───
  // 测量 .viewer-viewport 的 clientWidth/Height 减去 padding，
  // 得到图片真实可用区域。替代外层 prop containerSize（测量对象为 .canvas-scroll，
  // 不含 viewport 自身 padding 和 thumbnail bar 高度，导致 fitScale 偏大）。
  const [measuredSize, setMeasuredSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    let ticking = false
    const update = () => {
      ticking = false
      const style = getComputedStyle(el)
      const padX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
      const padY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
      const w = el.clientWidth - padX
      const h = el.clientHeight - padY
      setMeasuredSize((prev) => {
        if (prev.width === w && prev.height === h) return prev
        return { width: w, height: h }
      })
    }
    const observer = new ResizeObserver(() => {
      if (!ticking) {
        requestAnimationFrame(update)
        ticking = true
      }
    })
    observer.observe(el)
    // 首次立即测量（ResizeObserver 首次回调可能延迟一帧）
    update()
    return () => observer.disconnect()
  }, [])

  // 计算有效旋转和尺寸
  const effRotation = page ? effectiveRotation(page, viewRotation) : 0
  // 基础尺寸：优先 PageMeta；缺失（0×0，过渡期注册）时回退到已加载图片的自然尺寸。
  const baseW = page && page.width ? page.width : naturalDims ? naturalDims.width : 0
  const baseH = page && page.height ? page.height : naturalDims ? naturalDims.height : 0
  const dims = rotatedDimensions(baseW, baseH, effRotation)

  // 计算 fit scale（D2-1：使用自测量尺寸，非外层 prop）
  const fitScale = computeFitScale(dims.width, dims.height, measuredSize.width, measuredSize.height)

  // D2-3：双路径渲染 scale
  //  - 新模型（mode 已传入）：fit → fitScale（实时跟随视口）；manual → 冻结绝对 manualScale
  //    （窗口 resize 只重算 fitScale，manual 的 manualScale 不变 → 用户查看的局部细节不漂移）。
  //  - 旧模型（mode 未传入，DevDemo 回退）：scale = fitScale × zoom%（兼容原行为）。
  const useNewModel = mode !== undefined
  const renderScale = useNewModel
    ? (mode === 'manual' && manualScale != null ? manualScale : fitScale)
    : computeDisplaySize(dims.width, dims.height, fitScale, zoom).scale

  // ─── Image Load：捕获自然尺寸并上报回填 ───
  const handleImageLoad = useCallback((e) => {
    const w = e.target?.naturalWidth || 0
    const h = e.target?.naturalHeight || 0
    if (w <= 0 || h <= 0) return
    setNaturalDims({ width: w, height: h })
    // PageMeta 缺失尺寸时上报，由 DocumentViewer 回填 DocumentStore（D1：尺寸属于业务数据）
    if (page && (!page.width || !page.height)) {
      onNaturalSize?.(page.index, w, h)
    }
  }, [page, onNaturalSize])

  // ─── Image Error：延迟重试（覆盖渲染引擎注册时间窗） ───
  const handleImageError = useCallback(() => {
    if (retryRef.current >= 3) return
    retryRef.current += 1
    setTimeout(() => setLoadAttempt((n) => n + 1), 800)
  }, [])

  // ─── Wheel Zoom（D2-3 双路径）───
  // ref 持有最新 scale 上下文，handleWheel 引用保持稳定（deps=[]）：
  // fitScale 随 ResizeObserver 变化，若进 deps 会导致 wheel listener 反复注销/重注册。
  const zoomCtxRef = useRef({})
  zoomCtxRef.current = { useNewModel, mode, manualScale, fitScale, onEnterManual, onWheelZoom }

  const handleWheel = useCallback((e) => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    // D2-3 4a：ViewerViewport 完全拥有 Ctrl+wheel 缩放，阻止冒泡到 .canvas-scroll 上
    // 的 legacy usePreview.handleWheelZoom（usePreview.js:1057），避免污染 preview.zoom
    // 导致 toolbar 指示器与真实 mode/scale 错位。
    e.stopPropagation()
    const ctx = zoomCtxRef.current
    if (ctx.useNewModel) {
      // 新模型：当前 scale（manual 用冻结值，fit 用实时 fitScale）× 乘性因子 → 进入/更新 manual
      const currentScale = (ctx.mode === 'manual' && ctx.manualScale != null) ? ctx.manualScale : ctx.fitScale
      ctx.onEnterManual?.(currentScale * wheelZoomFactor(e.deltaY))
    } else {
      // 旧模型（DevDemo）：上报 deltaY，由 useViewerState.wheelZoom 处理
      ctx.onWheelZoom?.(e.deltaY)
    }
  }, [])

  // 注册 wheel 为 passive:false（React 默认 passive）
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // ─── Drag Pan ───
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    // 忽略交互元素
    if (e.target.closest('button, a, input, .overlay-box')) return
    dragState.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      startPanX: panX,
      startPanY: panY,
    }
    e.currentTarget.classList.add('is-dragging')
  }, [panX, panY])

  const handleMouseMove = useCallback((e) => {
    if (!dragState.current.dragging) return
    const dx = e.clientX - dragState.current.startX
    const dy = e.clientY - dragState.current.startY
    onPanChange?.(dragState.current.startPanX + dx, dragState.current.startPanY + dy)
  }, [onPanChange])

  const handleMouseUp = useCallback((e) => {
    dragState.current.dragging = false
    e.currentTarget?.classList?.remove('is-dragging')
  }, [])

  const handleMouseLeave = useCallback((e) => {
    if (dragState.current.dragging) {
      dragState.current.dragging = false
      e.currentTarget?.classList?.remove('is-dragging')
    }
  }, [])

  // ─── Double Click Fit ───
  const handleDoubleClick = useCallback((e) => {
    if (e.target.closest('button, a, .overlay-box')) return
    onDoubleClick?.()
  }, [onDoubleClick])

  // 无页面数据时显示占位
  if (!page || !previewUrl) {
    return (
      <div className="viewer-viewport" ref={viewportRef}>
        <div className="viewer-placeholder">
          {loading ? '加载中...' : '无预览'}
        </div>
      </div>
    )
  }

  const transformStr = buildTransformString({ panX, panY, scale: renderScale, rotation: effRotation })

  // 尺寸是否已知（PageMeta 有值，或图片已加载拿到自然尺寸）。
  // 未知时先隐藏图片并显示占位，避免以错误尺寸闪现。
  const dimsKnown = dims.width > 0 && dims.height > 0

  return (
    <div
      className="viewer-viewport"
      ref={viewportRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className="viewer-transform-wrapper"
        style={{
          transform: transformStr,
          willChange: 'transform',
          width: dims.width ? `${dims.width}px` : 'auto',
          height: dims.height ? `${dims.height}px` : 'auto',
          opacity: dimsKnown ? 1 : 0,
        }}
      >
        <img
          key={loadAttempt}
          className="viewer-image"
          src={previewUrl}
          alt=""
          draggable={false}
          loading="eager"
          decoding="async"
          onLoad={handleImageLoad}
          onError={handleImageError}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            filter: grayscale ? 'grayscale(100%)' : 'none',
          }}
        />
        {overlaySlot}
      </div>

      {!dimsKnown && (
        <div className="viewer-placeholder">加载中...</div>
      )}

      {loading && (
        <div className="viewer-loading-overlay">
          <div className="viewer-spinner" />
        </div>
      )}
    </div>
  )
}

export const ViewerViewport = memo(ViewerViewportInner)
