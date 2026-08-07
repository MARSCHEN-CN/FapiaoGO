/**
 * RotationResolver — 打印布局旋转解析器（三层权限模型，2026-08-06）
 *
 * ## 权限边界（Commit 2-C 冻结）
 *
 *   模块            | 可以修改              | 不可修改
 *   ───────────────┼──────────────────────┼──────────────────
 *   Viewer         | contentRotation      | paper
 *   PrintPreview   | paperOrientation     | contentRotation
 *   PrintPipeline  | 执行 placement        | 决定旋转
 *
 * ## 两层 Resolver
 *
 *   1. ContentResolve（本文件前半）：
 *      输入 contentRotation + contentPhysicalSize（px@dpi）→ 输出 effectiveContentSize + effectiveOrientation
 *      职责：把用户旋转动作物化为内容几何。Viewer 拥有旋转权限。
 *
 *   2. FitResolve（本文件后半）：
 *      输入 effectiveOrientation + paperSize → 输出 fitRotation（-90/0/+90）
 *      职责：纸面适配——当内容方向≠纸张方向时，计算所需的补偿旋转。
 *      fitRotation 不改变 contentRotation，只影响最终 placement 的 transform。
 *
 * ## 核心公式
 *
 *   effectiveContentW = contentRotated ? contentPhysicalSize.h : contentPhysicalSize.w
 *   effectiveContentH = contentRotated ? contentPhysicalSize.w : contentPhysicalSize.h
 *
 *   fitRotation =
 *     0   : 内容方向 == 纸张方向
 *     -90 : 内容横向 + 纸张纵向
 *     +90 : 内容纵向 + 纸张横向
 *
 * ## 与旧 Policy A 的区别
 *
 *   旧: rot90 → 纸面跟随旋转（paper follows content）
 *   新: rot90 → 内容旋转 → 纸面适配 → 打印机执行布局结果
 *
 * @module layout/RotationResolver
 */

/**
 * 归一化旋转角度到 0/90/180/270
 * @param {number} deg
 * @returns {number}
 */
export function normalizeRotation(deg) {
  return ((Math.round(deg) % 360) + 360) % 360
}

/**
 * 判断角度是否导致宽高交换
 * @param {number} deg - 归一化后角度
 * @returns {boolean}
 */
export function isRotated(deg) {
  const r = normalizeRotation(deg)
  return r === 90 || r === 270
}

/**
 * Layer 1 输出：用户旋转后内容在「内容世界」的尺寸。
 *
 * @param {{width:number, height:number}} contentBounds - 原始内容尺寸（px）
 * @param {number} contentRotation - 用户旋转角（0/90/180/270）
 * @returns {{width:number, height:number}} 旋转后内容尺寸
 */
export function resolveContentBounds(contentBounds, contentRotation) {
  const r = normalizeRotation(contentRotation)
  if (isRotated(r)) {
    return { width: contentBounds.height, height: contentBounds.width }
  }
  return { width: contentBounds.width, height: contentBounds.height }
}

/**
 * 检测内容天然方向
 * @param {{width:number, height:number}} size - 内容尺寸（旋转前原始尺寸）
 * @returns {'portrait'|'landscape'}
 */
export function detectContentOrientation(size) {
  return size.width > size.height ? 'landscape' : 'portrait'
}

/**
 * 检测纸张方向
 * @param {{widthMM:number, heightMM:number}} paper
 * @returns {'portrait'|'landscape'}
 */
export function detectPaperOrientation(paper) {
  return paper.widthMM > paper.heightMM ? 'landscape' : 'portrait'
}

/**
 * 从文件对象提取原始内容尺寸（px，旋转前）。
 * 支持 PDF（_pdfPageWidth/_pdfPageHeight）、图片（_imageWidth/_imageHeight）、
 * OFD（previewWidth/previewHeight）。
 *
 * @param {object} file - 文件对象
 * @returns {{width:number, height:number}|null} 原始内容尺寸，或 null（无可用尺寸）
 */
export function getContentDimensions(file) {
  if (!file) return null
  // PDF：加载时提取的页面尺寸
  if (file._pdfPageWidth > 0 && file._pdfPageHeight > 0) {
    return { width: file._pdfPageWidth, height: file._pdfPageHeight }
  }
  // 图片 / OFD previewImage
  const w = file._imageWidth || file.previewWidth || 0
  const h = file._imageHeight || file.previewHeight || 0
  if (w > 0 && h > 0) {
    return { width: w, height: h }
  }
  return null
}

/**
 * Layer 2：打印布局旋转（自动适配）。
 *
 * 规则（用户定稿）：
 *   - 内容方向 == 纸张方向 → 0（不额外旋转）
 *   - 横向内容 + 纵向纸张 → -90（逆时针转内容塞入竖纸）
 *   - 纵向内容 + 横向纸张 → +90（顺时针转内容塞入横纸）
 *
 * @param {'portrait'|'landscape'} contentOrientation - 旋转后内容的天然方向
 * @param {'portrait'|'landscape'} paperOrientation   - 纸张方向
 * @returns {number} layoutRotation（0 | -90 | 90）
 */
export function computeLayoutRotation(contentOrientation, paperOrientation) {
  if (contentOrientation === paperOrientation) return 0
  if (contentOrientation === 'landscape' && paperOrientation === 'portrait') return -90
  if (contentOrientation === 'portrait' && paperOrientation === 'landscape') return 90
  return 0
}

/**
 * ## RotationResolver 主入口
 *
 * 输入「内容世界」（Layer 1 结果）和「纸张世界」（Layer 2 参数），
 * 输出完整的布局描述。
 *
 * @param {Object} input
 * @param {{width:number, height:number}} input.contentPhysicalSize - 物理内容尺寸（**px@dpi，与纸张渲染空间一致**；旋转前原始尺寸）。
 *   ⚠️ PDF points（pdf.js getViewport({scale:1}) 返回 1/72"）必须 ×dpi/72 归一化为 px@dpi 后传入（调用方负责，见 PrintPreviewModel.fileContentPx）；
 *   image/OFD 天然像素直接传入（同样按 px@dpi 处理）。contentRotation 由本函数内部施加，请勿预旋转后传入。
 * @param {number}              input.contentRotation         - 用户旋转角（0/90/180/270）
 * @param {{widthMM:number, heightMM:number}} input.paperSize - 纸张尺寸（mm）
 * @param {'portrait'|'landscape'} [input.paperOrientation]    - 纸张方向（不传则自动从 paperSize 推导）
 * @param {{left?:number, right?:number, top?:number, bottom?:number}} [input.margins] - 安全边距（mm，默认 0）
 * @param {number} [input.dpi=300]                            - 渲染 DPI
 * @returns {{
 *   // Layer 1 透传
 *   contentRotation: number,         // 用户旋转（0/90/180/270）
 *   contentSize: {width:number, height:number},  // 旋转后内容尺寸（px）
 *   contentOrientation: 'portrait'|'landscape',  // 旋转后内容方向
 *
 *   // Layer 2 派生
 *   layoutRotation: number,          // 布局旋转（0|-90|90）
 *   finalRotation: number,           // 最终旋转 = contentRotation + layoutRotation（归一化 0/90/180/270）
 *   paperOrientation: 'portrait'|'landscape',   // 纸张方向
 *
 *   // 几何（px@dpi）
 *   canvasSize: {width:number, height:number},  // 最终画布尺寸（纸张 px + 方向适配）
 *   availableRect: {x:number, y:number, w:number, h:number},  // 安全区（px，已扣除 margins）
 *   scale: number,                   // fit scale = min(availableW / placedContentW, availableH / placedContentH)，可 >1（放大填充安全区）
 *   offset: {x:number, y:number},    // 居中偏移（px，locatedLayout 下内容左上角位置）
 *   placedRect: {x:number, y:number, w:number, h:number},  // 缩放居中后内容在画布上的位置
 * }}
 */
export function resolveContentPlacement({
  contentPhysicalSize,
  contentRotation,
  paperSize,
  paperOrientation: paperOrientInput,
  margins = {},
  dpi = 300,
}) {
  // ── 校验 ──
  if (!contentPhysicalSize?.width || !contentPhysicalSize?.height) {
    throw new Error('RotationResolver: contentPhysicalSize 需含正数 width/height（px@dpi）')
  }
  if (!paperSize?.widthMM || !paperSize?.heightMM) {
    throw new Error('RotationResolver: paperSize 需含正数 widthMM/heightMM')
  }

  const cr = normalizeRotation(contentRotation)
  const pxPerMm = dpi / 25.4
  const roundPx = (v) => Math.round(v)

  // ── Layer 1：内容世界 ──
  // Commit 3 fix: 先用 contentRotation 旋转原始尺寸，再检测方向。
  // 原横票+用户旋转90° → 有效竖内容 → 竖纸=匹配(layout=0)、横纸=需旋转(layout=-90)
  const contentRotated = isRotated(Math.abs(cr))
  const effectiveContentW = contentRotated ? contentPhysicalSize.height : contentPhysicalSize.width
  const effectiveContentH = contentRotated ? contentPhysicalSize.width : contentPhysicalSize.height
  const contentOrientation = detectContentOrientation({ width: effectiveContentW, height: effectiveContentH })

  // ── Layer 2：纸张世界 ──
  // 两个独立变量：
  //   paperShapeOrientation = 纸张物理形状（A4→portrait, 297×210→landscape）
  //   paperOrientation      = 用户选择的最终方向（portrait/landscape 切换）
  const paperShapeOrientation = detectPaperOrientation(paperSize)
  const paperOrientation = paperOrientInput || paperShapeOrientation
  const paperW = roundPx(paperSize.widthMM * pxPerMm)
  const paperH = roundPx(paperSize.heightMM * pxPerMm)
  const toPx = (mm) => roundPx((Number(mm) || 0) * pxPerMm)
  const mL = toPx(margins.left)
  const mR = toPx(margins.right)
  const mT = toPx(margins.top)
  const mB = toPx(margins.bottom)

  // ── 纸面适配旋转（二阶段 Fit，Commit 2-E）──
  // Stage 1: shapeFitRotation — 内容方向 vs 纸张物理形状
  //   横内容 + A4(竖形纸) → -90；竖内容 + A4(竖形纸) → 0
  // Stage 2: orientationFitRotation — shape-adjusted 方向 → 用户方向
  //   shapeAdjustedOrientation: 内容经 shapeFit 后的方向（= paperShapeOrientation）
  const shapeFitRotation = computeLayoutRotation(contentOrientation, paperShapeOrientation)
  // shape-adjusted 方向：shapeFit 后内容已经匹配纸型 → ≡ paperShapeOrientation
  const shapeAdjustedOrientation = paperShapeOrientation
  const orientationFitRotation = computeLayoutRotation(shapeAdjustedOrientation, paperOrientation)
  // fitRotation = 原始值(-90/0/90)，renderRotation = 归一化(0/90/180/270)
  const fitRotation = shapeFitRotation + orientationFitRotation
  const renderRotation = normalizeRotation(fitRotation)
  const fitRotated = isRotated(Math.abs(fitRotation))
  const placedContentW = fitRotated ? effectiveContentH : effectiveContentW
  const placedContentH = fitRotated ? effectiveContentW : effectiveContentH

  // 可用区域（纸张扣除安全边距）
  const availableW = paperW - mL - mR
  const availableH = paperH - mT - mB

  if (availableW <= 0 || availableH <= 0) {
    throw new Error(`RotationResolver: 安全边距超出纸张尺寸 (paper=${paperSize.widthMM}x${paperSize.heightMM}mm, available=${availableW}x${availableH}px)`)
  }

  // fit scale（排版对象语义：可放大可缩小，最大化填充安全区）
  //   PrintPreview 中发票是「可布局对象」，目标 = 等比 fit 到 availableRect 边界（不超出安全边距）。
  //   与 Viewer（查看对象，保持真实比例、不消费 fit scale）语义严格不同。
  //   ⚠️ 顺序约束：scale 必须在 fitRotation 之后计算（placedContentW/H 已是旋转后尺寸），
  //      禁止先 scale 再旋转（否则放大后包围盒再次改变 → 布局破裂）。
  const scaleRaw = Math.min(
    availableW / placedContentW,
    availableH / placedContentH,
  )
  // 非法值保护：防御 contentW/H 或 availableW/H 为 0 的极端边界，避免 SVG scale=Infinity/NaN。
  // （正常路径 inputs 已校验正数；此 guard 为未来代码路径兜底，回退 scale=1 不产生无限变换。）
  const scale = Number.isFinite(scaleRaw) && scaleRaw > 0 ? scaleRaw : 1

  // 居中偏移
  const scaledW = roundPx(placedContentW * scale)
  const scaledH = roundPx(placedContentH * scale)
  const offsetX = mL + Math.round((availableW - scaledW) / 2)
  const offsetY = mT + Math.round((availableH - scaledH) / 2)

  // 最终画布 = 纸张尺寸（纸面不旋转，内容适配）
  const canvasSize = { width: paperW, height: paperH }

  return {
    // Layer 1：内容世界（Viewer 拥有旋转权限）
    contentRotation: cr,
    contentPhysicalSize: { width: contentPhysicalSize.width, height: contentPhysicalSize.height },
    contentOrientation,

    // 有效内容尺寸（content-rotated，供消费者直接使用）
    effectiveContentSize: { width: effectiveContentW, height: effectiveContentH },

    // Layer 2：纸面适配（PrintPreview 拥有纸张权限）
    //   纸张物理形状（A4→portrait, 297×210→landscape）
    paperShapeOrientation,
    //   用户选择的最终方向
    paperOrientation,
    //   Stage 1: 内容 vs 纸张物理形状
    shapeFitRotation,
    //   Stage 1 后的内容方向（= paperShapeOrientation，显式中转）
    shapeAdjustedOrientation,
    //   PaperShape → UserOrientation 的旋转
    orientationFitRotation,
    //   总适配旋转 = shapeFitRotation + orientationFitRotation
    fitRotation,
    renderRotation,

    // 几何
    canvasSize,
    availableRect: { x: mL, y: mT, w: availableW, h: availableH },
    scale,
    offset: { x: offsetX, y: offsetY },
    placedRect: { x: offsetX, y: offsetY, w: scaledW, h: scaledH },

    // SVG renderTransform（Commit 2-B→2-C 改名；Audit-3 修复像素级拉伸）
    //   缩略图 = contentRotation 已 bake 的自然尺寸（effectiveContentSize），不被二次旋转。
    //   <image> 以自然尺寸(imageWidth×imageHeight)绘制，绕自身中心 rotate(fitRotation)，
    //   再 scale(fit) 并居中到可用区中心。三段式：translate(居中) scale(fit) rotate(fitRotation, 内容中心)。
    //   —— 严禁把 imageWidth/Height 设为旋转后包围盒尺寸（preserveAspectRatio=none 会拉伸内容）。
    renderTransform: {
      translateX: mL + availableW / 2 - (effectiveContentW * scale) / 2,
      translateY: mT + availableH / 2 - (effectiveContentH * scale) / 2,
      scale,
      rotationDeg: renderRotation,
      rotationCx: effectiveContentW / 2,
      rotationCy: effectiveContentH / 2,
      imageWidth: effectiveContentW,
      imageHeight: effectiveContentH,
    },
  }
}

export default resolveContentPlacement
