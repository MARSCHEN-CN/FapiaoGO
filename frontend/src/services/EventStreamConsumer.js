/**
 * EventStreamConsumer — EventSource SSE 流消费（PDF 导出专用）。
 *
 * 职责：
 *   消费后端 EventSource 事件流，将原始 event.data 解析为结构化消息。
 *   不持有业务状态，不操作 React 状态，不拥有生命周期。
 *
 * 与 StreamConsumer.js 的边界：
 *   - StreamConsumer：fetch + ReadableStream reader（POST body，Import 批量解析用）
 *   - EventStreamConsumer：EventSource（GET，PDF 导出 SSE 用）
 *   两个协议完全不同，刻意隔离，不共享代码，避免 Import 边界污染。
 *
 * 终态关闭策略：
 *   EventStreamConsumer 不感知业务终态（completed/cancelled/failed）。
 *   caller 在 onMessage 中判定终态后调用传入的 close() 函数。
 *   这让本模块保持纯协议层，业务逻辑由 ExportService 处理。
 *
 * @module services/EventStreamConsumer
 */

/**
 * @typedef {Object} EventStreamHandlers
 * @property {(msg: object, close: () => void) => void} [onMessage] - 消息回调
 * @property {() => void} [onError] - 连接中断回调（仅在非主动关闭时触发）
 */

/**
 * 消费 EventSource SSE 流。
 *
 * @param {string} url - SSE 端点 URL（含 taskId）
 * @param {EventStreamHandlers} [handlers]
 * @returns {() => void} close 函数（关闭 EventSource，幂等）
 *
 * @example
 * const close = consumeEventStream(`${BACKEND_URL}/api/export-pdf/events/${taskId}`, {
 *   onMessage: (msg, close) => {
 *     handleSseMessage(msg)
 *     if (['completed', 'cancelled', 'failed'].includes(msg.status)) {
 *       close()  // 终态 → 主动关闭
 *     }
 *   },
 *   onError: () => {
 *     // 连接中断（非主动关闭），标记失败
 *   },
 * })
 */
export function consumeEventStream(url, { onMessage, onError } = {}) {
  const es = new EventSource(url)
  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    es.close()
  }

  es.onmessage = (event) => {
    if (closed) return
    try {
      const msg = JSON.parse(event.data)
      onMessage?.(msg, close)
    } catch (_) {
      // 跳过无法解析的数据（心跳、部分包等）
    }
  }

  es.onerror = () => {
    // 主动 close 后 EventSource 可能仍触发 onerror（浏览器实现差异），
    // closed flag 防止重复处理。
    if (closed) return
    close()
    onError?.()
  }

  return close
}
