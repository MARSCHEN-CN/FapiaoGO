import { PAPER_SIZE_MAP } from './config.js'
import { ComposeSlotLayoutFactory, DEFAULT_SLOT_MARGIN_MM } from './compose/composeSlot.js'
import { rasterizeSlots } from './compose/composeSlotRasterizer.js'

/**
 * Layout Engine - 独立的布局计算层（WPS级架构）
 * 
 * 设计原则：
 * ❌ 不允许：drawImage, canvas, DOM 操作, ctx 操作
 * ✅ 只允许：计算位置、计算 bounds、计算 transform（纯数据）
 * 
 * 输入要求（标准化）：
 * {
 *   id: string,
 *   type: 'pdf' | 'image',
 *   meta: {
 *     width: number,
 *     height: number
 *   }
 * }
 */

export function getPaperPixels(paperKey, dpi, isLandscape = false, customPaper = null) {
  let paper
  if (paperKey === 'Custom' && customPaper?.widthMM > 0 && customPaper?.heightMM > 0) {
    paper = { widthMM: customPaper.widthMM, heightMM: customPaper.heightMM }
  } else {
    paper = PAPER_SIZE_MAP[paperKey] || PAPER_SIZE_MAP.A4
  }
  let w = paper.widthMM
  let h = paper.heightMM
  if (isLandscape) {
    ;[w, h] = [h, w]
  }
  return {
    width: Math.round(w * dpi / 25.4),
    height: Math.round(h * dpi / 25.4),
    widthMM: w,
    heightMM: h
  }
}

export const PRINT_SAFE_MARGIN_MM = 5

export const PRINTER_PROFILES = {
  default: {
    top: 4,
    bottom: 4,
    left: 5,
    right: 5
  },
  strict: {
    top: 10,
    bottom: 10,
    left: 10,
    right: 10
  },
  borderless: {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0
  }
}

export function getPrintableArea(pixels, margin = 0) {
  let top, bottom, left, right
  
  if (typeof margin === 'object') {
    top = margin.top || 0
    bottom = margin.bottom || 0
    left = margin.left || 0
    right = margin.right || 0
  } else {
    top = bottom = left = right = margin
  }
  
  // ✅ 分别计算 scaleX/scaleY，避免横向/自定义纸张时比例不一致
  const scaleX = pixels.width / pixels.widthMM
  const scaleY = pixels.height / pixels.heightMM
  
  return {
    x: Math.round(left * scaleX),
    y: Math.round(top * scaleY),
    width: pixels.width - Math.round((left + right) * scaleX),
    height: pixels.height - Math.round((top + bottom) * scaleY)
  }
}

export function createLayout(items, paperKey, dpi, isLandscape = false, options = {}) {
  const { slotCount, strategy = 'vertical', margin = 0, gridCols = 2, gridRows = 2, customPaper } = options

  const page = getPaperPixels(paperKey, dpi, isLandscape, customPaper)
  const area = getPrintableArea(page, margin)   // px 可打印区（对外契约不变：mergeFactory / renderers 仍消费 px）

  const count = slotCount || items.length

  // ── C1 step2：slot 分区 OWNERSHIP 移交 ComposeSlotLayoutFactory（逻辑 mm 来源）──
  // 1) 解析外层边距 → 可打印区 mm 尺寸 + origin（Factory 接收「已扣边距」的 paper + origin）
  const mLeft = typeof margin === 'object' ? (margin.left || 0) : margin
  const mTop = typeof margin === 'object' ? (margin.top || 0) : margin
  const mRight = typeof margin === 'object' ? (margin.right || 0) : margin
  const mBottom = typeof margin === 'object' ? (margin.bottom || 0) : margin
  const printableWidthMm = page.widthMM - mLeft - mRight
  const printableHeightMm = page.heightMM - mTop - mBottom
  // page.widthMM/heightMM 已由 getPaperPixels 按 isLandscape 调整，故传给 Factory 时
  // isLandscape:false，避免 Factory 内部二次旋转。
  const paperMM = { widthMM: printableWidthMm, heightMM: printableHeightMm, isLandscape: false }
  const mergeMode = strategy === 'grid' ? 'merge4' : `merge${count}`
  // 与 renderer(_composeContentRectPx / internalMarginMm) 同源：单页不内缩，Merge 内缩 5mm。
  // 这样 Discretizer 产出的 contentRect 与 renderer 当前行为一致，C2 切换字节级无感。
  const internalMarginMm = count > 1 ? DEFAULT_SLOT_MARGIN_MM : 0

  // 2) Factory 产出逻辑 slot（mm，连续值）→ 离散化交给 SlotDiscretizer（px + 余数保留）
  const logicalSlots = ComposeSlotLayoutFactory({
    paper: paperMM,
    mergeMode,
    marginMm: internalMarginMm,
    paperXMm: mLeft,
    paperYMm: mTop,
  })
  const pxSlots = discretizeSlots(logicalSlots, {
    dpi,
    areaPx: area,
    areaMm: { width: printableWidthMm, height: printableHeightMm },
    originMm: { x: mLeft, y: mTop },
    gridCols,
    gridRows,
    marginMm: internalMarginMm,
  })

  // 3) itemId 按位置映射（Factory 不感知 items）
  pxSlots.forEach((s, i) => { s.itemId = items[i] ? items[i].id : undefined })

  return { page, area, slots: pxSlots }
}

export function createTransform(angle, cx, cy, scale = 1) {
  return {
    rotate: angle,
    center: { x: cx, y: cy },
    scale
  }
}

export function calculateFitScale(slot, contentBounds) {
  if (!contentBounds || !contentBounds.width || !contentBounds.height) {
    return 1
  }
  return Math.min(
    slot.width / contentBounds.width,
    slot.height / contentBounds.height
  )
}

export function calculateCenteredPosition(slot, contentBounds, scale) {
  if (!contentBounds || !contentBounds.width || !contentBounds.height) {
    return { x: slot.x, y: slot.y }
  }
  
  const scaledWidth = contentBounds.width * scale
  const scaledHeight = contentBounds.height * scale
  return {
    x: slot.x + (slot.width - scaledWidth) / 2,
    y: slot.y + (slot.height - scaledHeight) / 2
  }
}

export function calculateRotatedBounds(contentBounds, angle) {
  const rad = (angle * Math.PI) / 180
  const cosA = Math.abs(Math.cos(rad))
  const sinA = Math.abs(Math.sin(rad))
  return {
    width: contentBounds.width * cosA + contentBounds.height * sinA,
    height: contentBounds.width * sinA + contentBounds.height * cosA
  }
}

export const LAYOUT_STRATEGIES = {
  VERTICAL: 'vertical',
  GRID: 'grid'
}

/**
 * Validate if item matches normalized format
 */
export function validateLayoutItem(item) {
  return !!(item && item.id && item.meta && typeof item.meta.width === 'number' && typeof item.meta.height === 'number')
}

/**
 * Convert item to normalized format
 * @param {Object} item - 文件项，必须包含 meta.width/meta.height 实际尺寸
 * @param {number} dpi - DPI（用于日志上下文）
 * @returns {Object} 标准化的布局项目
 * 
 * 调用方必须在传参前填充 item.meta 为真实尺寸：
 *   - PDF: 使用 pdfDoc.getPage(1).getViewport({scale:1}) 的 width/height
 *   - 图片/OFD: 使用实际像素尺寸
 */
export function normalizeLayoutItem(item, dpi) {
  const id = item.id || item.key || `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  const type = item._pdfData ? 'pdf' : item._previewImageUrl ? 'image' : 'unknown'
  
  let width, height
  if (item.meta && item.meta.width && item.meta.height) {
    // ✅ 使用调用方传入的真实尺寸
    width = item.meta.width
    height = item.meta.height
  } else {
    // Fallback（不应在生产中触发）
    console.warn(`[Layout] ${id} 缺少 meta 尺寸，使用默认 fallback。调用方应传入真实尺寸`)
    if (type === 'pdf') {
      // 在没有 viewport 信息时保守假设为 A4
      const a4 = getPaperPixels('A4', dpi, false)
      width = a4.width
      height = a4.height
    } else {
      width = 600
      height = 800
    }
  }
  
  return {
    id,
    type,
    meta: { width, height }
  }
}

export function normalizeLayoutItems(items, dpi) {
  return items.map(item => normalizeLayoutItem(item, dpi))
}