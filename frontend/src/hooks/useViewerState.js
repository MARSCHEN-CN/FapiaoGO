/**
 * useViewerState — Document Viewer 交互状态机
 *
 * 职责：
 *   管理 Viewer 的全部交互状态：currentPage / zoom / pan / viewRotation。
 *   提供离散/连续缩放、平移、旋转、翻页 actions。
 *   页切换时 reset zoom+pan，保留 viewRotation（document 级全局）。
 *
 * 所有权：
 *   由 DocumentViewer 组件调用。
 *   不依赖 usePreview / PreviewCanvas / 打印模块。
 *
 * Architecture Law D1：
 *   viewRotation 是用户临时查看旋转，与 PageMeta.sourceRotation 分离。
 *   effectiveRotation = sourceRotation + viewRotation。
 *
 * @module hooks/useViewerState
 */

import { useState, useCallback, useRef } from 'react'
import { nextZoomStep } from './zoomStep.mjs'
import { applyWheelZoom } from './continuousZoom.mjs'
import { clampPan, computeFitScale, computeDisplaySize, rotatedDimensions } from '../utils/viewerTransform'
import { effectiveRotation } from '../models/InvoiceDocument'

const ZOOM_STEPS = [25, 50, 75, 100, 125, 150, 200]
const ZOOM_MIN = 10
const ZOOM_MAX = 500

/**
 * @typedef {Object} ViewerState
 * @property {number} currentPage - 当前显示页 index（0-based）
 * @property {number} zoom - 缩放百分比（100 = fit）
 * @property {number} panX - 水平平移（px）
 * @property {number} panY - 垂直平移（px）
 * @property {number} viewRotation - 用户临时旋转（0/90/180/270）
 */

/**
 * @typedef {Object} ViewerActions
 * @property {() => void} zoomIn - 离散放大一档
 * @property {() => void} zoomOut - 离散缩小一档
 * @property {() => void} setFit - 适应窗口（zoom=100）
 * @property {(pct: number) => void} setManualScale - 设置精确缩放百分比
 * @property {(deltaY: number) => void} wheelZoom - 连续滚轮缩放
 * @property {() => void} rotateLeft - 逆时针旋转 90°
 * @property {() => void} rotateRight - 顺时针旋转 90°
 * @property {(index: number) => void} goToPage - 跳转到指定页
 * @property {() => void} nextPage - 下一页
 * @property {() => void} prevPage - 上一页
 * @property {(panX: number, panY: number) => void} setPan - 设置平移
 * @property {(deltaX: number, deltaY: number) => void} panBy - 增量平移
 * @property {() => void} resetView - 重置 zoom+pan（保留 viewRotation）
 */

/**
 * Document Viewer 交互状态 hook。
 *
 * @param {Object} opts
 * @param {import('../models/InvoiceDocument').InvoiceDocument|null} opts.document - 当前文档
 * @param {{ width: number, height: number }} opts.containerSize - 视口容器尺寸
 * @returns {{ state: ViewerState, actions: ViewerActions }}
 */
export function useViewerState({ document, containerSize }) {
  const [currentPage, setCurrentPage] = useState(0)
  const [zoom, setZoom] = useState(100)
  const [panX, setPanX] = useState(0)
  const [panY, setPanY] = useState(0)
  const [viewRotation, setViewRotation] = useState(0)

  // 用 ref 追踪容器尺寸，避免闭包陈旧
  const containerRef = useRef(containerSize)
  containerRef.current = containerSize

  // 当前页 PageMeta
  const page = document?.pages?.[currentPage] || null

  // 计算当前页有效尺寸（考虑旋转）
  const getPageDimensions = useCallback(() => {
    if (!page) return { width: 0, height: 0 }
    const effRotation = effectiveRotation(page, viewRotation)
    return rotatedDimensions(page.width || 0, page.height || 0, effRotation)
  }, [page, viewRotation])

  // ─── Zoom Actions ───

  const zoomIn = useCallback(() => {
    setZoom((z) => nextZoomStep(z, 'in', ZOOM_STEPS))
    setPanX(0)
    setPanY(0)
  }, [])

  const zoomOut = useCallback(() => {
    setZoom((z) => nextZoomStep(z, 'out', ZOOM_STEPS))
    setPanX(0)
    setPanY(0)
  }, [])

  const setFit = useCallback(() => {
    setZoom(100)
    setPanX(0)
    setPanY(0)
  }, [])

  const setManualScale = useCallback((pct) => {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pct))
    setZoom(clamped)
  }, [])

  const wheelZoom = useCallback((deltaY) => {
    setZoom((z) => applyWheelZoom(z, deltaY, { min: ZOOM_MIN, max: ZOOM_MAX }))
  }, [])

  // ─── Rotation Actions ───

  const rotateLeft = useCallback(() => {
    setViewRotation((r) => (r + 270) % 360)
    setPanX(0)
    setPanY(0)
  }, [])

  const rotateRight = useCallback(() => {
    setViewRotation((r) => (r + 90) % 360)
    setPanX(0)
    setPanY(0)
  }, [])

  // ─── Page Navigation ───

  const goToPage = useCallback((index) => {
    if (!document) return
    const clamped = Math.min(document.pageCount - 1, Math.max(0, index))
    setCurrentPage(clamped)
    // 页切换：reset zoom + pan，保留 viewRotation
    setZoom(100)
    setPanX(0)
    setPanY(0)
  }, [document])

  const nextPage = useCallback(() => {
    goToPage(currentPage + 1)
  }, [currentPage, goToPage])

  const prevPage = useCallback(() => {
    goToPage(currentPage - 1)
  }, [currentPage, goToPage])

  // ─── Pan Actions ───

  const setPan = useCallback((newPanX, newPanY) => {
    const dims = getPageDimensions()
    const container = containerRef.current
    if (!dims.width || !container?.width) {
      setPanX(newPanX)
      setPanY(newPanY)
      return
    }
    const fitScale = computeFitScale(dims.width, dims.height, container.width, container.height)
    const { displayW, displayH } = computeDisplaySize(dims.width, dims.height, fitScale, zoom)
    const clamped = clampPan(newPanX, newPanY, displayW, displayH, container.width, container.height)
    setPanX(clamped.panX)
    setPanY(clamped.panY)
  }, [getPageDimensions, zoom])

  const panBy = useCallback((deltaX, deltaY) => {
    setPanX((x) => x + deltaX)
    setPanY((y) => y + deltaY)
    // clamp 在下一帧由 setPan 处理，这里先增量
  }, [])

  const resetView = useCallback(() => {
    setZoom(100)
    setPanX(0)
    setPanY(0)
  }, [])

  return {
    state: {
      currentPage,
      zoom,
      panX,
      panY,
      viewRotation,
    },
    actions: {
      zoomIn,
      zoomOut,
      setFit,
      setManualScale,
      wheelZoom,
      rotateLeft,
      rotateRight,
      goToPage,
      nextPage,
      prevPage,
      setPan,
      panBy,
      resetView,
    },
  }
}
