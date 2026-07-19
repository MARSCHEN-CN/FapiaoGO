/**
 * parseRunner — 单文件解析执行器
 *
 * 职责：
 *   执行一次解析任务：读取文件 → 调用 /parse_invoice → 返回结果。
 *   不更新 UI 状态，不操作 React。
 *
 * 调用方（orchestrator）负责：
 *   - 从队列取出任务
 *   - 调用 runParseTask()
 *   - 将结果映射到 UI state（queueUpdate）
 *   - 处理失败 + 进度更新
 *
 * 允许调用：
 *   - FileResolver.resolveFile()
 *   - fetch /parse_invoice
 *
 * 禁止：
 *   - setFiles()
 *   - queueUpdate()
 *   - 任何 React state
 *
 * @module runners/parseRunner
 */

import { BACKEND_URL } from '../config'
import { resolveFile } from '../services/FileResolver'

/**
 * 执行单文件解析。
 *
 * @param {Object} job - 解析任务
 * @param {Object} job.fileObj - 文件对象（含 name, path, printPath, file）
 * @param {Object} deps - 依赖
 * @param {Object} deps.ipc - Electron IPC 渲染器
 * @param {boolean} deps.autoOrient - 是否自动旋转
 * @returns {Promise<Object>} 解析结果数据（原始 API 响应）
 * @throws {Error} 解析失败
 */
export async function runParseTask(job, { ipc, autoOrient }) {
  const { fileObj: f } = job
  let resp

  console.log('[parseRunner] Processing:', f.name, 'file:', !!f.file, 'printPath:', !!f.printPath, 'path:', !!f.path)

  if (f.file) {
    const fd = new FormData()
    fd.append('file', f.file)
    fd.append('autoOrient', autoOrient ? '1' : '0')
    fd.append('mode', 'batch')

    resp = await fetch(`${BACKEND_URL}/parse_invoice`, {
      method: 'POST', body: fd,
    })
  } else if ((f.printPath || f.path) && ipc) {
    const file = await resolveFile(f, ipc)
    if (!file) throw new Error('IPC read-file failed: ' + f.name)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('autoOrient', autoOrient ? '1' : '0')
    fd.append('mode', 'batch')

    resp = await fetch(`${BACKEND_URL}/parse_invoice`, {
      method: 'POST', body: fd,
    })
  }

  if (!resp) throw new Error('无法读取文件')

  if (!resp.ok) {
    if (resp.status === 429) {
      throw new Error('服务器繁忙，请稍后重试')
    }
    throw new Error(`parse_invoice returned ${resp.status}`)
  }

  const data = await resp.json()
  console.log('[parseRunner] Response data:', {
    type: data.invoice_type,
    number: data.invoice_number,
    amount: data.amount,
    date: data.invoice_date,
    failed_fields: data.failed_fields,
    parse_method: data.parse_method,
  })

  return data
}
