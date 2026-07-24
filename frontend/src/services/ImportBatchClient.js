/**
 * ImportBatchClient — Import Scale v1 批量导入 API 客户端
 *
 * 职责：
 *   封装 POST /import/batch + GET /import/batch/{id}/events SSE 调用。
 *   不持有业务状态，不操作 React，不管理 ImportSessionStore。
 *
 * 生命周期：
 *   由 useFileOps 创建和销毁。
 *   EventSource 引用由 TaskRegistry 管理（通过 setTaskStream）。
 *
 * 与 TaskRegistry 的关系：
 *   TaskRegistry 持有 EventSource 引用，用于取消时关闭连接。
 *   本模块只负责创建 EventSource 并返回。
 *
 * 消费独立的 GET SSE 端点（/import/batch 生命周期）。
 *
 * @module services/ImportBatchClient
 */

import { BACKEND_URL } from '../config'

// P6-D: POST /import/batch 网络级超时（与用户取消 signal 合并）。
// POST 非幂等，仅超时中断、绝不重试（防重复创建 batch）。
const CREATE_TIMEOUT_MS = 30000

/**
 * @typedef {Object} BatchProgress
 * @property {string} taskId - 批次 ID
 * @property {string} status - 状态 (pending/running/completed/failed/cancelled)
 * @property {number} total - 总文件数
 * @property {number} current - 已完成数
 * @property {number} percent - 完成百分比
 * @property {number} successCount - 成功数
 * @property {number} failCount - 失败数
 * @property {string} [error] - 错误信息
 */

/**
 * @typedef {Object} CreateBatchResult
 * @property {boolean} success - 是否成功
 * @property {string} batchId - 批次 ID
 * @property {number} total - 文件总数
 * @property {string} [error] - 错误信息
 */

/**
 * 创建批量导入任务。
 *
 * @param {Array<{file: File, name: string, clientKey?: string}>} files - 文件列表
 * @param {Object} options - 选项
 * @param {boolean} [options.autoOrient=true] - 是否自动旋转
 * @param {boolean} [options.enableAutoOcr=false] - 是否启用自动 OCR
 * @param {AbortSignal} [options.signal] - 取消信号
 * @returns {Promise<CreateBatchResult>}
 */
export async function createImportBatch(files, options = {}) {
  const { autoOrient = true, enableAutoOcr = false, signal } = options

  const formData = new FormData()
  for (const { file, name, clientKey } of files) {
    // 使用原始文件名，后端通过 filename 识别
    formData.append('files', file, name)
    // 护栏A：clientKey 可选，后端按索引与 files 对齐
    formData.append('clientKeys', clientKey || '')
  }
  formData.append('autoOrient', autoOrient ? '1' : '0')
  formData.append('enableAutoOcr', enableAutoOcr ? '1' : '0')

  // P6-D: 网络级 timeout 与用户取消 signal 合并。AbortSignal.any 不可用时退回
  // signal（保留用户取消能力，旧浏览器牺牲 timeout——POST 语义下用户取消优先）。
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), CREATE_TIMEOUT_MS)
  const combinedSignal =
    signal && AbortSignal.any
      ? AbortSignal.any([signal, timeoutController.signal])
      : signal || timeoutController.signal

  try {
    const resp = await fetch(`${BACKEND_URL}/import/batch`, {
      method: 'POST',
      body: formData,
      signal: combinedSignal,
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`创建批量导入失败: HTTP ${resp.status} ${text}`)
    }

    const data = await resp.json()
    if (!data.success) {
      throw new Error(data.error || '创建批量导入失败')
    }

    return {
      success: true,
      batchId: data.batchId,
      total: data.total,
    }
  } catch (err) {
    // 用户取消：保持原生 AbortError 透传（cancel flow 不变）
    // 网络超时：包装可读信息，但绝不标 _retryable / 不重试（防重复 batch）
    if (err.name === 'AbortError' && !signal?.aborted) {
      err.message = '创建导入批次超时，请检查网络连接'
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 监听批量导入进度（SSE）。
 *
 * @param {string} batchId - 批次 ID
 * @param {Object} callbacks - 回调函数
 * @param {(progress: BatchProgress) => void} callbacks.onProgress - 进度回调
 * @param {(progress: BatchProgress) => void} callbacks.onComplete - 完成回调
 * @param {(error: Error) => void} callbacks.onError - 错误回调
 * @returns {EventSource} SSE 连接（用于取消）
 */
export function subscribeBatchProgress(batchId, callbacks) {
  const { onProgress, onComplete, onError } = callbacks

  const url = `${BACKEND_URL}/import/batch/${batchId}/events`
  const eventSource = new EventSource(url)

  eventSource.onmessage = (event) => {
    try {
      const progress = JSON.parse(event.data)

      // 调用进度回调
      if (onProgress) {
        onProgress(progress)
      }

      // 检查终态
      if (['completed', 'failed', 'cancelled'].includes(progress.status)) {
        // 先关闭 SSE 释放连接槽，再调 onComplete（hydration fetch 需要连接）
        console.log('[ImportBatchClient] SSE 终态，关闭 EventSource')
        eventSource.close()
        if (onComplete) {
          onComplete(progress)
        }
      }
    } catch (err) {
      console.error('[ImportBatchClient] SSE 解析错误:', err)
    }
  }

  eventSource.onerror = (err) => {
    console.error('[ImportBatchClient] SSE 连接错误:', err)
    if (onError) {
      onError(new Error('SSE 连接失败'))
    }
    eventSource.close()
  }

  return eventSource
}

/**
 * 取消批量导入任务。
 *
 * @param {string} batchId - 批次 ID
 * @param {AbortSignal} [signal] - 取消信号
 * @returns {Promise<boolean>} 是否成功取消
 */
export async function cancelImportBatch(batchId, signal) {
  try {
    const resp = await fetch(`${BACKEND_URL}/import/batch/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId }),
      signal,
    })

    if (!resp.ok) {
      // 404 = 批次不存在或已完成，视为取消成功（幂等）
      if (resp.status === 404) {
        return true
      }
      return false
    }

    const data = await resp.json()
    return data.success === true
  } catch (err) {
    console.error('[ImportBatchClient] 取消批次失败:', err)
    return false
  }
}

/**
 * 获取批量导入的解析结果（用于完成后 hydration）。
 *
 * 调用时机：SSE onComplete 后，一次性拉取所有成功 job 的字段数据。
 * 返回的每项包含 clientKey（前端文件匹配键）和完整发票字段。
 *
 * @param {string} batchId - 批次 ID
 * @param {AbortSignal} [signal] - 取消信号
 * @returns {Promise<Array<Object>>} 结果列表（每项含 clientKey, invoiceType, invoiceNumber 等）
 */
export async function getBatchResults(batchId, signal) {
  // 走 Vite 代理（相对路径），避免与 SSE/preview 争用 localhost:5000 的连接池
  const url = `/import/batch/${batchId}/results`
  console.log('[ImportBatchClient] getBatchResults fetch START, url=', url)

  const doFetch = async (timeoutMs, label) => {
    const tc = new AbortController()
    const timer = setTimeout(() => tc.abort(), timeoutMs)
    const combinedSignal = signal
      ? (AbortSignal.any ? AbortSignal.any([signal, tc.signal]) : tc.signal)
      : tc.signal
    try {
      const resp = await fetch(url, { signal: combinedSignal })
      clearTimeout(timer)
      console.log(`[ImportBatchClient] getBatchResults ${label} DONE, status=`, resp.status)
      if (!resp.ok) {
        throw new Error(`获取批次结果失败: HTTP ${resp.status}`)
      }
      const data = await resp.json()
      if (!data.success) {
        throw new Error(data.error || '获取批次结果失败')
      }
      return data.items || []
    } catch (err) {
      clearTimeout(timer)
      if (err.name === 'AbortError' && !signal?.aborted) {
        err._retryable = true
        err.message = `获取批次结果超时 (${timeoutMs}ms)`
      }
      throw err
    }
  }

  // 第一次尝试：3s
  try {
    return await doFetch(3000, 'try1')
  } catch (err) {
    if (!err._retryable) throw err
    console.warn('[ImportBatchClient] getBatchResults try1 超时，300ms 后重试')
  }

  await new Promise(r => setTimeout(r, 300))

  // 第二次尝试：5s
  try {
    return await doFetch(5000, 'try2')
  } catch (err) {
    if (err._retryable) {
      throw new Error('获取批次结果失败：连接被占用，请刷新页面重试')
    }
    throw err
  }
}
