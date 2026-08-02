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
 *   FileItem 若携带 sourceDocId 且不是多页文档组（_isDocumentGroup）→ 它是父 PDF 的
 *   一个独立分页（拆分页）。多页发票组（_isDocumentGroup=true）不走拆分页路径，
 *   而是使用 DocumentStore 中的多页 InvoiceDocument（assembly 路径注册）。
 *   展示区永远只问："我要展示源文档的第几页？"
 *   合成的单页 Document PageMeta 直接携带 renderDocId=sourceDocId,
 *   renderPage=pageNum（1-based，后端 page_index），resolver 默认路径即可得到正确 URL
 *   （/preview/{sourceDocId}?page={pageNum}），无需特殊分支。
 *
 *   合成 Document 使用唯一 docId = `__display_${file.key}`，
 *   保证切换不同拆分页时 React 能检测到 document 身份变化（sourceDocId
 *   对同一父 PDF 的所有页相同，不能作为 docId，否则 resetForDocument、
 *   viewerReadyNotifiedRef 等依赖 docId 的 effect 不会触发）。
 *
 * CSS 隔离：
 *   DocumentViewer 路径下，DisplayAdapter 根容器 position:absolute;inset:0
 *   填满 .canvas-scroll 的 padding-box（覆盖 legacy padding 区域），
 *   内部 overflow:hidden 自成一体——不依赖 .canvas-scroll 的滚动/阴影/mask。
 *   通过 effect 复位 .canvas-scroll 的 padding/mask（inline style），
 *   防止 legacy 样式穿透。mergeActive 时恢复 legacy 样式。
 *
 * Old-frame buffer 已移除：
 *   此前在 DocumentViewer 路径下叠加了一层 PreviewCanvas 作为"旧帧缓冲"，
 *   用于切文件过渡期间显示上一文件的最后稳定帧。但这导致：
 *   1. PreviewCanvas 发起 legacy usePreview.js 请求（携带 paper_w 安全边距参数）
 *   2. 切换文件时缓冲层显示旧文件内容（"点B显示A的内容"）
 *   3. 两个 loading 状态并存（"看到两个加载中"）
 *   4. DocumentViewer 永远不 ready 时缓冲层永远不消失
 *   DocumentViewer 自带 loading 状态，无需外部缓冲。
 *
 * @module components/DisplayAdapter
 */

import React, { useEffect, useRef, useMemo } from 'react'
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

  // 拆分页判定：fileObj 携带 sourceDocId 且不是多页文档组 → 父 PDF 的一个独立分页。
  // _isDocumentGroup=true 的多页发票不作为拆分页，应走 DocumentStore 多页文档路径。
  const isSplitPage = !!file?.sourceDocId && !file?._isDocumentGroup

  // 合成最终 Document：
  //   - 拆分页（独立单页）：单页 doc，docId 唯一（基于 file.key）保证 React 变更检测，
  //     page.renderDocId = sourceDocId，page.renderPage = pageNum（1-based，后端 page_index）。
  //   - 非拆分页（多页组 / 普通文件）：透传 DocumentStore 查询结果
  const effectiveDocument = useMemo(() => {
    if (!file) return null
    if (isSplitPage) {
      const sourceDocId = file.sourceDocId
      const pageNum = file.pageNum ?? 1  // 1-based（后端 page_index = i+1）
      const page = createPageMeta({
        docId: sourceDocId,
        index: 0,
        renderDocId: sourceDocId,
        renderPage: pageNum,  // 1-based，直接用于 /preview/{sourceDocId}?page=N
      })
      return createDocument({
        docId: `__display_${file.key || sourceDocId}`,
        fileKey: file.key || '',
        pages: [page],
      })
    }
    return storeDocument || null
  }, [file, isSplitPage, file?.key, file?.sourceDocId, file?.pageNum, storeDocument])

  // 拆分页永远是单页；多页组从首页开始；普通文件也是单页 → 统一 initialPage = 0
  const initialPage = 0

  const rootRef = useRef(null)
  // 保存 .canvas-scroll 原始样式（首次 isolation 时保存一次）
  const canvasOriginalSavedRef = useRef(null)

  // ── CSS 隔离：将 .canvas-scroll 复位为纯滚动容器，移除 legacy 打印样式 ──
  // Architecture Law D1：展示区如实展示，不消费安全边距/纸张阴影/mask-image。
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
  // position: absolute; inset: 0 填满 .canvas-scroll 的 padding-box，
  // 从布局上彻底脱离 legacy padding 影响——展示区所见即所得。
  // overflow: hidden 自成一体，ViewerViewport 内部处理 pan/zoom。
  // 不再叠加 old-frame buffer（PreviewCanvas），避免 legacy 请求和内容错位。
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
      <DocumentViewer
        document={effectiveDocument}
        containerSize={containerSize}
        initialPage={initialPage}
        grayscale={grayscale}
        onViewerController={onViewerController}
        file={file}
      />
    </div>
  )
})
