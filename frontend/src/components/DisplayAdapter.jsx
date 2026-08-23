/**
 * DisplayAdapter — 展示区适配器
 *
 * 职责（单一）：
 *   展示区 = 始终如实展示当前选中的发票，不受任何打印设置影响。
 *   只做身份解析 + DocumentViewer 路由，不消费 merge/paper/margin 等配置。
 *
 * Architecture Law D1：
 *   本组件不碰纸张/边距/打印，只做身份解析。
 *   DocumentViewer 是展示区唯一渲染器。
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
 *   DocumentViewer 根容器 position:absolute;inset:0
 *   填满 .canvas-scroll 的 padding-box，内部 overflow:hidden 自成一体。
 *   通过 effect 复位 .canvas-scroll 的 padding/mask（inline style），
 *   防止 legacy 样式穿透。
 *
 * @module components/DisplayAdapter
 */

import React, { useEffect, useRef, useMemo } from 'react'
import { DocumentViewer } from './DocumentViewer'
import { useDocument } from '../hooks/useDocument'
import { createDocument, createPageMeta } from '../models/InvoiceDocument'
import { resolveDocumentIdentity, getRegisteredDocIds, getDocument } from '../stores/DocumentStore'
import { getActiveSessionId } from '../stores/ImportSessionStore'
import { useFileContext } from '../contexts/FileContext'

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
 * @param {(controller: Object|null) => void} [props.onViewerController] -
 *   DocumentViewer 缩放控制上抬回调。
 */
export const DisplayAdapter = React.memo(function DisplayAdapter({
  file,
  containerSize,
  onViewerController,
  previewRotation,
}) {
  // ── 所有 hooks 必须在顶部无条件调用（React Rules of Hooks） ──

  // [S7] 只读 correlation：FileContext 最近一次 commit 的 materializedDocs 标识。
  //   viewSig 相同的两条 [S7] 日志（materializedDocs / display）才允许配对成一次证据。
  //   ⚠️ 仅消费 viewSig 用于 console.log，不参与任何渲染分支；context 订阅只带来
  //   探针期可忽略的额外重渲染，不影响渲染输出（React.memo 不拦截 context，仅此而已）。
  const { s7Correlation } = useFileContext()

  // 存储键查找：使用统一的 resolveDocumentIdentity 解析
  // 同时有 instanceId + invoiceDocumentId → 复合键（完整身份）
  // 与 DocumentStore 存储键保持一致
  const storeDocId = resolveDocumentIdentity(file) || resolveDocId(file) || file?.key
  const storeDocument = useDocument(storeDocId)

  // [O2-D-PROBE] 只读：Display Identity → Store Lookup → Loading 全链快照
  // 目标：判定 OFD 卡 Loading 是 Case D1（store miss，注册/生命周期问题）、
  // D2（file 缺复合身份，assembly 未覆盖）、还是 D3（store hit 但 viewer readiness 问题）。
  if (process.env.NODE_ENV === 'development' && file) {
    console.log(`[O2-D-PROBE] trace=${file.__traceId || 'UNDEFINED'} fmt=${file._fileFormat || file.fileFormat} key=${String(file.key).slice(0, 24)} ` +
      `instanceId=${file.instanceId || '-'} invDocId=${file.invoiceDocumentId || '-'} ` +
      `storeDocId=${storeDocId} hit=${!!storeDocument} pageCount=${storeDocument?.pageCount ?? '-'} ` +
      `splitPage=${!!file?.sourceDocId && !file?._isDocumentGroup} ` +
      `assetReady=${!!file._previewImageUrl || !!file.previewImage || !!file.docId}`)
    // [V2-TRACE][E-display] Display 实际收到的 previewFile 的 url + dimensions
    console.log(`[V2-TRACE][E-display] fmt=${file._fileFormat || file.fileFormat} key=${String(file.key).slice(0, 24)} ` +
      `docId=${file.docId || '-'} ` +
      `url=${file._previewImageUrl ? (file._previewImageUrl.startsWith('blob:') ? 'blob' : 'http') : '-'} ` +
      `imgW=${file._imageWidth || '-'} imgH=${file._imageHeight || '-'} ` +
      `pvW=${file.previewWidth || '-'} pvH=${file.previewHeight || '-'} ` +
      `pdfW=${file._pdfPageWidth || '-'} pdfH=${file._pdfPageHeight || '-'} ` +
      `hit=${!!storeDocument} pageCount=${storeDocument?.pageCount ?? '-'}`)
    // [V2-TRACE][E-store] storeDocId vs 注册键空间对照（Case B1/B2 判定）
    const allKeys = getRegisteredDocIds()
    const related = allKeys.filter(
      (k) => (file?.docId && k.includes(file.docId.slice(0, 12))) || (file?.key && k.includes(String(file.key).slice(0, 20)))
    )
    console.log(`[V2-TRACE][E-store] storeDocId=${storeDocId} total=${allKeys.length} ` +
      `related=${related.length ? related.join(' | ') : 'NONE'} ` +
      `hitViaGetDoc=${!!getDocument(storeDocId)}`)
    // [S7] 同一时刻六项快照：previewFile 身份 + resolvedStoreDocId + registeredIds + hit + sessionId
    //   viewSig/source 来自 FileContext 的 s7Correlation（同源）——只有与
    //   [S7][materializedDocs] 的 viewSig 相同的这条日志才允许组成一次证据。
    console.log('[S7][display]', {
      viewSig: s7Correlation?.viewSig ?? 'NO-FILE-CONTEXT',
      source: s7Correlation?.source ?? '-',
      sessionId: getActiveSessionId(),
      previewFile: {
        key: file.key?.slice(0, 24),
        instanceId: file.instanceId || '-',
        invoiceDocumentId: file.invoiceDocumentId?.slice(0, 28) || '-',
        documentId: file.documentId?.slice(0, 20) || '-',
        docId: file.docId?.slice(0, 20) || '-',
      },
      resolvedStoreDocId: storeDocId,
      registeredIds: allKeys,
      hit: !!getDocument(storeDocId),
      storeDocumentPageCount: storeDocument?.pageCount ?? '-',
    })
  }

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

  // ── CSS 隔离：将 .canvas-scroll 复位为纯滚动容器 ──
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

    // DocumentViewer 模式：隔离 legacy 样式，展示区所见即所得
    el.style.padding = '0'
    el.style.webkitMaskImage = 'none'
    el.style.maskImage = 'none'

    return () => {
      el.style.padding = ''
      el.style.webkitMaskImage = ''
      el.style.maskImage = ''
    }
  }, [])

  // ── DocumentViewer 唯一渲染路径 ──
  // position: absolute; inset: 0 填满 .canvas-scroll 的 padding-box，
  // 从布局上彻底脱离 legacy padding 影响——展示区所见即所得。
  // overflow: hidden 自成一体，ViewerViewport 内部处理 pan/zoom。
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
        onViewerController={onViewerController}
        file={file}
        previewRotation={previewRotation}
      />
    </div>
  )
})
