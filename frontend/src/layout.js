import { PAPER_SIZE_MAP } from './config'

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
  const area = getPrintableArea(page, margin)
  
  const count = slotCount || items.length
  
  let slots = []
  if (strategy === 'vertical') {
    const partHeight = Math.floor(area.height / count)
    
    slots = items.map((item, index) => {
      const y = index * partHeight
      const height = (index === count - 1) ? area.height - y : partHeight
      
      return {
        id: `slot-${item.id || index}`,
        itemId: item.id,
        index,
        x: area.x,
        y: area.y + y,
        width: area.width,
        height
      }
    })
  } else if (strategy === 'grid') {
    // ✅ 新增网格布局逻辑（2×2 或自定义）
    const cellWidth = Math.floor(area.width / gridCols)
    const cellHeight = Math.floor(area.height / gridRows)
      
    slots = items.map((item, index) => {
      if (index >= gridCols * gridRows) {
        // 超出网格容量的项忽略
        return null
      }
        
      const col = index % gridCols
      const row = Math.floor(index / gridCols)
        
      // 计算 x 坐标（考虑最后一列的宽度补偿）
      const x = area.x + col * cellWidth
        
      // 计算 y 坐标（考虑最后一行的高度补偿）
      const y = area.y + row * cellHeight
        
      // 最后一列/最后一行补偿余数像素
      const width = (col === gridCols - 1) ? area.width - (col * cellWidth) : cellWidth
      const height = (row === gridRows - 1) ? area.height - (row * cellHeight) : cellHeight
        
      return {
        id: `slot-${item.id || index}`,
        itemId: item.id,
        index,
        x,
        y,
        width,
        height,
        // ✅ 新增网格位置信息（用于调试和扩展）
        gridPosition: { col, row }
      }
    })
  }
  return { page, area, slots }
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