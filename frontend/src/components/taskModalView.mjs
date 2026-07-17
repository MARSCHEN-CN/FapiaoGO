// 纯函数：后端 ExportTask 状态 → TaskProgressModal 展示派生量。
//
// 单一真相：与后端状态机（pending → running → completed | cancelled | failed）
// 对齐。任何端到端场景的状态都不得在本层丢失或误映射。
//
// 历史教训（Phase 4.4 验证发现并修复）：
//   1. failed 曾未处理 → 误显「成功对勾」且 isFinished=false 导致弹窗无法关闭；
//   2. starting / pending 曾被当作非运行态 → 进度环不显示、瞬间闪成功。
//
// 抽成无 React 依赖的纯函数，便于用 node --test 直接锁死状态映射，
// 不引入前端测试框架。

const TERMINAL = ['completed', 'cancelled', 'failed']

/**
 * @param {string|undefined} status 后端任务状态
 * @param {Array<{file?: string, error?: string}>} errors 失败明细
 * @returns {{isRunning:boolean,isDone:boolean,isCancelled:boolean,isFailed:boolean,isFinished:boolean,hasErrors:boolean,resultIcon:'success'|'error'|'cancelled'}}
 */
export function deriveTaskModalView(status, errors = []) {
  // 终态之外的所有状态（starting/pending/running/未设）一律按运行态展示
  const isRunning = !status || !TERMINAL.includes(status)
  const isDone = status === 'completed'
  const isCancelled = status === 'cancelled'
  const isFailed = status === 'failed'
  const isFinished = isDone || isCancelled || isFailed
  // failed 即使无 per-file errors，也应视为有错误（显示错误图标 + 可关闭）
  const hasErrors = errors.length > 0 || isFailed
  // 四态精确映射：transient 归 running（不渲染，但语义上绝不可能是 success）
  const resultIcon = isCancelled ? 'cancelled'
    : isFailed || hasErrors ? 'error'
    : isDone ? 'success'
    : 'running'
  return { isRunning, isDone, isCancelled, isFailed, isFinished, hasErrors, resultIcon }
}
