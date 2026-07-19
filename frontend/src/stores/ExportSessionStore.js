/**
 * ExportSessionStore — 导出会话运行时状态管理。
 *
 * 纯 JS 模块级 store，无 React 依赖。
 * Observer 模式（subscribe/notify）用于 React 同步。
 *
 * 与 PrintSessionStore（多任务批量会话）不同，ExportSessionStore 是
 * **单任务会话**——Excel 和 PDF 互斥，同一时刻最多一个活跃会话。
 * 这反映了 useExport.js 的实际语义（exporting / pdfExportTask 不会同时活跃）。
 *
 * ## session 对象结构
 *
 * session = ExportSession 模型字段 + store 层 `details` 扩展：
 *
 *   {
 *     // ── ExportSession 模型字段（models/ExportSession.js，冻结） ──
 *     id, task, status, progress, stage, result, createdAt, completedAt,
 *
 *     // ── store 层扩展：运行时细节（镜像后端 SSE 字段） ──
 *     details: {
 *       backendTaskId: string|null,  // 后端 SSE 返回的 UUID（仅 PDF）
 *       current: number,             // 已处理文件数
 *       total: number,               // 文件总数
 *       currentFile: string,         // 当前处理的文件名
 *       successCount: number,        // 成功文件数
 *       failCount: number,           // 失败文件数
 *       errors: Array<{file:string,error:string}>,
 *     }
 *   }
 *
 * `details` 是 store 层扩展，**非 ExportSession 模型字段**。模型保持冻结。
 * Excel 导出只填 details.current/total，其余默认；PDF 填全部字段。
 *
 * ## 不负责
 *
 *   ❌ React state / hooks
 *   ❌ UI logic / modal visible state（由 useExport 根据 session 存在性推导）
 *   ❌ Export execution（IPC/fetch/EventSource，由 ExportService 负责）
 *   ❌ SSE EventSource 生命周期管理
 *
 * @module stores/ExportSessionStore
 */

import {
  createExportSession as _createSessionModel,
  markSessionStarted,
  markSessionProgress,
  markSessionCompleted,
  markSessionFailed,
  markSessionCancelled,
  isTerminalStatus,
} from '../models/ExportSession.js'

/** @type {Map<number, object>} id → session（含 details） */
const sessions = new Map()

/** @type {Set<Function>} */
const listeners = new Set()

let _activeSessionId = null

/**
 * 创建空的 details 对象。
 * @returns {object}
 */
function _emptyDetails() {
  return {
    backendTaskId: null,
    current: 0,
    total: 0,
    currentFile: '',
    successCount: 0,
    failCount: 0,
    errors: [],
  }
}

/**
 * 订阅 store 变化。
 * @param {Function} fn - (activeSessionId) => void
 * @returns {Function} unsubscribe
 */
export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify() {
  for (const fn of listeners) {
    try { fn(_activeSessionId) } catch (e) { console.warn('[ExportSessionStore] notify error:', e) }
  }
}

/**
 * 获取当前活跃会话 ID。
 * @returns {number|null}
 */
export function getActiveSessionId() {
  return _activeSessionId
}

/**
 * 获取活跃会话对象（含 details）。
 * @returns {object|null}
 */
export function getActiveSession() {
  return _activeSessionId != null ? sessions.get(_activeSessionId) || null : null
}

/**
 * 获取指定会话。
 * @param {number} id
 * @returns {object|undefined}
 */
export function getSession(id) {
  return sessions.get(id)
}

/**
 * 创建新的导出会话并设为活跃。
 *
 * @param {object} task - ExportTask（由 createExportTask 构造）
 * @returns {object} 新创建的 session（含 details）
 */
export function createExportSession(task) {
  const session = {
    ..._createSessionModel(task),
    details: _emptyDetails(),
  }
  sessions.set(session.id, session)
  _activeSessionId = session.id
  notify()
  return session
}

/**
 * 标记会话开始（CREATED → RUNNING）。
 * @param {number} id
 * @param {string} [stage='正在导出']
 * @returns {object|null}
 */
export function startExport(id, stage) {
  const session = sessions.get(id)
  if (!session) return null
  const updated = {
    ...markSessionStarted(session, stage),
    details: session.details,
  }
  sessions.set(id, updated)
  notify()
  return updated
}

/**
 * 更新会话进度（不可变）。
 *
 * update 对象可包含模型字段（progress/stage）和 details 字段。
 * 模型字段交给 markSessionProgress（含终态守卫），details 字段合并到 session.details。
 *
 * @param {number} id
 * @param {object} update - { progress?, stage?, backendTaskId?, current?, total?,
 *                            currentFile?, successCount?, failCount?, errors? }
 * @returns {object|null}
 */
export function updateProgress(id, update = {}) {
  const session = sessions.get(id)
  if (!session) return null

  // 模型层更新（含终态守卫：终态时忽略 progress/stage）
  const updatedModel = markSessionProgress(session, {
    progress: update.progress,
    stage: update.stage,
  })

  // details 层更新（终态时也允许补充 details，如 errors 在终态消息里携带）
  const updatedDetails = { ...session.details }
  if (update.backendTaskId != null) updatedDetails.backendTaskId = update.backendTaskId
  if (update.current != null) updatedDetails.current = update.current
  if (update.total != null) updatedDetails.total = update.total
  if (update.currentFile != null) updatedDetails.currentFile = update.currentFile
  if (update.successCount != null) updatedDetails.successCount = update.successCount
  if (update.failCount != null) updatedDetails.failCount = update.failCount
  if (update.errors != null) updatedDetails.errors = update.errors

  const updated = { ...updatedModel, details: updatedDetails }
  sessions.set(id, updated)
  notify()
  return updated
}

/**
 * 标记会话完成（附带 ExportResult）。
 *
 * 不清除 _activeSessionId——UI 需要在终态后查询 result 显示成功/失败 alert。
 * 由 clearActiveSession / clearSession 在 UI 关闭结果时清理。
 *
 * @param {number} id
 * @param {object} result - ExportResult
 * @returns {object|null}
 */
export function completeExport(id, result) {
  const session = sessions.get(id)
  if (!session) return null
  const updated = {
    ...markSessionCompleted(session, result),
    details: session.details,
  }
  sessions.set(id, updated)
  notify()
  return updated
}

/**
 * 标记会话失败（附带 ExportResult）。
 *
 * 不清除 _activeSessionId——UI 需要在终态后查询 result 显示错误 alert。
 *
 * @param {number} id
 * @param {object} result - ExportResult
 * @returns {object|null}
 */
export function failExport(id, result) {
  const session = sessions.get(id)
  if (!session) return null
  const updated = {
    ...markSessionFailed(session, result),
    details: session.details,
  }
  sessions.set(id, updated)
  notify()
  return updated
}

/**
 * 标记会话取消。
 * @param {number} id
 * @param {object} [result] - ExportResult（可选）
 * @returns {object|null}
 */
export function cancelExport(id, result = null) {
  const session = sessions.get(id)
  if (!session) return null
  const updated = {
    ...markSessionCancelled(session, result),
    details: session.details,
  }
  sessions.set(id, updated)
  _activeSessionId = null
  notify()
  return updated
}

/**
 * 清除活跃会话（供 useExport 的 setter shim 调用）。
 *
 * 不改变 session 的 status（若仍活跃则保持当前状态），
 * 仅解除 _activeSessionId 指针，使 useExport 的派生视图归零。
 * session 对象仍保留在 sessions Map 中（可被 getSession 查询）。
 */
export function clearActiveSession() {
  _activeSessionId = null
  notify()
}

/**
 * 清除指定会话（从 Map 中删除）。
 * @param {number} id
 */
export function clearSession(id) {
  sessions.delete(id)
  if (_activeSessionId === id) _activeSessionId = null
  notify()
}

/**
 * 重置所有状态（测试/清理用）。
 */
export function resetStore() {
  sessions.clear()
  listeners.clear()
  _activeSessionId = null
}
