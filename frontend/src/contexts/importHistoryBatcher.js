// PERF-WHITE-1 / P1-A：importHistory publication batching
//
// 目标：把「每条 importHistory 响应 → 立即发布一个新的 React Map state」
//      （454 条响应 = 454 次 Map 全量重建 + 454 次 Context value identity 变化）
//      改为「响应先合并进 pending → 短 debounce 单 flush → 至多一次发布」。
//
// 冻结契约（P1-A 只允许改 WHEN state updates are published，不改 WHAT）：
//   - 查询次数 / 查询结果 / 广播语义 / 最终 UI 数据 完全不变
//   - applyHistoryEntry 与 FileContext 原 updater（2026-09-03 版 :266-281）逐字节同构：
//     整表重建 + 只保留 liveKeys 存活 key + 同号 fileKeys 广播写入同一 value 引用
//   - 唯一新增行为：内容无实际变化时返回 prev（React bail out / noop），
//     切断「热路径重复查询 → 无意义 publication」的 churn。
//
// 为什么用 debounce 而不用 requestIdleCallback：白屏期主线程长期繁忙，
// idle callback 可能长时间拿不到执行机会反而延迟发布；setTimeout 短 debounce
// 在主线程繁忙时会被自然推迟 → 越忙合并越多，publication 越少（用户拍板）。
//
// liveKeys 收敛：工厂持「最新存活 key 集合」（FileContext 每次 files effect 同步），
// flush 时统一用最新 liveKeys 过滤 —— 避免「删除竞态」下用旧快照把已删文件写回。

// 值与既有历史值逐一比较（null/undefined 归一，避免无谓 churn）
export function historyValueEquals(a, b) {
  if (!a || !b) return false
  const f = (x) => (x === undefined || x === null ? null : x)
  return (
    f(a.invoiceDate) === f(b.invoiceDate) &&
    f(a.firstImportedAt) === f(b.firstImportedAt) &&
    a.importCount === b.importCount &&
    f(a.dateMismatchCount) === f(b.dateMismatchCount)
  )
}

// 单条响应应用。与 FileContext 原 updater 同构：
//   1) new Map + 只保留 liveKeys 存活 key（剔除已移除文件的残留）
//   2) 同号 fileKeys 逐个写入同一 value 引用（广播）
// 差异：内容无变化 → 返回 prev（原 updater 恒返回新 Map）。
// @param {Map} prev 当前已发布的历史 Map
// @param {{fileKeys: string[], value: object}} entry 一条响应的广播内容
// @param {Set<string>} liveKeys 发布时最新存活 file.key 集合
export function applyHistoryEntry(prev, entry, liveKeys) {
  const { fileKeys, value } = entry
  const next = new Map()
  let changed = false
  for (const [k, v] of prev) {
    if (liveKeys.has(k)) next.set(k, v)
    else changed = true                    // 剔除非存活残留
  }
  for (const k of fileKeys) {
    if (!liveKeys.has(k)) continue         // 死 key 不写
    const old = next.get(k)
    if (!changed && !(old && historyValueEquals(old, value))) changed = true
    next.set(k, value)
  }
  return changed ? next : prev
}

/**
 * publication batching 工厂。
 * @param {object} opts
 * @param {number} [opts.debounceMs=50] flush 去抖窗
 * @param {(map: Map) => void} opts.publish 发布回调（FileContext: setImportHistoryInfo(next)）。
 *   next === 上次已发布引用时由 React 自行 bail out；工厂保证内容无变化时不调用 publish。
 * @param {() => void} [opts.onPublish] 真实发布计数（perfProbe: importHistoryPublish）
 * @param {() => void} [opts.onNoop]   内容无变化放弃发布计数（perfProbe: importHistoryNoop）
 * @param {Map} [opts.initial] 初始 Map（与 React useState 对齐）
 */
export function createImportHistoryBatcher({ debounceMs = 50, publish, onPublish, onNoop, initial = new Map() } = {}) {
  if (typeof publish !== 'function') throw new Error('importHistoryBatcher: publish 必填')
  let current = initial            // 工厂自持 ground truth（唯一写者；publish 即同步给 React）
  let pending = []                 // [{ fileKeys, value }, ...]
  let timer = null
  let liveKeys = new Set()         // 最新存活 key 集合（FileContext files effect 同步）
  let disposed = false

  function setLiveKeys(keys) {
    liveKeys = keys instanceof Set ? keys : new Set(keys)
  }

  function flush() {
    if (disposed || pending.length === 0) return
    const batch = pending
    pending = []
    let cur = current
    for (const entry of batch) {
      cur = applyHistoryEntry(cur, entry, liveKeys)
    }
    if (cur === current) {         // 整批无实际变化 → 不发布（React state 零更新）
      onNoop?.()
      return
    }
    current = cur
    onPublish?.()
    publish(current)
  }

  function schedule() {
    if (timer !== null || disposed) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, debounceMs)
  }

  // 一条响应命中（importCount>=2）：合入 pending + 排程单 flush
  function enqueue(entry) {
    if (disposed) return
    if (!entry || !Array.isArray(entry.fileKeys) || entry.fileKeys.length === 0) return
    pending.push({ fileKeys: entry.fileKeys, value: entry.value })
    schedule()
  }

  // files 变化时的主动剔除（FileContext :218/:238 语义收敛到一处）：
  // 只保留 liveKeys 存活 key；无剔除 → 不发布。
  function prune(keys) {
    if (disposed) return
    const ls = keys instanceof Set ? keys : new Set(keys)
    let changed = false
    const next = new Map()
    for (const [k, v] of current) {
      if (ls.has(k)) next.set(k, v)
      else changed = true
    }
    if (!changed) return
    current = next
    onPublish?.()
    publish(current)
  }

  function dispose() {
    disposed = true
    if (timer !== null) { clearTimeout(timer); timer = null }
    pending = []
    current = null
  }

  return { enqueue, prune, setLiveKeys, dispose, flush }
}
