/**
 * ExportTask — 一次导出请求的不可变输入契约。
 *
 * 描述"要导出什么、怎么导出"，不包含 UI 状态或 React 绑定。
 *
 * 注意：与后端 `backend/services/task.py::ExportTask`（运行时任务对象，
 * 含 status/progress/cancel_callback）语义不同。前端 ExportTask 对应
 * POST `/api/export-pdf` / `/api/export-excel-sse` 的请求 body，
 * 是"输入"而非"运行时状态"。运行时状态见 `models/ExportSession`。
 *
 * 不负责：
 *   ❌ React state / callbacks
 *   ❌ progress / current / percent
 *   ❌ SSE handler / EventSource 生命周期
 *   ❌ UI message / stage 文案
 *   ❌ 文件解析 / 内容读取
 *
 * @module models/ExportTask
 */

let _nextTaskId = 0

/**
 * 生成自增导出任务 ID（前端侧，用于 React key 与 ExportSession 关联）。
 * 注意：与后端 SSE 返回的 `taskId`（UUID 字符串）不同。
 * @returns {number}
 */
export function nextExportTaskId() {
  return _nextTaskId++
}

/**
 * 重置导出任务 ID 计数器（用于测试/清理）。
 */
export function resetExportTaskId() {
  _nextTaskId = 0
}

/**
 * 导出类型。
 * @readonly
 */
export const EXPORT_TYPE = {
  PDF: 'pdf',
  EXCEL: 'excel',
  CSV: 'csv',
}

/**
 * PDF 导出模式（Excel/CSV 不适用，强制为 SINGLE）。
 * @readonly
 */
export const EXPORT_MODE = {
  MERGE: 'merge',     // 多个文件合并为单一 PDF
  SINGLE: 'single',   // 每个文件独立输出
}

/**
 * 创建导出任务。
 *
 * @param {object} params
 * @param {string} params.type                 - 导出类型 (pdf|excel|csv)
 * @param {string} [params.mode='single']      - PDF 导出模式 (merge|single)；
 *                                               Excel/CSV 忽略此字段，强制 single
 * @param {Array<{name:string,path:string,outputPath?:string}>} [params.files=[]]
 *        - 待导出文件列表；merge 模式下 outputPath 留空，single 模式下每项需 outputPath
 * @param {string} [params.outputPath='']      - merge 模式的统一输出路径
 * @param {object} [params.options={}]         - 透传选项 bag
 *        （如 Excel 的 includeRemark/splitByType/format 等）
 * @returns {object} ExportTask
 */
export function createExportTask({
  type,
  mode = EXPORT_MODE.SINGLE,
  files = [],
  outputPath = '',
  options = {},
}) {
  if (!type) throw new Error('ExportTask: type is required')
  if (!Array.isArray(files)) throw new Error('ExportTask: files must be an array')

  // Excel/CSV 不支持 merge 模式，强制 single
  const effectiveMode = type === EXPORT_TYPE.PDF ? mode : EXPORT_MODE.SINGLE

  return {
    id: nextExportTaskId(),
    type,
    mode: effectiveMode,
    files: files.map(f => ({
      name: f.name || '',
      path: f.path || '',
      outputPath: f.outputPath || '',
    })),
    outputPath: outputPath || '',
    options: { ...options },
    createdAt: new Date().toISOString(),
  }
}

/**
 * 验证 ExportTask 是否完整可用。
 *
 * 校验规则：
 *   - type 必须在 EXPORT_TYPE 中
 *   - files 必须非空（空数组视为无效，由调用方提前拦截）
 *   - merge 模式下 outputPath 必填
 *   - single 模式下每个 file 需有 outputPath
 *
 * @param {object} task
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateExportTask(task) {
  const errors = []
  if (!task) return { valid: false, errors: ['task is null/undefined'] }
  if (!task.type) {
    errors.push('type is required')
  } else if (!Object.values(EXPORT_TYPE).includes(task.type)) {
    errors.push(`invalid type: ${task.type}`)
  }
  if (!Array.isArray(task.files)) {
    errors.push('files must be an array')
  } else if (task.files.length === 0) {
    errors.push('files must not be empty')
  }
  if (task.type === EXPORT_TYPE.PDF && task.mode === EXPORT_MODE.MERGE) {
    if (!task.outputPath) errors.push('outputPath is required for merge mode')
  }
  if (task.type === EXPORT_TYPE.PDF && task.mode === EXPORT_MODE.SINGLE) {
    task.files?.forEach((f, i) => {
      if (!f.outputPath) errors.push(`files[${i}].outputPath is required in single mode`)
    })
  }
  return { valid: errors.length === 0, errors }
}
