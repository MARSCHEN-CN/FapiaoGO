/**
 * deriveMergePrintJobs — 从 PrintExecutionPlan（merge 模式）派生真实执行 jobs（Commit 3）
 *
 * 职责：
 *   把已证等价的 plan（buildPrintExecutionPlan 产出，merge 模式）映射回 doPrint 的
 *   合并打印队列需要的 job 列表（每组 = 一个物理页，含该组文件对象数组）。
 *
 * 冻结边界：
 *   - 这是「Plan → 执行 job」的唯一映射点，doPrint 的 merge 分支只调用本函数。
 *   - 不引入任何新行为：分组顺序/成员/方向完全由 plan.pages 决定，而 plan 已证与
 *     doPrint L493-502 的 `parsedFiles.slice(i, i+groupSize)` 滑窗分组等价（见 A1.5）。
 *   - 不碰 renderMergeGroupToPrintImage / renderMultipleItemsToCanvas / MultiTicketComposer /
 *     createPlacement / safeMargin / PRINT_PIPELINE.mode（属 A2/A3）。
 *   - 每组的文件解析自 plan.pages[*].slots[*].fileId（按 files key 反查），与旧
 *     `parsedFiles.slice` 产出的文件对象数组一一对应。
 *
 * @module print/deriveMergePrintJobs
 */

/**
 * @param {Object} plan - buildPrintExecutionPlan 产出的 plan（merge 模式）
 * @param {Array<Object>} files - 原始文件列表（按 key 反查文件对象）
 * @returns {Array<{ files: Array<Object>, groupIndex: number, orientation: string }>}
 *   每组对应一个待渲染的物理页；files 数组顺序 = plan.pages[*].slots 顺序。
 */
export function deriveMergePrintJobs(plan, files) {
  const fileById = new Map(files.map((f) => [f.key, f]))

  const jobs = (plan.pages || []).map((page, groupIndex) => {
    const resolved = (page.slots || [])
      .map((s) => fileById.get(s.fileId))
      .filter(Boolean)
    return {
      files: resolved,
      groupIndex,
      orientation: page.orientation,
    }
  })

  return jobs
}

export default deriveMergePrintJobs
