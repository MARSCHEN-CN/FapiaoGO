/**
 * PrintSessionStore — 打印会话运行时状态管理。
 *
 * 纯 JS 模块级 store，无 React 依赖。
 * Observer 模式（subscribe/notify）用于 React 同步。
 *
 * 不负责：
 *   ❌ React state
 *   ❌ UI logic
 *   ❌ Print execution
 *
 * @module stores/PrintSessionStore
 */

import {
  createPrintSession,
  markSessionStarted,
  appendSessionResult,
  markSessionCompleted,
  markSessionCancelled,
} from '../models/PrintSession'

/** @type {Map<number, object>} */
const sessions = new Map()

/** @type {Set<Function>} */
const listeners = new Set()

let _activeSessionId = null

/**
 * 订阅 store 变化。
 * @param {Function} fn - (sessionId) => void
 * @returns {Function} unsubscribe
 */
export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify() {
  for (const fn of listeners) {
    try { fn(_activeSessionId) } catch (e) { console.warn('[PrintSessionStore] notify error:', e) }
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
 * 获取活跃会话对象。
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
 * 创建新的打印会话。
 * @param {object[]} tasks - PrintTask 数组
 * @returns {object} 新创建的 session
 */
export function createPrintingSession(tasks) {
  const session = createPrintSession(tasks)
  sessions.set(session.id, session)
  _activeSessionId = session.id
  notify()
  return session
}

/**
 * 标记会话开始打印。
 * @returns {object|null}
 */
export function startPrinting() {
  const session = getActiveSession()
  if (!session) return null
  const updated = markSessionStarted(session)
  sessions.set(session.id, updated)
  notify()
  return updated
}

/**
 * 追加打印结果。
 * @param {object} result - PrintResult
 * @returns {object|null}
 */
export function addPrintResult(result) {
  const session = getActiveSession()
  if (!session) return null
  const updated = appendSessionResult(session, result)
  sessions.set(session.id, updated)
  notify()
  return updated
}

/**
 * 完成会话。
 * @returns {object|null}
 */
export function completePrinting() {
  const session = getActiveSession()
  if (!session) return null
  const updated = markSessionCompleted(session)
  sessions.set(session.id, updated)
  notify()
  return updated
}

/**
 * 取消会话。
 * @returns {object|null}
 */
export function cancelPrinting() {
  const session = getActiveSession()
  if (!session) return null
  const updated = markSessionCancelled(session)
  sessions.set(session.id, updated)
  _activeSessionId = null
  notify()
  return updated
}

/**
 * 获取当前进度摘要。
 * @returns {{ total: number, completed: number, failed: number, status: string }}
 */
export function getProgressSummary() {
  const session = getActiveSession()
  if (!session) return { total: 0, completed: 0, failed: 0, status: 'idle' }
  return {
    total: session.total,
    completed: session.completed,
    failed: session.failed,
    status: session.status,
  }
}

/**
 * 清理已完成会话。
 */
export function cleanCompletedSessions() {
  for (const [id, session] of sessions) {
    if (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled') {
      sessions.delete(id)
    }
  }
  if (_activeSessionId && !sessions.has(_activeSessionId)) {
    _activeSessionId = null
  }
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
