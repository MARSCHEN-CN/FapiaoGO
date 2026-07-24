/**
 * ParseBatchClient — 批量解析请求构造与提交
 *
 * 职责：
 *   - 解析文件输入，构建 FormData
 *   - 返回 { url, formData } 供调用方通过 fetch 提交
 *
 * 不负责：
 *   ❌ SSE 流消费（由调用方负责）
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
 * 单文件解析请求构造（用于 fallback 路径）。
 * @param {{ file?: File, printPath?: string, path?: string, name: string }} fileObj
 * @param {{ ipc: object, autoOrient: boolean }} options
 * @returns {Promise<{ url: string, formData: FormData }>}
 */
export async function prepareSingleRequest(fileObj, { ipc, autoOrient }) {
  let file = fileObj.file
  if (!file && (fileObj.printPath || fileObj.path) && ipc) {
    console.log('[DIAG] prepareSingleRequest no native file, reading via IPC:', fileObj.name, 'path:', fileObj.printPath || fileObj.path)
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
