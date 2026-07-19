/**
 * parseResultConsumer — 解析结果消费器
 *
 * 职责：
 *   接收 ParseResult，将其写入 ImportSessionStore 并生成 UI 更新。
 *   不发起请求，不管理 SSE，不操作 React。
 *
 * 消费流程：
 *   ParseResult
 *       ↓
 *   parseResultMapper.mapParseResultToFileUpdate()
 *       ↓
 *   ImportSessionStore.updateFileStatus()
 *       ↓
 *   queueUpdate() (由调用方执行)
 *
 * @module consumers/parseResultConsumer
 */

import { mapParseResultToFileUpdate } from '../mappers/parseResultMapper'
import { updateFileStatus, addResult } from '../stores/ImportSessionStore'

/**
 * 消费单个解析结果。
 *
 * @param {Object} result - ParseResult
 * @param {Object} fileObj - 原始文件对象（用于更新状态）
 * @param {string} sessionId - 会话 ID
 * @returns {Object} UI 更新数据（可传入 queueUpdate）
 */
export function consumeParseResult(result, fileObj, sessionId) {
  const update = mapParseResultToFileUpdate(result, fileObj)

  // 写入 Store
  updateFileStatus(sessionId, fileObj.key, { ...update, status: result.status })
  addResult(sessionId, { fileKey: fileObj.key, result })

  return update
}
