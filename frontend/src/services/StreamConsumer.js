/**
 * StreamConsumer v1 — SSE 事件流消费
 *
 * 职责：
 *   消费后端 SSE 事件流，将原始流数据解析为结构化事件。
 *   不持有业务状态，不操作 React 状态，不拥有生命周期。
 *
 * 生命周期由 TaskRegistry 管理（通过 AbortSignal 实现取消）。
 *
 * 输入：
 *   - URL（后端端点）
 *   - FormData（POST 请求体）
 *   - options.signal（TaskRegistry 提供的 AbortSignal）
 *   - options.onProgress（进度回调，由 ProgressStore / BatchUIUpdater 处理）
 *
 * 输出：
 *   返回解析完成的 batchResult（包含所有文件的解析结果）。
 *
 * 这是 Import State Model v2 (docs/architecture/import-state-model-v2.md)
 * 定义的 StreamConsumer 实现。Phase 1b-2。
 *
 * @module services/StreamConsumer
 */

/**
 * @typedef {Object} SSEMessage
 * @property {Object} [items] - 最终结果（所有文件解析完成）
 * @property {number} [current] - 当前进度（progress 事件）
 * @property {number} [total] - 总数（progress 事件）
 * @property {boolean} [success] - 是否成功（仅在 items 事件中）
 * @property {string} [error] - 错误消息（仅在失败时）
 */

/**
 * @typedef {Object} ConsumeOptions
 * @property {AbortSignal} [signal] - 取消信号（来自 TaskRegistry）
 * @property {(msg: {current: number, total: number}) => void} [onProgress] - 进度回调
 */

/**
 * 消费 SSE 事件流，返回解析结果。
 *
 * @param {string} url - 后端端点 URL
 * @param {FormData} formData - POST 请求体
 * @param {ConsumeOptions} [options] - 选项
 * @returns {Promise<SSEMessage>} 解析完成后的 batchResult
 * @throws {Error} HTTP 错误或解析失败
 */
export async function consumeBatchStream(url, formData, options = {}) {
  const { signal, onProgress } = options

  // 发起 fetch（AbortSignal 由 TaskRegistry 管理）
  const res = await fetch(url, {
    method: 'POST',
    body: formData,
    signal,
  })

  if (!res.ok) {
    throw new Error(`批量解析失败: HTTP ${res.status}`)
  }

  // 消费 SSE 流
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let batchResult = null

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

        if (msg.items) {
          // 最终结果
          batchResult = msg
        } else if (msg.current !== undefined && onProgress) {
          // 进度事件 — 纯遥测
          onProgress(msg)
        }
      } catch (_) {
        // 忽略解析错误
      }
    }
  }

  if (!batchResult || !batchResult.success) {
    throw new Error(batchResult?.error || '批量解析失败')
  }

  return batchResult
}
