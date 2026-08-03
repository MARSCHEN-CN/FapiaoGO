/**
 * compareLegacyPlan — A1.5 影子比较 helper（Commit 2 接线时使用）
 *
 * 用途：
 *   Commit 2 把 executePrint 改为消费 buildPrintExecutionPlan 产出的 plan 时，用本 helper
 *   在开发期把「新 plan」与「Legacy Oracle（buildLegacyPrintPlan，即旧执行逻辑抽到纯函数）」
 *   做归一化比较，确认两者等价后再删除旧逻辑。
 *
 * 安全约束（用户定稿）：
 *   helper 本身只比较、只 console.warn，绝不抛错、绝不影响真实打印流程。
 *   调用方必须用 `import.meta.env.DEV && localStorage.DEBUG_PRINT_PLAN_COMPARE==='1'` 守卫，
 *   确保任何 production build 都不留 debug 分支。见 usePrint.js（Commit 2 注入点）。
 *
 * @module print/compareLegacyPlan
 */

import { buildLegacyPrintPlan } from './buildLegacyPrintPlan.js'

/**
 * 把 Plan 归一化为可比较的投影：
 *   每个 page（含 extraPages）→ { type, orientation, fileIds[], slots[{fileId,rotation}] }
 * 这样比较不关心 pageIndex / _round / paper 等结构细节，只锁定：
 *   · 文件顺序（数组序）
 *   · 合并分组（fileIds 数组长度与成员）
 *   · 方向（orientation）
 *   · 每文件旋转（slot.rotation）
 */
export function normalizePlan(plan) {
  return [...(plan.pages || []), ...(plan.extraPages || [])].map((p) => ({
    type: p.type,
    orientation: p.orientation,
    fileIds: (p.slots || []).map((s) => s.fileId),
    slots: (p.slots || []).map((s) => ({ fileId: s.fileId, rotation: s.rotation })),
  }))
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 比较「新 plan」与「Legacy Oracle（由相同 files/settings/fileRotations 重建）」。
 *
 * @param {Object} plan - buildPrintExecutionPlan 产出的 plan
 * @param {Object} opts
 * @param {Array<Object>} opts.files - 原始文件列表（重建 Legacy Oracle 用）
 * @param {Object} [opts.settings]
 * @param {Object} [opts.fileRotations]
 * @returns {{ match: boolean, legacy: Array, next: Array, diff?: string }}
 */
export function compareLegacyPlan(plan, opts = {}) {
  const { files = [], settings = {}, fileRotations = {} } = opts
  const legacy = buildLegacyPrintPlan(files, { settings, fileRotations })
  const a = normalizePlan(legacy)
  const b = normalizePlan(plan)
  const match = deepEqual(a, b)
  if (!match) {
    console.warn(
      '[PRINT PLAN COMPARE] mismatch between Legacy Oracle and new plan\n',
      'legacy:', JSON.stringify(a),
      '\nnext  :', JSON.stringify(b),
    )
  }
  return { match, legacy: a, next: b, diff: match ? undefined : 'see console' }
}

/**
 * 调用方守卫：仅在开发态且显式打开开关时返回 true。
 * 用于 Commit 2 注入点：
 *   if (printPlanCompareEnabled()) compareLegacyPlan(plan, { files, settings, fileRotations })
 */
export function printPlanCompareEnabled() {
  try {
    // import.meta.env.DEV 在 vite 生产构建为 false；localStorage 仅开发期手动置 '1'
    const dev = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV
    const flag =
      typeof localStorage !== 'undefined' &&
      localStorage.getItem('DEBUG_PRINT_PLAN_COMPARE') === '1'
    return !!dev && !!flag
  } catch {
    return false
  }
}

export default compareLegacyPlan
