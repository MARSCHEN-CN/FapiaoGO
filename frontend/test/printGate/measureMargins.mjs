/**
 * A2-G1 安全边距测量纯函数（G0 阶段立框架，G1 直接复用）
 *
 * 职责：给定内容包围盒 + 纸张尺寸 → 四边边距(mm)。
 * 纯函数，无 I/O，无打印依赖。测试见 gateFramework.test.mjs。
 */
import { GATE_DPI, SAFE_MARGIN_TOLERANCE_MM } from './gateConfig.mjs'

/**
 * 像素矩阵 → 内容 bbox（G1 核心纯函数）
 *
 * 输入为 RGBA 像素数组（length = width*height*4，Uint8ClampedArray 或普通数组）。
 * 判定"内容像素"：alpha > alphaThreshold 且非纯白背景（G1 默认跳过白底）。
 * 返回内容像素的最小包围盒 {x,y,w,h}；全空白返回 null。
 *
 * @param {ArrayLike<number>} pixels RGBA，length = w*h*4
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 * @param {number} [opts.alphaThreshold=0]    alpha 低于此值视为透明
 * @param {number} [opts.brightnessMax=250]   亮度 ≥ 此值视为白底（发票白底黑字场景）
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
export function findContentBBox(pixels, width, height, opts = {}) {
  if (!pixels || width <= 0 || height <= 0) throw new Error('findContentBBox: pixels/width/height required')
  if (pixels.length !== width * height * 4) {
    throw new Error(`findContentBBox: pixel length ${pixels.length} != ${width}x${height}x4`)
  }
  const alphaThreshold = opts.alphaThreshold ?? 0
  const brightnessMax = opts.brightnessMax ?? 250
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const a = pixels[i + 3]
      if (a <= alphaThreshold) continue
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2]
      const brightness = (r + g + b) / 3
      if (brightness >= brightnessMax) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/**
 * 内容包围盒 → 四边边距（px）
 * @param {object} contentBox {x,y,w,h}（px，内容非透明像素的最小包围盒，相对纸张左上角）
 * @param {object} paperPx   {w,h}（纸张尺寸，px）
 * @returns {{left:number,right:number,top:number,bottom:number}} 四边边距（px）
 */
export function measureMarginsPx(contentBox, paperPx) {
  if (!contentBox || !paperPx) throw new Error('measureMarginsPx: contentBox/paperPx required')
  if (paperPx.w <= 0 || paperPx.h <= 0) throw new Error(`measureMarginsPx: invalid paper ${paperPx.w}x${paperPx.h}`)
  const left = contentBox.x
  const top = contentBox.y
  const right = paperPx.w - (contentBox.x + contentBox.w)
  const bottom = paperPx.h - (contentBox.y + contentBox.h)
  // 允许微小浮点，但绝不出现负边距（bbox 越界 = 输入非法）
  if (right < -1e-6 || bottom < -1e-6 || left < -1e-6 || top < -1e-6) {
    throw new Error(`measureMarginsPx: content bbox 越出纸张边界 (bbox=${JSON.stringify(contentBox)} paper=${JSON.stringify(paperPx)})`)
  }
  return { left: round3(left), top: round3(top), right: round3(right), bottom: round3(bottom) }
}

/** px → mm：mm = px * 25.4 / dpi */
export function pxToMm(px, dpi = GATE_DPI) {
  return px * 25.4 / dpi
}

/** mm → px（G1 采集 canvas/source 输出时反向换算用） */
export function mmToPx(mm, dpi = GATE_DPI) {
  return mm * dpi / 25.4
}

/** 四边边距 px → mm（保留 3 位小数） */
export function marginsToMm(marginsPx, dpi = GATE_DPI) {
  return {
    left: round3(pxToMm(marginsPx.left, dpi)),
    top: round3(pxToMm(marginsPx.top, dpi)),
    right: round3(pxToMm(marginsPx.right, dpi)),
    bottom: round3(pxToMm(marginsPx.bottom, dpi)),
  }
}

/**
 * G1 核心断言：canvas 边距 vs source 边距是否在容差内（用户定稿 §11.2）
 * @param {object} canvasMm {left,top,right,bottom}（mm）
 * @param {object} sourceMm {left,top,right,bottom}（mm）
 * @param {number} toleranceMm 默认 SAFE_MARGIN_TOLERANCE_MM=0.5
 * @returns {{pass:boolean, diffs:object, maxDiffMm:number}}
 *   diffs: 四边 |canvas-source|；maxDiffMm 用于报告
 */
export function assertSafeMarginAlignment(canvasMm, sourceMm, toleranceMm = SAFE_MARGIN_TOLERANCE_MM) {
  if (!canvasMm || !sourceMm) throw new Error('assertSafeMarginAlignment: canvasMm/sourceMm required')
  const edges = ['left', 'top', 'right', 'bottom']
  const diffs = {}
  let maxDiffMm = 0
  for (const e of edges) {
    const d = Math.abs((canvasMm[e] ?? NaN) - (sourceMm[e] ?? NaN))
    if (Number.isNaN(d)) throw new Error(`assertSafeMarginAlignment: 边 ${e} 缺失值 canvas=${canvasMm[e]} source=${sourceMm[e]}`)
    diffs[e] = round3(d)
    if (d > maxDiffMm) maxDiffMm = d
  }
  return { pass: maxDiffMm <= toleranceMm, diffs, maxDiffMm: round3(maxDiffMm) }
}

function round3(n) {
  return Math.round(n * 1000) / 1000
}
