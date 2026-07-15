'use strict'

/**
 * Margin sanitizer — 配置层（Fact 边界）对边距的修正单元。
 *
 * V16 架构铁律：PaperSpec 是 Fact；Derived 层（computePaperLayout）禁止修改 Fact（F1）。
 * 因此任何「非法边距的修正」必须发生在 Fact 进入 Render DAG 之前 —— 即本单元（配置边界）。
 *
 * 保证每条边距不超过 (纸张维度 - MIN_CONTENT_MM)/2，从而
 *   mLeft+mRight <= 纸张宽 - MIN_CONTENT，mTop+mBottom <= 纸张高 - MIN_CONTENT
 * → computePaperLayout 的 contentRect 永不为 0（Derived 层正常值路径不会被触发坍缩）。
 *
 * 缺失 / 非有限 / 负值 → 回落安全默认 3mm，且不标记为「非法」（属良性缺省，不是脏配置）。
 * 只有有限值且超过单边上限才标记 changed，用于一次性开发告警。
 */

const { PAPER_SIZE_MAP } = require('./paper-registry')

const DEFAULT_MARGIN_MM = 3
const MIN_CONTENT_MM = 5

/** 解析纸张尺寸：custom 走 customPaper；未知尺寸回落 A4（避免夹取算出 NaN）。 */
function resolvePaperDims(settings) {
  const ps = settings && settings.paperSize
  if (ps === 'Custom' && settings.customPaper && typeof settings.customPaper.widthMM === 'number') {
    return { widthMM: settings.customPaper.widthMM, heightMM: settings.customPaper.heightMM }
  }
  if (PAPER_SIZE_MAP[ps]) return PAPER_SIZE_MAP[ps]
  return { widthMM: 210, heightMM: 297 }
}

/**
 * 夹取单条边距。
 * @param {any} v 原始值（mm）
 * @param {number} max 单边上限（mm）
 * @returns {{ value:number, changed:boolean, orig:any }}
 */
function sanitizeOne(v, max) {
  if (typeof v !== 'number' || !isFinite(v) || v < 0) {
    return { value: DEFAULT_MARGIN_MM, changed: false, orig: v }
  }
  if (v > max) return { value: max, changed: true, orig: v }
  return { value: v, changed: false, orig: v }
}

/**
 * 修正 settings 中全部四条边距（不就地修改入参）。
 * @param {Object} settings 解析后的 Settings.json
 * @returns {{ settings: Object, changed: boolean, original: Object }}
 */
function sanitizeMargins(settings) {
  const out = Object.assign({}, settings || {})
  const { widthMM, heightMM } = resolvePaperDims(out)
  const maxW = Math.max(0, (widthMM - MIN_CONTENT_MM) / 2)
  const maxH = Math.max(0, (heightMM - MIN_CONTENT_MM) / 2)
  const original = {
    marginLeft: out.marginLeft,
    marginRight: out.marginRight,
    marginTop: out.marginTop,
    marginBottom: out.marginBottom,
  }
  const r = {
    left: sanitizeOne(out.marginLeft, maxW),
    right: sanitizeOne(out.marginRight, maxW),
    top: sanitizeOne(out.marginTop, maxH),
    bottom: sanitizeOne(out.marginBottom, maxH),
  }
  out.marginLeft = r.left.value
  out.marginRight = r.right.value
  out.marginTop = r.top.value
  out.marginBottom = r.bottom.value
  const changed = r.left.changed || r.right.changed || r.top.changed || r.bottom.changed
  return { settings: out, changed, original }
}

module.exports = { sanitizeMargins, sanitizeOne, resolvePaperDims, DEFAULT_MARGIN_MM, MIN_CONTENT_MM }
