/**
 * PrintTask — 一次打印动作的不可变输入契约。
 *
 * 描述"要打印什么、怎么打印"，不包含 UI 状态或 React 绑定。
 *
 * 不负责：
 *   ❌ UI state (selected, checked, expanded)
 *   ❌ React state / callbacks
 *   ❌ print progress / queue status
 *   ❌ printer discovery / selection
 *
 * @module models/PrintTask
 */

let _nextTaskId = 0

/**
 * 生成自增打印任务 ID。
 * @returns {number}
 */
export function nextPrintTaskId() {
  return _nextTaskId++
}

/**
 * 重置打印任务 ID 计数器（用于测试/清理）。
 */
export function resetPrintTaskId() {
  _nextTaskId = 0
}

/**
 * 打印优先级。
 * @readonly
 */
export const PRINT_PRIORITY = {
  NORMAL: 'normal',
  HIGH: 'high',
}

/**
 * 打印模式。
 * @readonly
 */
export const PRINT_MODE = {
  SOURCE: 'source',   // 直送源文件到 Sumatra
  MERGED: 'merged',   // 渲染 Canvas → PNG → 临时 PDF
}

/**
 * 打印任务状态。
 * @readonly
 */
export const TASK_STATUS = {
  CREATED: 'created',
  QUEUED: 'queued',
  RENDERING: 'rendering',
  PRINTING: 'printing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
}

/**
 * 源文件类型。
 * @readonly
 */
export const SOURCE_TYPE = {
  PDF: 'pdf',
  IMAGE: 'image',
  OFD: 'ofd',
}

/**
 * 创建打印任务。
 *
 * @param {object} params
 * @param {string} params.fileId         - 关联的文件 ID
 * @param {string} params.sourceType     - 源文件类型 (pdf|image|ofd)
 * @param {string} params.sourcePath     - 源文件路径
 * @param {string} [params.pageSize]     - 纸张尺寸 (A4, A5, Letter, etc.)
 * @param {string} [params.orientation]  - portrait | landscape
 * @param {string} [params.printer]      - 打印机名称
 * @param {number} [params.copies=1]     - 打印份数
 * @param {string} [params.colorMode='color'] - color | grayscale
 * @param {boolean} [params.duplex=false]     - 双面打印
 * @param {string} [params.mode='source']     - 打印管线模式
 * @param {object} [params.pageCount]         - 页数
 * @returns {object} PrintTask
 */
export function createPrintTask({
  fileId,
  sourceType,
  sourcePath,
  pageSize,
  orientation,
  printer,
  copies = 1,
  colorMode = 'color',
  duplex = false,
  mode = PRINT_MODE.SOURCE,
  pageCount,
}) {
  if (!fileId) throw new Error('PrintTask: fileId is required')
  if (!sourceType) throw new Error('PrintTask: sourceType is required')
  if (!sourcePath) throw new Error('PrintTask: sourcePath is required')

  return {
    id: nextPrintTaskId(),
    fileId,
    sourceType,
    sourcePath,
    pageSize: pageSize || 'A4',
    orientation: orientation || 'portrait',
    printer: printer || '',
    copies: Math.max(1, copies),
    colorMode,
    duplex,
    mode,
    pageCount: pageCount || { total: 1 },
    status: TASK_STATUS.CREATED,
    createdAt: new Date().toISOString(),
  }
}

/**
 * 验证 PrintTask 是否完整可用。
 * @param {object} task
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePrintTask(task) {
  const errors = []
  if (!task) return { valid: false, errors: ['task is null/undefined'] }
  if (!task.fileId) errors.push('fileId is required')
  if (!task.sourcePath) errors.push('sourcePath is required')
  if (!task.sourceType) errors.push('sourceType is required')
  if (!task.printer) errors.push('printer is required')
  return { valid: errors.length === 0, errors }
}
