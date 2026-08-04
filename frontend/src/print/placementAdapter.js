/**
 * A3-3-2 PlacementAdapter 纯层（冻结 a3_design_spec §A3-3 / §A3-3-2）
 *
 * 职责（用户定稿）：只做一件事——给 native bitmap 增加 sourceOrigin 位移。
 *
 *   RenderResource (native bitmap)
 *           ↓
 *   PlacementAdapter (paper coordinate space)
 *           ↓
 *   PlacementCommand（drawRenderCommand 兼容）
 *           ↓
 *   paper canvas
 *
 * 原则：resource ≠ placement（A3-1/2 验证的架构原则延续）。
 *   - 不碰 canvas / 不改 pixel data / 不改 scale / 不改 rotation
 *   - 只生成「位移后的绘制命令」，消费方（drawRenderCommand）负责绘制
 *
 * ⚠️ sourceOrigin ≠ margin（A3-3-1 冻结）：
 *   - sourceOrigin = source 语义（原始 PDF 内容相对扩展纸面的偏移，mm）
 *   - margin = layout 可用区域约束
 *   二者数值可能相同（10mm）但语义不同，本模块只消费 sourceOrigin，绝不读 margin。
 *
 * 纯函数，node 可直接测试。
 */

// DPI 由调用方传入（默认 300，与 Canvas 轨 PREVIEW_DPI 一致）。
// 不 import config.js（其含 vite import.meta.env 依赖，node 不可加载）——保持本模块纯 node 可测。
const DEFAULT_DPI = 300

/** mm → px（@300dpi，与 Canvas 轨 PREVIEW_DPI 一致）——命名带 Placement 后缀避免与 measureMargins.mmToPx 冲突 */
export function mmToPxPlacement(mm, dpi = DEFAULT_DPI) {
  return Math.round((Number(mm) || 0) * dpi / 25.4)
}

/**
 * 生成 PlacementCommand（drawRenderCommand 兼容，renderDraw.js:34-50）
 *
 * @param {object} opts
 * @param {object} opts.renderResource  native 渲染结果（renderPDFPageRaw 输出或 {canvas,width,height}）
 * @param {object} opts.paperLayout     含 sourceOrigin（extendPaperLayoutContract 输出）
 * @param {object} [opts.rotation=0]    内容旋转角（A3-3-2 仅 rot0，A3-3-3 处理 rotation）
 * @returns {object} PlacementCommand
 *   { placement:{offsetX,offsetY,scale}, rotatedBounds:{width,height}, contentRotation, clip }
 */
export function applySourceOriginPlacement({ renderResource, paperLayout, rotation = 0 }) {
  if (!renderResource?.width || !renderResource?.height) {
    throw new Error('applySourceOriginPlacement: renderResource 需含 width/height（native 渲染结果）')
  }
  if (!paperLayout?.sourceOrigin) {
    throw new Error('applySourceOriginPlacement: paperLayout 需含 sourceOrigin（extendPaperLayoutContract 输出）')
  }

  const offsetX = mmToPxPlacement(paperLayout.sourceOrigin.x)
  const offsetY = mmToPxPlacement(paperLayout.sourceOrigin.y)
  const scale = 1  // A3-3-2：不缩放（source = native + offset，G1-3B 已证 ratio 1.0）

  return {
    placement: { offsetX, offsetY, scale },
    rotatedBounds: {
      width: renderResource.width,
      height: renderResource.height,
    },
    contentRotation: rotation,
    clip: null,  // 单文件整页，不裁剪
  }
}

/**
 * A3-3-3 transformPaperRotation：Policy A（paper + content 一体旋转）的画布级旋转命令
 *
 * 冻结（a3_design_spec §7.1）：
 *   - C2 Policy A：纸面方向跟随内容旋转（rot90 → 纸面 W×H → H×W），非纸固定内容旋转（Policy B）
 *   - C3 变换顺序：native → 施加 sourceOrigin（扩展纸面）→ 整体旋转（paper+content 一体，中心支点）
 *   - C4 sourceOrigin 是 paper-space 属性：**不参与旋转变换**（rot0 阶段 offset 已施加，
 *     旋转作用于整个扩展纸面画布）
 *   - 输出仍是 PlacementCommand（drawRenderCommand 兼容），**绝不返回 bitmap**
 *     （用户实现边界：PlacementAdapter → PlacementCommand → drawRenderCommand → Canvas）
 *
 * ⚠️ 实现要点（2026-08-04 修正，Gate 02/03 失败暴露）：
 *   drawRenderCommand 的 contentRotation 语义 = 内容在**画布内**绕落盘中心旋转（Policy B），
 *   直接改 command 的 offset/rotatedBounds 走 cr 旋转会让内容旋转后超出画布（Policy A 不满足）。
 *   Policy A 的正确实现 = **画布级旋转**：rot0 command 先绘制扩展纸面画布（2717×1890），
 *   再把该画布作为 source 用「画布旋转 command」（rotateCanvasCommand）旋转绘制到新画布（1890×2717）。
 *   与 A3-2 采集器（canvas 2D 旋转整个画布）同一数学——已验证（C5 bbox (201,169) 吻合）。
 *
 * @param {object} placement  PlacementCommand（applySourceOriginPlacement 输出，rot0 版）
 * @param {number} rotation   90 | 180 | 270（0 返回原画布尺寸 + 无旋转命令）
 * @param {number} paperW     原扩展纸面宽（px）
 * @param {number} paperH     原扩展纸面高（px）
 * @returns {object} { canvasW, canvasH, rotateCanvasCommand|null }
 *   - canvasW/canvasH：旋转后画布尺寸（90/270 → paperH×paperW；180 → 原尺寸）
 *   - rotateCanvasCommand：把「扩展纸面画布」旋转绘制到新画布的 PlacementCommand
 *     （placement.offset=0/0 居中、rotatedBounds=原画布尺寸、contentRotation=rotation、clip=null）
 */
export function transformPaperRotation(placement, rotation, paperW, paperH) {
  const r = ((Math.round(rotation) % 360) + 360) % 360
  if (!(paperW > 0) || !(paperH > 0)) {
    throw new Error('transformPaperRotation: paperW/paperH 需为正数（扩展纸面 px）')
  }
  if (r === 0) return { canvasW: paperW, canvasH: paperH, rotateCanvasCommand: null }
  if (r !== 90 && r !== 180 && r !== 270) {
    // 非法角度（非 0/90/180/270）：fail-loud，不静默返回错误几何
    throw new Error(`transformPaperRotation: 非法 rotation=${rotation}（仅支持 0/90/180/270）`)
  }
  const swap = r === 90 || r === 270
  const nW = swap ? paperH : paperW
  const nH = swap ? paperW : paperH
  return {
    canvasW: nW,
    canvasH: nH,
    rotateCanvasCommand: {
      placement: { offsetX: 0, offsetY: 0, scale: 1 },
      rotatedBounds: { width: paperW, height: paperH },  // source = 扩展纸面画布（整页）
      contentRotation: r,
      clip: null,
    },
  }
}

/**
 * A3-3-2-01 Gate：placement 后 bbox 是否 = native bbox + sourceOrigin（dx/dy ≤0.5mm）
 * @param {object} nativeBbox {x,y,w,h}（px，native 渲染内容 bbox）
 * @param {object} paperLayout 含 sourceOrigin（mm）
 * @param {object} expectedSourceBbox {x,y,w,h}（px，source 轨内容 bbox）
 * @returns {{pass:boolean, dxPx:number, dyPx:number, dxMm:number, dyMm:number, errors:string[]}}
 */
export function assertPlacementOffset(nativeBbox, paperLayout, expectedSourceBbox, dpi = DEFAULT_DPI) {
  const errors = []
  const offsetX = mmToPxPlacement(paperLayout.sourceOrigin.x, dpi)
  const offsetY = mmToPxPlacement(paperLayout.sourceOrigin.y, dpi)
  const placedX = nativeBbox.x + offsetX
  const placedY = nativeBbox.y + offsetY
  const dxPx = placedX - expectedSourceBbox.x
  const dyPx = placedY - expectedSourceBbox.y
  const dxMm = dxPx * 25.4 / dpi
  const dyMm = dyPx * 25.4 / dpi
  if (Math.abs(dxMm) > 0.5) errors.push(`dx=${dxMm.toFixed(3)}mm > 0.5mm`)
  if (Math.abs(dyMm) > 0.5) errors.push(`dy=${dyMm.toFixed(3)}mm > 0.5mm`)
  return {
    pass: errors.length === 0,
    dxPx, dyPx, dxMm: Math.round(dxMm * 1000) / 1000, dyMm: Math.round(dyMm * 1000) / 1000,
    placedX, placedY,
    errors,
  }
}
