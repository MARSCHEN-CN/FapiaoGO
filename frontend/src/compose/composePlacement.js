/**
 * composePlacement.js — V16 Compose Placement 几何层（B1 阶段，纯数学）
 *
 * 设计纪律（对齐 V16 F5 纯函数 + B0 边界）：
 *   ❌ 禁止：config / renderers / worker / window / zoom / viewport / RenderCommand 组装
 *   ✅ 只允许：px 坐标的「内容 → 虚拟纸」几何映射
 *
 * 职责单一（两级，互不污染）：
 *   - mmSlotToPx:  ComposeSlot(mm) → ComposeSlot(px)，仅做单位换算，不混入 fit/rotate/source
 *   - createPlacement: 内容尺寸(px) + contentRect(px) + rotation → RenderPlacement(px)
 *
 * 这是 B1 真正要建的「几何转换层」，替代 renderers.js:731-755 里散落的 fit/offset/clip
 * 内联数学；Preview(Worker) 与 Print(Direct) 两条链后续都将调用 createPlacement，
 * 确保两端 placement 几何一致（V16：Renderer 不拥有 Layout）。
 *
 * 输出 RenderPlacement 故意不含 version / paper / command —— 那些是 RenderCommand
 * 组装层（调用方 / ComposeLayoutFactory）的职责，本工厂只产纯几何。
 */

/** mm → px 换算系数 */
export function mmToPxFactor(dpi) {
  return dpi / 25.4
}

/**
 * ComposeSlot(mm) → ComposeSlot(px)。纯单位换算，不改动任何几何关系。
 * 仅转换 paperRect / marginRect / contentRect 三个矩形，保留 id/index/gridPosition。
 * @param {ComposeSlot} slot - B0 产物（mm）
 * @param {number} dpi
 * @returns {ComposeSlot} px 版（深拷贝，不改入参）
 */
export function mmSlotToPx(slot, dpi) {
  const k = mmToPxFactor(dpi)
  const toPx = (r) => ({
    x: r.x * k,
    y: r.y * k,
    width: r.width * k,
    height: r.height * k,
  })
  const out = {
    id: slot.id,
    index: slot.index,
    paperRect: toPx(slot.paperRect),
    marginRect: toPx(slot.marginRect),
    contentRect: toPx(slot.contentRect),
  }
  if (slot.gridPosition) out.gridPosition = slot.gridPosition
  return out
}

/**
 * 计算单张内容在虚拟纸 contentRect 内的 placement（px）。
 *
 * 关键修复（相对 renderers.js:731-755 旧内联数学）：
 *   fit / offset / clip 全部读取 **contentRect**（已内缩安全边距），而非整个 slot，
 *   使发票 fit 到安全边距内、四周留白，而非填满 slot 触边。
 *
 * @param {Object} params
 * @param {Object} params.contentRect - px 矩形 {x, y, width, height}（来自 mmSlotToPx 后）
 * @param {number} params.sourceWidth - 内容原始宽(px)
 * @param {number} params.sourceHeight - 内容原始高(px)
 * @param {number} [params.rotation=0] - 0 | 90 | 180 | 270
 * @returns {RenderPlacement}
 */
export function createPlacement({ contentRect, sourceWidth, sourceHeight, rotation = 0 }) {
  const isRotated90 = rotation === 90 || rotation === 270
  // rotation-aware：旋转 90/270 后内容的有效宽高互换（镜像 renderers.js:738-740）
  const effectiveW = isRotated90 ? sourceHeight : sourceWidth
  const effectiveH = isRotated90 ? sourceWidth : sourceHeight

  // 防御：contentRect 或 effective 维度非正 → fit 收敛到 0，绝不产生 Infinity / NaN / 负 scale。
  // 与现有 renderer「slot.width=0 → scale=0 → 不绘制」语义一致，且不破坏调用方契约
  // （始终返回合法 RenderPlacement，从不返回 null）。
  const fitW = effectiveW > 0 ? contentRect.width / effectiveW : 0
  const fitH = effectiveH > 0 ? contentRect.height / effectiveH : 0
  const scale = Math.max(0, Math.min(fitW, fitH))

  const drawW = effectiveW * scale
  const drawH = effectiveH * scale

  // 左上角契约：contentRect 中心对齐内容中心（等价 renderers.js:750-751 的中心式偏移，
  // 当 contentRect === slot 时结果完全一致 → 像素级等价旧行为）。
  const offsetX = contentRect.x + (contentRect.width - drawW) / 2
  const offsetY = contentRect.y + (contentRect.height - drawH) / 2

  return {
    scale,
    offsetX,
    offsetY,
    // rotatedBounds 是「未缩放」的旋转后内容尺寸（px），与 renderers.js:747 一致
    rotatedBounds: { width: effectiveW, height: effectiveH },
    // 语义：安全边距区域永远不可绘制 → clip 锁 contentRect
    clip: {
      x: contentRect.x,
      y: contentRect.y,
      width: contentRect.width,
      height: contentRect.height,
    },
    contentRotation: rotation,
  }
}
