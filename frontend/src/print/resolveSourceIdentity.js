/**
 * resolveSourceIdentity — 聚合源 identity → 原始源 identity 的 fallback 查询
 *
 * R-2 背景（2026-08-24）：normalizePrintSources 把多页完整选择聚合成
 * key='__source_<groupKey>' 的单一 source 目标（buildPrintExecutionPlan.js），
 * 但 fileRotations / placements 两个 map 仍按【原始页 key】键控。聚合对象
 * 的 key 在两个 map 中查不到 → 用户对多页 PDF 的 UI 旋转与布局在聚合打印时
 * 静默丢失（恒 0/null）。
 *
 * 本模块提供统一 fallback 查询：
 *   查询优先级 = 聚合 key → _sourceOriginalKey（原始 key）→ default
 *
 * 语义（冻结）：
 *   - key 是 execution identity（plan 唯一 ID），_sourceOriginalKey 是
 *     source identity（fallback lookup），两者职责不同，互不覆盖；
 *   - 未来若聚合对象拥有自己的 rotation/placement（key 命中），优先于原始。
 *
 * 冻结边界：不改 fileRotations / placements 数据结构、不改聚合模型、
 * 不触碰 PrintPreviewModel / Sumatra / margin contract。
 *
 * @module print/resolveSourceIdentity
 */

/**
 * 解析文件旋转（聚合 key → 原始 key → 0）。
 * @param {Object} file - 文件对象（含 key，可选 _sourceOriginalKey）
 * @param {Object} [fileRotations] - { [fileKey]: rotationDegrees }
 * @returns {number} 旋转角度（默认 0）
 */
export function resolveFileRotation(file, fileRotations = {}) {
  const key = file?.key
  const originalKey = file?._sourceOriginalKey
  return fileRotations?.[key] ?? fileRotations?.[originalKey] ?? 0
}

/**
 * 解析文件 placement（聚合 key → 原始 key → null）。
 * @param {Object} file - 文件对象（含 key，可选 _sourceOriginalKey）
 * @param {Object} [placements] - { [fileKey]: PlacementResult }
 * @returns {Object|null} RotationResolver 布局结果（默认 null）
 */
export function resolveFilePlacement(file, placements = {}) {
  const key = file?.key
  const originalKey = file?._sourceOriginalKey
  return placements?.[key] ?? placements?.[originalKey] ?? null
}
