/**
 * viewerTransform — Viewer 变换计算纯函数
 *
 * 职责：
 *   计算 pan 边界 clamp、zoom 适配比例、transform 字符串。
 *   纯数学，不依赖 React / DOM / 状态管理。
 *
 * 所有权：
 *   由 useViewerState hook 调用。
 *   可独立单测。
 *
 * @module utils/viewerTransform
 */

/**
 * 计算 fit-to-container 的缩放比例。
 *
 * @param {number} imgW - 图片自然宽度（px）
 * @param {number} imgH - 图片自然高度（px）
 * @param {number} containerW - 容器宽度（px）
 * @param {number} containerH - 容器高度（px）
 * @returns {number} - fit 比例（0-1 之间表示缩小，>1 表示放大）
 */
export function computeFitScale(imgW, imgH, containerW, containerH) {
  if (!imgW || !imgH || !containerW || !containerH) return 1
  return Math.min(containerW / imgW, containerH / imgH)
}

/**
 * 计算给定 zoom 百分比下的实际显示尺寸。
 *
 * @param {number} imgW - 图片自然宽度
 * @param {number} imgH - 图片自然高度
 * @param {number} fitScale - fit-to-container 比例
 * @param {number} zoomPercent - 用户缩放百分比（100 = fit）
 * @returns {{ displayW: number, displayH: number, scale: number }}
 */
export function computeDisplaySize(imgW, imgH, fitScale, zoomPercent) {
  const scale = fitScale * (zoomPercent / 100)
  return {
    displayW: imgW * scale,
    displayH: imgH * scale,
    scale,
  }
}

/**
 * Clamp pan 值，使图片不拖出容器外。
 *
 * 规则：
 *   - 图片比容器大：允许平移，但边缘不超出容器
 *   - 图片比容器小：居中，不允许平移（pan = 0）
 *
 * @param {number} panX - 当前水平平移
 * @param {number} panY - 当前垂直平移
 * @param {number} displayW - 图片显示宽度
 * @param {number} displayH - 图片显示高度
 * @param {number} containerW - 容器宽度
 * @param {number} containerH - 容器高度
 * @returns {{ panX: number, panY: number }}
 */
export function clampPan(panX, panY, displayW, displayH, containerW, containerH) {
  const maxPanX = Math.max(0, (displayW - containerW) / 2)
  const maxPanY = Math.max(0, (displayH - containerH) / 2)
  return {
    panX: Math.min(maxPanX, Math.max(-maxPanX, panX)),
    panY: Math.min(maxPanY, Math.max(-maxPanY, panY)),
  }
}

/**
 * 构建 CSS transform 字符串。
 *
 * @param {Object} opts
 * @param {number} opts.panX - 水平平移（px）
 * @param {number} opts.panY - 垂直平移（px）
 * @param {number} opts.scale - 缩放比例
 * @param {number} opts.rotation - 旋转角度（deg）
 * @returns {string} - CSS transform 值
 */
export function buildTransformString({ panX, panY, scale, rotation }) {
  const parts = [
    `translate3d(${panX}px, ${panY}px, 0)`,
    `scale(${scale})`,
  ]
  if (rotation) {
    parts.push(`rotate(${rotation}deg)`)
  }
  return parts.join(' ')
}

/**
 * 计算旋转后的有效尺寸（宽高可能互换）。
 *
 * @param {number} width - 原始宽度
 * @param {number} height - 原始高度
 * @param {number} rotation - 旋转角度（0/90/180/270）
 * @returns {{ width: number, height: number }}
 */
export function rotatedDimensions(width, height, rotation) {
  const normalized = ((rotation % 360) + 360) % 360
  if (normalized === 90 || normalized === 270) {
    return { width: height, height: width }
  }
  return { width, height }
}
