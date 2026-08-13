'use strict'

/**
 * Geometry Translator (G1d / R6) — 唯一 Rotation → Geometry 语义转换入口。
 *
 * 职责（严格限定）：
 *   把 Print Truth 的两轴 { orientation, rotate } 翻译成 apply_pdf 所需的
 *   { nativePaperW_mm, nativePaperH_mm, contentRotation }。
 *
 * 不碰：PDF / Canvas / Preview / Margin / placement / Invoice / RotationResolver。
 *
 * ⚠️ 不复用 print-settings.js:normalize() 作为本 Translator。
 *    normalize() 的 swap 准则 = (requestedOrient !== naturalOrient)，
 *    与 §9.4 的 swap 准则 = (rotate % 180 === 90) 不同。
 *    复用 normalize() 的 swap 作为几何会再引入 R6 双重交换（见 geometry-translator.test.js 负向控制 B9）。
 *    本模块是 R6 唯一权威；下游 apply_pdf 的 policy_a 是「唯一一次」方向推导。
 *
 * 公式（§9.4 / 黄金向量 Layer B）：
 *    r = rotate % 180
 *    nativeOrientation = (r === 90) ? opposite(orientation) : orientation
 *    nativePaper      = nativeOrientation==='landscape'
 *                         ? (max(w,h), min(w,h))   // 297×210 (A4)
 *                         : (min(w,h), max(w,h))   // 210×297 (A4)
 *    contentRotation  = rotate（直通）
 *
 * 语义要点（防双重交换）：
 *    orientation 只在「此处」一次性决定 native 纸的宽高指派；
 *    rotate 只作为 contentRotation 直通给 apply_pdf；
 *    二者都不二次进入 apply_pdf（apply_pdf 无 orientation 参数，policy_a 按
 *    contentRotation%180 推导输出方向 == 唯一一次 swap）。
 *
 * @module print-service/geometry-translator
 */

/**
 * 取相反方向。
 * @param {'portrait'|'landscape'} orientation
 * @returns {'portrait'|'landscape'}
 */
function opposite(orientation) {
  return orientation === 'landscape' ? 'portrait' : 'landscape'
}

/**
 * 把任意旋转角归一为 0/90/180/270。
 * @param {number} rotate
 * @returns {number}
 */
function normalizeRotate(rotate) {
  const steps = ((Math.round(Number(rotate) / 90) % 4) + 4) % 4
  return steps * 90
}

/**
 * 从 baseDims 中取出物理纸尺寸（mm）。
 * 兼容 { width, height }（resolvePaperMmFromSettings 产出）与
 * { widthMM, heightMM }（PaperRegistry / PrintSpec 产出）。
 * @param {object} baseDims
 * @returns {{ w: number, h: number }}
 */
function readBaseDims(baseDims) {
  if (!baseDims || typeof baseDims !== 'object') {
    return { w: 0, h: 0 }
  }
  const w = Number(baseDims.widthMM) > 0 ? Number(baseDims.widthMM)
    : Number(baseDims.width) > 0 ? Number(baseDims.width) : 0
  const h = Number(baseDims.heightMM) > 0 ? Number(baseDims.heightMM)
    : Number(baseDims.height) > 0 ? Number(baseDims.height) : 0
  return { w, h }
}

/**
 * 把 Print Truth 翻译成 apply_pdf 输入。
 *
 * @param {object} input
 * @param {'portrait'|'landscape'} input.orientation - Truth.orientation（最终期望输出纸方向）
 * @param {number} input.rotate - Truth.rotate（0/90/180/270）
 * @param {object} input.baseDims - 物理纸尺寸 mm（orientation-agnostic，如 A4 = {width:210,height:297}）
 * @returns {{ nativePaperW_mm: number, nativePaperH_mm: number, contentRotation: number }}
 * @throws {Error} baseDims 无效
 */
function translateGeometry({ orientation, rotate, baseDims }) {
  const orient = orientation === 'landscape' ? 'landscape' : 'portrait'
  const rot = normalizeRotate(rotate || 0)
  const { w, h } = readBaseDims(baseDims)
  if (w <= 0 || h <= 0) {
    throw new Error('translateGeometry: baseDims 必须提供有效的物理纸尺寸 (mm)，收到 ' +
      JSON.stringify(baseDims))
  }

  const r = rot % 180
  const nativeOrientation = r === 90 ? opposite(orient) : orient

  const short = Math.min(w, h)
  const long = Math.max(w, h)
  const nativePaperW_mm = nativeOrientation === 'landscape' ? long : short
  const nativePaperH_mm = nativeOrientation === 'landscape' ? short : long

  return {
    nativePaperW_mm,
    nativePaperH_mm,
    contentRotation: rot,
  }
}

module.exports = { translateGeometry, opposite, normalizeRotate, readBaseDims }
