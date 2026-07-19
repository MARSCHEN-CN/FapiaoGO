/**
 * PrintSession — 一次批量打印会话的状态根对象。
 *
 * 描述"一次打印任务的全部状态"，不包含 UI 绑定。
 *
 * 不负责：
 *   ❌ Modal/printer dialog state
 *   ❌ React state / callbacks
 *
 * @module models/PrintSession
 */

let _nextSessionId = 0

/**
 * 生成自增会话 ID。
 * @returns {number}
 */
export function nextPrintSessionId() {
  return _nextSessionId++
}

/**
 * 重置会话 ID 计数器（用于测试/清理）。
 */
export function resetPrintSessionId() {
  _nextSessionId = 0
}

/**
 * 会话状态。
 * @readonly
 */
export const SESSION_STATUS = {
  IDLE: 'idle',
  PREPARING: 'preparing',
  PRINTING: 'printing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
}

/**
 * 创建打印会话。
 *
 * @param {object[]} tasks - PrintTask 数组
 * @returns {object} PrintSession
 */
export function createPrintSession(tasks = []) {
  return {
    id: nextPrintSessionId(),
    tasks: [...tasks],
    status: SESSION_STATUS.IDLE,
    total: tasks.length,
    completed: 0,
    failed: 0,
    results: [],
    startedAt: null,
    finishedAt: null,
  }
}

/**
 * 标记会话开始。
 * @param {object} session
 * @returns {object}
 */
export function markSessionStarted(session) {
  return {
    ...session,
    status: SESSION_STATUS.PRINTING,
    startedAt: session.startedAt || new Date().toISOString(),
  }
}

/**
 * 追加一个打印结果。
 * @param {object} session
 * @param {object} result - PrintResult
 * @returns {object}
 */
export function appendSessionResult(session, result) {
  const results = [...session.results, result]
  const completed = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length

  return {
    ...session,
    results,
    completed,
    failed,
  }
}

/**
 * 标记会话完成。
 * @param {object} session
 * @returns {object}
 */
export function markSessionCompleted(session) {
  const allCompleted = session.failed === 0
  return {
    ...session,
    status: allCompleted ? SESSION_STATUS.COMPLETED : SESSION_STATUS.FAILED,
    finishedAt: new Date().toISOString(),
  }
}

/**
 * 标记会话取消。
 * @param {object} session
 * @returns {object}
 */
export function markSessionCancelled(session) {
  return {
    ...session,
    status: SESSION_STATUS.CANCELLED,
    finishedAt: new Date().toISOString(),
  }
}
