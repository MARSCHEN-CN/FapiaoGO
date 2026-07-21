/**
 * ExportService — 导出执行服务。
 *
 * 职责：
 *   - Excel/CSV 导出（IPC select-save-path + fetch ReadableStream SSE）
 *   - PDF 导出（POST 创建任务 + EventSource SSE）
 *   - PDF 取消
 *
 * 不负责：
 *   ❌ React state / hooks
 *   ❌ UI message / toast / modal
 *   ❌ 文件列表管理 / 状态过滤
 *
 * 依赖注入：
 *   - ipc（Electron ipcRenderer）由 caller 传入，不直接 import Electron
 *   - BACKEND_URL 从 config 导入
 *
 * 协议隔离：
 *   - Excel：fetch + ReadableStream（POST body，内联消费，不复用 StreamConsumer）
 *   - PDF：EventSource（GET，委托 EventStreamConsumer）
 *   两种协议不共享代码，避免 Import 边界污染。
 *
 * @module services/ExportService
 */

import { BACKEND_URL } from '../config'
import { consumeEventStream } from './EventStreamConsumer'
import {
  createSuccessfulExport,
  createFailedExport,
  createCancelledExport,
} from '../models/ExportResult'

// ═══════════════════════════════════════════════════════════
// 私有辅助
// ═══════════════════════════════════════════════════════════

/**
 * 生成 yymmdd 格式日期字符串。
 * @returns {string}
 */
function _dateSuffix() {
  const d = new Date()
  return String(d.getFullYear()).slice(2) +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0')
}

/**
 * 为文件生成 PDF 输出路径。
 *
 * single 模式：每个文件独立路径（源文件目录 + basename_export_YYMMDD.pdf）。
 * merge 模式：单一路径（输出目录 + config.fileName）。
 *
 * @param {object} file - { name?, path? }
 * @param {object} config - { mode, outputType, folderPath, fileName }
 * @returns {string}
 */
function _resolveOutputPath(file, config) {
  let outputDir = ''
  if (config.outputType === 'source' && file.path) {
    outputDir = file.path.split(/[\\/]/).slice(0, -1).join('/')
  } else if (config.outputType === 'folder' && config.folderPath) {
    outputDir = config.folderPath
  }
  if (!outputDir) outputDir = '.'

  if (config.mode === 'merge') {
    const fname = config.fileName || 'invoice_export.pdf'
    return `${outputDir}/${fname}`
  }

  const name = file.name || file.path?.split(/[\\/]/).pop() || 'export'
  const baseName = name.replace(/\.[^.]+$/, '')
  return `${outputDir}/${baseName}_export_${_dateSuffix()}.pdf`
}

/**
 * 从非 2xx 响应体中提取错误信息。
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function _extractError(response) {
  let errorMsg = `服务器返回 ${response.status}`
  try {
    const errBody = await response.json()
    if (errBody.error) errorMsg = errBody.error
  } catch (_) { /* 非 JSON 体，保留默认 */ }
  return errorMsg
}

// ═══════════════════════════════════════════════════════════
// Excel 导出
// ═══════════════════════════════════════════════════════════

/**
 * 导出 Excel/CSV。
 *
 * 流程：IPC select-save-path → fetch /api/export-excel-sse → 消费 SSE → ExportResult
 *
 * @param {object} params
 * @param {Array} params.files - 已过滤的 parsed 文件列表
 * @param {object} params.ipc - Electron ipcRenderer（依赖注入）
 * @param {object} [params.options] - { includeRemark=true, splitByType=false, format='xlsx' }
 * @param {Array}  [params.columns] - 字段确认弹窗下发的列定义 [{key,label,width,virtual}]
 *                                     顺序即导出列序；不传则后端走默认全列。
 * @param {number} params.taskId - 前端 ExportTask.id（关联 ExportResult）
 * @param {(progress: {current:number,total:number,stage:string}) => void} [params.onProgress]
 * @returns {Promise<object>} ExportResult
 */
export async function exportExcel({
  files,
  ipc,
  options = {},
  columns = null,
  taskId,
  onProgress,
}) {
  if (!ipc) {
    return createFailedExport({ taskId, error: 'Electron API 不可用' })
  }

  // 只传文件名列表，后端从数据库读取完整数据
  const fileNames = files
    .map(f => f.name || f.path || f.fileName || '')
    .filter(Boolean)

  if (fileNames.length === 0) {
    return createFailedExport({ taskId, error: '无法获取文件名' })
  }

  // ── 第一步：IPC 获取保存路径 ──
  const dialogResult = await ipc.invoke('select-save-path', {
    defaultName: `发票汇总_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
    filters: [
      { name: 'Excel 文件', extensions: ['xlsx'] },
      { name: 'CSV 文件', extensions: ['csv'] },
    ],
  })

  if (!dialogResult || dialogResult.canceled || !dialogResult.filePath) {
    // 用户取消保存对话框 —— 不视为错误，返回 cancelled
    return createCancelledExport({ taskId })
  }

  const savePath = dialogResult.filePath
  const isCsv = savePath.toLowerCase().endsWith('.csv')

  onProgress?.({ current: 0, total: 100, stage: '准备中' })

  // ── 第二步：fetch SSE 流式调用后端 ──
  const response = await fetch(`${BACKEND_URL}/api/export-excel-sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath: savePath,
      fileNames,
      options: {
        includeRemark: options.includeRemark ?? true,
        splitByType: options.splitByType ?? false,
      },
      columns: columns || undefined,
      format: options.format || (isCsv ? 'csv' : 'xlsx'),
    }),
  })

  if (!response.ok) {
    const errorMsg = await _extractError(response)
    return createFailedExport({ taskId, error: errorMsg })
  }

  // ── 消费 SSE 事件流 ──
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue

      try {
        const msg = JSON.parse(line.slice(6))

        if (msg.error) {
          return createFailedExport({ taskId, error: msg.error })
        }

        if (msg.result) {
          onProgress?.({ current: 100, total: 100, stage: '完成' })
          return createSuccessfulExport({
            taskId,
            path: msg.result.path || savePath,
            metadata: {
              backendTaskId: null,  // Excel 无后端 taskId
              total: fileNames.length,
              successCount: msg.result.successCount ?? fileNames.length,
              failCount: msg.result.failCount ?? 0,
            },
          })
        }

        // 进度事件
        onProgress?.({
          current: msg.current || 0,
          total: msg.total || 100,
          stage: msg.stage || '处理中',
        })
      } catch (_) {
        // 跳过无法解析的行（心跳等）
      }
    }
  }

  // 流结束但未收到 result → 视为失败
  return createFailedExport({ taskId, error: '导出流意外结束' })
}

// ═══════════════════════════════════════════════════════════
// PDF 导出
// ═══════════════════════════════════════════════════════════

/**
 * 启动 PDF 导出任务。
 *
 * 流程：POST /api/export-pdf 创建任务 → EventSource 消费 SSE → 回调通知
 *
 * @param {object} config - 来自 PdfExportConfirmModal.onConfirm
 *   { mode: 'merge'|'single', outputType, folderPath, fileName, files: [{path,name}] }
 * @param {object} [handlers]
 * @param {(msg: object) => void} [handlers.onProgress] - SSE 消息回调（含 running/pending）
 * @param {(msg: object) => void} [handlers.onTerminal] - 终态回调（completed/cancelled/failed）
 * @param {() => void} [handlers.onError] - 连接中断回调
 * @returns {Promise<{taskId: string, close: () => void}>}
 */
export async function startPdfExport(config, handlers = {}) {
  const { onProgress, onTerminal, onError } = handlers

  // ── 构建 POST body ──
  let body

  if (config.mode === 'merge') {
    const firstFile = config.files[0]
    const mergeOutput = _resolveOutputPath(firstFile, config)
    const filesPayload = config.files.map(f => ({
      name: f.name || f.path?.split(/[\\/]/).pop() || '',
      path: f.path || '',
    }))
    body = { mode: 'merge', files: filesPayload, outputPath: mergeOutput }
  } else {
    const filesPayload = config.files.map(f => ({
      name: f.name || f.path?.split(/[\\/]/).pop() || '',
      path: f.path || '',
      outputPath: _resolveOutputPath(f, config),
    }))
    body = { mode: 'single', files: filesPayload }
  }

  // ── POST 创建任务 ──
  const response = await fetch(`${BACKEND_URL}/api/export-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorMsg = await _extractError(response)
    // 非 2xx → 直接进入终态（failed）
    onTerminal?.({
      status: 'failed',
      stage: errorMsg,
      errors: [{ file: '', error: errorMsg }],
    })
    return { taskId: null, close: () => {} }
  }

  const { taskId } = await response.json()

  if (!taskId) {
    onTerminal?.({ status: 'failed', stage: '未返回 taskId' })
    return { taskId: null, close: () => {} }
  }

  // ── EventSource 消费 SSE ──
  const close = consumeEventStream(
    `${BACKEND_URL}/api/export-pdf/events/${taskId}`,
    {
      onMessage: (msg, closeStream) => {
        // 首次收到 running 时补全 taskId（后端 pending→running 过渡期可能缺失）
        if (msg.status === 'running' && !msg.taskId) {
          msg.taskId = taskId
        }
        onProgress?.(msg)

        // 终态 → 关闭流 + 通知 caller
        if (['completed', 'cancelled', 'failed'].includes(msg.status)) {
          closeStream()
          onTerminal?.(msg)
        }
      },
      onError: () => {
        // 连接中断（非主动关闭）→ 标记失败
        onTerminal?.({
          status: 'failed',
          stage: '连接中断',
          errors: [{ file: '', error: 'SSE 连接中断' }],
        })
      },
    }
  )

  return { taskId, close }
}

/**
 * 启动 RenderCommand 管线 PDF 导出任务（D2-2-c1）。
 *
 * 流程：POST /api/export-render（commands: RenderCommand[]）→ EventSource 消费 SSE。
 * 与 startPdfExport 协议同构，仅端点 / body 不同；本函数不触碰任何几何
 * （commands 已由 caller 经 buildExportSnapshot 组好，几何完全由前端 producer 拥有）。
 *
 * @param {Array} commands - RenderCommand[]（来自 buildExportSnapshot）
 * @param {object} [handlers]
 * @param {(msg: object) => void} [handlers.onProgress] - SSE 消息回调（含 running/pending）
 * @param {(msg: object) => void} [handlers.onTerminal] - 终态回调（completed/cancelled/failed）
 * @param {() => void} [handlers.onError] - 连接中断回调
 * @returns {Promise<{taskId: string, close: () => void}>}
 */
export async function startRenderExport(commands, handlers = {}) {
  const { onProgress, onTerminal, onError } = handlers

  const body = { commands: Array.isArray(commands) ? commands : [] }

  const response = await fetch(`${BACKEND_URL}/api/export-render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorMsg = await _extractError(response)
    onTerminal?.({
      status: 'failed',
      stage: errorMsg,
      errors: [{ file: '', error: errorMsg }],
    })
    return { taskId: null, close: () => {} }
  }

  const { taskId } = await response.json()

  if (!taskId) {
    onTerminal?.({ status: 'failed', stage: '未返回 taskId' })
    return { taskId: null, close: () => {} }
  }

  // ── EventSource 消费 SSE ──
  const close = consumeEventStream(
    `${BACKEND_URL}/api/export-render/events/${taskId}`,
    {
      onMessage: (msg, closeStream) => {
        if (msg.status === 'running' && !msg.taskId) {
          msg.taskId = taskId
        }
        onProgress?.(msg)

        if (['completed', 'cancelled', 'failed'].includes(msg.status)) {
          closeStream()
          onTerminal?.(msg)
        }
      },
      onError: () => {
        onTerminal?.({
          status: 'failed',
          stage: '连接中断',
          errors: [{ file: '', error: 'SSE 连接中断' }],
        })
      },
    }
  )

  return { taskId, close }
}

/**
 * 取消 PDF 导出任务。
 *
 * @param {string} taskId - 后端任务 ID
 * @returns {Promise<boolean>} 是否成功发送取消请求
 */
export async function cancelPdfExport(taskId) {
  if (!taskId) return false

  try {
    await fetch(`${BACKEND_URL}/api/export-pdf/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    })
    return true
  } catch (err) {
    console.error('取消导出失败:', err)
    return false
  }
}
