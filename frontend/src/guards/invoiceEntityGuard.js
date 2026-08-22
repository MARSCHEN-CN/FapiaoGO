/**
 * invoiceEntityGuard — InvoiceDocument 生命周期约束
 *
 * Invoice Entity Boundary Contract §三：
 *   本模块将 Step 1 建立的规则编码为运行时约束。
 *   所有对 InvoiceDocument 的注册/patch/seal/delete 操作必须经过 guard 检查。
 *
 * 生命周期枚举：
 *   CREATED    — 对象已创建，尚未注册到 Store
 *   REGISTERED — 已注册到 ImportSessionStore.documents[]
 *   SEALED     — 终态，禁止结构变更
 *   DELETED    — 已从 Store 移除（软删除标记）
 *
 * @module guards/invoiceEntityGuard
 */

// ═══════════════════════════════════════════════════════════
// 生命周期枚举
// ═══════════════════════════════════════════════════════════

/** @enum {string} */
export const Lifecycle = {
  CREATED: 'CREATED',
  REGISTERED: 'REGISTERED',
  SEALED: 'SEALED',
  DELETED: 'DELETED',
}

/** 允许 patch 更新的字段白名单（Invoice Entity Boundary Contract §二） */
const ALLOWED_PATCH_FIELDS = new Set([
  'amount', 'invoiceDate', 'invoiceType',
  'buyerName', 'sellerName', 'status',
  'parseMethod', 'lifecycle', '_source',
])

/** 禁止 patch 修改的字段（身份/结构字段） */
const FORBIDDEN_PATCH_FIELDS = new Set([
  'docId', 'instanceId', 'invoiceDocumentId',
  'id', 'invoiceNumber', 'pages', 'pageCount',
  '_source', '_pageKeys', 'sourceDocId', 'fileKey',
])

// ═══════════════════════════════════════════════════════════
// Guard 断言
// ═══════════════════════════════════════════════════════════

/**
 * 断言文档可以被注册到 Store。
 *
 * 允许条件：
 *   - 文档不存在（isNew）
 *   - lifecycle 为 CREATED 或 REGISTERED（尚未 SEALED）
 *   - pages.length >= 1
 *
 * 禁止：
 *   - SEALED / DELETED 状态
 *   - 空 pages
 *
 * @param {Object} doc - 要注册的 InvoiceDocument
 * @param {Object|null} existing - 同 instanceKey 的已有文档（null = 新文档）
 * @throws {Error} 检查不通过
 */
export function assertCanRegisterDocument(doc, existing = null) {
  if (existing) {
    if (existing.lifecycle === Lifecycle.SEALED) {
      const key = existing.instanceId && existing.invoiceDocumentId
        ? `${existing.instanceId}::${existing.invoiceDocumentId}`
        : (existing.instanceId || existing.docId || existing.id || '?')
      throw new Error(`[invoiceEntityGuard] 拒绝注册：文档已 SEALED (instanceKey=${key})`)
    }
    if (existing.lifecycle === Lifecycle.DELETED) {
      throw new Error(`[invoiceEntityGuard] 拒绝注册：文档已 DELETED`)
    }
    throw new Error(`[invoiceEntityGuard] 拒绝注册：文档已存在 lifecycle=${existing.lifecycle}`)
  }
  if (!doc.pages || doc.pages.length === 0) {
    throw new Error('[invoiceEntityGuard] 拒绝注册：pages 为空')
  }
}

/**
 * 断言文档可以被 patch。
 *
 * 允许条件：
 *   - lifecycle 不是 DELETED
 *   - patch 字段全在白名单内，不在禁止名单内
 *
 * 禁止：
 *   - patch 含身份字段（docId/instanceId/invoiceNumber/pages 等）
 *
 * @param {Object} doc - 被 patch 的文档
 * @param {Object} patch - 要合并的字段
 * @throws {Error} 检查不通过
 */
export function assertCanPatchDocument(doc, patch) {
  if (!doc) throw new Error('[invoiceEntityGuard] 拒绝 patch：文档不存在')
  if (doc.lifecycle === Lifecycle.DELETED) {
    throw new Error('[invoiceEntityGuard] 拒绝 patch：文档已 DELETED')
  }
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_PATCH_FIELDS.has(key)) {
      throw new Error(`[invoiceEntityGuard] 拒绝 patch：禁止修改字段 "${key}"（身份/结构字段不可变）`)
    }
    if (!ALLOWED_PATCH_FIELDS.has(key)) {
      throw new Error(`[invoiceEntityGuard] 拒绝 patch：字段 "${key}" 不在白名单内`)
    }
  }
}

/**
 * 断言文档可以被 seal。
 *
 * 允许条件：
 *   - lifecycle 为 REGISTERED（只有已注册文档才能 seal）
 *   - pages.length >= 1
 *   - 有有效实例身份（instanceId + invoiceDocumentId 必须同时存在）
 *
 * 禁止：
 *   - 已是 SEALED / DELETED
 *   - 空 pages
 *   - 无有效实例身份
 *
 * @param {Object} doc
 * @throws {Error} 检查不通过
 */
export function assertCanSealDocument(doc) {
  if (!doc) throw new Error('[invoiceEntityGuard] 拒绝 seal：文档不存在')
  if (doc.lifecycle === Lifecycle.SEALED) {
    throw new Error('[invoiceEntityGuard] 拒绝 seal：文档已是 SEALED')
  }
  if (doc.lifecycle === Lifecycle.DELETED) {
    throw new Error('[invoiceEntityGuard] 拒绝 seal：文档已 DELETED')
  }
  if (doc.lifecycle !== Lifecycle.REGISTERED) {
    throw new Error(`[invoiceEntityGuard] 拒绝 seal：当前 lifecycle=${doc.lifecycle}，需要 REGISTERED`)
  }
  if (!doc.pages || doc.pages.length === 0) {
    throw new Error('[invoiceEntityGuard] 拒绝 seal：pages 为空')
  }
  // Contract C 修复：instanceId + invoiceDocumentId 必须同时存在
  if (!doc.instanceId || !doc.invoiceDocumentId) {
    throw new Error(
      `[invoiceEntityGuard] 拒绝 seal：实例身份不完整 ` +
      `(instanceId=${doc.instanceId || '?'}, invoiceDocumentId=${doc.invoiceDocumentId || '?'})`
    )
  }
}

/**
 * 断言文档可以被删除。
 *
 * 允许：所有非 DELETED 状态
 * 禁止：已是 DELETED
 *
 * @param {Object} doc
 * @throws {Error} 检查不通过
 */
export function assertCanDeleteDocument(doc) {
  if (!doc) throw new Error('[invoiceEntityGuard] 拒绝删除：文档不存在')
  if (doc.lifecycle === Lifecycle.DELETED) {
    throw new Error('[invoiceEntityGuard] 拒绝删除：文档已是 DELETED')
  }
}

/**
 * 断言两个文档属于同一发票实体。
 *
 * 用于检查 merge 操作（禁止）。
 *
 * @param {Object} docA
 * @param {Object} docB
 * @throws {Error} 检查不通过（merge 始终被禁止）
 */
export function assertSameInvoiceIdentity(docA, docB) {
  // Invoice Entity Boundary Contract §二：禁止 merge registered documents
  throw new Error(
    `[invoiceEntityGuard] 拒绝合并：已注册的 InvoiceDocument 不可合并 ` +
    `(docA=${docA?.docId || '?'}, docB=${docB?.docId || '?'})`
  )
}

/**
 * 简单的生命周期合法性检查（不抛异常，返回 boolean）。
 * 用于 hydrate 等大循环中快速过滤。
 *
 * @param {Object} doc
 * @param {string} targetLifecycle - 目标生命周期
 * @returns {boolean}
 */
export function canTransitionTo(doc, targetLifecycle) {
  if (!doc) return false
  const current = doc.lifecycle || ''
  // 合法转换表
  const transitions = {
    '': [Lifecycle.CREATED],
    [Lifecycle.CREATED]: [Lifecycle.REGISTERED],
    [Lifecycle.REGISTERED]: [Lifecycle.SEALED, Lifecycle.DELETED],
    [Lifecycle.SEALED]: [Lifecycle.DELETED],
    [Lifecycle.DELETED]: [], // 终态，无合法转换
  }
  const allowed = transitions[current] || []
  return allowed.includes(targetLifecycle)
}
