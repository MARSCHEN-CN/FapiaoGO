/**
 * DisplayAdapter — 展示区双轨适配器
 *
 * 职责（单一）：
 *   判断当前文件是否已注册 InvoiceDocument：
 *     - 有 → 走新展示路径 DocumentViewer（Document/Page/Viewer 三层）。
 *     - 无 → 走旧展示路径 PreviewCanvas（legacy，保留一个版本周期）。
 *
 * 为什么独立成组件（而不是直接改 App.jsx）：
 *   App.jsx 是应用组合层。DocumentStore 查询、Viewer 判断、Preview fallback
 *   属于"展示路由"职责，应收敛在本组件，避免 App.jsx 重新膨胀为大组件。
 *
 * 响应式：
 *   通过 useDocument 订阅 DocumentStore。即使预览先于解析完成显示
 *   （docId 已在 fileObj 上，但 Document 稍后才注册），也能在注册后
 *   自动从 PreviewCanvas 切换到 DocumentViewer，无需刷新或导航。
 *
 * Architecture Law D1：
 *   本组件只做路由，不碰纸张/边距（Print），也不碰 zoom/pan（Viewer 内部）。
 *
 * @module components/DisplayAdapter
 */

import React, { useState, useEffect, useCallback } from 'react'
import { DocumentViewer } from './DocumentViewer'
import PreviewCanvas from './PreviewCanvas'
import { useDocument } from '../hooks/useDocument'

/**
 * 从 fileObj 解析规范 docId。
 *
 * 身份契约（Identity Contract v1.1）：identity.docId 是规范出口，
 * 顶层 docId 为兼容字段。读取顺序：identity.docId → docId。
 * 永不使用 key / filename 作为文档身份。
 *
 * @param {Object|null} file - fileObj
 * @returns {string|null} docId，无法解析时返回 null
 */
export function resolveDocId(file) {
  return file?.identity?.docId || file?.docId || null
}

/**
 * 判断文件是否为 PDF。
 *
 * 仅用于需要区分 PDF 与图片/OFD 的少数调用点（如导出路径选择）。
 * 注意：DocumentViewer 渲染路由不依赖本函数——PDF/Image/OFD 统一由
 * docId + pageCount 驱动（13A-3 后 OFD 与 PDF/Image 同级）。
 *
 * @param {Object|null} file - fileObj
 * @returns {boolean}
 */
export function isPdfFile(file) {
  return file?.fileFormat === 'pdf' || file?._fileFormat === 'pdf'
}

/**
 * @param {Object} props
 * @param {Object|null} props.file - 当前预览文件对象（fileObj）
 * @param {{ width: number, height: number }} props.containerSize - 视口容器尺寸
 * @param {boolean} [props.grayscale=false] - 灰度模式
 * @param {(controller: Object|null) => void} [props.onViewerController] -
 *   D2-4.1：DocumentViewer 缩放控制上抬回调（透传给 DocumentViewer，供 App control-bar ZoomToolbar）。
 *
 * @param {boolean} [props.mergeActive=false] - 合并模式是否激活。
 *   合并模式下 DocumentViewer 无法展示多票合成布局，必须回退到 PreviewCanvas。
 *
 * ── 以下为 legacy PreviewCanvas 透传 props（新路径不使用） ──
 * @param {HTMLCanvasElement|null} [props.previewCanvas]
 * @param {string|null} [props.previewUrl]
 * @param {number} [props.previewRenderVersion]
 * @param {Object|null} [props.paperLayout]
 * @param {Object|null} [props.contentLayout]
 * @param {number} [props.previewRotation]
 * @param {boolean} [props.previewLoading]
 */
export const DisplayAdapter = React.memo(function DisplayAdapter({
  file,
  containerSize,
  grayscale = false,
  onViewerController,
  mergeActive = false,
  // legacy pass-through
  previewCanvas,
  previewUrl,
  previewRenderVersion,
  paperLayout,
  contentLayout,
  previewRotation,
  previewLoading,
}) {
  // documentId 优先：当 file 来自 InvoiceDocument row（_isDocumentGroup）时，
  // 使用业务 documentId（invDocId）查找 DocumentStore 中的 InvoiceDocument，
  // 使 Viewer 获得完整 pages[]（多页）；否则降级为物理页 identity。
  // 两层模型分离：FileList 已升级为 Document 层，Preview 链路同步。
  const docId = file?.documentId || resolveDocId(file)
  const document = useDocument(docId)

  // 拆分页定位：fileObj.pageNum 为 1-based（后端 page_index），
  // 转为 Viewer 的 0-based 页 index。非拆分文件 pageNum 为 null → 第 1 页。
  // 解析后的拆分页（docId !== sourceDocId）已独立注册为单页文档，
  // pageNum 仅保留原始排序意义，preview 时应定位到 index 0。
  const isParsedSplitPage = !!(file?.sourceDocId && file?.docId !== file?.sourceDocId)
  const initialPage = isParsedSplitPage ? 0 : (file?.pageNum ?? 0)

  // 合并模式守卫：DocumentViewer 只展示单页，无多票合成能力。
  // merge 模式下必须走 PreviewCanvas（renderMultipleItemsToCanvas 合成画布）。
  // 未来 Compose Backend 成熟后可移除此守卫。
  if (mergeActive) {
    return (
      <PreviewCanvas
        previewFile={file}
        previewCanvas={previewCanvas}
        previewUrl={previewUrl}
        grayscale={grayscale}
        previewRenderVersion={previewRenderVersion}
        paperLayout={paperLayout}
        contentLayout={contentLayout}
        previewRotation={previewRotation}
        previewLoading={previewLoading}
        containerSize={containerSize}
      />
    )
  }

  // Viewer 是否就绪（文档已注册且有页面）
  const viewerReady = !!(document && document.pageCount > 0)

  // Viewer 完全就绪状态（fitScale > 0）：确保缩放和自适应功能正常后再显示
  const [viewerFullyReady, setViewerFullyReady] = useState(false)

  // 切换文件时重置就绪状态
  useEffect(() => {
    setViewerFullyReady(false)
  }, [file?.key, docId])

  // Viewer 就绪回调：当 fitScale 首次变为有效值时触发
  const handleViewerReady = useCallback(() => {
    setViewerFullyReady(true)
  }, [])

  return (
    // 6B-4.2：容器高度必须由 flex 撑满，而非内容撑高。
    // 此前 height:100% 在 flex 容器（.canvas-scroll）中解析失败 → 高度退化为
    // 内容高度（wrapper+padding）→ 图片 wrapper 小 → 容器塌缩 61px；
    // PDF wrapper 大 → 被内容撑高掩盖（看似正常）。
    // 修复：flex:1 + min-height:0 + display:flex（canvas-scroll 内 stretch 撑满），
    // .document-viewer(flex:1) 在 flex 容器中正确占满。
    <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
      {/* PreviewCanvas 作为底层持续存在，直到 DocumentViewer 完全就绪 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: viewerFullyReady ? 0 : 1,
          transition: 'opacity 0.15s ease-out',
          zIndex: viewerFullyReady ? 1 : 2,
          pointerEvents: viewerFullyReady ? 'none' : 'auto',
        }}
      >
        <PreviewCanvas
          previewFile={file}
          previewCanvas={previewCanvas}
          previewUrl={previewUrl}
          grayscale={grayscale}
          previewRenderVersion={previewRenderVersion}
          paperLayout={paperLayout}
          contentLayout={contentLayout}
          previewRotation={previewRotation}
          previewLoading={previewLoading}
          containerSize={containerSize}
        />
      </div>

      {/* DocumentViewer 在上层，viewerReady 时渲染，viewerFullyReady 时淡入显示 */}
      {viewerReady && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 3,
            opacity: viewerFullyReady ? 1 : 0,
            transition: 'opacity 0.15s ease-in',
            pointerEvents: viewerFullyReady ? 'auto' : 'none',
          }}
        >
          <DocumentViewer
            document={document}
            containerSize={containerSize}
            initialPage={initialPage}
            grayscale={grayscale}
            onViewerController={onViewerController}
            onViewerReady={handleViewerReady}
          />
        </div>
      )}
    </div>
  )
})
