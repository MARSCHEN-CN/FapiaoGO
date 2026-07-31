/**
 * instancePageOwnership — assembled 文档的页面归属解析（IS-4.2 Step 4.3）
 *
 * 职责（单一）：
 *   给定「按 invoiceNumber 匹配到的候选文件」与「后端组装结果」，
 *   返回真正属于该 assembled 文档的页面文件集合（Page Ownership）。
 *
 * 为什么按 instanceId 而非 sourceDocId：
 *   同内容 A.pdf/B.pdf 共享 sourceDocId（内容哈希），按它过滤会让 A、B 互相吸收对方的页；
 *   instanceId（文件实例身份，前端 producer 生成、assembly 透传）更严格——
 *   A/B 实例不同 → 各自只收自己的页；多页 PDF 的所有拆分页共享同一 instanceId → 正确聚合。
 *
 * 边界（冻结）：
 *   instanceId 只管 Page Ownership；InvoiceDocument Identity 仍由调用方的 invDocId
 *   （实例 × 发票）承担。一个文件实例可产出多张发票（多票 PDF），DocumentStore 键不能用裸 instanceId。
 *
 * 纪律：
 *   纯函数——零 I/O、零副作用。告警由调用方根据返回的 fallback 标志发出（便于 Node 单测）。
 *
 * @module utils/instancePageOwnership
 */

/**
 * legacy 同源过滤（instanceId 缺失/失配时的兜底口径，与 Step 4.3 前行为一致）。
 *
 * @param {Object[]} matchingFiles
 * @param {string} [targetSourceDocId]
 * @returns {Object[]}
 */
function legacySameSource(matchingFiles, targetSourceDocId) {
  return targetSourceDocId
    ? matchingFiles.filter((f) => (f.sourceDocId || f.docId) === targetSourceDocId)
    : matchingFiles
}

/**
 * 解析 assembled 文档的页面归属文件。
 *
 * @param {Object[]} matchingFiles - 按 invoiceNumber 匹配到的候选文件（来自 readyFiles 全局池）
 * @param {{instanceId?: string, sourceDocId?: string}} assembled - 后端组装结果
 * @returns {{files: Object[], fallback: 'none'|'instance-mismatch'|'missing-instanceId'}}
 *   files：归属页面文件；fallback：是否/为何回退到 sourceDocId（供调用方决定是否告警）。
 *     - 'none'：按 instanceId 命中（正常路径）
 *     - 'instance-mismatch'：instanceId 存在但匹配不到任何 fileObj.instanceId（异常态，回退）
 *     - 'missing-instanceId'：assembled 缺 instanceId（legacy，回退）
 */
export function resolveInstancePageFiles(matchingFiles, assembled) {
  const pool = Array.isArray(matchingFiles) ? matchingFiles : []
  const targetInstanceId = assembled?.instanceId
  const targetSourceDocId = assembled?.sourceDocId

  if (targetInstanceId) {
    const byInstance = pool.filter((f) => f.instanceId === targetInstanceId)
    if (byInstance.length > 0) return { files: byInstance, fallback: 'none' }
    // instanceId 存在但匹配不到 → 回退 sourceDocId（调用方告警）
    return { files: legacySameSource(pool, targetSourceDocId), fallback: 'instance-mismatch' }
  }

  // instanceId 缺失 → legacy sourceDocId 过滤（调用方告警）
  return { files: legacySameSource(pool, targetSourceDocId), fallback: 'missing-instanceId' }
}
