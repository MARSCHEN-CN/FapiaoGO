/**
 * DisplayAdapter — 展示区路由适配器
 *
 * 职责（单一）：
 *   路由层：根据 mergeActive 选择渲染路径。
 *   - mergeActive=true → PreviewCanvas（legacy 合并预览，不可替代）。
 *   - 其余所有情况 → DocumentViewer（唯一渲染世界）。
 *
 * Architecture Law D1：
 *   本组件不碰纸张/边距/打印，只做路由 + 身份解析。
 *   DocumentViewer 是展示区唯一渲染器，PreviewCanvas 仅作 merge 兜底。
 *
 * 身份契约（Split Page Render Identity）：
 *   FileItem 若携带 sourceDocId → 它是父 PDF 的一页（拆分页）。
 *   展示区永远只问："我要展示源文档的第几页？"
 *   合成的单页 Document PageMeta 直接携带 renderDocId=sourceDocId,
 *   renderPage=pageNum+1，resolver 默认路径即可得到正确 URL
 *   （/preview/{sourceDocId}?page={pageNum+1}），无需特殊分支。
 *   不再依赖 DocumentStore 对兄弟拆分页做错误的多页聚合。
 *
 *   合成 Document 使用唯一 docId = `__display_${file.key}`，
 *   保证切换不同拆分页时 React 能检测到 document 身份变化（sourceDocId
 *   对同一父 PDF 的所有页相同，不能作为 docId，否则 resetForDocument、
 *   viewerReadyNotifiedRef 等依赖 docId 的 effect 不会触发，导致
 *   后续页永远卡在 loading buffer）。
 *
 * CSS 隔离：
 *   DocumentViewer 路径下，DisplayAdapter 根容器 position:absolute;inset:0
 *   填满 .canvas-scroll 的 padding-box（覆盖 legacy padding 区域），
 *   内部 overflow:hidden 自成一体——不依赖 .canvas-scroll 的滚动/阴影/mask。
 *   通过 effect 复位 .canvas-scroll 的 padding/mask（inline style），
 *   防止 legacy 样式穿透。mergeActive 时恢复 legacy 样式。
 *
 * Double Buffer 策略：
 *   DocumentViewer 始终 mounted。切文件时 old-frame buffer 显示旧帧，
 *   DocumentViewer 就绪后 fade-in，old-frame fade-out。
 *
 * @module components/DisplayAdapter
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { DocumentViewer } from './DocumentViewer'
import PreviewCanvas from './PreviewCanvas'
import { useDocument } from '../hooks/useDocument'
import { createDocument, createPageMeta } from '../models/InvoiceDocument'

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
 *   DocumentViewer 缩放控制上抬回调。
 * @param {boolean} [props.mergeActive=false] - 合并模式是否激活（回退 PreviewCanvas）。
 *
 * ── legacy PreviewCanvas 透传 props（merge 路径使用） ──
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
  // legacy pass-through（仅 merge 路径使用）
  previewCanvas,
  previewUrl,
  previewRenderVersion,
  paperLayout,
  contentLayout,
  previewRotation,
  previewLoading,
}) {
  // ── 所有 hooks 必须在顶部无条件调用（React Rules of Hooks） ──

  // documentId 优先：当 file 来自 InvoiceDocument row（_isDocumentGroup）时，
  // 使用业务 documentId（invDocId）查找 DocumentStore；否则降级为物理 identity。
  const storeDocId = file?.documentId || resolveDocId(file)
  const storeDocument = useDocument(storeDocId)

  // 拆分页判定：fileObj 携带 sourceDocId → 父 PDF 的一个分页。
  // 此时不依赖 DocumentStore 聚合（兄弟共享 sourceDocId 会错误拼成多页 Document），
  // 直接合成一个单页 Document，其 PageMeta 携带正确的 renderDocId/renderPage。
  const isSplitPage = !!file?.sourceDocId

  // 合成最终 Document：
  //   - 拆分页：单页 doc，docId 唯一（基于 file.key）保证 React 变更检测，
  //     page.renderDocId = sourceDocId，page.renderPage = pageNum + 1（渲染资源身份）。
  //   - 非拆分页：透传 DocumentStore 查询结果（可能是多页组装文档、单页图片/PDF/OFD）
  const effectiveDocument = useMemo(() => {
    if (!file) return null
    if (isSplitPage) {
      const sourceDocId = file.sourceDocId
      const pageNum = file.pageNum ?? 0
      const page = createPageMeta({
        docId: sourceDocId,
        index: 0,
        renderDocId: sourceDocId,
        renderPage: pageNum + 1,
      })
      return createDocument({
        // 使用唯一 docId 保证切换不同拆分页时 React 能检测到 document 变化，
        // 触发 resetForDocument 和 viewerReady 逻辑。
        // 加 __display_ 前缀避免与任何真实 DocumentStore 键冲突。
        docId: `__display_${file.key || sourceDocId}`,
        fileKey: file.key || '',
        pages: [page],
      })
    }
    return storeDocument || null
  }, [file, isSplitPage, file?.key, file?.sourceDocId, file?.pageNum, storeDocument])

  // 拆分页永远是单页，initialPage = 0；非拆分页使用 file.pageNum（0-based）
  const initialPage = isSplitPage ? 0 : (file?.pageNum ?? 0)

  // ── Viewer 就绪状态管理 ──
  const [viewerFullyReady, setViewerFullyReady] = useState(false)
  // file.key 变化（切文件）时重置就绪状态，触发 old-frame buffer 显示
  useEffect(() => {
    setViewerFullyReady(false)
  }, [file?.key])

  // ── Old Frame Buffer 机制 ──
  const prevStablePreviewUrlRef = useRef(null)
  useEffect(() => {
    if (viewerFullyReady && previewUrl) {
      prevStablePreviewUrlRef.current = previewUrl
    }
  }, [previewUrl, viewerFullyReady])
  const bufferPreviewUrl = viewerFullyReady ? previewUrl : (prevStablePreviewUrlRef.current || previewUrl)
  const stableFileRef = useRef(file)
  useEffect(() => {
    if (viewerFullyReady && file) {
      stableFileRef.current = file
    }
  }, [file, viewerFullyReady])
  const bufferFile = viewerFullyReady ? file : (stableFileRef.current || file)

  const rootRef = useRef(null)
  // 保存 .canvas-scroll 原始样式（首次 isolation 时保存一次）
  const canvasOriginalSavedRef = useRef(null)

  // ── CSS 隔离：将 .canvas-scroll 复位为纯滚动容器，移除 legacy 打印样式 ──
  // Architecture Law D1：展示区如实展示，不消费安全边距/纸张阴影/mask-image。
  // 策略：
  //   - mergeActive=false（DocumentViewer 路径）：application 隔离样式（padding:0/mask:none）。
  //   - mergeActive=true（PreviewCanvas 路径）：恢复 legacy 样式（PreviewCanvas 需要纸张阴影/padding）。
  //   - 卸载时：恢复原始样式。
  //   - 不随 file 切换反复 save/restore，避免两帧闪烁。
  useEffect(() => {
    let el = rootRef.current
    if (!el) {
      el = document.querySelector('.canvas-scroll')
    } else {
      while (el && !el.classList.contains('canvas-scroll')) {
        el = el.parentElement
      }
    }
    if (!el) return

    // 首次进入 isolation 时保存原始值
    if (canvasOriginalSavedRef.current === null) {
      canvasOriginalSavedRef.current = {
        padding: el.style.padding,
        paddingTop: el.style.paddingTop,
        paddingRight: el.style.paddingRight,
        paddingBottom: el.style.paddingBottom,
        paddingLeft: el.style.paddingLeft,
        webkitMaskImage: el.style.webkitMaskImage,
        maskImage: el.style.maskImage,
      }
    }

    if (mergeActive) {
      // merge 模式：恢复 legacy 样式，PreviewCanvas 需要 padding/mask 做纸张模拟
      const original = canvasOriginalSavedRef.current
      el.style.padding = original.padding
      el.style.paddingTop = original.paddingTop
      el.style.paddingRight = original.paddingRight
      el.style.paddingBottom = original.paddingBottom
      el.style.paddingLeft = original.paddingLeft
      el.style.webkitMaskImage = original.webkitMaskImage
      el.style.maskImage = original.maskImage
    } else {
      // DocumentViewer 模式：隔离 legacy 样式
      el.style.padding = '0'
      el.style.webkitMaskImage = 'none'
      el.style.maskImage = 'none'
    }

    return () => {
      // 卸载时恢复所有原始样式
      const original = canvasOriginalSavedRef.current
      if (original) {
        el.style.padding = original.padding
        el.style.paddingTop = original.paddingTop
        el.style.paddingRight = original.paddingRight
        el.style.paddingBottom = original.paddingBottom
        el.style.paddingLeft = original.paddingLeft
        el.style.webkitMaskImage = original.webkitMaskImage
        el.style.maskImage = original.maskImage
        canvasOriginalSavedRef.current = null
      }
    }
  }, [mergeActive])

  const handleViewerReady = useCallback(() => {
    setViewerFullyReady(true)
  }, [])

  // ── 合并模式：唯一保留 PreviewCanvas 的场景 ──
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

  // ── DocumentViewer 单一路径 ──
  // position: absolute; inset: 0 填满 .canvas-scroll 的 padding-box（已设 position:relative），
  // 从布局上彻底脱离 legacy padding 影响——展示区所见即所得。
  // overflow: hidden 自成一体，ViewerViewport 内部处理 pan/zoom，不依赖 .canvas-scroll 滚动。
  return (
    <div
      ref={rootRef}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        background: 'transparent',
      }}
    >
      {/* Old Frame Buffer：切文件过渡期间显示旧文件的最后稳定帧 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          opacity: viewerFullyReady ? 0 : 1,
          transition: 'opacity 0.15s ease-out',
          zIndex: viewerFullyReady ? 1 : 3,
          pointerEvents: viewerFullyReady ? 'none' : 'auto',
        }}
      >
        <PreviewCanvas
          previewFile={bufferFile}
          previewCanvas={previewCanvas}
          previewUrl={bufferPreviewUrl}
          grayscale={grayscale}
          previewRenderVersion={previewRenderVersion}
          paperLayout={paperLayout}
          contentLayout={contentLayout}
          previewRotation={previewRotation}
          previewLoading={previewLoading}
          containerSize={containerSize}
        />
      </div>

      {/* DocumentViewer：始终 mounted */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          zIndex: 2,
          pointerEvents: 'auto',
        }}
      >
        <DocumentViewer
          document={effectiveDocument}
          containerSize={containerSize}
          initialPage={initialPage}
          grayscale={grayscale}
          onViewerController={onViewerController}
          onViewerReady={handleViewerReady}
          file={file}
        />
      </div>
    </div>
  )
})
