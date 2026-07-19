/**
 * ExportResult — 一次导出执行的结果。
 *
 * 描述"导出了什么、结果如何"，不包含 UI 反馈或 React 绑定。
 * 统一 Excel export 与 PDF export 的返回结构，供 ExportSession 持有。
 *
 * 字段约定：
 *   - `taskId`：前端 ExportTask.id（数字，必有）。
 *   - `metadata.backendTaskId`：后端 SSE 返回的 UUID（仅 PDF 有，Excel 为 null）。
 *
 * 不负责：
 *   ❌ Notification / toast / modal
 *   ❌ setFiles() / setPdfExportTask()
 *   ❌ Progress tracking（progress 属于 ExportSession）
 *
 * @module models/ExportResult
 */

/**
 * 导出结果状态。
 * @readonly
 */
export const RESULT_STATUS = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
}

/**
 * 创建导出结果。
 *
 * @param {object} params
 * @param {number} params.taskId                 - 关联的 ExportTask.id
 * @param {string} [params.status]               - 执行状态；若未提供则由 success 推导
 * @param {boolean} [params.success]             - 是否成功（status 优先）
 * @param {string} [params.path='']              - 输出路径（成功时）；
 *                                                  merge 模式为统一路径，single 模式取首个
 * @param {string} [params.error='']             - 任务级错误信息（失败时）
 * @param {object} [params.metadata={}]          - 附加元数据：
 *   @param {string} [params.metadata.backendTaskId]    - 后端 SSE 返回的 UUID（仅 PDF）
 *   @param {number} [params.metadata.total]           - 文件总数
 *   @param {number} [params.metadata.successCount]    - 成功文件数
 *   @param {number} [params.metadata.failCount]       - 失败文件数
 *   @param {number} [params.metadata.durationMs]      - 执行耗时（毫秒）
 *   @param {Array<{file:string,error:string}>} [params.metadata.fileErrors]
 *        - 单文件错误列表（PDF 批量导出场景）
 * @returns {object} ExportResult
 */
export function createExportResult({
  taskId,
  status,
  success,
  path = '',
  error = '',
  metadata = {},
}) {
  if (taskId == null) throw new Error('ExportResult: taskId is required')

  // status 优先，否则由 success 推导
  const resolvedStatus = status
    ?? (success === false ? RESULT_STATUS.FAILED : RESULT_STATUS.COMPLETED)

  if (!Object.values(RESULT_STATUS).includes(resolvedStatus)) {
    throw new Error(`ExportResult: invalid status "${resolvedStatus}"`)
  }

  const now = new Date().toISOString()

  return {
    taskId,
    success: resolvedStatus === RESULT_STATUS.COMPLETED,
    status: resolvedStatus,
    path: path || '',
    error: error || '',
    metadata: {
      backendTaskId: null,
      total: 0,
      successCount: 0,
      failCount: 0,
      durationMs: 0,
      fileErrors: [],
      ...metadata,
    },
    finishedAt: now,
  }
}

/**
 * 创建成功的导出结果。
 * @param {object} params
 * @param {number} params.taskId
 * @param {string} [params.path]
 * @param {object} [params.metadata]
 * @returns {object}
 */
export function createSuccessfulExport({ taskId, path, metadata }) {
  return createExportResult({
    taskId,
    status: RESULT_STATUS.COMPLETED,
    path,
    metadata,
  })
}

/**
 * 创建失败的导出结果。
 * @param {object} params
 * @param {number} params.taskId
 * @param {string} params.error
 * @param {object} [params.metadata]
 * @returns {object}
 */
export function createFailedExport({ taskId, error, metadata }) {
  return createExportResult({
    taskId,
    status: RESULT_STATUS.FAILED,
    error,
    metadata,
  })
}

/**
 * 创建被取消的导出结果。
 * @param {object} params
 * @param {number} params.taskId
 * @param {object} [params.metadata]
 * @returns {object}
 */
export function createCancelledExport({ taskId, metadata }) {
  return createExportResult({
    taskId,
    status: RESULT_STATUS.CANCELLED,
    metadata,
  })
}
