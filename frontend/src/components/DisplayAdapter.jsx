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

import React from 'react'
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
 * Step 10 阶段 DocumentViewer 仅服务 PDF：
 * 后端 /preview/{docId} 只能栅格化 PDF（图片渲染分支尚未实现，恒 404），
 * 图片/OFD 文件必须继续走 legacy PreviewCanvas（客户端 canvas 回退），
 * 否则会被新路径路由到 DocumentViewer 后预览损坏。
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
  const docId = resolveDocId(file)
  const document = useDocument(docId)

  // 拆分页定位：fileObj.pageNum 为 1-based（后端 page_index），
  // 转为 Viewer 的 0-based 页 index。非拆分文件 pageNum 为 null → 第 1 页。
  const initialPage = (file?.pageNum || 1) - 1

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

  // 新路径：PDF 且已注册有效 Document（至少 1 页）。
  // 非 PDF（图片/OFD）后端 /preview 无法服务，保持 legacy 路径。
  if (isPdfFile(file) && document && document.pageCount > 0) {
    return (
      <DocumentViewer
        document={document}
        containerSize={containerSize}
        initialPage={initialPage}
        grayscale={grayscale}
        onViewerController={onViewerController}
      />
    )
  }

  // 旧路径：fallback 到 PreviewCanvas（保留一个版本周期）
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
})
