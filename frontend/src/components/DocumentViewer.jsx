/**
 * DocumentViewer — 独立文档查看器（纯 ViewerViewport + 底部页码控制）
 *
 * 职责：
 *   自包含的文档查看组件，独立处理 loading/empty/content 三种状态。
 *   通过 PreviewResourceResolver 消费 InvoiceDocument 模型。
 *   不碰纸张/边距/打印（Architecture Law D1）。
 *
 * 布局：
 *   ┌──────────────────────┐
 *   │                      │
 *   │   ViewerViewport     │  ← flex: 1，占满
 *   │                      │
 *   ├──────────────────────┤
 *   │    PageNavigator     │  ← 固定高度，底部
 *   └──────────────────────┘
 *
 * 6B-4.3 Display Area Simplification：
 *   移除左缩略图边栏（ThumbnailStrip），改为底部轻量页码控制。
 *   展示区不再有任何布局耦合源，ViewerViewport 是唯一渲染主人。
 *
 * @module components/DocumentViewer
 */

import React, { useMemo, useCallback, useEffect, useRef } from 'react'
import { ViewerViewport } from './ViewerViewport'
import { useViewerState } from '../hooks/useViewerState'
import { resolvePreviewUrl } from '../utils/previewResourceResolver'
import { getPage } from '../models/InvoiceDocument'
import { patchPageMeta } from '../stores/DocumentStore'
import './DocumentViewer.css'

/**
 * @param {Object} props
 * @param {import('../models/InvoiceDocument').InvoiceDocument|null} props.document - 文档模型
 * @param {{ width: number, height: number }} props.containerSize - 视口容器尺寸
 * @param {number} [props.initialPage=0] - 初始页 index（0-based）
 * @param {React.ReactNode} [props.overlaySlot] - OCR/字段 Overlay 插槽
 * @param {(controller: Object|null) => void} [props.onViewerController] - 缩放控制上抬
 * @param {() => void} [props.onViewerReady] - Viewer 完全就绪回调
 * @param {Object|null} [props.file] - 当前预览 fileObj，用于拆分页 identity 判定
 */
export const DocumentViewer = React.memo(function DocumentViewer({
  document,
  containerSize,
  initialPage = 0,
  overlaySlot,
  onViewerController,
  onViewerReady,
  file,
  previewRotation,
}) {
  // Architecture Law D1：DocumentViewer 自包含 loading/empty 状态。
  const isLoading = !document || !document.pageCount
  const totalPages = document?.pageCount || 0

  const { state, actions } = useViewerState({ document, containerSize, initialPage, contentRotation: previewRotation })

  // D2-4.1：viewer controller 桥接
  // 包含 currentPage/totalPages 供 App.jsx status-bar 中的 PageNavigator 使用。
  const controllerRef = useRef(null)
  controllerRef.current = {
    mode: state.mode,
    zoomPercent: state.zoomPercent,
    currentPage: state.currentPage,
    totalPages,
    actions,
  }
  useEffect(() => {
    if (state.fitScale > 0) {
      onViewerController?.(controllerRef.current)
    }
  }, [state.mode, state.zoomPercent, state.fitScale, state.currentPage, totalPages, onViewerController])
  useEffect(() => () => onViewerController?.(null), [onViewerController])

  // Viewer 就绪检测
  const viewerReadyNotifiedRef = useRef(false)
  useEffect(() => {
    if (state.fitScale > 0 && !viewerReadyNotifiedRef.current) {
      viewerReadyNotifiedRef.current = true
      onViewerReady?.()
    }
  }, [state.fitScale, onViewerReady])

  // 切换文档/文件时重置就绪标记
  // 使用 file?.key 作为额外的变更检测维度：合成拆分页文档的 docId 基于 file.key 唯一，
  // 但对非拆分页（DocumentStore 文档）额外依赖 file.key 确保切文件时一定重置，
  // 避免 viewerReadyNotifiedRef 残留导致 onViewerReady 不触发、页面卡在 loading buffer。
  useEffect(() => {
    viewerReadyNotifiedRef.current = false
  }, [document?.docId, file?.key])

  // ─── 6B-1.1：换文档重置阅读环境 ───
  // 同时依赖 file?.key：合成拆分页文档 docId 已唯一（基于 file.key），但非拆分页场景下
  // 若 docId 相同但 file 切换（如不同实例同内容文档），仍需重置阅读环境。
  const resetActionsRef = useRef(actions)
  resetActionsRef.current = actions
  useEffect(() => {
    resetActionsRef.current.resetForDocument()
  }, [document?.docId, file?.key])

  // 当前页 PageMeta
  const currentPage = getPage(document, state.currentPage)

  // 通过 PreviewResourceResolver 解析 URL
  // Architecture Law D1：对拆分页必须传入 file 上下文，使 resolver 能判断
  // 使用 sourceDocId + pageNum 拼接 URL（父 PDF 注册身份），而非直接用
  // per-page docId——后者后端 render_engine 未注册，会命中 404 导致无限加载。
  const previewUrl = useMemo(() => {
    if (!currentPage || !document?.docId) return null
    return resolvePreviewUrl(currentPage, document.docId, file || null)
  }, [currentPage, document?.docId, file])

  const handleDoubleClick = useCallback(() => {
    actions.setFitMode()
  }, [actions])

  const handlePanChange = useCallback((panX, panY) => {
    actions.setPan(panX, panY)
  }, [actions])

  const handleNaturalSize = useCallback((pageIndex, width, height) => {
    if (!document?.docId) return
    const target = getPage(document, pageIndex)
    if (target) {
      // Architecture Law D1：强制使用上报的真实物理尺寸 (width/height) 覆盖 PageMeta。
      // 不再判断 PageMeta 是否为空，确保数据模型始终与图片的真实物理属性保持一致，
      // 移除任何可能由业务逻辑（如打印排版）引入的“虚拟尺寸”。
      patchPageMeta(document.docId, pageIndex, {
        width,
        height,
        sourceRotation: target.sourceRotation || 0,
      })
    }
  }, [document])

  // ─── 键盘导航：← → 翻页 ───
  // 仅在多页文档时生效，避免影响单页场景的其他快捷键。
  useEffect(() => {
    if (!document || document.pageCount <= 1) return
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        actions.prevPage()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        actions.nextPage()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [document, actions])

  return (
    <div className="document-viewer">
      {/* ViewerViewport：展示区唯一渲染主人。
          Architecture Law D1：无任何 overlay/sidebar/navigator 影响其布局。
          flex: 1 占满全部可用空间。
          页码控制已迁移到 App.jsx status-bar，不污染展示区。 */}
      <div className="document-viewer-main">
        <ViewerViewport
          page={currentPage}
          document={document}
          previewUrl={previewUrl}
          mode={state.mode}
          scale={state.scale}
          panX={state.panX}
          panY={state.panY}
          viewRotation={state.viewRotation}
          containerSize={containerSize}
          loading={isLoading}
          onEnterManual={actions.enterManual}
          onFitScaleChange={actions.reportFitScale}
          onPanChange={handlePanChange}
          onDoubleClick={handleDoubleClick}
          onNaturalSize={handleNaturalSize}
          overlaySlot={overlaySlot}
        />
      </div>
    </div>
  )
})
