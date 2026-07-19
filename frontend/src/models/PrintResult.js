/**
 * PrintResult — 一次打印执行的结果。
 *
 * 描述"打印了什么、结果如何"，不包含 UI 反馈或 React 绑定。
 *
 * 不负责：
 *   ❌ Notification / toast / modal
 *   ❌ setFiles()
 *   ❌ Progress tracking
 *
 * @module models/PrintResult
 */

/**
 * 打印结果状态。
 * @readonly
 */
export const RESULT_STATUS = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
}

/**
 * 创建打印结果。
 *
 * @param {object} params
 * @param {number|string} params.taskId            - 关联的 PrintTask ID
 * @param {string} params.status                   - 执行状态
 * @param {string} [params.printer]                - 实际使用的打印机
 * @param {number} [params.pagesPrinted=0]         - 实际打印页数
 * @param {string} [params.error]                  - 错误信息（如果失败）
 * @param {string} [params.success]                - 是否成功
 * @returns {object} PrintResult
 */
export function createPrintResult({
  taskId,
  status,
  printer,
  pagesPrinted = 0,
  error,
}) {
  if (taskId == null) throw new Error('PrintResult: taskId is required')
  if (!status) throw new Error('PrintResult: status is required')

  const now = new Date().toISOString()

  return {
    taskId,
    success: status === RESULT_STATUS.COMPLETED,
    status,
    printer: printer || '',
    pagesPrinted: Math.max(0, pagesPrinted),
    error: error || null,
    startedAt: null,
    finishedAt: status !== RESULT_STATUS.COMPLETED && status !== RESULT_STATUS.FAILED ? null : now,
  }
}

/**
 * 标记开始时间。
 * @param {object} result
 * @returns {object} 新的 PrintResult（不可变副本）
 */
export function markResultStarted(result) {
  if (!result) return result
  return { ...result, startedAt: new Date().toISOString() }
}

/**
 * 创建成功的打印结果。
 * @param {object} params
 * @param {number|string} params.taskId
 * @param {string} [params.printer]
 * @param {number} [params.pagesPrinted]
 * @returns {object}
 */
export function createSuccessfulResult({ taskId, printer, pagesPrinted }) {
  return createPrintResult({
    taskId,
    status: RESULT_STATUS.COMPLETED,
    printer,
    pagesPrinted,
  })
}

/**
 * 创建失败的打印结果。
 * @param {object} params
 * @param {number|string} params.taskId
 * @param {string} [params.printer]
 * @param {string} params.error
 * @returns {object}
 */
export function createFailedResult({ taskId, printer, error }) {
  return createPrintResult({
    taskId,
    status: RESULT_STATUS.FAILED,
    printer,
    error,
  })
}
