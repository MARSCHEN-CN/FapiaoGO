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
 *      输入 contentRotation + contentSize → 输出 effectiveContentSize + effectiveOrientation
 *      职责：把用户旋转动作物化为内容几何。Viewer 拥有旋转权限。
 *
 *   2. FitResolve（本文件后半）：
 *      输入 effectiveOrientation + paperSize → 输出 fitRotation（-90/0/+90）
 *      职责：纸面适配——当内容方向≠纸张方向时，计算所需的补偿旋转。
 *      fitRotation 不改变 contentRotation，只影响最终 placement 的 transform。
 *
 * ## 核心公式
 *
 *   effectiveContentW = contentRotated ? contentSize.h : contentSize.w
 *   effectiveContentH = contentRotated ? contentSize.w : contentSize.h
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
 * @param {{width:number, height:number}} input.contentSize  - 旋转后内容尺寸（px，resolveContentBounds 输出）
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
 *   scale: number,                   // fit scale = min(availableW / contentW, availableH / contentH)
 *   offset: {x:number, y:number},    // 居中偏移（px，locatedLayout 下内容左上角位置）
 *   placedRect: {x:number, y:number, w:number, h:number},  // 缩放居中后内容在画布上的位置
 * }}
 */
export function resolveContentPlacement({
  contentSize,
  contentRotation,
  paperSize,
  paperOrientation: paperOrientInput,
  margins = {},
  dpi = 300,
}) {
  // ── 校验 ──
  if (!contentSize?.width || !contentSize?.height) {
    throw new Error('RotationResolver: contentSize 需含正数 width/height')
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
  const effectiveContentW = contentRotated ? contentSize.height : contentSize.width
  const effectiveContentH = contentRotated ? contentSize.width : contentSize.height
  const contentOrientation = detectContentOrientation({ width: effectiveContentW, height: effectiveContentH })

  // ── Layer 2：纸张世界 ──
  const paperOrientation = paperOrientInput || detectPaperOrientation(paperSize)
  const paperW = roundPx(paperSize.widthMM * pxPerMm)
  const paperH = roundPx(paperSize.heightMM * pxPerMm)
  const toPx = (mm) => roundPx((Number(mm) || 0) * pxPerMm)
  const mL = toPx(margins.left)
  const mR = toPx(margins.right)
  const mT = toPx(margins.top)
  const mB = toPx(margins.bottom)

  // ── 纸面适配旋转（Fit）──
  // fitRotation = 内容方向不适配纸张方向时的补偿旋转（-90/0/+90）
  // 它不是"布局旋转内容"，而是"计算纸面适配所需的旋转补偿"
  const fitRotation = computeLayoutRotation(contentOrientation, paperOrientation)
  const fitRotated = isRotated(Math.abs(fitRotation))
  const placedContentW = fitRotated ? effectiveContentH : effectiveContentW
  const placedContentH = fitRotated ? effectiveContentW : effectiveContentH

  // 可用区域（纸张扣除安全边距）
  const availableW = paperW - mL - mR
  const availableH = paperH - mT - mB

  if (availableW <= 0 || availableH <= 0) {
    throw new Error(`RotationResolver: 安全边距超出纸张尺寸 (paper=${paperSize.widthMM}x${paperSize.heightMM}mm, available=${availableW}x${availableH}px)`)
  }

  // fit scale（只缩小不放大——内容小于安全区时保持原尺寸）
  const scale = Math.min(
    1,
    availableW / placedContentW,
    availableH / placedContentH,
  )

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
    contentSize: { width: contentSize.width, height: contentSize.height },
    contentOrientation,

    // 有效内容尺寸（content-rotated，供消费者直接使用）
    effectiveContentSize: { width: effectiveContentW, height: effectiveContentH },

    // Layer 2：纸面适配（PrintPreview 拥有纸张权限）
    // fitRotation = 内容方向不适配纸张时的补偿旋转（-90/0/+90）
    fitRotation,

    // 几何
    canvasSize,
    paperOrientation,
    availableRect: { x: mL, y: mT, w: availableW, h: availableH },
    scale,
    offset: { x: offsetX, y: offsetY },
    placedRect: { x: offsetX, y: offsetY, w: scaledW, h: scaledH },

    // SVG renderTransform（Commit 2-B→2-C 改名）
    //   translate(ox,oy) → 定位到纸面坐标
    //   scale(s)         → fit 缩放
    //   rotate(deg,cx,cy)→ 总旋转 = contentRotation + fitRotation（绕内容中心）
    //   消费方只需把 transform 直接作为 SVG <g> 属性，image 尺寸=imageWidth×imageHeight
    renderTransform: {
      translateX: offsetX,
      translateY: offsetY,
      scale,
      rotationDeg: normalizeRotation(cr + fitRotation),
      rotationCx: placedContentW / 2,
      rotationCy: placedContentH / 2,
      imageWidth: placedContentW,
      imageHeight: placedContentH,
    },
  }
}

export default resolveContentPlacement
