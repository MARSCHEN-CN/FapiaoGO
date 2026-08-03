/**
 * A2-G1 安全边距测量纯函数（G0 阶段立框架，G1 直接复用）
 *
 * 职责：给定内容包围盒 + 纸张尺寸 → 四边边距(mm)。
 * 纯函数，无 I/O，无打印依赖。测试见 gateFramework.test.mjs。
 */
import { GATE_DPI, SAFE_MARGIN_TOLERANCE_MM } from './gateConfig.mjs'

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
