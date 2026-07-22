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

import React, { useMemo, useCallback, useEffect } from 'react'
import { ViewerViewport } from './ViewerViewport'
import { ThumbnailStrip } from './ThumbnailStrip'
import { useViewerState } from '../hooks/useViewerState'
import { resolvePreviewUrl } from '../utils/previewResourceResolver'
import { getPage } from '../models/InvoiceDocument'
import { patchPageMeta } from '../stores/DocumentStore'
import './DocumentViewer.css'

/**
 * @param {Object} props
 * @param {import('../models/InvoiceDocument').InvoiceDocument|null} props.document - 文档模型
 * @param {{ width: number, height: number }} props.containerSize - 视口容器尺寸
 * @param {number} [props.initialPage=0] - 初始页 index（0-based，来自 fileObj.pageNum - 1）
 * @param {boolean} [props.grayscale=false] - 灰度模式
 * @param {boolean} [props.loading=false] - 加载状态
 * @param {React.ReactNode} [props.overlaySlot] - OCR/字段 Overlay 插槽
 * @param {React.ReactNode} [props.toolbarSlot] - 工具栏插槽（zoom/rotate 按钮）
 * @param {(zoom: {mode: 'fit'|'manual', scale: number|null}|null) => void} [props.onViewerZoomChange] -
 *   D2-3 4b：缩放显示上抬回调。把 useViewerState 的 mode/scale 上报给 App toolbar 指示器；
 *   组件卸载时上报 null（避免切到 legacy 路径后 toolbar 残留 viewer 显示）。
 */
export const DocumentViewer = React.memo(function DocumentViewer({
  document,
  containerSize,
  initialPage = 0,
  grayscale = false,
  loading = false,
  overlaySlot,
  toolbarSlot,
  onViewerZoomChange,
}) {
  const { state, actions } = useViewerState({ document, containerSize, initialPage })

  // D2-3 4b：把 mode/scale 上抬给 App toolbar 指示器（只读展示通道，非新 zoom source）。
  // 卸载时上报 null（独立 effect，cleanup 仅在卸载/onViewerZoomChange 变化时触发，避免每次
  // mode/scale 变化先清空再赋值造成闪烁）。
  useEffect(() => {
    onViewerZoomChange?.({ mode: state.mode, scale: state.scale })
  }, [state.mode, state.scale, onViewerZoomChange])
  useEffect(() => {
    return () => onViewerZoomChange?.(null)
  }, [onViewerZoomChange])

  // 当前页 PageMeta
  const currentPage = getPage(document, state.currentPage)

  // 通过 PreviewResourceResolver 解析 URL（Architecture Law D1: Document 不含 URL）
  const previewUrl = useMemo(() => {
    if (!currentPage || !document?.docId) return null
    return resolvePreviewUrl(currentPage, document.docId)
  }, [currentPage, document?.docId])

  // 双击适应（D2-3：回到 fit 模式，scale=null）
  const handleDoubleClick = useCallback(() => {
    actions.setFitMode()
  }, [actions])

  // 平移
  const handlePanChange = useCallback((panX, panY) => {
    actions.setPan(panX, panY)
  }, [actions])

  // 图片加载后回填真实像素尺寸（过渡期注册的 PageMeta 尺寸为 0×0）。
  // D1：尺寸属于业务数据，写回 DocumentStore，供 Viewer/Print 共享。
  const handleNaturalSize = useCallback((pageIndex, width, height) => {
    if (!document?.docId) return
    const target = getPage(document, pageIndex)
    if (target && (!target.width || !target.height)) {
      patchPageMeta(document.docId, pageIndex, {
        width,
        height,
        sourceRotation: target.sourceRotation || 0,
      })
    }
  }, [document])

  return (
    <div className="document-viewer">
      {/* 主视口（上方） */}
      <div className="document-viewer-main">
        {toolbarSlot}

        <ViewerViewport
          page={currentPage}
          previewUrl={previewUrl}
          mode={state.mode}
          scale={state.scale}
          panX={state.panX}
          panY={state.panY}
          viewRotation={state.viewRotation}
          containerSize={containerSize}
          grayscale={grayscale}
          loading={loading}
          onEnterManual={actions.enterManual}
          onPanChange={handlePanChange}
          onDoubleClick={handleDoubleClick}
          onNaturalSize={handleNaturalSize}
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
})
