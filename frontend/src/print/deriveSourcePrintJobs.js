/**
 * deriveSourcePrintJobs — 从 PrintExecutionPlan（source 模式）派生真实执行 jobs（Commit 2）
 *
 * 职责：
 *   把已证等价的 plan（buildPrintExecutionPlan 产出）映射回 printAllSourceFiles 需要的
 *   job 列表（文件对象 + _jobKey / _round 进度追踪字段）。
 *
 * ⭐ 新增：支持 normalizePrintSources 聚合后的 source 目标
 *   - 聚合后的 source 目标 key 为 `__source_xxx`
 *   - 通过 `_sourceGroupKey` 或 `key` 查找原始文件
 *   - 聚合目标的打印会触发 Sumatra 打印完整源文件
 *
 * 冻结边界：
 *   - 这是「Plan → 执行 job」的唯一映射点，executePrint 的 source 分支只调用本函数。
 *   - 不引入任何新行为：round1 = plan.pages，round2 = plan.extraPages（一普二专第 2 轮），
 *     与旧 executePrint L826-829 mergedJobs 的 _jobKey/_round 编码逐字一致。
 *   - 多页文档逐页展开在渲染层（renderFileToPrintImage），此处每文件 = 1 job（与旧粒度一致）。
 *
 * @module print/deriveSourcePrintJobs
 */

/**
 * @param {Object} plan - buildPrintExecutionPlan 产出的 plan（source 模式）
 * @param {Array<Object>} files - 原始文件列表（按 key 反查文件对象，可能包含聚合后的 source 目标）
 * @returns {Array<Object>} 带 _jobKey / _round 的 job 列表，顺序 = round1 ++ round2
 */
export function deriveSourcePrintJobs(plan, files) {
  // 构建查找索引：支持按 key 查找
  const fileById = new Map(files.map((f) => [f.key, f]))

  const toJob = (page, round) => {
    const fileId = page.source.fileId
    const f = fileById.get(fileId)

    if (!f) return null

    const jobKey = round === 2 ? `${f.key}_v2` : f.key
    return {
      ...f,
      _jobKey: jobKey,
      _round: round,
    }
  }

  const jobs = [
    ...(plan.pages || []).map((p) => toJob(p, 1)),
    ...(plan.extraPages || []).map((p) => toJob(p, 2)),
  ].filter(Boolean)

  return jobs
}

export default deriveSourcePrintJobs
