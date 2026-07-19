/**
 * exportSnapshotBuilder.js — D2-2-c1 Export Snapshot Bridge（薄桥，几何无关）
 *
 * 职责（唯一）：把「已存在的 Preview 几何状态」组装成 Export RenderCommand[]。
 * 本桥不做任何 fit / 居中 / 旋转计算 —— 全部委托 buildExportRenderCommand → createPlacement。
 *
 * 数据来源（不扩 usePreview、不写回 file）：
 *   documentState : 当前预览文件几何（pageSize / pageNum / sourceType）—— 来自 usePreview.state
 *   fileRotations : 全文件 rotation map（per-file）—— 来自 usePreview.state
 *   settings      : 纸张 + 边距（PaperSpec 事实源）—— 来自 settings
 *
 * 边界（见 d2-2-c0 三契约陷阱）：
 *   A) contentRect 必须在 EXPORT_DPI 重算（禁转发 Preview @72 command）。
 *   B) paper 必须发后端 PaperSpec {widthMm, heightMm, dpi}，禁转发 paperLayout。
 *   C) sourceRef 必填 {path, page}（PDF=当前页, image=0）。
 *
 * 已知简化（D2-3 / Document Engine 范围，不在此扩大）：
 *   多文件异构 page 尺寸时，统一用当前预览 documentState.pageSize 作几何代表；
 *   逐文件真实 pageSize 由 D2-3 提供。单文件导出本桥完全正确。
 */
import { resolvePaper } from './resolvePaper.js'
import { buildExportRenderCommand } from './exportRenderCommand.js'
import { EXPORT_DPI } from './exportConstants.js'

const MM_PER_INCH = 25.4

/**
 * 派生后端 PaperSpec（陷阱 B）：widthMm/heightMm 来自 resolvePaper（唯一事实源），
 * dpi 固定 EXPORT_DPI。绝不透出 previewState 的 PaperLayout（Preview-only 字段）。
 * @param {Object} settings - { paperSize, customPaper }
 * @returns {{widthMm:number, heightMm:number, dpi:number}}
 */
export function buildExportPaperSpec(settings) {
  const paper = resolvePaper(settings?.paperSize, settings?.customPaper)
  return { widthMm: paper.widthMM, heightMm: paper.heightMM, dpi: EXPORT_DPI }
}

/**
 * 在指定 dpi 下计算 contentRect（陷阱 A）。纯镜像 computePaperLayout 的「边距→px」数学，
 * 但 dpi 由入参决定（导出固定 EXPORT_DPI），不硬编码 PREVIEW_DPI。
 * 返回 {x,y,width,height}（与 createPlacement 输入形状一致）。
 * @param {Object} settings - { paperSize, customPaper, marginTop, marginRight, marginBottom, marginLeft }
 * @param {number} dpi
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function computeContentRectAtDpi(settings, dpi) {
  const paper = resolvePaper(settings?.paperSize, settings?.customPaper)
  const paperW = Math.round(paper.widthMM / MM_PER_INCH * dpi)
  const paperH = Math.round(paper.heightMM / MM_PER_INCH * dpi)
  const toPx = (v) => {
    const mm = (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 3
    return Math.round(mm / MM_PER_INCH * dpi)
  }
  const mLeft = toPx(settings?.marginLeft)
  const mRight = toPx(settings?.marginRight)
  const mTop = toPx(settings?.marginTop)
  const mBottom = toPx(settings?.marginBottom)
  return {
    x: mLeft,
    y: mTop,
    width: Math.max(0, paperW - mLeft - mRight),
    height: Math.max(0, paperH - mTop - mBottom),
  }
}

/**
 * 薄桥：files + Preview 几何状态 + settings → RenderCommand[]。
 * 纯函数、DOM-free、node-safe（仅依赖 resolvePaper / exportRenderCommand / exportConstants）。
 *
 * @param {Object} params
 * @param {Array} params.files - 业务文件列表（含 key/path/status）
 * @param {Object} [params.documentState] - 当前预览 documentState（pageSize / pageNum / sourceType）
 * @param {Object<string,number>} [params.fileRotations] - 全文件 rotation map（per-file）
 * @param {number} [params.previewPage=1] - 当前预览页（PDF sourceRef.page）
 * @param {Object} params.settings - { paperSize, customPaper, marginTop, marginRight, marginBottom, marginLeft }
 * @returns {Array} RenderCommand[]（经 buildExportRenderCommand → createPlacement）
 */
export function buildExportSnapshot({ files, documentState, fileRotations, previewPage = 1, settings }) {
  const paperSpec = buildExportPaperSpec(settings)
  const contentRect = computeContentRectAtDpi(settings, EXPORT_DPI)
  const sourceWidth = documentState?.pageSize?.w ?? 0
  const sourceHeight = documentState?.pageSize?.h ?? 0
  const isPdf = documentState?.sourceType === 'pdf'

  return (files || [])
    .filter(f => f.status === 'parsed')
    .map(f => {
      const rotation = (fileRotations && fileRotations[f.key]) || 0
      const page = isPdf ? (previewPage || documentState?.pageNum || 0) : 0
      return buildExportRenderCommand({
        sourceWidth,
        sourceHeight,
        contentRect,
        rotation,
        paper: paperSpec,
        sourceRef: { path: f.path, page },
      })
    })
}
