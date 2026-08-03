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
