/**
 * DocumentViewer — 文档查看器主组件
 *
 * 职责：
 *   组合 ViewerViewport + useViewerState，提供完整的文档查看体验。
 *   消费 InvoiceDocument 模型，通过 PreviewResourceResolver 获取资源 URL。
 *   不碰纸张/边距/打印（Architecture Law D1）。
 *
 * 所有权：
 *   由 App.jsx 渲染（替代 PreviewCanvas 的位置）。
 *   Phase 4 阶段用 mock 数据验证，Phase 6 接入真实导入。
 *
 * @module components/DocumentViewer
 */

import React, { useMemo, useCallback } from 'react'
import { ViewerViewport } from './ViewerViewport'
import { ThumbnailStrip } from './ThumbnailStrip'
import { useViewerState } from '../hooks/useViewerState'
import { resolvePreviewUrl } from '../utils/previewResourceResolver'
import { getPage } from '../models/InvoiceDocument'
import './DocumentViewer.css'

/**
 * @param {Object} props
 * @param {import('../models/InvoiceDocument').InvoiceDocument|null} props.document - 文档模型
 * @param {{ width: number, height: number }} props.containerSize - 视口容器尺寸
 * @param {boolean} [props.grayscale=false] - 灰度模式
 * @param {boolean} [props.loading=false] - 加载状态
 * @param {React.ReactNode} [props.overlaySlot] - OCR/字段 Overlay 插槽
 * @param {React.ReactNode} [props.toolbarSlot] - 工具栏插槽（zoom/rotate 按钮）
 */
export function DocumentViewer({
  document,
  containerSize,
  grayscale = false,
  loading = false,
  overlaySlot,
  toolbarSlot,
}) {
  const { state, actions } = useViewerState({ document, containerSize })

  // 当前页 PageMeta
  const currentPage = getPage(document, state.currentPage)

  // 通过 PreviewResourceResolver 解析 URL（Architecture Law D1: Document 不含 URL）
  const previewUrl = useMemo(() => {
    if (!currentPage || !document?.docId) return null
    return resolvePreviewUrl(currentPage, document.docId)
  }, [currentPage, document?.docId])

  // 双击适应
  const handleDoubleClick = useCallback(() => {
    actions.setFit()
  }, [actions])

  // 平移
  const handlePanChange = useCallback((panX, panY) => {
    actions.setPan(panX, panY)
  }, [actions])

  return (
    <div className="document-viewer">
      {/* 主视口（上方） */}
      <div className="document-viewer-main">
        {toolbarSlot}

        <ViewerViewport
          page={currentPage}
          previewUrl={previewUrl}
          zoom={state.zoom}
          panX={state.panX}
          panY={state.panY}
          viewRotation={state.viewRotation}
          containerSize={containerSize}
          grayscale={grayscale}
          loading={loading}
          onWheelZoom={actions.wheelZoom}
          onPanChange={handlePanChange}
          onDoubleClick={handleDoubleClick}
          overlaySlot={overlaySlot}
        />

        {/* 页码指示器（多页时显示） */}
        {document && document.pageCount > 1 && (
          <div className="document-viewer-page-indicator">
            {state.currentPage + 1} / {document.pageCount}
          </div>
        )}
      </div>

      {/* 缩略图横向导航栏（底部，多页时自动显示） */}
      <ThumbnailStrip
        document={document}
        currentPage={state.currentPage}
        onPageSelect={actions.goToPage}
      />
    </div>
  )
}
