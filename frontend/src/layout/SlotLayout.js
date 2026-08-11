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
 * 计算一页 N 票的票位（统一入口：支持 vertical / grid 两种策略）。
 *
 * ⚠️ 冻结的 px 分区公式（与 composeSlotRasterizer.js 同源，C 阶段铁律）：
 *   vertical: baseH = floor(areaPx.height / count)
 *             y = index * baseH
 *             height = (index === count-1) ? areaPx.height - y : baseH
 *   grid:     baseW = floor(areaPx.width / gridCols)
 *             baseH = floor(areaPx.height / gridRows)
 *             width  = (col === gridCols-1) ? areaPx.width  - col*baseW  : baseW
 *             height = (row === gridRows-1) ? areaPx.height - row*baseH : baseH
 *   ⇒ 余数恒落「最后一格 / 最后一列 / 最后一行」，与旧行为一致。
 *
 * 不变量：
 *  • count<=1 退化为整页单票（slot0 == 安全区）。
 *  • 票位落在 paperLayout 自然空间（portrait）；横向纸张由 buildRenderCommand 统一做轴交换。
 *  • 末位精确收口，杜绝浮点累积导致越界。
 *  • 每个 slot 含 paperRect（虚拟纸张外框）和 contentRect（内缩安全边距后）。
 *
 * @param {Object} paperLayout - computePaperLayout 产物（usableRect 已在边距内缩，px@dpi）
 * @param {Object} options
 * @param {number} options.count - 票数（非正整数→1）
 * @param {'vertical'|'grid'} [options.strategy='vertical'] - 切分策略
 * @param {number} [options.gridCols=2] - grid 模式列数
 * @param {number} [options.gridRows=2] - grid 模式行数
 * @returns {Array<{index:number, x:number, y:number, width:number, height:number, paperRect:Object, contentRect:Object, gridPosition?:{col:number,row:number}}>}
 *   空数组表示 paperLayout 非法（调用方应走 empty / 不渲染）。
 */
export function computeSlots(paperLayout, options) {
  const safe = safeRectOf(paperLayout)
  if (!safe) return []

  const {
    count: countRaw,
    strategy = 'vertical',
    gridCols = 2,
    gridRows = 2,
  } = options || {}

  const count = Math.max(1, Math.floor(countRaw) || 1)
  // slotMarginPx：每张虚拟纸（slot）的内部 margin（px）。
  // 对应 Virtual Paper Geometry 的第二层：slot → contentRect（四周均匀内缩）。
  const inset = (paperLayout && paperLayout.slotMarginPx) || 0

  // 单票：slot0 == 整页安全区（向后兼容 buildRenderCommand 无 slot 语义）
  if (count === 1) {
    const paperRect = { x: safe.x, y: safe.y, width: safe.w, height: safe.h }
    const contentRect = inset > 0
      ? { x: safe.x + inset, y: safe.y + inset, width: safe.w - 2 * inset, height: safe.h - 2 * inset }
      : { ...paperRect }
    return [{ index: 0, x: contentRect.x, y: contentRect.y, width: contentRect.width, height: contentRect.height, paperRect, contentRect }]
  }

  const slots = []

  if (strategy === 'grid') {
    const cols = Math.max(1, Math.floor(gridCols) || 1)
    const rows = Math.max(1, Math.floor(gridRows) || 1)
    const baseW = Math.floor(safe.w / cols)
    const baseH = Math.floor(safe.h / rows)
    let idx = 0
    for (let row = 0; row < rows && idx < count; row++) {
      for (let col = 0; col < cols && idx < count; col++) {
        const x = safe.x + col * baseW
        const y = safe.y + row * baseH
        const width = (col === cols - 1) ? (safe.x + safe.w - x) : baseW
        const height = (row === rows - 1) ? (safe.y + safe.h - y) : baseH
        const paperRect = { x, y, width, height }
        const contentRect = inset > 0
          ? { x: x + inset, y: y + inset, width: Math.max(0, width - 2 * inset), height: Math.max(0, height - 2 * inset) }
          : { ...paperRect }
        slots.push({
          index: idx,
          x: contentRect.x,
          y: contentRect.y,
          width: contentRect.width,
          height: contentRect.height,
          paperRect,
          contentRect,
          gridPosition: { col, row },
        })
        idx++
      }
    }
  } else {
    // vertical 策略：竖向等分
    const baseH = Math.floor(safe.h / count)
    let accY = safe.y
    for (let i = 0; i < count; i++) {
      const height = (i === count - 1) ? (safe.y + safe.h - accY) : baseH
      const paperRect = { x: safe.x, y: accY, width: safe.w, height }
      const contentRect = inset > 0
        ? { x: safe.x + inset, y: accY + inset, width: safe.w - 2 * inset, height: height - 2 * inset }
        : { ...paperRect }
      slots.push({
        index: i,
        x: contentRect.x,
        y: contentRect.y,
        width: contentRect.width,
        height: contentRect.height,
        paperRect,
        contentRect,
      })
      accY += height
    }
  }

  return slots
}

/**
 * 计算一页 N 票的票位（竖向等分 band）。
 *
 * 向后兼容的 thin wrapper：内部委托 computeSlots(strategy='vertical')，
 * 仅返回 contentRect 的扁平 x/y/width/height/index（旧调用方只消费这些字段）。
 *
 * @deprecated 新代码请直接使用 computeSlots({ strategy })
 * @param {Object} paperLayout - computePaperLayout 产物（usableRect 已在边距内缩，px@dpi）
 * @param {number} ticketCount - 票数（非正整数→1）
 * @returns {Array<{x:number,y:number,width:number,height:number,index:number}>}
 */
export function computeTicketSlots(paperLayout, ticketCount) {
  const slots = computeSlots(paperLayout, { count: ticketCount, strategy: 'vertical' })
  // 兼容旧契约：只返回扁平字段（x/y/width/height/index = contentRect 投影）
  return slots.map(s => ({ x: s.x, y: s.y, width: s.width, height: s.height, index: s.index }))
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
