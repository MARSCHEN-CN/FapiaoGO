// P2-L1：import-history 查询目标构建 + 去重守卫（纯函数，可单测）
//
// ── 为什么独立成模块 ──────────────────────────────────────────
// 原逻辑内联在 FileContext.jsx 的 [files] effect 里，「是否重查」被绑在
// React effect 生命周期上（cleanup 无条件清空 firedSigRef），导致：
//   查询结果发布 → useSort 置顶重排 → setFiles（新引用）→ effect cleanup
//   → 守卫签名被清空 → 同一批号码再查一轮
// 这是状态/生命周期正确性问题，不是性能问题。
//
// 本模块把判定基准改为唯一正确的一个：**归一化发票号码集合是否变化**。
// effect 生命周期不再参与「是否重查」的判定。
//
// ── 契约（与 FileContext 2026-09-07 前版本逐字节等价的部分）────
//   - 归一化规则与后端 import_history.normalize_invoice_number 一致：
//     trim → 折叠内部空白 → uppercase；空值返回 null
//   - 只收 status === 'parsed' 且带 invoiceNumber 的文件
//   - 同号多 fileKey 聚合为数组（多页发票广播语义）
//   - sig = 归一化号集合排序后以 '|' 连接（顺序无关 → 纯排序不改变它）

/** 发票号码归一化（与后端 import_history.normalize_invoice_number 对齐） */
export function normalizeInvoiceNumber(raw) {
  if (raw == null) return null
  const s = String(raw).trim().replace(/\s+/g, '').toUpperCase()
  return s || null
}

/**
 * 从 files 构建查询目标。
 * @param {Array<{key: string, status?: string, invoiceNumber?: string}>} files
 * @returns {{ byNumber: Map<string, string[]>, sig: string }}
 *   byNumber: 归一化号 → fileKey[]（同号多页聚合）
 *   sig     : 顺序无关的集合签名；空集合为 ''
 */
export function buildQueryTargets(files) {
  const byNumber = new Map()
  if (!Array.isArray(files)) return { byNumber, sig: '' }
  for (const file of files) {
    if (!file) continue
    if (file.status !== 'parsed' || !file.invoiceNumber) continue
    const norm = normalizeInvoiceNumber(file.invoiceNumber)
    if (!norm) continue
    const keys = byNumber.get(norm)
    if (keys) keys.push(file.key)
    else byNumber.set(norm, [file.key])
  }
  const sig = byNumber.size
    ? Array.from(byNumber.keys()).sort().join('|')
    : ''
  return { byNumber, sig }
}

/**
 * 从批量响应构建本轮全部 entry（P2-L2）。
 *
 * 冻结语义（与旧「逐号 GET 逐条 enqueue」逐条等价）：
 *   - 未命中（null / exists !== true）→ 跳过
 *   - importCount < 2 → 跳过：首次导入的历史记录由本次导入创建（count 含本次），
 *     只有 count>=2 才说明本次之前已导入过（= 重复报销）
 *   - 同号 fileKeys 原样保留 → flush 时广播写入同一 value 引用
 *
 * @param {Map<string, string[]>} byNumber buildQueryTargets 的输出
 * @param {Object} results 后端批量响应：{ 归一化号: rec | null }
 * @returns {Array<{fileKeys: string[], value: object}>}
 */
export function buildHistoryEntries(byNumber, results) {
  const entries = []
  if (!byNumber || byNumber.size === 0) return entries
  for (const [norm, fileKeys] of byNumber) {
    const rec = results ? results[norm] : null
    if (!rec || rec.exists !== true) continue
    if ((rec.importCount ?? 0) < 2) continue
    entries.push({
      fileKeys,
      value: {
        exists: true,
        invoiceDate: rec.invoiceDate,
        firstImportedAt: rec.firstImportedAt,
        importCount: rec.importCount,
        dateMismatchCount: rec.dateMismatchCount,
      },
    })
  }
  return entries
}

/**
 * 去重守卫：是否应发起新一轮查询。
 *
 * 语义（P2-L1 冻结）：「同一个归一化号码集合，只允许触发一次检测」。
 * 只在号码集合真正变化（新增 / 删除 / 号码字段就绪）时返回 true；
 * 纯排序、纯字段更新、以及查询结果自身发布导致的引用变化，一律 false。
 *
 * 注：首轮（lastSig 为空串且 sig 非空）返回 true —— 空集合 sig 也是 ''，
 * 由调用方在无查询目标时提前 return，不会走到这里。
 *
 * @param {string} lastSig 上次已发起查询的签名
 * @param {string} sig     本轮构建的签名
 */
export function shouldFireQuery(lastSig, sig) {
  return lastSig !== sig
}
