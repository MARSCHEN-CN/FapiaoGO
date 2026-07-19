/**
 * SlotLayout.js — V16 Stage 1 票位（N-Up）几何派生（纯函数 / node-safe）
 *
 * 职责（对齐 v16-architecture-target.md / RenderLayoutFactory.js）：
 *  • 把「一页 N 票」的票位划分收敛为唯一几何来源（与 createPlacement 同构：几何只算一次、只在此）。
 *  • 输入 PaperLayout（computePaperLayout 产物，usableRect 已含边距内缩，px@PREVIEW_DPI），
 *    输出 N 个等长竖向 band（{x,y,width,height,index}），坐标落在 paperLayout 的「自然（未旋转纸张）」空间。
 *  • 不感知票内容 / 屏幕 / 业务（V16：Paper 不知票、票不知屏、Renderer 不知业务）。
 *  • fit 数学零自研：fitIntoSlot 直接委托 composePlacement.createPlacement（唯一几何来源），
 *    不引入第二套 scale/offset 公式。
 *
 * 与旧 createLayout（layout.js → composeSlotRasterizer，mm→px 冻结公式）的关系：
 *  旧路径服务 Compose/Print 的「整页重排版」且工作在 mm→px 层；本模块服务 V16 RenderLayoutFactory
 *  的 buildRenderCommand(slotRect)，工作在已内缩边距的 usableRect（px）层。两者几何语义一致
 *  （竖向等分、末位精确收口），但本模块不重算 margin/dpi，符合 V16「Layout owns geometry」纪律。
 */

import { createPlacement } from '../compose/composePlacement.js'

/**
 * 从 PaperLayout 取「安全可打印区」（已含边距内缩），归一为 {x,y,w,h}。
 * 优先 usableRect，回退 contentRect（二者均为自然空间，无纸张方向 swap）。
 * @param {Object} paperLayout
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
export function safeRectOf(paperLayout) {
  const r = paperLayout && (paperLayout.usableRect || paperLayout.contentRect)
  if (!r) return null
  const w = r.w ?? r.width
  const h = r.h ?? r.height
  if (!(w > 0) || !(h > 0)) return null
  return { x: r.x || 0, y: r.y || 0, w, h }
}

/**
 * 计算一页 N 票的票位（竖向等分 band）。
 *
 * 不变量：
 *  • count<=1 退化为整页单票（slot0 == 安全区），保证 buildRenderCommand(slot) 与无 slot 行为一致。
 *  • 票位落在 paperLayout 自然空间（portrait）；横向纸张由 buildRenderCommand 统一做轴交换。
 *  • 末位精确收口到 usable 底边，杜绝浮点累积导致越界（与 createLayout「末格吃余」同义）。
 *
 * @param {Object} paperLayout - computePaperLayout 产物（usableRect 已在边距内缩，px@dpi）
 * @param {number} ticketCount - 票数（非正整数→1）
 * @returns {Array<{x:number,y:number,width:number,height:number,index:number}>}
 *   空数组表示 paperLayout 非法（调用方应走 empty / 不渲染）。
 */
export function computeTicketSlots(paperLayout, ticketCount) {
  const safe = safeRectOf(paperLayout)
  if (!safe) return []

  const count = Math.max(1, Math.floor(ticketCount) || 1)
  // 单票：slot0 == 整页安全区（向后兼容 buildRenderCommand 无 slot 语义）
  if (count === 1) {
    return [{ x: safe.x, y: safe.y, width: safe.w, height: safe.h, index: 0 }]
  }

  // ── 与 createLayout 对齐的 slot 几何 ──
  // 1) 基数用 Math.floor（非 float 等分），避免 Flt 累积
  // 2) 末 slot 吃余数，保证 sum(slots.height) === usable.h
  // 3) 每 slot 内缩 safeInsetPx（由 paperLayout.slotSafeInset 提供，
  //    对应 old DEFAULT_SLOT_MARGIN_MM / PRINT_SAFE_MARGIN_MM 的 px 当量），
  //    使 fit/居中在「留四周安全边距的 contentRect」内进行，与 createLayout 的同构。
  const inset = (paperLayout && paperLayout.slotSafeInset) || 0
  const baseH = Math.floor(safe.h / count)
  const slots = []
  let accY = safe.y
  for (let i = 0; i < count; i++) {
    // 末 slot 精确收口到底边（吃余数）
    const height = (i === count - 1) ? (safe.y + safe.h - accY) : baseH
    const rawSlot = { x: safe.x, y: accY, width: safe.w, height }
    // 内缩 safeInset（用于 createPlacement 的 contentRect）
    const insetSlot = inset > 0
      ? { x: rawSlot.x + inset, y: rawSlot.y + inset, width: rawSlot.width - 2 * inset, height: rawSlot.height - 2 * inset }
      : { ...rawSlot }
    slots.push({ ...insetSlot, index: i })
    accY += height
  }
  return slots
}

/**
 * 把单张内容 fit 进票位（min-contain + 居中），委托 createPlacement（唯一几何来源）。
 * 与 RenderLayoutFactory.buildRenderCommand 的 slot 路径同构——仅作独立计算/测试入口。
 *
 * @param {Object} params
 * @param {{x:number,y:number,width:number,height:number}} params.slotRect
 * @param {number} params.sourceWidth  - 内容固有宽(px，非预旋)
 * @param {number} params.sourceHeight - 内容固有高(px，非预旋)
 * @param {0|90|180|270} [params.rotation=0]
 * @returns {ReturnType<typeof createPlacement>}
 */
export function fitIntoSlot({ slotRect, sourceWidth, sourceHeight, rotation = 0 }) {
  if (!slotRect || !(slotRect.width > 0) || !(slotRect.height > 0)) {
    // 未就绪：降级的空几何（scale=0），与 createPlacement 守卫语义一致
    return createPlacement({
      contentRect: { x: 0, y: 0, width: 0, height: 0 },
      sourceWidth,
      sourceHeight,
      rotation,
    })
  }
  return createPlacement({
    contentRect: { x: slotRect.x, y: slotRect.y, width: slotRect.width, height: slotRect.height },
    sourceWidth,
    sourceHeight,
    rotation,
  })
}

/**
 * 横向纸张下，把「自然空间」票位按 buildRenderCommand 同一约定做轴交换。
 * 约定（与 RenderLayoutFactory 内 usableRect swap 同源）：
 *   横向可用区原点仍为 (mL,mT)，但尺寸交换 —— 故 portrait 票位 (x,y,w,h) →
 *   landscape (mL+(y-mT), mT+(x-mL), h, w)。
 * @param {{x:number,y:number,width:number,height:number}} slot - 自然空间票位
 * @param {{mL:number,mT:number}} margins - 物理边距（px）
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function slotToLandscape(slot, { mL, mT }) {
  return { x: mL + (slot.y - mT), y: mT + (slot.x - mL), width: slot.height, height: slot.width }
}
