/**
 * documentViewSignature — S7 取证用 documentView 只读内容签名（Decision Layer，纯函数）
 *
 * 依据：2026-08-23 Step S7（End-to-End Identity Equality Audit）
 *
 * 目的（唯一用途：探针配对）：
 *   [S7][materializedDocs]（FileContext）与 [S7][display]（DisplayAdapter）必须证明
 *   来自同一渲染轮次，否则可能把 FileContext render N/N+1 与 DisplayAdapter render N
 *   误拼成「同一时刻六项证据」。viewSig 就是两条日志的 correlation 标识：
 *
 *     - 同一份 materializedDocs（canonical identity 集合）→ 同一 viewSig（跨组件、跨 render 稳定）
 *     - 不同身份集合 → 不同 viewSig
 *     - null / 空 → 'none'
 *
 * 配对规则（用户冻结）：只有 viewSig 相同的两条日志才允许组成一次证据。
 *
 * 签名原料复用 getDocumentCacheIdentity（canonical → fallback stable → docId，
 * 已有 D6-D8 测试契约），与 documentView 缓存签名（computeDocsSig）同算法，保证
 * 「materializedDocs 内容签名」与业务侧对身份的理解完全一致。
 *
 * ⚠️ 本模块仅供 S7 取证，不参与任何业务逻辑；禁止被业务路径 import。
 *
 * @module utils/documentViewSignature
 */

import { getDocumentCacheIdentity } from './documentViewCacheIdentity.js'

/**
 * 计算 materializedDocs 的内容签名（viewSig）。
 *
 * @param {Object[]|null} docs - materialized InvoiceDocument 列表（null/undefined/空数组 → 'none'）
 * @returns {string} viewSig（'none' 表示无文档可配对）
 */
export function getDocumentViewSignature(docs) {
  if (!Array.isArray(docs) || docs.length === 0) return 'none'
  return docs.map(getDocumentCacheIdentity).sort().join('‖')
}
