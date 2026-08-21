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

import { computeSlots } from '../layout/SlotLayout.js'
import { resolveMergeSpec } from '../compose/composeSlot.js'
import { resolveContentPlacement, resolveContentBounds, getContentDimensions, normalizeRotation } from '../layout/RotationResolver.js'
// C-2 Step 2（G-C2-5）：纸张表单源化——不再维护内联 PAPER_MM，统一消费 paperSpec.js。
// config.js PAPER_REGISTRY（UI 运行时表，依赖 vite import.meta.env）仍由守卫测试锁定同步。
import { PAPER_MM } from './paperSpec.js'

const PREVIEW_DPI = 300
const PX_TO_MM = 25.4 / PREVIEW_DPI

const round2 = (v) => Math.round(v * 100) / 100

/**
 * 文件原始尺寸 → 渲染空间物理尺寸（px@PREVIEW_DPI），统一作为 RotationResolver.contentPhysicalSize。
 *
 * 根因（Commit 2-G 修复）：pdf.js getViewport({scale:1}) 返回 **PDF points (1/72")**，
 * 而 RotationResolver 纸面坐标 paperW = paperSize.widthMM * (dpi/25.4) 是 **px@dpi**。
 * 直接把 points 当 px@dpi 传 → 内容缩小 300/72≈4.167× → scale 封顶=1 → 发票不占满安全区。
 * 故 PDF points 必须 × dpi/72 归一到 px@dpi；image/OFD 天然 px 直接当 px@dpi（与纸面渲染空间一致）。
 *
 * @param {object} f - 文件对象
 * @returns {{width:number,height:number}|null}
 */
export function fileContentPx(f) {
  if (!f) return null
  if (f._pdfPageWidth > 0 && f._pdfPageHeight > 0) {
    // PDF points (1/72") → px@PREVIEW_DPI
    return { width: f._pdfPageWidth * PREVIEW_DPI / 72, height: f._pdfPageHeight * PREVIEW_DPI / 72 }
  }
  const w = f._imageWidth || f.previewWidth || 0
  const h = f._imageHeight || f.previewHeight || 0
  if (w > 0 && h > 0) {
    // 图片/OFD：天然像素按 px@PREVIEW_DPI 处理（与纸面渲染空间一致）
    return { width: w, height: h }
  }
  return null
}

// 纸张表单源：paperSpec.js（C-2 Step 2 G-C2-5，原内联表已删除）
// 与 config.js PAPER_REGISTRY（L102-109）同步；新增纸型须两处同步（守卫测试锁定）。
// (PAPER_MM imported from './paperSpec.js')

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
  // 合并模式规格：从 plan.mergeMode 推导（与实际打印同源），slotCount 与 strategy 用于
  // 计算票位几何——merge 模式下 slot 总数固定（如 merge4=4），不足文件时空 slot 保留。
  const mergeMode = plan.mergeMode || settings.mergeMode || 'none'
  const isMerge = mergeMode && mergeMode !== 'none'
  const mergeSpec = isMerge ? resolveMergeSpec(mergeMode) : null
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
      // schema=2: 一次性破浏览器/Electron `Cache-Control: immutable` 缓存——
      // 旋转方向修复后，旧发票在 fix 前烤进的反转缩略图需经新 URL 重新拉取正确字节。
      // 后端忽略此参数（仅作 URL 破冰），后端内存缓存由 RENDER_ENGINE_VERSION 负责失效。
      const schemaBust = "&schema=2"
      return contentRotation
        ? `${base}${schemaBust}&content_rotation=${contentRotation}`
        : `${base}${schemaBust}`
    }
    if (file.previewImage) {
      return file.previewImage
    }
    return null
  }

  const pageToModel = (page) => {
    // C-2 Step 2（G-C2-4）：plan.paper 是纸张几何唯一事实源（resolvePaperSpec 已完成
    // needSwap 归一，widthMM/heightMM = 请求方向物理尺寸）。
    //   usable = paper(请求方向) − margins：needSwap 时旧 landUsable.w = naturalH−mL−mR
    //   == 请求方向 paperW−mL−mR，数学等价（margins 属 Paper 坐标，不随方向变化）。
    // fallback（旧 plan，缺 plan.paper）：保留 previewPaperLayout + needSwap 旧逻辑。
    const planPaper = (page.paper && page.paper.widthMM > 0 && page.paper.heightMM > 0)
      ? page.paper
      : null
    let paperW, paperH, widthMM, heightMM, usable
    if (planPaper) {
      paperW = Math.round(planPaper.widthMM / 25.4 * PREVIEW_DPI)
      paperH = Math.round(planPaper.heightMM / 25.4 * PREVIEW_DPI)
      widthMM = planPaper.widthMM
      heightMM = planPaper.heightMM
      usable = { x: mL, y: mT, w: paperW - mL - mR, h: paperH - mT - mB }
    } else {
      // B1 修复语义（保留为 fallback）：swap 触发 = requested ≠ paperShape（非 requested===landscape）
      const requested = page.orientation
      const paperShapeOrientation = layout.paperRect.w > layout.paperRect.h ? 'landscape' : 'portrait'
      const needSwap = requested !== paperShapeOrientation
      usable = needSwap ? landUsable : layout.usableRect
      widthMM = (needSwap ? layout.paperRect.h : layout.paperRect.w) * PX_TO_MM
      heightMM = (needSwap ? layout.paperRect.w : layout.paperRect.h) * PX_TO_MM
      paperW = layout.paperRect.w
      paperH = layout.paperRect.h
    }
    // 可用区非正（边距超出）→ 返回 null，由调用方统一判定 invalid。
    if (usable.w <= 0 || usable.h <= 0) {
      // [DIAG-16] pageToModel 返回 null 的根因（边距超出纸张 → 无有效预览页）
      console.log('[DIAG-16 pageToModel null] fileKey=%s usable=%dx%d paperW=%d paperH=%d',
        page.slots[0]?.fileId?.slice(-20) || '?', Math.round(usable.w), Math.round(usable.h),
        Math.round(paperW), Math.round(paperH))
      return null
    }
    // 票位几何：merge 模式使用固定 slotCount + strategy（与实际打印同源），
    // 非 merge 模式退回 page.slots.length（单文件=1）。
    // slot 使用 paperRect（虚拟纸张外框）作为定位参考，内容在 contentRect 内。
    const slotCount = mergeSpec ? mergeSpec.groupSize : page.slots.length
    const slotStrategy = mergeSpec ? mergeSpec.strategy : 'vertical'
    const allSlots = computeSlots(
      { usableRect: usable },
      { count: slotCount, strategy: slotStrategy, gridCols: mergeSpec?.gridCols, gridRows: mergeSpec?.gridRows }
    )

    return {
      paper: page.paper?.size || settings.paperSize || 'A4',
      requestedPaperOrientation: page.orientation,
      paperSizeMM: { widthMM: round2(widthMM), heightMM: round2(heightMM) },
      slots: allSlots.map((s, i) => {
        const slotDef = page.slots[i] || {}
        const f = fileById.get(slotDef.fileId)
        const userRotation = slotDef.rotation || 0
        // [DIAG-4] PrintPreview 消费 rotation
        if (userRotation !== 0) {
          console.log('[DIAG-4 printPreview rotation] fileKey=%s slotDef.rotation=%d fileRotations-used=%o',
            slotDef.fileId, userRotation, { hasDim: !!(f && f._pdfPageWidth > 0) })
        }

        // 三层旋转模型（Commit 1→2→3）：RotationResolver 替换旧 computeAutoRotation
        //   contentRotation = 用户旋转（来自 slotDef.rotation），Viewer 唯一拥有
        //   fitRotation     = Resolver 计算的内容→纸张适配旋转（PrintPreview 拥有）
        //   renderRotation  = fitRotation 归一化，由 Canvas 施加（Printer 只执行）
        let effectiveRotation = userRotation
        let placementResult = null  // resolveContentPlacement 输出（有尺寸时填充）
        // 原始尺寸（PDF points / 天然 px，仅诊断）；contentPx = 归一化到 px@PREVIEW_DPI（供 Resolver）
        const rawDims = f ? getContentDimensions(f) : null
        const contentPx = f ? fileContentPx(f) : null
        // [DIAG-14] 尺寸归一化核对（PDF points → px@dpi）
        if (f) {
          console.log('[DIAG-14 contentDims] fileKey=%s raw=%o contentPx=%o pdfPage=%d',
            slotDef.fileId?.slice(-20),
            rawDims ? `${rawDims.width}x${rawDims.height}` : 'null',
            contentPx ? `${Math.round(contentPx.width)}x${Math.round(contentPx.height)}` : 'null',
            f._pdfPageWidth || 0
          )
        }
        if (contentPx && contentPx.width > 0 && contentPx.height > 0) {
          // P0 Fix: Placement target = slot（virtual paper 语义），而非整页 paper。
          //
          // 背景（Defect: Placement-Paper Geometry Disconnect）：
          //   旧代码用整页 paper + 页级 outerMargin 作为 placement target，
          //   导致 merge 模式下 invoice 仍然按整页尺寸 fit，与 slot 框几何完全脱节。
          //
          // 修复策略：
          //   把 slot 当作 mini paper 喂给 RotationResolver：
          //     physicalPaper = slot.paperRect  (slot 外框 = virtual paper 外框)
          //     margins       = slot 内缩量      (slotMargin = virtual paper 的边距)
          //   Resolver 输出为 slot-local 坐标，再加上 slot.paperRect.x/y 偏移
          //   回到 SVG 纸面绝对坐标，保证 Canvas 消费契约不变。
          //
          // 不变量：
          //   • RotationResolver 算法不动（layoutRotation / fit / center 语义不变）
          //   • PrintPreviewCanvas 消费契约不动（renderTransformMM 仍是纸面 mm 绝对坐标）
          //   • 实际打印路径不动（buildRenderCommand → createPlacement 不受影响）
          //   • Margin 语义不动（slotMargin 来源仍由 SlotLayout 决定）
          const slotPaper = s.paperRect || { x: 0, y: 0, width: s.width, height: s.height }
          const slotContent = s.contentRect || slotPaper
          // slot-local margins = paperRect → contentRect 的四边内缩量（px）
          const slotMarginLeft = slotContent.x - slotPaper.x
          const slotMarginTop = slotContent.y - slotPaper.y
          const slotMarginRight = slotPaper.width - slotContent.width - slotMarginLeft
          const slotMarginBottom = slotPaper.height - slotContent.height - slotMarginTop
          // px → mm（Resolver 入参要求 mm 单位）
          const slotPaperW_mm = slotPaper.width * PX_TO_MM
          const slotPaperH_mm = slotPaper.height * PX_TO_MM
          const slotMarginLeft_mm = slotMarginLeft * PX_TO_MM
          const slotMarginRight_mm = slotMarginRight * PX_TO_MM
          const slotMarginTop_mm = slotMarginTop * PX_TO_MM
          const slotMarginBottom_mm = slotMarginBottom * PX_TO_MM

          placementResult = resolveContentPlacement({
            contentPhysicalSize: contentPx,   // 已归一化到 px@PREVIEW_DPI（PDF points×dpi/72）
            contentRotation: userRotation,    // Resolver 内部 apply contentRotation
            physicalPaper: { widthMM: slotPaperW_mm, heightMM: slotPaperH_mm },
            margins: {
              left: slotMarginLeft_mm,
              right: slotMarginRight_mm,
              top: slotMarginTop_mm,
              bottom: slotMarginBottom_mm,
            },
            dpi: PREVIEW_DPI,
          })

          // slot-local → paper-absolute 坐标偏移（px 层偏移，mm 转换在 renderTransformMM 统一做）
          // 注意：canvasSize 是尺寸不是位置，不偏移；rotationCx/Cy 是内容中心（相对内容原点），不偏移。
          const slotOffsetX = slotPaper.x
          const slotOffsetY = slotPaper.y
          placementResult = {
            ...placementResult,
            offset: {
              x: placementResult.offset.x + slotOffsetX,
              y: placementResult.offset.y + slotOffsetY,
            },
            placedRect: {
              x: placementResult.placedRect.x + slotOffsetX,
              y: placementResult.placedRect.y + slotOffsetY,
              w: placementResult.placedRect.w,
              h: placementResult.placedRect.h,
            },
            availableRect: {
              x: placementResult.availableRect.x + slotOffsetX,
              y: placementResult.availableRect.y + slotOffsetY,
              w: placementResult.availableRect.w,
              h: placementResult.availableRect.h,
            },
            renderTransform: {
              ...placementResult.renderTransform,
              translateX: placementResult.renderTransform.translateX + slotOffsetX,
              translateY: placementResult.renderTransform.translateY + slotOffsetY,
            },
          }

          effectiveRotation = normalizeRotation(
            (placementResult.contentRotation || 0) + (placementResult.layoutRotation || 0)
          )
        }
        return {
          x: round2(s.x * PX_TO_MM),
          y: round2(s.y * PX_TO_MM),
          width: round2(s.width * PX_TO_MM),
          height: round2(s.height * PX_TO_MM),
          source: f?.name || slotDef.fileId || `#${i + 1}`,
          // deprecated（保留兼容）→ 新消费者请用 contentRotation / fitRotation
          _deprecatedRotation: effectiveRotation,
          contentRotation: placementResult?.contentRotation ?? userRotation,
          layoutRotation: placementResult?.layoutRotation ?? 0,
          // 布局结果（Commit 2 新增，PrintPreviewCanvas 消费）
          placement: placementResult ? {
            scale: placementResult.scale,
            offset: { x: placementResult.offset.x, y: placementResult.offset.y },
            placedRect: { ...placementResult.placedRect },
            canvasSize: { ...placementResult.canvasSize },
            // SVG renderTransform（Commit 2-B 新增，px@PREVIEW_DPI，Resolver 原始输出）。
            //   仅供打印/导出等需 px 的消费者；预览 Canvas 必须改用下方 renderTransformMM。
            renderTransform: { ...placementResult.renderTransform },
            // Commit 2-F-1：px → mm 单位隔离。SVG viewBox 是 mm，Resolver 输出是 px@PREVIEW_DPI。
            // 在此一次性换算，Canvas 永不感知 DPI（300/150/96/600 任意切换都不影响预览几何）。
            // 字段语义：contentBoxWidth/Height = 内容在「纸面 mm 坐标系」下的包围盒尺寸（mm），
            //   非真实像素（缩略图非 300DPI 栅格），勿误用于像素级测量。
            renderTransformMM: {
              translateX: round2(placementResult.renderTransform.translateX * PX_TO_MM),
              translateY: round2(placementResult.renderTransform.translateY * PX_TO_MM),
              scale: placementResult.renderTransform.scale,
              rotationDeg: placementResult.renderTransform.rotationDeg,
              rotationCx: round2(placementResult.renderTransform.rotationCx * PX_TO_MM),
              rotationCy: round2(placementResult.renderTransform.rotationCy * PX_TO_MM),
              contentBoxWidth: round2(placementResult.renderTransform.imageWidth * PX_TO_MM),
              contentBoxHeight: round2(placementResult.renderTransform.imageHeight * PX_TO_MM),
            },
          } : null,
          previewTransform: { rotation: effectiveRotation },
          thumbnailUrl: getThumbnailUrl(f, 0, userRotation),
          fileId: slotDef.fileId,
          // [DIAG] renderTransform 语义验证（无条件）
          _diag: placementResult ? {
            contentRotation: placementResult.contentRotation,
            layoutRotation: placementResult.layoutRotation,
            effectiveSize: placementResult.effectiveContentSize,
            rotationDeg: placementResult.renderTransform.rotationDeg,
          } : null,
          pageIndex: 0,
        }
      }),
    }
  }

  // [DIAG-12] Runtime Trace — Plan entry
  console.log('[DIAG-12 plan input] pageCount=%d firstPageOrientation=%s firstSlotRotation=%d',
    plan.pages.length, plan.pages[0]?.orientation || '?', plan.pages[0]?.slots[0]?.rotation || 0)

  // 构建基础预览页（横向边距超纸时 pageToModel 返回 null，过滤后判定 invalid）
  const basePages = [
    ...plan.pages.map(pageToModel),
    ...(plan.extraPages || []).map(pageToModel),
  ].filter(Boolean)

  // [DIAG-11] 打印旋转语义验证矩阵（无条件）
  if (basePages.length > 0) {
    const p = basePages[0]
    const s = p.slots[0]
    if (s._diag) {
      console.log('[DIAG-11 rotation matrix] contentRotation=%d layoutRotation=%d effectiveSize=%s rotationDeg=%d requestedPaperOrientation=%s',
        s._diag.contentRotation, s._diag.layoutRotation, s._diag.effectiveSize,
        s._diag.rotationDeg, p.requestedPaperOrientation)
  } else {
    console.log('[DIAG-11 no placement] slotRotation=%d hasThumb=%s requestedPaperOrientation=%s',
      s._deprecatedRotation, !!s.thumbnailUrl, p.requestedPaperOrientation)
  }
  } else {
    // [DIAG-11 empty] basePages 为空（所有 pageToModel 返回 null）→ 外层 valid:false
    console.log('[DIAG-11 empty] planPages=%d firstPageOrientation=%s reason=无有效预览页(边距可能超出纸张)',
      plan.pages.length, plan.pages[0]?.orientation || '?')
  }
  if (basePages.length === 0) {
    return { valid: false, reason: '边距超出纸张尺寸（打印内容无可用区域）', pages: [], currentPageIndex: 0 }
  }

  // 多页文档展开：将每个 slot 的多页文档展开为多个预览页
  const expandedPages = []
  for (const page of basePages) {
    if (page.slots.length === 1) {
      const slot = page.slots[0]
      const f = fileById.get(slot.fileId)
      // Bug A fix: 聚合 source 的真实物理页数由 normalizePrintSources 写入 _aggregatedPageCount；
      // 页级拆分文件自带 totalPages；普通多页单文件在 pageCount。按优先级取，缺省 1。
      // 旧逻辑只读 f.pageCount（聚合 source 默认恒为 1）→ 同票多页在预览被塌缩为 1 页。
      const pageCount = f?._aggregatedPageCount || f?.totalPages || f?.pageCount || 1
      if (pageCount <= 1) {
        expandedPages.push(page)
      } else {
        // Bug A-2/A-3 fix: 聚合源（_aggregatedPages 存在）中每物理页是独立拆分文件，
        // 各有自己的 docId 和 key。展开时须消费 _aggregatedPages[p] 的 identity
        // （pageFile.docId → 正确的缩略图；pageFile.key → currentSelection 可匹配），
        // 而非继续用聚合代表页 f.docId + page=N（会把第二页指到第一页的单页文件）。
        const isAggregated = !!(f._aggregatedPages)
        for (let p = 0; p < pageCount; p++) {
          const pageFile = isAggregated ? f._aggregatedPages[p] : f
          expandedPages.push({
            ...page,
            slots: [{
              ...slot,
              pageIndex: p,
              thumbnailUrl: getThumbnailUrl(
                pageFile,
                isAggregated ? 0 : p,
                slot.contentRotation,
              ),
              fileId: pageFile.key,
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
            thumbnailUrl: getThumbnailUrl(f, 0, slot.contentRotation),
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
