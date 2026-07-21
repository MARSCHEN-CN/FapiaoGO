/**
 * ViewerViewport — 图片变换渲染层
 *
 * 职责：
 *   渲染当前页 <img> + CSS transform（zoom/pan/rotate）。
 *   处理交互手势：Ctrl+wheel zoom、拖拽 pan、双击 fit。
 *   不管理状态（由 useViewerState 驱动），纯渲染 + 事件上报。
 *
 * Architecture Law D1：
 *   只消费 resolvePreviewUrl 产出的 URL，不碰纸张/边距。
 *
 * @module components/ViewerViewport
 */

import React, { useRef, useCallback, useEffect, memo } from 'react'
import { buildTransformString, computeFitScale, computeDisplaySize, rotatedDimensions } from '../utils/viewerTransform'
import { effectiveRotation } from '../models/InvoiceDocument'

/**
 * @param {Object} props
 * @param {import('../models/InvoiceDocument').PageMeta|null} props.page - 当前页 PageMeta
 * @param {string|null} props.previewUrl - 当前页预览 URL（由 PreviewResourceResolver 解析）
 * @param {number} props.zoom - 缩放百分比（100=fit）
 * @param {number} props.panX - 水平平移
 * @param {number} props.panY - 垂直平移
 * @param {number} props.viewRotation - 用户查看旋转
 * @param {{ width: number, height: number }} props.containerSize - 容器尺寸
 * @param {boolean} props.grayscale - 灰度模式
 * @param {boolean} props.loading - 加载中
 * @param {(deltaY: number) => void} props.onWheelZoom - 滚轮缩放回调
 * @param {(panX: number, panY: number) => void} props.onPanChange - 平移回调
 * @param {() => void} props.onDoubleClick - 双击适应回调
 * @param {React.ReactNode} [props.overlaySlot] - Overlay 插槽（OCR/字段高亮）
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
  overlaySlot,
}) {
  const viewportRef = useRef(null)
  const dragState = useRef({ dragging: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0 })

  // 计算有效旋转和尺寸
  const effRotation = page ? effectiveRotation(page, viewRotation) : 0
  const dims = page ? rotatedDimensions(page.width || 0, page.height || 0, effRotation) : { width: 0, height: 0 }

  // 计算 fit scale 和显示尺寸
  const fitScale = computeFitScale(dims.width, dims.height, containerSize?.width || 0, containerSize?.height || 0)
  const { displayW, displayH, scale } = computeDisplaySize(dims.width, dims.height, fitScale, zoom)

  // ─── Wheel Zoom ───
  const handleWheel = useCallback((e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      onWheelZoom?.(e.deltaY)
    }
  }, [onWheelZoom])

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

  const transformStr = buildTransformString({ panX, panY, scale, rotation: effRotation })

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
        }}
      >
        <img
          className="viewer-image"
          src={previewUrl}
          alt=""
          draggable={false}
          loading="eager"
          decoding="async"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            filter: grayscale ? 'grayscale(100%)' : 'none',
          }}
        />
        {overlaySlot}
      </div>

      {loading && (
        <div className="viewer-loading-overlay">
          <div className="viewer-spinner" />
        </div>
      )}
    </div>
  )
}

export const ViewerViewport = memo(ViewerViewportInner)
