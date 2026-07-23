/**
 * ImportSessionStore — 导入会话运行时存储
 *
 * 职责：
 *   管理 ImportSession 实例的创建、查询、更新。
 *   作为一次导入任务的唯一状态根。
 *
 * 非 React store：
 *   不使用 useState / useReducer / 任何 React API。
 *   纯模块级 Map + 导出方法。
 *
 * 调用方 (useFileOps) 负责：
 *   - 创建 session
 *   - 将用户操作转化为 store 方法调用
 *   - 将 store 数据同步到 React state（通过 BatchUIUpdater）
 *
 * 与 TaskScheduler 的关系：
 *   Store 属于业务状态层（what），
 *   Scheduler 属于执行层（how）。
 *   Scheduler 不直接读写 Store。
 *
 * @module stores/ImportSessionStore
 */

import { createSession, createSessionFile } from '../models/ImportSession.js'

// ── 会话存储 ────────────────────────────────────────────

/** @type {Map<string, import('../models/ImportSession').ImportSessionData>} */
const sessions = new Map()

// ── 订阅者（用于 React 同步） ───────────────────────────

/** @type {Set<(sessionId: string) => void>} */
const subscribers = new Set()

/**
 * 订阅会话变化。
 * @param {(sessionId: string) => void} fn - 回调函数
 * @returns {() => void} 取消订阅函数
 */
export function subscribe(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/**
 * 通知所有订阅者。
 * @param {string} sessionId
 */
function notify(sessionId) {
  for (const fn of subscribers) {
    try { fn(sessionId) } catch (_) { /* ignore subscriber errors */ }
  }
}

// ── 会话管理 ────────────────────────────────────────────

/**
 * 创建新会话。
 * @param {Array} [files] - 初始文件列表
 * @returns {import('../models/ImportSession').ImportSessionData}
 */
export function createImportSession(files = []) {
  const session = createSession(files)
  sessions.set(session.id, session)
  notify(session.id)
  return session
}

/**
 * 获取会话。
 * @param {string} id
 * @returns {import('../models/ImportSession').ImportSessionData|undefined}
 */
export function getSession(id) {
  return sessions.get(id)
}

/**
 * 删除会话。
 * @param {string} id
 */
export function removeSession(id) {
  sessions.delete(id)
  notify(id)
}

// ── 文件管理 ────────────────────────────────────────────

/**
 * 向会话添加文件。
 * @param {string} sessionId
 * @param {Array} fileInputs - 文件输入数组
 */
export function addFilesToSession(sessionId, fileInputs) {
  const session = sessions.get(sessionId)
  if (!session) return

  const existingKeys = new Set(session.files.map(f => f.key))
  const newFiles = fileInputs
    .filter(f => !existingKeys.has(f.key || f.name))
    .map(f => createSessionFile(f))

  session.files.push(...newFiles)
  session.progress.total = session.files.length
  notify(sessionId)
}

/**
 * 更新会话中某个文件的状态。
 * @param {string} sessionId
 * @param {string} fileKey
 * @param {Partial<import('../models/ImportSession').SessionFile>} updates
 */
export function updateFileStatus(sessionId, fileKey, updates) {
  const session = sessions.get(sessionId)
  if (!session) return

  const file = session.files.find(f => f.key === fileKey)
  if (!file) return

  Object.assign(file, updates)
  notify(sessionId)
}

/**
 * 替换会话中某个文件的占位项（多页 PDF 拆分后）。
 * @param {string} sessionId
 * @param {string} fileKey - 被替换的占位 key
 * @param {Array} newItems - 替换项
 */
export function replaceFileItems(sessionId, fileKey, newItems) {
  const session = sessions.get(sessionId)
  if (!session) return

  const idx = session.files.findIndex(f => f.key === fileKey)
  if (idx === -1) return

  session.files.splice(idx, 1, ...newItems.map(i => createSessionFile(i)))
  session.progress.total = session.files.length
  notify(sessionId)
}

// ── 批次聚合（合同 §2/§3：session 1:N batch） ──────────────

/**
 * 记录一个子批次 ID 到会话。
 * 用于多批进度聚合、cancel cascade、retry mapping。
 * @param {string} sessionId
 * @param {string} batchId
 */
export function addChildBatch(sessionId, batchId) {
  const session = sessions.get(sessionId)
  if (!session) return
  if (!session.childBatchIds.includes(batchId)) {
    session.childBatchIds.push(batchId)
  }
  notify(sessionId)
}

/**
 * 获取会话的子批次 ID 列表副本。
 * @param {string} sessionId
 * @returns {string[]}
 */
export function getChildBatchIds(sessionId) {
  const session = sessions.get(sessionId)
  return session ? [...session.childBatchIds] : []
}

/**
 * 将一批文件绑定到某个子批次（chunk 提交后调用）。
 * @param {string} sessionId
 * @param {string[]} fileIds - 文件标识（= file.key / file.id）
 * @param {string} batchId
 */
export function attachFilesToBatch(sessionId, fileIds, batchId) {
  const session = sessions.get(sessionId)
  if (!session) return
  for (const fid of fileIds) {
    const file = session.files.find(f => f.key === fid || f.id === fid)
    if (file) file.batchId = batchId
  }
  notify(sessionId)
}

/**
 * 回填文件级失败信息（合同 §6 file-level mapping）。
 * 仅首次置为 error 时累加失败计数，避免重复调用重复计数。
 * @param {string} sessionId
 * @param {string} fileId
 * @param {string|null} error
 */
export function updateFileError(sessionId, fileId, error) {
  const session = sessions.get(sessionId)
  if (!session) return
  const file = session.files.find(f => f.key === fileId || f.id === fileId)
  if (!file) return
  file.error = error
  if (file.status !== 'error') {
    file.status = 'error'
    session.progress.failed = (session.progress.failed || 0) + 1
  }
  notify(sessionId)
}

// ── 任务管理 ────────────────────────────────────────────

/**
 * 添加任务到会话。
 * @param {string} sessionId
 * @param {import('../models/ImportSession').SessionTask} task
 */
export function addTask(sessionId, task) {
  const session = sessions.get(sessionId)
  if (!session) return
  session.tasks.push(task)
  notify(sessionId)
}

/**
 * 更新任务状态。
 * @param {string} sessionId
 * @param {string} taskId
 * @param {string} status
 */
export function updateTaskStatus(sessionId, taskId, status) {
  const session = sessions.get(sessionId)
  if (!session) return
  const task = session.tasks.find(t => t.id === taskId)
  if (!task) return
  task.status = status
  notify(sessionId)
}

// ── 进度管理 ────────────────────────────────────────────

/**
 * 更新会话进度。
 * @param {string} sessionId
 * @param {Partial<import('../models/ImportSession').SessionProgress>} delta
 */
export function updateProgress(sessionId, delta) {
  const session = sessions.get(sessionId)
  if (!session) return
  if (delta.completed != null) session.progress.completed = delta.completed
  if (delta.failed != null) session.progress.failed = delta.failed
  if (delta.total != null) session.progress.total = delta.total
  notify(sessionId)
}

/**
 * 更新会话状态。
 * @param {string} sessionId
 * @param {import('../models/ImportSession').SessionStatus} status
 */
export function updateSessionStatus(sessionId, status) {
  const session = sessions.get(sessionId)
  if (!session) return
  session.status = status
  notify(sessionId)
}

// ── 结果管理 ────────────────────────────────────────────

/**
 * 添加解析结果到会话。
 * @param {string} sessionId
 * @param {Object} result
 */
export function addResult(sessionId, result) {
  const session = sessions.get(sessionId)
  if (!session) return
  session.results.push(result)
  notify(sessionId)
}
