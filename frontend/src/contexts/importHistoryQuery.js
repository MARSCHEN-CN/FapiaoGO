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
