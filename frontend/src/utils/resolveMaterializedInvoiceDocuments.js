/**
 * resolveMaterializedInvoiceDocuments — Persistent Document View Source（Decision Layer）
 *
 * 依据：INV-S1 / Candidate 1-R（用户冻结 2026-08-23）
 *
 * 背景（Step S1 静态地图 + INV-S1 Red Test）：
 *   FileContext 的 invoiceDocs 直接 = session.documents。session 被 TTL 回收（60s）后
 *   invoiceDocs=null → documentView 降级裸行 → Display 空白（files 仍在，身份丢失）。
 *   根因：ImportSession（临时）承载了 Display 持久展示所需的 canonical identity。
 *
 * 冻结契约（Candidate 1-R：Persistent Document View Source）：
 *   1. 当前 files 决定展示 membership（哪些文件显示）——唯一 truth。
 *   2. 已注册的 canonical InvoiceDocument（DocumentStore，registerDocument 持久化）
 *      提供 display identity。
 *   3. ImportSession.documents 仅服务导入过程中的过渡态（session 存在时优先）。
 *   4. session cleanup 后，已 materialize 的文件必须仍命中同一个 canonical document。
 *   5. 禁止字符串 includes() 反查 / 裸 key 猜测（D5）。
 *
 * @module utils/resolveMaterializedInvoiceDocuments
 */

/**
 * 从三个来源解析当前展示应使用的 InvoiceDocument[]。
 *
 * 优先级（冻结）：
 *   1. sessionDocuments（导入过渡态，session 存在且有文档时优先——最新装配结果）
 *   2. registeredDocuments（已 materialize 到 DocumentStore 的 canonical docs，
 *      按当前 files membership 过滤——session cleanup 后的持久身份源）
 *   3. 都没有 → null（降级裸行）
 *
 * membership 判定（S5 关键：files 是唯一 truth，DocumentStore 不能 resurrect 已删文件）：
 *   一个 registered doc 属于当前展示集合，当且仅当它至少覆盖一个当前 files 的成员：
 *     - doc._pageKeys 含 file.key（强身份，assembly 精确记录）
 *     - doc.fileKey === file.key（代表页 key）
 *     - doc.sourceDocId === file.docId（弱身份，回退）
 *   已删除文件（不在 files 中）→ 不被任何 doc 覆盖 → 不 resurrect。
 *
 * @param {Object[]|null} files - 当前 page-level files（FileContext 持久 state）
 * @param {Object[]|null} sessionDocuments - ImportSession.documents（可为 null）
 * @param {Object[]|null} registeredDocuments - DocumentStore 全部已注册 InvoiceDocument[]
 * @returns {Object[]|null} 应注入 view model 的 InvoiceDocument[]；无则 null
 */
export function resolveMaterializedInvoiceDocuments(files, sessionDocuments, registeredDocuments) {
  // 1. 导入过渡态：session 存在且有文档 → 优先使用（最新装配结果）
  if (Array.isArray(sessionDocuments) && sessionDocuments.length > 0) {
    return sessionDocuments
  }

  // 2. 持久身份源：从 DocumentStore 已注册文档中，按当前 files membership 过滤。
  //    files 是展示 membership 唯一 truth（S5）：已删除文件不在 files → 不被任何 doc 覆盖 → 不 resurrect。
  if (!Array.isArray(files) || files.length === 0) return null
  if (!Array.isArray(registeredDocuments) || registeredDocuments.length === 0) return null

  // 预构建当前 files 的身份索引（O(n)）
  const fileKeys = new Set()
  for (const f of files) {
    if (!f) continue
    if (f.key) fileKeys.add(f.key)
  }

  // membership 判定（结构字段匹配，非字符串猜测）：
  //   - _pageKeys 含 file.key（assembly 精确记录，强身份，首选）
  //   - fileKey === file.key（代表页 key）
  //   不使用 sourceDocId 独立命中：同内容不同实例共享 sourceDocId（A/B 两份同发票），
  //   用它命中会 resurrect 已删除的同内容文件（S5 锁死）。assembly 路径总是设置
  //   _pageKeys（useFileOps），弱身份场景由 fileKey 覆盖。
  const matched = []
  for (const doc of registeredDocuments) {
    if (!doc) continue
    const pageKeys = Array.isArray(doc._pageKeys) ? doc._pageKeys : []
    const hitsPageKey = pageKeys.some((k) => fileKeys.has(k))
    const hitsFileKey = !!(doc.fileKey && fileKeys.has(doc.fileKey))
    if (hitsPageKey || hitsFileKey) {
      matched.push(doc)
    }
  }
  return matched.length > 0 ? matched : null
}
