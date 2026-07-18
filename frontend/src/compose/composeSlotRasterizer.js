/**
 * composeSlotRasterizer.js — C1 step2：逻辑 ComposeSlot(mm) → RenderSlot(px) 离散执行层
 *
 * 设计纪律（对齐 V16 F5 纯函数 + B0/B1 边界 + C 阶段铁律）：
 *   ❌ 禁止：config / renderers / worker / window / zoom / viewport / fit / rotate
 *   ✅ 只允许：把逻辑 slot 的「顺序 / 网格位置」映射到冻结的 px 分区公式
 *
 * ⚠️ C 阶段铁律（本次拍板）：
 *   「连续几何层（ComposeSlotLayoutFactory, mm）可以优化算法，
 *    但离散执行层（本文件, px）必须冻结历史 raster contract。」
 *   用户看到的是 px 输出，所以 px 分区结果必须与重构前 createLayout 字节级一致。
 *
 * 冻结的旧 px 分区公式（来自重构前 layout.js）：
 *   vertical: partHeight = floor(areaPx.height / count)
 *             y = index * partHeight
 *             height = (index === count-1) ? areaPx.height - y : partHeight
 *   grid:     cellWidth  = floor(areaPx.width  / gridCols)
 *             cellHeight = floor(areaPx.height / gridRows)
 *             width  = (col === gridCols-1) ? areaPx.width  - col*cellWidth  : cellWidth
 *             height = (row === gridRows-1) ? areaPx.height - row*cellHeight : cellHeight
 *   ⇒ 余数恒落「最后一格 / 最后一列 / 最后一行」，与旧行为一致（如 A4@300 merge3 = 1169/1169/1170）。
 *
 * 本层不重新发明分区：slot 数量与顺序由 ComposeSlotLayoutFactory（mm 语义）决定，
 * 本层只把每个 slot 按其 index / gridPosition 套用上面的冻结公式产出 px 矩形。
 * contentRect = slot 内缩 marginMm*k（与 renderers._composeContentRectPx 同源，C2 切换字节级无感）。
 */
import { DEFAULT_SLOT_MARGIN_MM } from './composeSlot.js'

/**
 * 把逻辑 ComposeSlot[]（mm，连续值，由 ComposeSlotLayoutFactory 产出）映射为 px RenderSlot[]。
 *
 * @param {Array} logicalSlots - ComposeSlotLayoutFactory 产出（含 index / gridPosition，用于排序与网格定位）
 * @param {Object} opts
 * @param {number} opts.dpi
 * @param {Object} opts.areaPx - px 可打印区 {x, y, width, height}（= getPrintableArea 输出），作为分区基准
 * @param {number} [opts.gridCols=2] - 仅 grid 模式用于列判定（vertical 视为单列）
 * @param {number} [opts.gridRows=2]
 * @param {number} [opts.marginMm=DEFAULT_SLOT_MARGIN_MM] - 内部安全边距（mm），产出 contentRect 内缩量
 * @returns {Array<{id:string, index:number, itemId:*, x:number, y:number, width:number, height:number, contentRect:object, gridPosition?:object}>}
 */
export function rasterizeSlots(logicalSlots, opts) {
  const {
    dpi,
    areaPx,
    gridCols = 2,
    gridRows = 2,
    marginMm = DEFAULT_SLOT_MARGIN_MM,
  } = opts
  const k = dpi / 25.4
  const inset = marginMm * k

  if (!logicalSlots || !logicalSlots.length) return []

  // 网格模式由 Factory 是否在 slot 上挂 gridPosition 决定（vertical 不挂）
  const isGrid = logicalSlots.some((s) => s.gridPosition)
  const cols = isGrid ? gridCols : 1
  const rows = isGrid ? gridRows : logicalSlots.length

  // ── 冻结旧 px 分区基数（floor，非 round；余数留给末格/末列/末行）──
  const baseW = cols > 1 ? Math.floor(areaPx.width / cols) : areaPx.width
  const baseH = rows > 1 ? Math.floor(areaPx.height / rows) : areaPx.height

  return logicalSlots.map((s) => {
    const col = s.gridPosition ? s.gridPosition.col : 0
    const row = s.gridPosition ? s.gridPosition.row : s.index

    // 末列/末行吃余数；其余用 floor 基数。vertical 时 cols=1 → 整宽整高。
    const x = areaPx.x + (cols > 1
      ? (col === cols - 1 ? areaPx.width - col * baseW : col * baseW)
      : 0)
    const y = areaPx.y + (rows > 1
      ? (row === rows - 1 ? areaPx.height - row * baseH : row * baseH)
      : 0)
    const width = cols > 1
      ? (col === cols - 1 ? areaPx.width - col * baseW : baseW)
      : areaPx.width
    const height = rows > 1
      ? (row === rows - 1 ? areaPx.height - row * baseH : baseH)
      : areaPx.height

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
