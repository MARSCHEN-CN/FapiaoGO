/**
 * slotDiscretizer.js — C1 step2：逻辑 ComposeSlot(mm) → RenderSlot(px) 离散化层
 *
 * 设计纪律（对齐 V16 F5 纯函数 + B0/B1 边界）：
 *   ❌ 禁止：config / renderers / worker / window / zoom / viewport / fit / rotate
 *   ✅ 只允许：mm → px 单位换算 + 累计误差保留（不混入 fit/rotate/source）
 *
 * 存在原因：ComposeSlotLayoutFactory 产出「逻辑 slot」（mm，连续值，不离散化，
 * 余数由其拥有）。但最终渲染需要 px 整数坐标，且必须保留旧 createLayout 的
 * 「余数落在某一 slot」px characterization（如 A4@300 merge3 = 1169/1169/1170）。
 *
 * 关键算法（累计边界取整 + 末边界钉死）：
 *   对每个维度，收集所有 slot 的「左/上边缘」mm 位置 + 该维度总面积 mm，
 *   逐边缘 round(mm × dpi/25.4) 得到 px 边缘，最后一个边缘钉死到 px 可打印区
 *   的对应 extent（保证恰好铺满、无累计漂移）。每个 slot 的 px 矩形 = 相邻边缘之差。
 *   这样 merge2 边界（亚 mm 级）与 merge3 余数都与原 px 分区字节级一致，且
 *   Preview≡Print 两端使用同一离散化，彼此天然一致。
 */
import { DEFAULT_SLOT_MARGIN_MM } from './composeSlot.js'

/**
 * 将逻辑 ComposeSlot[]（mm，连续值）离散化为 px RenderSlot[]。
 *
 * @param {Array} logicalSlots - ComposeSlotLayoutFactory 产出（mm，连续值，含 paperRect/gridPosition）
 * @param {Object} opts
 * @param {number} opts.dpi
 * @param {Object} opts.areaPx - px 可打印区 {x, y, width, height}（来自 getPrintableArea），
 *        作为锚点（slot 原点偏移）+ 末边界钉死基准
 * @param {Object} opts.areaMm - mm 可打印区尺寸 {width, height}（= 传入 Factory 的 paper 尺寸）
 * @param {Object} [opts.originMm={x:0,y:0}] - 可打印区 origin（mm，相对纸张原点）；Factory 的 paperRect 已含此偏移，
 *        离散化时需先减去，得到相对可打印区的 mm 再 ×k 锚定到 areaPx。
 * @param {number} [opts.gridCols=2] - 仅用于 row-major 列判定（vertical 视为单列）
 * @param {number} [opts.gridRows=2]
 * @param {number} [opts.marginMm=DEFAULT_SLOT_MARGIN_MM] - 内部安全边距（mm），用于产出 contentRect。
 *        step2 renderer 仍用 _composeContentRectPx；两者值（浮点 mm×dpi/25.4）一致，C2 切换字节级无感。
 * @returns {Array<{id:string, index:number, itemId:*, x:number, y:number, width:number, height:number, contentRect:object, gridPosition?:object}>}
 */
export function discretizeSlots(logicalSlots, opts) {
  const {
    dpi,
    areaPx,
    areaMm,
    originMm = { x: 0, y: 0 },
    gridCols = 2,
    gridRows = 2,
    marginMm = DEFAULT_SLOT_MARGIN_MM,
  } = opts
  const k = dpi / 25.4
  const rnd = Math.round

  if (!logicalSlots || !logicalSlots.length) return []

  // Factory 的 paperRect 相对纸张原点（已含 originMm 偏移）；先减去得到相对可打印区的 mm，
  // 再 ×k 锚定到 areaPx，避免 origin 被重复计入。
  const ox = originMm.x
  const oy = originMm.y

  // ── X 边缘：所有列左边缘 mm（相对 origin）+ 右边界（= 可打印区宽 mm）──
  const colLeftsMm = [...new Set(logicalSlots.map((s) => s.paperRect.x - ox))].sort((a, b) => a - b)
  const xEdgesMm = [...colLeftsMm, areaMm.width]
  const xEdgesPx = xEdgesMm.map((mm, i) =>
    i === xEdgesMm.length - 1 ? areaPx.width : rnd(mm * k)
  )

  // ── Y 边缘：所有行上边缘 mm（相对 origin）+ 下边界（= 可打印区高 mm）──
  const rowTopsMm = [...new Set(logicalSlots.map((s) => s.paperRect.y - oy))].sort((a, b) => a - b)
  const yEdgesMm = [...rowTopsMm, areaMm.height]
  const yEdgesPx = yEdgesMm.map((mm, i) =>
    i === yEdgesMm.length - 1 ? areaPx.height : rnd(mm * k)
  )

  // 与 renderers._composeContentRectPx 同源（浮点），C2 切换字节级一致
  const inset = marginMm * k

  return logicalSlots.map((s) => {
    const col = s.gridPosition ? s.gridPosition.col : 0
    const row = s.gridPosition ? s.gridPosition.row : s.index
    const x = areaPx.x + xEdgesPx[col]
    const y = areaPx.y + yEdgesPx[row]
    const width = xEdgesPx[col + 1] - xEdgesPx[col]
    const height = yEdgesPx[row + 1] - yEdgesPx[row]
    const contentRect = {
      x: x + inset,
      y: y + inset,
      width: Math.max(0, width - 2 * inset),
      height: Math.max(0, height - 2 * inset),
    }
    const out = {
      id: s.id,
      index: s.index,
      itemId: undefined, // 由 createLayout 按位置映射（Factory 不感知 items）
      x,
      y,
      width,
      height,
      contentRect,
    }
    if (s.gridPosition) out.gridPosition = s.gridPosition
    return out
  })
}
