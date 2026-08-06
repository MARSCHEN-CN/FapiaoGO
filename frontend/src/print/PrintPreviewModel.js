/**
 * PrintPreviewModel.js — 打印预览描述模型（Phase 3.5 Preview Skeleton）
 *
 * 职责：
 *   buildPrintPreviewModel(plan, { files, settings })：把「打印执行计划」（buildPrintExecutionPlan 产物）
 *   派生为「预览描述」——每物理页的纸张尺寸、方向、槽位几何（x/y/width/height，mm 单位）+ 来源文件名。
 *   供 PrintConfirmModal 的 PrintPreviewCanvas 消费（Step 2 骨架：纸张比例 / 票据位置 / 页数 / 排版）。
 *
 * 冻结边界（对齐冻结文档 §4 Phase 2 + 用户定稿 Phase 3.5）：
 *   - 只描述「预览怎么摆」：纸张 mm、方向、槽位几何、来源。不渲染像素、不涉 PDF 内容。
 *   - Plan 冻结「不描述怎么画」（禁止 usableRect/slotRect）——本模型是 Plan 的**消费方**：
 *     只读派生，绝不改写 plan 对象，绝不把几何反向写回 Plan。
 *   - 与打印几何的关系：本模型用「与 computePaperLayout 同构的本地公式」算安全区（原因见下），
 *     槽位等分复用生产函数 computeTicketSlots（node-safe）；横向票位在「横向物理可用区」
 *     重算（margins 属 Paper 坐标不随内容旋转，与 RenderLayoutFactory 同源语义），
 *     不用 slotToLandscape 轴交换（非对称边距会溢出）。
 *     预览语义 = 打印语义（同一 Plan），但本模型**不裁决**打印几何——打印几何仍由打印 adapter 决定。
 *
 * ⚠️ 为什么 previewPaperLayout 不直接 import previewState.computePaperLayout：
 *   previewState.js / config.js 依赖 vite import.meta.env（BACKEND_URL/BASE_URL），纯 node 测试无法加载。
 *   本地实现与 previewState.js:178-220 公式完全同构（mm→px@300 + 边距内缩 + usableRect），
 *   并以「内联纸张表（与 config.js PAPER_REGISTRY 同步）+ 数值锚点测试」锁定一致性（防漂移）。
 *   ⚠️ 新增纸型 / 修改边距公式时，必须同时同步 previewState.js 与本文件，并由
 *   printPreviewModel.test.mjs 的数值锚点断言把关。
 *
 * @module print/PrintPreviewModel
 */

import { computeTicketSlots } from '../layout/SlotLayout.js'
import { resolveContentPlacement, resolveContentBounds, getContentDimensions, normalizeRotation } from '../layout/RotationResolver.js'

const PREVIEW_DPI = 300
const PX_TO_MM = 25.4 / PREVIEW_DPI

const round2 = (v) => Math.round(v * 100) / 100

// 与 config.js PAPER_REGISTRY（L102-109）同步的内联纸张表（mm）。
// config.js 依赖 vite import.meta.env 不可在纯 node 加载；新增纸型须两处同步（守卫测试锁定）。
const PAPER_MM = {
  A4: { widthMM: 210, heightMM: 297 },
  A5: { widthMM: 148, heightMM: 210 },
  A3: { widthMM: 297, heightMM: 420 },
  Letter: { widthMM: 215.9, heightMM: 279.4 },
  Voucher240x140: { widthMM: 240, heightMM: 140 },
}

/**
 * 预览纸面几何（与 computePaperLayout 同构的本地实现，纯 node）。
 * 返回「自然空间」（未做方向 swap）的纸张 px + 安全区 usableRect（px@300，已内缩边距）。
 *
 * @param {string} [paperSize='A4']
 * @param {{widthMM:number,heightMM:number}|null} [customPaper]
 * @param {{left?:number,right?:number,top?:number,bottom?:number}} [margins] - mm
 * @returns {{valid:boolean, reason?:string, paperRect:{w:number,h:number}|null, usableRect:{x:number,y:number,w:number,h:number}|null}}
 */
export function previewPaperLayout(paperSize = 'A4', customPaper = null, margins = {}) {
  const paper = customPaper && customPaper.widthMM > 0 && customPaper.heightMM > 0
    ? { widthMM: customPaper.widthMM, heightMM: customPaper.heightMM }
    : PAPER_MM[paperSize]
  if (!paper) return { valid: false, reason: `未知纸张: ${paperSize}`, paperRect: null, usableRect: null }

  // ↓ 以下公式与 previewState.js computePaperLayout（L182-199）逐行同构，勿改 ↓
  const paperW = Math.round(paper.widthMM / 25.4 * PREVIEW_DPI)
  const paperH = Math.round(paper.heightMM / 25.4 * PREVIEW_DPI)
  const toPx = (v) => {
    const mm = (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 3
    return Math.round(mm / 25.4 * PREVIEW_DPI)
  }
  const mLeft = toPx(margins.left)
  const mRight = toPx(margins.right)
  const mTop = toPx(margins.top)
  const mBottom = toPx(margins.bottom)
  const innerW = paperW - mLeft - mRight
  const innerH = paperH - mTop - mBottom
  // ↑ 与 computePaperLayout 同构结束 ↑

  if (innerW <= 0 || innerH <= 0) {
    return { valid: false, reason: '边距超出纸张尺寸', paperRect: null, usableRect: null }
  }
  return {
    valid: true,
    paperRect: { w: paperW, h: paperH },
    usableRect: { x: mLeft, y: mTop, w: innerW, h: innerH },
  }
}

/**
 * 从打印执行计划构建打印预览描述。
 *
 * @param {Object} plan - buildPrintExecutionPlan 产物（pages[] / extraPages[]）
 * @param {Object} [options]
 * @param {Array<Object>} [options.files] - 文件对象数组（key→name 映射 + 缩略图 URL）
 * @param {Object} [options.settings] - { paperSize, customPaper, marginLeft/Right/Top/Bottom }
 * @param {Object} [options.currentSelection] - { fileId, pageIndex } 当前选中页，用于定位
 * @param {string} [options.backendUrl] - 后端 Base URL（缩略图端点前缀；默认空=相对路径）。
 *   ⚠️ 注入而非 import config.js：config 依赖 vite import.meta.env，纯 node 测试无法加载；
 *   调用方（usePrint）在浏览器环境传 BACKEND_URL。
 * @returns {{valid:boolean, reason?:string, pages:Array<Object>, currentPageIndex:number}}
 *   pages[].paperSizeMM = { widthMM, heightMM }（按方向交换后的显示尺寸）
 *   pages[].slots[] = { x, y, width, height, source, rotation, thumbnailUrl, fileId, pageIndex }
 */
export function buildPrintPreviewModel(plan, { files = [], settings = {}, currentSelection = null, backendUrl = '' } = {}) {
  if (!plan || !Array.isArray(plan.pages)) {
    return { valid: false, reason: 'plan 缺失或结构非法', pages: [], currentPageIndex: 0 }
  }
  const layout = previewPaperLayout(
    settings.paperSize || 'A4',
    settings.customPaper || null,
    {
      left: settings.marginLeft,
      right: settings.marginRight,
      top: settings.marginTop,
      bottom: settings.marginBottom,
    },
  )
  if (!layout.valid) return { valid: false, reason: layout.reason, pages: [], currentPageIndex: 0 }

  const fileById = new Map(files.map((f) => [f.key, f]))
  const mL = layout.usableRect.x
  const mT = layout.usableRect.y
  const mR = layout.paperRect.w - layout.usableRect.w - mL
  const mB = layout.paperRect.h - layout.usableRect.h - mT

  // 横向物理可用区（冻结语义：margins 属 Paper 坐标，Top/Left 仍为物理上/左边，不随内容旋转；
  // 与 RenderLayoutFactory 的 usableRect swap 同源）。横向票位在此重算等分——
  // 不用 slotToLandscape 简单轴交换：轴交换会把「自然垂直边距(mT+mB)」当成横向水平可用长度，
  // 非对称边距时（如左 30mm 右 3mm）得宽 291mm > 纸宽 297-30-3=264mm → 右侧溢出被裁，内容挤右上角。
  const landUsable = {
    x: mL, y: mT,
    w: layout.paperRect.h - mL - mR,
    h: layout.paperRect.w - mT - mB,
  }

  /**
   * 获取文件指定页的缩略图 URL
   * 优先使用 docId 从后端 /thumbnail 端点获取（page 参数后端 1-based），fallback 到 previewImage
   */
  const getThumbnailUrl = (file, pageIndex = 0, contentRotation = 0) => {
    if (!file) return null
    if (file.docId) {
      const base = `${backendUrl}/thumbnail/${file.docId}?page=${pageIndex + 1}`
      // Commit 3 fix: 传 content_rotation 给后端，让它生成正确方向的缩略图
      return contentRotation ? `${base}&content_rotation=${contentRotation}` : base
    }
    if (file.previewImage) {
      return file.previewImage
    }
    return null
  }

  const pageToModel = (page) => {
    const isLandscape = page.orientation === 'landscape'
    // 票位几何：横向在横向物理可用区重算（margins 不随内容旋转），纵向用自然可用区。
    // 可用区非正（边距超出）→ 返回 null，由调用方统一判定 invalid。
    const usable = isLandscape ? landUsable : layout.usableRect
    if (usable.w <= 0 || usable.h <= 0) return null
    const slots = computeTicketSlots({ usableRect: usable }, page.slots.length)

    const widthMM = (isLandscape ? layout.paperRect.h : layout.paperRect.w) * PX_TO_MM
    const heightMM = (isLandscape ? layout.paperRect.w : layout.paperRect.h) * PX_TO_MM

    return {
      paper: page.paper?.size || settings.paperSize || 'A4',
      orientation: page.orientation,
      paperSizeMM: { widthMM: round2(widthMM), heightMM: round2(heightMM) },
      slots: slots.map((s, i) => {
        const slotDef = page.slots[i] || {}
        const f = fileById.get(slotDef.fileId)
        const userRotation = slotDef.rotation || 0
        // [DIAG-4] PrintPreview 消费 rotation
        if (userRotation !== 0) {
          console.log('[DIAG-4 printPreview rotation] fileKey=%s slotDef.rotation=%d fileRotations-used=%o',
            slotDef.fileId, userRotation, { hasDim: !!(f && f._pdfPageWidth > 0) })
        }

        // 三层旋转模型（Commit 1→2）：RotationResolver 替换旧 computeAutoRotation
        //   contentRotation = 用户旋转（来自 slotDef.rotation）
        //   layoutRotation  = 内容适配纸张的自动旋转
        //   finalRotation   = contentRotation + layoutRotation
        let effectiveRotation = userRotation
        let placementResult = null  // resolveContentPlacement 输出（有尺寸时填充）
        const contentDims = f ? getContentDimensions(f) : null
        if (contentDims && contentDims.width > 0 && contentDims.height > 0) {
          const rotatedSize = resolveContentBounds(contentDims, userRotation)
          const paperW_mm = layout.paperRect.w * PX_TO_MM
          const paperH_mm = layout.paperRect.h * PX_TO_MM
          const marginLeft_mm = mL * PX_TO_MM
          const marginRight_mm = mR * PX_TO_MM
          const marginTop_mm = mT * PX_TO_MM
          const marginBottom_mm = mB * PX_TO_MM
          // 纸面尺寸不变：不因内容旋转而旋转纸面
          placementResult = resolveContentPlacement({
            contentSize: rotatedSize,
            contentRotation: userRotation,
            paperSize: { widthMM: paperW_mm, heightMM: paperH_mm },
            paperOrientation: page.orientation,
            margins: {
              left: marginLeft_mm,
              right: marginRight_mm,
              top: marginTop_mm,
              bottom: marginBottom_mm,
            },
            dpi: PREVIEW_DPI,
          })
          effectiveRotation = normalizeRotation(
            (placementResult.contentRotation || 0) + (placementResult.fitRotation || 0)
          )
        }
        return {
          x: round2(s.x * PX_TO_MM),
          y: round2(s.y * PX_TO_MM),
          width: round2(s.width * PX_TO_MM),
          height: round2(s.height * PX_TO_MM),
          source: f?.name || slotDef.fileId || `#${i + 1}`,
          // deprecated（保留兼容）→ 新消费者请用 contentRotation / fitRotation
          rotation: effectiveRotation,
          contentRotation: placementResult?.contentRotation ?? userRotation,
          fitRotation: placementResult?.fitRotation ?? 0,
          // 布局结果（Commit 2 新增，PrintPreviewCanvas 消费）
          placement: placementResult ? {
            scale: placementResult.scale,
            offset: { x: placementResult.offset.x, y: placementResult.offset.y },
            placedRect: { ...placementResult.placedRect },
            canvasSize: { ...placementResult.canvasSize },
            // SVG renderTransform（Commit 2-B 新增）
            //   消费方直接作为 <g transform="..."> 属性
            renderTransform: { ...placementResult.renderTransform },
          } : null,
          previewTransform: { rotation: effectiveRotation },
          thumbnailUrl: getThumbnailUrl(f, 0, userRotation),
          fileId: slotDef.fileId,
          pageIndex: 0,
        }
      }),
    }
  }

  // 构建基础预览页（横向边距超纸时 pageToModel 返回 null，过滤后判定 invalid）
  const basePages = [
    ...plan.pages.map(pageToModel),
    ...(plan.extraPages || []).map(pageToModel),
  ].filter(Boolean)
  if (basePages.length === 0) {
    return { valid: false, reason: '边距超出纸张尺寸（打印内容无可用区域）', pages: [], currentPageIndex: 0 }
  }

  // 多页文档展开：将每个 slot 的多页文档展开为多个预览页
  const expandedPages = []
  for (const page of basePages) {
    if (page.slots.length === 1) {
      const slot = page.slots[0]
      const f = fileById.get(slot.fileId)
      const pageCount = f?.pageCount || 1
      if (pageCount <= 1) {
        expandedPages.push(page)
      } else {
        for (let p = 0; p < pageCount; p++) {
          expandedPages.push({
            ...page,
            slots: [{
              ...slot,
              pageIndex: p,
              thumbnailUrl: getThumbnailUrl(f, p, slot.rotation || 0),
            }],
          })
        }
      }
    } else {
      // 合并模式：多 slot 保持不变，但更新每个 slot 的缩略图
      expandedPages.push({
        ...page,
        slots: page.slots.map((slot) => {
          const f = fileById.get(slot.fileId)
          return {
            ...slot,
            thumbnailUrl: getThumbnailUrl(f, 0, slot.contentRotation || slot.rotation || 0),
            pageIndex: 0,
          }
        }),
      })
    }
  }

  // 计算当前选中页在展开后预览页中的索引
  let currentPageIndex = 0
  if (currentSelection?.fileId) {
    for (let i = 0; i < expandedPages.length; i++) {
      const slot = expandedPages[i].slots[0]
      if (slot && slot.fileId === currentSelection.fileId && (slot.pageIndex || 0) === (currentSelection.pageIndex || 0)) {
        currentPageIndex = i
        break
      }
    }
  }

  return {
    valid: true,
    pages: expandedPages,
    currentPageIndex,
  }
}

export default buildPrintPreviewModel
