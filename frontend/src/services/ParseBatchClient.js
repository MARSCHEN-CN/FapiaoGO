/**
 * ParseBatchClient — 批量解析请求构造与提交
 *
 * 职责：
 *   - 解析文件输入，构建 FormData
 *   - 返回 { url, formData } 供 StreamConsumer 消费
 *
 * 不负责：
 *   ❌ SSE 流消费（StreamConsumer 负责）
 *   ❌ 结果映射（ParseResultConsumer 负责）
 *   ❌ 状态管理（ImportSessionStore 负责）
 *   ❌ React state
 *
 * 只负责 Transport Layer 协议栈：
 *   文件准备 → FormData → URL → Fetch
 *
 * @module services/ParseBatchClient
 */

import { BACKEND_URL } from '../config'
import { resolveFile } from './FileResolver'

/**
 * 准备批量解析请求的 FormData。
 *
 * @param {Array<{file?: File, path?: string, printPath?: string, name: string, key: string}>} filesToParse
 * @param {{ ipc: object, autoOrient: boolean }} options
 * @returns {Promise<{ url: string, formData: FormData }>}
 */
export async function prepareBatchRequest(filesToParse, { ipc, autoOrient }) {
  // ── 准备所有文件的 File 对象 ──────────────────────────
  const preparedFiles = []
  for (const fileObj of filesToParse) {
    if (fileObj.file) {
      preparedFiles.push(fileObj.file)
    } else if ((fileObj.printPath || fileObj.path) && ipc) {
      const file = await resolveFile(fileObj, ipc)
      preparedFiles.push(file)
    } else {
      preparedFiles.push(null)
    }
  }

  // ── 构造 FormData ────────────────────────────────────
  const formData = new FormData()
  for (let i = 0; i < preparedFiles.length; i++) {
    if (preparedFiles[i]) {
      formData.append('files', preparedFiles[i], filesToParse[i].name)
    }
  }
  formData.append('autoOrient', autoOrient ? '1' : '0')

  return {
    url: `${BACKEND_URL}/parse_batch`,
    formData,
  }
}

/**
 * 单文件解析请求构造（用于 fallback 路径）。
 * @param {{ file?: File, printPath?: string, path?: string, name: string }} fileObj
 * @param {{ ipc: object, autoOrient: boolean }} options
 * @returns {Promise<{ url: string, formData: FormData }>}
 */
export async function prepareSingleRequest(fileObj, { ipc, autoOrient }) {
  let file = fileObj.file
  if (!file && (fileObj.printPath || fileObj.path) && ipc) {
    file = await resolveFile(fileObj, ipc)
  }
  if (!file) return null

  const formData = new FormData()
  formData.append('file', file)
  formData.append('autoOrient', autoOrient ? '1' : '0')
  formData.append('mode', 'batch')

  return {
    url: `${BACKEND_URL}/parse_invoice`,
    formData,
  }
}
