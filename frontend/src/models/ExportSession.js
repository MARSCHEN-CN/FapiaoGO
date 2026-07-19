/**
 * ExportSession — 一次导出会话的状态根对象。
 *
 * 描述"一次导出任务的全部状态"，不包含 UI 绑定。
 *
 * 与 PrintSession（多任务批量会话）不同，ExportSession 是**单任务会话**：
 * Excel 和 PDF 互斥，一次只进行一个导出任务。这反映了 useExport.js
 * 的实际语义（`exporting` / `pdfExportTask` 两个状态不会同时活跃）。
 *
 * 不负责：
 *   ❌ Modal / dialog state
 *   ❌ React state / callbacks
 *   ❌ SSE EventSource 生命周期管理
 *   ❌ 后端 TaskRegistry 镜像（仅持有前端可见的进度快照）
 *
 * @module models/ExportSession
 */

let _nextSessionId = 0

/**
 * 生成自增会话 ID。
 * @returns {number}
 */
export function nextExportSessionId() {
  return _nextSessionId++
}

/**
 * 重置会话 ID 计数器（用于测试/清理）。
 */
export function resetExportSessionId() {
  _nextSessionId = 0
}

/**
 * 会话状态。
 *
 * 状态机：
 *   CREATED → RUNNING → COMPLETED
 *                    ↘ FAILED
 *                    ↘ CANCELLED
 *
 * 注意：与后端 TaskStatus 对齐（backend/services/task.py），
 * 但前端不持有 PENDING 态——PENDING 是后端创建任务到 start() 之间的瞬间，
 * 前端在收到首个 SSE running 消息前不创建 session。
 *
 * @readonly
 */
export const SESSION_STATUS = {
  CREATED: 'created',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
}

/**
 * 是否终态。
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalStatus(status) {
  return status === SESSION_STATUS.COMPLETED
    || status === SESSION_STATUS.FAILED
    || status === SESSION_STATUS.CANCELLED
}

/**
 * 创建导出会话。
 *
 * @param {object} task - ExportTask（由 createExportTask 构造）
 * @returns {object} ExportSession
 */
export function createExportSession(task) {
  if (!task) throw new Error('ExportSession: task is required')

  return {
    id: nextExportSessionId(),
    task,
    status: SESSION_STATUS.CREATED,
    progress: 0,         // 0-100，对齐后端 percent
    stage: '',           // 中文文案，对齐后端 stage
    result: null,        // ExportResult，终态时填充
    createdAt: new Date().toISOString(),
    completedAt: null,
  }
}

/**
 * 标记会话开始。
 * @param {object} session
 * @param {string} [stage='正在导出']
 * @returns {object}
 */
export function markSessionStarted(session, stage = '正在导出') {
  return {
    ...session,
    status: SESSION_STATUS.RUNNING,
    stage: stage || session.stage,
  }
}

/**
 * 更新会话进度（不可变）。
 *
 * 用于消费 SSE running 消息时更新 progress / stage。
 * 若 session 已处于终态则忽略更新，避免覆盖终态（对齐 useExport.js
 * 中 `if (['completed','cancelled','failed'].includes(prev.status)) return prev` 的守卫）。
 *
 * @param {object} session
 * @param {{progress?:number, stage?:string}} update
 * @returns {object}
 */
export function markSessionProgress(session, { progress, stage } = {}) {
  if (!session) return session
  if (isTerminalStatus(session.status)) return session

  return {
    ...session,
    progress: typeof progress === 'number' ? Math.max(0, Math.min(100, progress)) : session.progress,
    stage: stage ?? session.stage,
  }
}

/**
 * 标记会话完成（附带 ExportResult）。
 * @param {object} session
 * @param {object} result - ExportResult
 * @returns {object}
 */
export function markSessionCompleted(session, result) {
  return {
    ...session,
    status: SESSION_STATUS.COMPLETED,
    progress: 100,
    stage: '导出完成',
    result,
    completedAt: new Date().toISOString(),
  }
}

/**
 * 标记会话失败（附带 ExportResult）。
 * @param {object} session
 * @param {object} result - ExportResult
 * @returns {object}
 */
export function markSessionFailed(session, result) {
  return {
    ...session,
    status: SESSION_STATUS.FAILED,
    stage: '导出失败',
    result,
    completedAt: new Date().toISOString(),
  }
}

/**
 * 标记会话取消（附带 ExportResult）。
 * @param {object} session
 * @param {object} [result] - ExportResult（可选，调用方可能尚未构造）
 * @returns {object}
 */
export function markSessionCancelled(session, result = null) {
  return {
    ...session,
    status: SESSION_STATUS.CANCELLED,
    stage: '已取消',
    result,
    completedAt: new Date().toISOString(),
  }
}
