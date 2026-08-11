/**
 * sumatra-command-resolver.js — Sumatra Executor Command Mapping（C-2-Sumatra-Command-Matrix）
 *
 * ⚠️ 职责边界（用户裁决 2026-08-11）：
 *   - 本模块是【executor command 层】：把「已确定的最终打印结果」编码成 Sumatra
 *     -print-settings 命令。**不是** RotationResolver 的替代（RotationResolver 职责 =
 *     内容实际怎么旋转/放置；本模块职责 = 最终结果如何编码成命令）。
 *   - 硬编码的是【经过实测验证的映射规则】（数据驱动查表），不是 16 个 if/else。
 *   - 不碰：RotationResolver / placement / paper resolve / PrintExecutionPlan /
 *     placement_bake / margin_contract / noscale（全部冻结）。
 *
 * 数据来源：2026-08-11 真实虚拟打印机（Wondershare PDFelement）16-case 实测
 * （用户提供矩阵，invoiceRotation × paperOrientation → rotate）。
 *
 * 映射规则：
 *   orientation = paperOrientation（纸方向直接决定 Sumatra landscape/portrait）
 *   rotate      = f(contentOrientation, contentRotation, paperOrientation)——查表
 *
 * 输入：
 *   contentOrientation  'landscape' | 'portrait'  发票自然方向（MediaBox 方向）
 *   contentRotation     0 | 90 | 180 | 270        用户旋转（sourceRotation）
 *   paperOrientation    'landscape' | 'portrait'  目标纸方向（Plan paper.orientation）
 *
 * 输出：
 *   { orientation: 'landscape'|'portrait', rotate: 90|270 }
 *   （实测 rotate 只有 90/270 两值）
 */

// ── 实测矩阵（2026-08-11，16-case，Wondershare 真实打印验证）──
// ROTATE_MATRIX[contentOrientation][paperOrientation][contentRotation] = rotate
const ROTATE_MATRIX = Object.freeze({
  landscape: Object.freeze({          // 横发票
    landscape: Object.freeze({ 0: 90, 90: 90, 180: 270, 270: 270 }),   // 横纸
    portrait: Object.freeze({ 0: 90, 90: 270, 180: 270, 270: 90 }),    // 竖纸
  }),
  portrait: Object.freeze({           // 竖发票
    landscape: Object.freeze({ 0: 270, 90: 90, 180: 90, 270: 270 }),   // 横纸
    portrait: Object.freeze({ 0: 90, 90: 90, 180: 270, 270: 270 }),    // 竖纸
  }),
})

const VALID_ROTATIONS = Object.freeze([0, 90, 180, 270])

/**
 * 解析 Sumatra 最终旋转命令。
 *
 * @param {object} input
 * @param {'landscape'|'portrait'} input.contentOrientation - 发票自然方向
 * @param {number} input.contentRotation - 用户旋转（0/90/180/270）
 * @param {'landscape'|'portrait'} input.paperOrientation - 目标纸方向
 * @returns {{ orientation: 'landscape'|'portrait', rotate: 90|270 }}
 * @throws {Error} 输入非法
 */
function resolveSumatraRotation({ contentOrientation, contentRotation, paperOrientation }) {
  if (contentOrientation !== 'landscape' && contentOrientation !== 'portrait') {
    throw new Error(`contentOrientation 非法: ${contentOrientation}`)
  }
  if (paperOrientation !== 'landscape' && paperOrientation !== 'portrait') {
    throw new Error(`paperOrientation 非法: ${paperOrientation}`)
  }
  const rot = Number(contentRotation)
  if (!VALID_ROTATIONS.includes(rot)) {
    throw new Error(`contentRotation 非法: ${contentRotation}`)
  }
  const rotate = ROTATE_MATRIX[contentOrientation][paperOrientation][rot]
  return {
    orientation: paperOrientation,
    rotate,
  }
}

/**
 * 将 resolver 输出格式化为 Sumatra -print-settings 片段（orientation + rotate）。
 * 注意：仅返回方向部分；scale（fit/noscale）与 paper 由调用方拼接。
 *
 * @param {ReturnType<typeof resolveSumatraRotation>} r
 * @returns {string[]} 如 ['landscape', 'rotate=90'] 或 ['disable-auto-rotation', 'rotate=270']
 */
function toOrientationParts(r) {
  const parts = []
  parts.push(r.orientation === 'landscape' ? 'landscape' : 'disable-auto-rotation')
  parts.push(`rotate=${r.rotate}`)
  return parts
}

module.exports = { resolveSumatraRotation, toOrientationParts, ROTATE_MATRIX }
