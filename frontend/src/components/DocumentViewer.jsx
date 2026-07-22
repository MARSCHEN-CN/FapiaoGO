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

import React, { useMemo, useCallback, useEffect, useRef } from 'react'
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
 * @param {(controller: {mode: 'fit'|'manual', zoomPercent: number, actions: import('../hooks/useViewerState').ViewerActions}|null) => void} [props.onViewerController] -
 *   D2-4.1：viewer 缩放控制上抬回调。把 useViewerState 的 zoom 显示态 + actions 上报给 App，
 *   供 control-bar 的 ZoomToolbar 渲染（状态归属 Viewer，UI 位置在 control-bar）。卸载时上报 null。
 */
export const DocumentViewer = React.memo(function DocumentViewer({
  document,
  containerSize,
  initialPage = 0,
  grayscale = false,
  loading = false,
  overlaySlot,
  onViewerController,
}) {
  const { state, actions } = useViewerState({ document, containerSize, initialPage })

  // D2-4.1：viewer controller 桥接 —— 把缩放控制上抬给 App control-bar 的 ZoomToolbar。
  // 状态归属仍在 useViewerState（Viewer 内部），UI 位置回到用户习惯的 control-bar。
  // 关键：useViewerState 每次渲染返回新的 state/actions 对象（未 useMemo），若把它们放进 deps，
  // 拖拽平移（panX/panY 每帧变化）会让 App 每帧重渲染。故只在 mode/zoomPercent/fitScale 变化时
  // 通知 App（这三者决定工具栏显示与 +/− 档位目标），actions 经 ref 取最新、不进 deps。
  // fitScale 必须在 deps：applyZoomStep 依赖它，resize 后不通知会让「+」用陈旧 fitScale 算错绝对 scale。
  const controllerRef = useRef(null)
  controllerRef.current = { mode: state.mode, zoomPercent: state.zoomPercent, actions }
  useEffect(() => {
    onViewerController?.(controllerRef.current)
  }, [state.mode, state.zoomPercent, state.fitScale, onViewerController])
  // 卸载时清空（切到 legacy 路径后 App 回退旧 toolbar，避免残留死 actions）
  useEffect(() => () => onViewerController?.(null), [onViewerController])

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
          onFitScaleChange={actions.reportFitScale}
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
