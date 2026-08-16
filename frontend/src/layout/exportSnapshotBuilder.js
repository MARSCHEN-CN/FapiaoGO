/**
 * exportSnapshotBuilder.js — D2-2-c1 Export Snapshot Bridge（薄桥，几何无关）
 *
 * 职责（唯一）：把「per-file 物理尺寸 + settings」组装成 Export RenderCommand[]。
 * 本桥不做任何 fit / 居中 / 旋转计算 —— 全部委托 buildExportRenderCommand → createPlacement。
 *
 * 数据来源：
 *   dimensions   : per-file 物理尺寸 Map<key,{width,height}>（由 exportFileDimensions 补齐，
 *                  image=natural px，PDF=points 透传不参与渲染）—— 来自 useExport 调用方
 *   fileRotations: 全文件 rotation map（per-file）—— 来自 usePreview.state
 *   settings     : 纸张 + 边距（PaperSpec 事实源）—— 来自 settings
 *
 * 边界（见 d2-2-c0 三契约陷阱）：
 *   A) contentRect 必须在 EXPORT_DPI 重算（禁转发 Preview @72 command）。
 *   B) paper 必须发后端 PaperSpec {widthMm, heightMm, dpi}，禁转发 paperLayout。
 *   C) sourceRef 必填 {path, page}（page 0-based）。
 *
 * P0-Image-Geometry：sourceWidth/sourceHeight 不再取全局 documentState.pageSize，
 * 改为 per-file（image 用 natural px）；PDF 走 insert_pdf 透传，sourceWidth 不参与渲染。
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
 * 薄桥：files + per-file 尺寸 + settings → RenderCommand[]。
 * 纯函数、DOM-free、node-safe（仅依赖 resolvePaper / exportRenderCommand / exportConstants）。
 *
 * @param {Object} params
 * @param {Array} params.files - 业务文件列表（含 key/path/status）
 * @param {Object<string,number>} [params.fileRotations] - 全文件 rotation map（per-file）
 * @param {Object} params.settings - { paperSize, customPaper, marginTop, marginRight, marginBottom, marginLeft }
 * @param {Map<string,{width:number,height:number}>} [params.dimensions] - per-file 物理尺寸（image=natural px）
 * @returns {Array} RenderCommand[]（经 buildExportRenderCommand → createPlacement）
 */
export function buildExportSnapshot({ files, fileRotations, settings, dimensions }) {
  const paperSpec = buildExportPaperSpec(settings)
  const contentRect = computeContentRectAtDpi(settings, EXPORT_DPI)

  // [merge 导出契约 · P0-A/P0-B/P0-D]
  // 一个输入 file（page-level，多页 PDF 已在导入阶段被 /split_pdf 拆成单页 fileObj）
  // → 一个输出页。sourceRef.page 恒为 0-based：
  //   pageNum 是 1-based SOURCE evidence（buildFileObj 冻结），在此边界 -1 转 0-based；
  //   单页文件 / 图片 pageNum=null → page=0。
  // previewPage（UI 1-based 页码）不参与导出页范围决策（验收 M-09）。
  return (files || [])
    .filter(f => f.status === 'parsed')
    .map(f => {
      const rotation = (fileRotations && fileRotations[f.key]) || 0
      const pageNum = (typeof f.pageNum === 'number' && f.pageNum >= 1) ? f.pageNum : 1
      const page = pageNum - 1  // 0-based，与后端 fitz / insert_pdf(from_page) 对齐
      // P0-Image-Geometry：sourceWidth/sourceHeight 取 per-file 尺寸。
      // image → natural px（createPlacement 的 contain-fit 依赖它）；PDF 走 insert_pdf 透传不参与渲染。
      const dims = (dimensions && dimensions.get && dimensions.get(f.key)) || {}
      const sourceWidth = dims.width || 0
      const sourceHeight = dims.height || 0
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
