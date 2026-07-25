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
import { updateFileStatus, addResult, addDocument } from '../stores/ImportSessionStore'
import { ensureDocumentFromFileObj, getDocument } from '../stores/DocumentStore'

/**
 * 消费单个解析结果。
 *
 * @param {Object} result - ParseResult
 * @param {Object} fileObj - 原始文件对象（用于更新状态）
 * @param {string} sessionId - 会话 ID
 * @param {Object[]} [siblings] - 同批文件数组（多页聚合：共享 docId 的分页 fileObj）
 * @returns {Object} UI 更新数据（可传入 queueUpdate）
 */
export function consumeParseResult(result, fileObj, sessionId, siblings = null) {
  const update = mapParseResultToFileUpdate(result, fileObj)

  // 写入 Store
  updateFileStatus(sessionId, fileObj.key, { ...update, status: result.status })
  addResult(sessionId, { fileKey: fileObj.key, result })

  // ── Display Area Refactor：Document 注册 ──
  // 当 parse 产出 docId 时���确保 DocumentStore 有对应的 InvoiceDocument。
  // Step 10.5：传入 siblings 后，共享 docId 的拆分页聚合为多页 Document；
  // 未传时退化为单页构建。OCR/ParseResult 合并仍属 Coordinator 职责。
  console.log('[E1] consumeParseResult: docId from result:', result?.doc_id, 'raw doc_id:', result?.raw?.doc_id, 'update.docId:', update.docId)
  if (update.docId) {
    ensureDocumentFromFileObj({ ...fileObj, docId: update.docId, identity: update.identity }, siblings)
    // Phase E-1：双写模式 — 将 DocumentStore 的 InvoiceDocument 同步到
    // ImportSessionStore.documents[]，为前端从 file 模型迁移到 document 模型铺路。
    // 当前 UI 仍从 files[] 消费，documents[] 仅建立并存状态。
    const doc = getDocument(update.docId)
    if (doc && sessionId) {
      addDocument(sessionId, doc)
    }
  }

  return update
}
