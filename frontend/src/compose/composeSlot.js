/**
 * ComposeSlot — V16 Virtual Paper Slot 几何模型（B0 阶段，纯数学）
 *
 * 设计纪律（对齐 V16 F5 纯函数）：
 *   ❌ 禁止：dpi / px / canvas / image / RenderCommand / window / zoom / viewport
 *   ✅ 只允许：纸张坐标(mm) 的矩形计算
 *
 * 逻辑几何来源（非离散化层）：
 *   - vertical N 等分 / grid 2×2，row-major（与旧 layout.js 分区同构）
 *   - 仅产出 mm 连续值，不四舍五入、不在此吃余数
 *   - px 离散化由 composeSlotRasterizer.js 负责，冻结旧 createLayout 的 px 分区公式
 *     （floor 基数 + 末格/末列/末行吃余数），保留旧 px characterization（A4@300 merge3 = 1169/1169/1170）
 *
 * 坐标单位为 mm；本工厂接收「可打印区 origin（paperXMm/paperYMm，外层边距后的左上角）
 * + paper 尺寸」，默认 origin={0,0} 即整纸（与 B0 行为一致）。仅在每张虚拟纸内部再内缩
 * marginMm 得到 contentRect。C1 起为 ComposeSlotLayoutFactory（buildComposeSlots 保留别名）。
 *
 * 输入为「已解析」的纸张 mm 尺寸 + mergeMode（不读 config / 不解析 paperKey），
 * 因此可在纯 Node 下单测，不依赖 Vite / Electron。
 */

export const DEFAULT_SLOT_MARGIN_MM = 5

/** 从 mergeMode 推导分割规格（镜像 usePreview.js:606-607 + usePrint.js:298） */
export function resolveMergeSpec(mergeMode) {
  const groupSize = parseInt(String(mergeMode).replace('merge', ''), 10) || 2
  const strategy = groupSize === 4 ? 'grid' : 'vertical'
  return { groupSize, strategy, gridCols: 2, gridRows: 2 }
}

function makeSlot(index, x, y, width, height, marginMm, gridPosition) {
  const paperRect = { x, y, width, height }
  const inset = 2 * marginMm
  const marginRect = {
    x: x + marginMm,
    y: y + marginMm,
    width: Math.max(0, width - inset),
    height: Math.max(0, height - inset),
  }
  // uniform 边距下 marginRect 与 contentRect 同一矩形；contentRect 即内容 fit 区域
  const contentRect = { ...marginRect }
  const slot = { id: `slot-${index}`, index, paperRect, marginRect, contentRect }
  if (gridPosition) slot.gridPosition = gridPosition
  return slot
}

/**
 * 构建 Virtual Paper Slot 列表（mm，DPI 无关）—— C1 起为 ComposeSlotLayoutFactory。
 * 接收「可打印区 origin（paperXMm/paperYMm，由调用方扣完外层边距后的左上角）+ paper 尺寸」，
 * 默认 origin={0,0} 即整纸（与 B0 characterization 测试一致）。仅每张虚拟纸内部再内缩 marginMm。
 *
 * @param {Object} params
 * @param {Object} params.paper - 已解析纸张尺寸：{ widthMM, heightMM, isLandscape }
 * @param {string} params.mergeMode - 'merge2' | 'merge3' | 'merge4'
 * @param {number} [params.marginMm=5] - 每张虚拟纸内部安全边距（mm）
 * @param {number} [params.paperXMm=0] - 可打印区左上角 x 偏移（mm，相对纸张原点）
 * @param {number} [params.paperYMm=0] - 可打印区左上角 y 偏移（mm，相对纸张原点）
 * @returns {ComposeSlot[]}
 */
export function ComposeSlotLayoutFactory({ paper, mergeMode, marginMm = DEFAULT_SLOT_MARGIN_MM, paperXMm = 0, paperYMm = 0 }) {
  if (!paper || typeof paper.widthMM !== 'number' || typeof paper.heightMM !== 'number') {
    throw new Error('ComposeSlotLayoutFactory: paper.widthMM/heightMM required (mm, already resolved)')
  }
  const w = paper.isLandscape ? paper.heightMM : paper.widthMM
  const h = paper.isLandscape ? paper.widthMM : paper.heightMM
  // 可打印区 origin：调用方扣完外层边距后的左上角（mm）。默认 {0,0}=整纸（与 B0 一致）。
  const area = { x: paperXMm, y: paperYMm, width: w, height: h }

  const { groupSize, strategy, gridCols, gridRows } = resolveMergeSpec(mergeMode)
  const count = groupSize
  const slots = []

  // C1 step2：本工厂只产出「逻辑 slot」（mm，连续值，不离散化）。
  // px 离散化交由 composeSlotRasterizer.js，冻结旧 createLayout 的 px 分区公式
  // （floor 基数 + 末格/末列/末行吃余数），保留旧 px characterization（如 A4@300 merge3 = 1169/1169/1170）。
  if (strategy === 'vertical') {
    const partHeight = area.height / count
    for (let index = 0; index < count; index++) {
      const y = area.y + index * partHeight
      slots.push(makeSlot(index, area.x, y, area.width, partHeight, marginMm))
    }
  } else {
    const cellWidth = area.width / gridCols
    const cellHeight = area.height / gridRows
    for (let index = 0; index < count; index++) {
      const col = index % gridCols
      const row = Math.floor(index / gridCols)
      const x = area.x + col * cellWidth
      const y = area.y + row * cellHeight
      slots.push(makeSlot(index, x, y, cellWidth, cellHeight, marginMm, { col, row }))
    }
  }
  return slots
}

// 向后兼容别名：C1 之前名为 buildComposeSlots。C2 接线后统一改用 ComposeSlotLayoutFactory。
export const buildComposeSlots = ComposeSlotLayoutFactory
