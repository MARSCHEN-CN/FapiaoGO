/**
 * TaskScheduler v1 — 导入任务调度器
 *
 * 职责：
 *   管理 split 和 parse 任务队列，控制并发执行。
 *   不持有业务状态，不了解 React UI，不直接 IPC。
 *
 * 所有权：
 *   splitQueue 和 parseQueue 归 TaskScheduler 所有。
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

// ── 并发配置 ─────────────────────────────────────────────
/** 多页 PDF 拆分的最大并发数 */
export const DEFAULT_SPLIT_CONCURRENCY = 4

/** 单文件解析的最大并发数 */
export const DEFAULT_PARSE_CONCURRENCY = 2

// ── 任务队列 ────────────────────────────────────────────
/** @type {Array} */
const splitQueue = []

/** @type {Array} */
const parseQueue = []

/**
 * 初始化队列。
 * 清除旧队列，为新导入会话做好准备。
 */
export function createQueues() {
  splitQueue.length = 0
  parseQueue.length = 0
}

/**
 * 向 split 队列添加任务。
 * @param {Array} jobs - 需要拆分的文件任务
 */
export function enqueueSplit(jobs) {
  splitQueue.push(...jobs)
}

/**
 * 向 parse 队列添加任务。
 * @param {Array} jobs - 需要解析的文件任务
 */
export function enqueueParse(jobs) {
  parseQueue.push(...jobs)
}

/**
 * 从 split 队列取出下一个任务。
 * @returns {*} 下一个任务，队列为空时返回 undefined
 */
export function dequeueSplit() {
  return splitQueue.shift()
}

/**
 * 从 parse 队列取出下一个任务。
 * @returns {*} 下一个任务，队列为空时返回 undefined
 */
export function dequeueParse() {
  return parseQueue.shift()
}

/**
 * 获取 split 队列长度。
 * @returns {number}
 */
export function getSplitQueueLength() {
  return splitQueue.length
}

/**
 * 获取 parse 队列长度。
 * @returns {number}
 */
export function getParseQueueLength() {
  return parseQueue.length
}

/**
 * 检查所有队列是否为空。
 * @returns {boolean}
 */
export function isQueueEmpty() {
  return splitQueue.length === 0 && parseQueue.length === 0
}

/**
 * 获取队列状态摘要（用于调试/进度）。
 * @returns {{ splitQueueLength: number, parseQueueLength: number }}
 */
export function getQueueStatus() {
  return {
    splitQueueLength: splitQueue.length,
    parseQueueLength: parseQueue.length,
  }
}

/**
 * 清空所有队列（用于取消/清理）。
 */
export function clearQueues() {
  splitQueue.length = 0
  parseQueue.length = 0
}

// ── 执行存根（Phase 1b-3-2/3 实现） ────────────────────

/**
 * 执行下一个 split 任务。
 *
 * 调用方负责：
 *   1. dequeueSplit() 获取任务
 *   2. 调用 FileResolver.resolve() 获取文件
 *   3. 调用 /split_pdf API
 *   4. 将输出加入 parse 队列
 *   5. 调用 queueUpdate() 更新 UI
 *
 * @param {Function} runner - 实际执行函数
 * @returns {Promise<boolean>} 是否有任务被执行
 */
export async function runNextSplit(runner) {
  const job = dequeueSplit()
  if (!job) return false
  await runner(job)
  return true
}

/**
 * 执行下一个 parse 任务。
 *
 * @param {Function} runner - 实际执行函数
 * @returns {Promise<boolean>} 是否有任务被执行
 */
export async function runNextParse(runner) {
  const job = dequeueParse()
  if (!job) return false
  await runner(job)
  return true
}

/**
 * 启动 split worker 池（并发执行）。
 *
 * @param {number} concurrency - 并发数
 * @param {Function} runner - 实际执行函数
 * @returns {Promise<void[]>}
 */
export async function startSplitWorkers(concurrency = DEFAULT_SPLIT_CONCURRENCY, runner) {
  const workers = []
  for (let i = 0; i < Math.min(concurrency, getSplitQueueLength() || 1); i++) {
    workers.push(runNextSplit(runner))
  }
  // 递归消费：当一个 worker 完成后，检查队列并继续
  // （实际实现由 runner 内部决定，此处仅返回首次启动的 Promise）
  return Promise.all(workers)
}

/**
 * 启动 parse worker 池（并发执行）。
 *
 * @param {number} concurrency - 并发数
 * @param {Function} runner - 实际执行函数
 * @returns {Promise<void[]>}
 */
export async function startParseWorkers(concurrency = DEFAULT_PARSE_CONCURRENCY, runner) {
  const workers = []
  for (let i = 0; i < concurrency; i++) {
    workers.push(runNextParse(runner))
  }
  return Promise.all(workers)
}
