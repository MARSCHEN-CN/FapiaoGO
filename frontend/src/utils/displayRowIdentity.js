/**
 * displayRowIdentity — Display Row 身份契约（Decision Layer，纯函数）
 *
 * 依据：Display Row Identity Contract（用户冻结 2026-08-23）
 *
 * 背景（运行时铁证 E-store）：
 *   注册侧复合键 instanceId::invoiceDocumentId 在 DocumentStore 中正确存在，
 *   但 Display 行（displayFiles/previewFile）缺 instanceId/invoiceDocumentId，
 *   storeDocId 静默退化到裸 file.key → 与注册键永不匹配 → storeDocument=null →
 *   DocumentViewer 永久 Loading。
 *
 * 冻结契约：
 *   1. 任何已进入 DocumentStore 注册并需要由 DocumentViewer 消费的行，
 *      必须携带 canonical store identity（= 注册时的复合键）。
 *   2. Display 查找键必须与注册键严格相等（Registration Key === Lookup Key）。
 *   3. 禁止在 Display 消费侧用字符串 includes() 反查 / 模糊猜测身份。
 *   4. 缺 identity 时不得静默 fallback 到裸 file.key —— 必须是可见的
 *      contract violation（D5），由行构建链修复，而非消费侧兜底。
 *
 * 本模块只做两件事：
 *   - resolveDisplayStoreDocumentId(row)：从行上取 canonical store identity
 *     （修复后 DisplayAdapter 的唯一身份来源）
 *   - assertRowIdentityComplete(row)：D5 契约判定（缺身份 → violation）
 *
 * @module utils/displayRowIdentity
 */

/**
 * 从 Display 行解析 canonical store identity（DisplayAdapter 唯一身份来源）。
 *
 * 优先级（冻结）：
 *   1. row.storeDocumentId          —— 显式透传的 canonical store key（修复目标形态）
 *   2. instanceId + invoiceDocumentId 同时存在 → `${instanceId}::${invoiceDocumentId}`
 *   3. invoiceDocumentId            —— 单值业务键（旧路径兼容）
 *   4. instanceId                   —— 单值实例键（旧路径兼容）
 *
 * 明确禁止：
 *   - 裸 docId（物理身份 ≠ 业务 store 键）
 *   - 裸 file.key（实例 key ≠ store 键）
 *   - includes() 反查 / 模糊匹配
 *
 * @param {Object|null} row - displayFiles 行对象
 * @returns {string|null} canonical store identity；无法解析时返回 null
 */
export function resolveDisplayStoreDocumentId(row) {
  if (!row) return null
  if (typeof row === 'string') return row || null

  // 1. 显式透传的 canonical store key（修复目标形态，最高优先级）
  if (row.storeDocumentId) return row.storeDocumentId

  const { instanceId, invoiceDocumentId } = row
  // 2. 复合键
  if (instanceId && invoiceDocumentId) {
    return `${instanceId}::${invoiceDocumentId}`
  }
  // 3. 单值业务键 / 实例键
  if (invoiceDocumentId) return invoiceDocumentId
  if (instanceId) return instanceId
  // 4. 无法解析 → null（contract violation，由调用方决定如何处理）
  return null
}

/**
 * D5 契约判定：行身份是否完整。
 *
 * 缺 identity（返回 null 且无任何业务身份字段）时，这是一个可见的
 * contract violation —— 禁止 Display 消费侧用裸 file.key 静默兜底。
 *
 * @param {Object|null} row
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function assertRowIdentityComplete(row) {
  if (!row) return { ok: false, reason: 'row-null' }
  const id = resolveDisplayStoreDocumentId(row)
  if (id) return { ok: true, reason: null }
  // 兜底判断：是否至少还有一个可被静默 fallback 的伪身份（裸 key / 裸 docId）
  const hasFakeFallback = !!(row.key || row.docId)
  return {
    ok: false,
    reason: hasFakeFallback
      ? 'identity-missing-but-fake-fallback-available'
      : 'identity-missing-no-fallback',
  }
}
