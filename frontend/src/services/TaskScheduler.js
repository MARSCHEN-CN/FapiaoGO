/**
 * TaskScheduler v1 — 导入任务调度器
 *
 * 职责：
 *   管理 split 任务队列，控制并发执行。
 *   不持有业务状态，不了解 React UI，不直接 IPC。
 *
 * 所有权：
 *   splitQueue 归 TaskScheduler 所有。
 *   任何模块不得直接操作队列（push/shift 封装在内部）。
 *
 * 与 FileResolver 的关系：
 *   TaskScheduler 调用 FileResolver.resolve() 获取文件内容。
 *   Worker 不直接使用 IPC。
 *
 * 与 TaskRegistry 的关系：
 *   TaskScheduler 通过 taskId 关联 TaskRegistry 的任务状态。
 *   TaskRegistry 管理生命周期（取消），TaskScheduler 管理执行。
 *
 * 与 StreamConsumer 的关系：
 *   批量解析时，TaskScheduler 调用 StreamConsumer.consumeBatchStream()。
 *
 * 这是 Import State Model v2 (docs/architecture/import-state-model-v2.md)
 * 定义的 TaskScheduler 实现。Phase 1b-3-1: 仅新增模块，不迁移调用点。
 *
 * @module services/TaskScheduler
 */

// ── 任务队列 ────────────────────────────────────────────
/** @type {Array} */
const splitQueue = []

/**
 * 初始化队列。
 * 清除旧队列，为新导入会话做好准备。
 */
export function createQueues() {
  splitQueue.length = 0
}

/**
 * 向 split 队列添加任务。
 * @param {Array} jobs - 需要拆分的文件任务
 */
export function enqueueSplit(jobs) {
  splitQueue.push(...jobs)
}

/**
 * 从 split 队列取出下一个任务。
 * @returns {*} 下一个任务，队列为空时返回 undefined
 */
export function dequeueSplit() {
  return splitQueue.shift()
}

/**
 * 获取 split 队列长度。
 * @returns {number}
 */
export function getSplitQueueLength() {
  return splitQueue.length
}
