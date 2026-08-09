/**
 * RotationResolver — 打印布局旋转解析器（三层权限模型，2026-08-06）
 *
 * ## 权限边界（Commit 2-C 冻结）
 *
 *   模块            | 可以修改              | 不可修改
 *   ───────────────┼──────────────────────┼──────────────────
 *   Viewer         | contentRotation      | paper
 *   PrintPreview   | requestedPaperOrientation     | contentRotation
 *   PrintPipeline  | 执行 placement        | 决定旋转
 *
 * ## 两层 Resolver
 *
 *   1. ContentResolve（本文件前半）：
 *      输入 contentRotation + contentPhysicalSize（px@dpi）→ 输出 effectiveContentSize + effectiveOrientation
 *      职责：把用户旋转动作物化为内容几何。Viewer 拥有旋转权限。
 *
 *   2. FitResolve（本文件后半）：
 *      输入 effectiveContentOrientation + physicalPaperOrientation → 输出 layoutRotation（-90/0）
 *      职责：纸面适配——比较【用户旋转后的有效内容方向】vs 物理纸方向，计算唯一匹配旋转。
 *      ⚠️ Commit 3（B2 修复）：物理纸方向**只从 physicalPaper 几何派生**，Resolver 不再接受方向标签。
 *      纸张坐标链：requestedPaperOrientation → needSwap（调用方）→ physicalPaper → physicalPaperOrientation。
 *      layoutRotation 不改变 contentRotation（thumbnail 已 bake），只影响最终 placement 的 transform。
 *
 * ## 核心公式（Step 2 统一模型）
 *
 *   effectiveContentW = contentRotated ? contentPhysicalSize.h : contentPhysicalSize.w
 *   effectiveContentH = contentRotated ? contentPhysicalSize.w : contentPhysicalSize.h
 *   effectiveContentOrientation = detectContentOrientation(effectiveContentW, effectiveContentH)
 *
 *   layoutRotation =
 *     0   : effectiveContentOrientation == physicalPaperOrientation
 *     -90 : 方向不匹配（横内容塞竖纸 / 竖内容塞横纸 同约定）
 *
 *   最终视觉 = contentRotation(烤入缩略图) + layoutRotation(SVG transform)，二者串行不互相修正。
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
 * Layer 2：打印布局旋转（纸张匹配，自动适配）。
 *
 * Step 2（2026-08-07）统一模型：用户旋转与纸张匹配严格分层。
 *   - contentOrientation 必须是【用户旋转后】的有效内容方向（由 resolveContentPlacement 内部计算）。
 *   - 比较有效内容方向 vs 物理纸方向（physicalPaperOrientation），决定唯一的纸张匹配旋转。
 * 规则：
 *   - 内容方向 == 纸张方向 → 0（不额外旋转）
 *   - 方向不匹配          → -90（逆时针 90° 对齐方向；横内容塞竖纸 / 竖内容塞横纸 同此约定）
 *
 * ⚠️ 约定：任何方向不匹配统一 -90（不再区分 +90），因为 thumbnail 已 bake contentRotation，
 *   SVG 只施加 layoutRotation；-90 使最终视觉 = contentRotation(烤入) + (-90) 正确对齐。
 *
 * @param {'portrait'|'landscape'} contentOrientation - 用户旋转后的有效内容方向
 * @param {'portrait'|'landscape'} physicalPaperOrientation - 物理纸张方向（由 physicalPaper 几何派生）
 * @returns {number} layoutRotation（0 | -90）
 */
export function computeLayoutRotation(contentOrientation, physicalPaperOrientation) {
  if (contentOrientation === physicalPaperOrientation) return 0
  // 方向不匹配：统一逆时针 90°（Step 2 统一模型，横内容塞竖纸 / 竖内容塞横纸 同约定）
  return -90
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
 * @param {{widthMM:number, heightMM:number}} input.physicalPaper - **最终物理纸张**尺寸（mm）。
 *   ⚠️ Commit 3（B2 修复）：Resolver 只接受一个可信的纸张物理坐标系，**不再接受 orientation 标签**。
 *   方向一律由几何派生：`physicalPaperOrientation = widthMM > heightMM ? 'landscape' : 'portrait'`。
 *   调用方负责在上游完成 `requestedPaperOrientation → needSwap → physicalPaper` 归一化
 *   （见 PrintPreviewModel.pageToModel 的 needSwap）。禁止把 requested/shape 标签再传进来，
 *   否则 Resolver 内部会发生「第二次 swap」——这正是 B2 语义分裂的根因。
 * @param {{left?:number, right?:number, top?:number, bottom?:number}} [input.margins] - 安全边距（mm，默认 0）
 * @param {number} [input.dpi=300]                            - 渲染 DPI
 * @returns {{
 *   // Layer 1 透传（内容世界）
 *   contentRotation: number,         // 用户旋转（0/90/180/270）
 *   contentPhysicalSize: {width:number, height:number},  // 原始内容尺寸（px，旋转前）
 *   contentOrientation: 'portrait'|'landscape',  // 有效内容方向 = 用户旋转后（Stage 1 物化）
 *   effectiveContentSize: {width:number, height:number}, // 用户旋转后的内容尺寸（px）
 *
 *   // Layer 2 派生（纸张匹配，Step 2 统一模型）
 *   physicalPaperOrientation: 'portrait'|'landscape',    // 物理纸张方向（**仅从 physicalPaper 几何派生**）
 *   layoutRotation: number,          // 唯一适配旋转（0 | -90），有效内容方向 vs 物理纸方向
 *   renderRotation: number,          // 归一化(layoutRotation)；SVG 施加旋转，thumbnail 已 bake contentRotation
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
  physicalPaper,
  margins = {},
  dpi = 300,
  ...legacyInput
}) {
  // ── 校验 ──
  if (!contentPhysicalSize?.width || !contentPhysicalSize?.height) {
    throw new Error('RotationResolver: contentPhysicalSize 需含正数 width/height（px@dpi）')
  }
  // Commit 3 契约护栏：拒绝旧的「几何 + 方向标签」双入参。
  //   静默忽略会制造假绿（Commit 1-A 改名后，旧 `paperOrientation:` 键已被无声吞掉，
  //   多个审计测试因此在不知情下变成纯几何驱动）。这里 fail-fast 让语义违约立刻暴露。
  for (const legacyKey of ['paperSize', 'paperOrientation', 'requestedPaperOrientation', 'paperShapeOrientation']) {
    if (legacyKey in legacyInput) {
      throw new Error(
        `RotationResolver: 已废弃入参 '${legacyKey}'（Commit 3 B2 修复）。` +
        `请在调用方完成 requestedPaperOrientation → needSwap → physicalPaper 归一化后，只传 physicalPaper{widthMM,heightMM}。`
      )
    }
  }
  if (!physicalPaper?.widthMM || !physicalPaper?.heightMM) {
    throw new Error('RotationResolver: physicalPaper 需含正数 widthMM/heightMM')
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
  // Commit 3（B2 修复）：Resolver 内部只存在**一个**可信的纸张物理坐标系。
  //   physicalPaper（调用方已归一化）→ physicalPaperOrientation（纯几何派生）→ 旋转决策 + 画布/可用区。
  //   旧模型同时相信 paperSize（几何）与 paperOrientation（标签），二者在横向纸型下恒相反 → 语义分裂。
  //   现在几何是唯一事实源：不可能再出现「外部 swap 后 Resolver 内部二次解释方向」。
  const physicalPaperOrientation = detectPaperOrientation(physicalPaper)
  const paperW = roundPx(physicalPaper.widthMM * pxPerMm)
  const paperH = roundPx(physicalPaper.heightMM * pxPerMm)
  const toPx = (mm) => roundPx((Number(mm) || 0) * pxPerMm)
  const mL = toPx(margins.left)
  const mR = toPx(margins.right)
  const mT = toPx(margins.top)
  const mB = toPx(margins.bottom)

  // 布局旋转 = 有效内容方向 vs 物理纸方向（唯一适配旋转，Stage 2）。
  //   方向匹配 → 0；方向不匹配 → -90（逆时针 90° 对齐方向）。
  // 注：thumbnail 已 bake contentRotation，故 layoutRotation 仅承载纸张匹配；
  //   最终视觉 = contentRotation(烤入缩略图) + layoutRotation(SVG)，二者串行、不互相修正。
  const layoutRotation = computeLayoutRotation(contentOrientation, physicalPaperOrientation)
  const renderRotation = normalizeRotation(layoutRotation)
  const fitRotated = isRotated(Math.abs(layoutRotation))
  const placedContentW = fitRotated ? effectiveContentH : effectiveContentW
  const placedContentH = fitRotated ? effectiveContentW : effectiveContentH

  // 可用区域（纸张扣除安全边距）
  const availableW = paperW - mL - mR
  const availableH = paperH - mT - mB

  if (availableW <= 0 || availableH <= 0) {
    throw new Error(`RotationResolver: 安全边距超出纸张尺寸 (paper=${physicalPaper.widthMM}x${physicalPaper.heightMM}mm, available=${availableW}x${availableH}px)`)
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
    // 有效内容方向 = 用户旋转后（Stage 1 物化），供 Stage 2 纸张匹配消费
    contentOrientation,

    // 有效内容尺寸（content-rotated，供消费者直接使用）
    effectiveContentSize: { width: effectiveContentW, height: effectiveContentH },

    // Layer 2：纸面适配（PrintPreview 拥有纸张权限）
    //   物理纸张方向（**唯一事实源 = physicalPaper 几何**，不再接受外部标签）
    physicalPaperOrientation,
    //   唯一适配旋转 = 有效内容方向 vs 物理纸方向（Step 2 统一模型）
    layoutRotation,
    //   SVG 施加旋转 = 归一化(layoutRotation)；thumbnail 已 bake contentRotation，故不含 content。
    renderRotation,

    // 几何
    canvasSize,
    availableRect: { x: mL, y: mT, w: availableW, h: availableH },
    scale,
    offset: { x: offsetX, y: offsetY },
    placedRect: { x: offsetX, y: offsetY, w: scaledW, h: scaledH },

    // SVG renderTransform（Commit 2-B→2-C 改名；Audit-3 修复像素级拉伸）
    //   缩略图 = contentRotation 已 bake 的自然尺寸（effectiveContentSize），不被二次旋转。
    //   <image> 以自然尺寸(imageWidth×imageHeight)绘制，绕自身中心 rotate(layoutRotation)，
    //   再 scale(fit) 并居中到可用区中心。三段式：translate(居中) scale(fit) rotate(layoutRotation, 内容中心)。
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
