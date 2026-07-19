/**
 * TaskRegistry v1 — 导入任务生命周期管理
 *
 * 职责：
 *   管理导入任务的生命周期（创建、状态流转、取消、清理）。
 *   不涉及 worker 调度、File 读取、UI 更新。
 *
 * 所有权：
 *   一个 Task 对象代表一次导入会话（如拖入 1000 个文件）。
 *   TaskRegistry 是 Task 的唯一所有者。
 *
 * 与 FileResolver 的关系：
 *   Task 持有 fileIds，不持有 File 对象。
 *   文件读取通过 FileResolver 在 worker 内部完成。
 *
 * 与 StreamConsumer 的关系：
 *   Task 持有 stream (EventSource) 引用，方便取消时关闭连接。
 *   StreamConsumer 负责解析事件并更新 TaskRegistry / ProgressStore。
 *
 * 这是 Import State Model v2 (docs/architecture/import-state-model-v2.md)
 * 定义的 TaskRegistry 实现。Phase 1b Commit 1b-1: 仅新增模块，不迁移调用点。
 *
 * @module services/TaskRegistry
 */

/**
 * @typedef {'pending'|'running'|'completed'|'cancelled'} TaskStatus
 */

/**
 * @typedef {Object} TaskProgress
 * @property {number} total - 总文件数
 * @property {number} finished - 已完成数
 * @property {number} failed - 失败数
 */

/**
 * @typedef {Object} ImportTask
 * @property {string} id - 任务唯一标识
 * @property {TaskStatus} status - 任务状态
 * @property {number} createdAt - 创建时间戳
 * @property {string[]} fileIds - 文件 ID 列表（非 File 对象）
 * @property {TaskProgress} progress - 进度遥测
 * @property {AbortController|null} abortController - 取消信号（用于中止 fetch）
 * @property {EventSource|null} stream - SSE 连接引用
 */

// ── Task Store ──────────────────────────────────────────
/** @type {Map<string, ImportTask>} */
const tasks = new Map()

let taskIdCounter = 0

/**
 * 生成唯一任务 ID。
 * @returns {string}
 */
function generateTaskId() {
  taskIdCounter++
  return `task-${Date.now()}-${taskIdCounter}`
}

// ── Public API ──────────────────────────────────────────

/**
 * 创建新导入任务。
 * 不启动任何工作，只注册任务状态。
 *
 * @param {string[]} fileIds - 文件 ID 列表
 * @returns {ImportTask}
 */
export function createTask(fileIds) {
  const task = {
    id: generateTaskId(),
    status: 'pending',
    createdAt: Date.now(),
    fileIds,
    progress: {
      total: fileIds.length,
      finished: 0,
      failed: 0,
    },
    abortController: null,
    stream: null,
  }
  tasks.set(task.id, task)
  return task
}

/**
 * 按 ID 获取任务。
 * @param {string} id
 * @returns {ImportTask|undefined}
 */
export function getTask(id) {
  return tasks.get(id)
}

/**
 * 删除任务（释放资源）。
 * 调用前应确保任务已停止（status 为 completed 或 cancelled）。
 * @param {string} id
 * @returns {boolean} 是否成功删除
 */
export function removeTask(id) {
  const task = tasks.get(id)
  if (!task) return false

  // 防御性清理：关闭 stream、中止 in-flight 请求
  if (task.stream) {
    task.stream.close()
  }
  if (task.abortController) {
    task.abortController.abort()
  }

  return tasks.delete(id)
}

/**
 * 更新任务状态。
 * 仅允许正向迁移：pending → running → completed | cancelled
 *
 * @param {string} id
 * @param {TaskStatus} status
 * @returns {boolean} 是否成功更新
 */
export function updateTaskStatus(id, status) {
  const task = tasks.get(id)
  if (!task) return false

  const VALID_TRANSITION = {
    pending: ['running'],
    running: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
  }

  const allowed = VALID_TRANSITION[task.status]
  if (!allowed || !allowed.includes(status)) {
    return false
  }

  task.status = status
  return true
}

/**
 * 绑定 AbortController 到任务（用于取消进行中的 fetch 请求）。
 * @param {string} id
 * @param {AbortController} controller
 */
export function setTaskAbortController(id, controller) {
  const task = tasks.get(id)
  if (!task) return
  task.abortController = controller
}

/**
 * 绑定 SSE EventSource 到任务。
 * @param {string} id
 * @param {EventSource} stream
 */
export function setTaskStream(id, stream) {
  const task = tasks.get(id)
  if (!task) return
  task.stream = stream
}

/**
 * 取消任务：触发 AbortController + 关闭 SSE + 标记状态。
 * @param {string} id
 * @returns {boolean}
 */
export function cancelTask(id) {
  const task = tasks.get(id)
  if (!task) return false
  if (task.status !== 'running' && task.status !== 'pending') return false

  if (task.abortController) {
    task.abortController.abort()
  }
  if (task.stream) {
    task.stream.close()
    task.stream = null
  }

  task.status = 'cancelled'
  return true
}

/**
 * 更新进度。
 * 纯遥测操作，不涉及业务状态。
 *
 * @param {string} id
 * @param {Partial<TaskProgress>} delta - 增量更新（只传变化字段）
 */
export function updateTaskProgress(id, delta) {
  const task = tasks.get(id)
  if (!task) return

  if (delta.finished != null) task.progress.finished = delta.finished
  if (delta.failed != null) task.progress.failed = delta.failed
  if (delta.total != null) task.progress.total = delta.total
}

/**
 * 获取当前所有活跃任务。
 * @returns {ImportTask[]}
 */
export function getActiveTasks() {
  return Array.from(tasks.values()).filter(
    (t) => t.status === 'pending' || t.status === 'running'
  )
}

/**
 * 清理所有已完成/已取消的任务。
 * @returns {number} 清理数量
 */
export function cleanCompletedTasks() {
  let count = 0
  for (const [id, task] of tasks) {
    if (task.status === 'completed' || task.status === 'cancelled') {
      removeTask(id)
      count++
    }
  }
  return count
}
