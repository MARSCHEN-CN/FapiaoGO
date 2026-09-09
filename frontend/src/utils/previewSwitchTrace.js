/**
 * Preview Switch Trace —— Phase 2「真机端到端分层测量」只读探针。
 *
 * 目的：回答「后端 Render MISS=0 时，Warm A 为什么还慢」。
 * 把一次切换拆成可测量的阶段：
 *
 *   T0 用户选择（App 层埋点 markUserSelect）
 *    ↓  React 状态传播
 *   T1 ViewerViewport 收到新 previewUrl（effect）
 *    ↓  <img src> 生效
 *   T2 资源请求开始        ← PerformanceResourceTiming.startTime
 *   T3 响应可用            ← PerformanceResourceTiming.responseEnd
 *    ↓
 *   T4 img onload
 *    ↓
 *   T5 decode 完成         ← img.decode() 解算
 *    ↓
 *   T6 真正可见（dimensions known → 下一帧 paint）
 *
 * 关键：同时给出本次请求**到底走的是哪条缓存路径** —— memory/disk cache、
 * 304 revalidate、还是完整 200。这直接决定下一步优化方向，是本探针的核心价值。
 *
 * 纪律（与 previewTrace / perfExperimentFlags 一致）：
 *   • 默认 OFF —— 合并后零行为变化、零 console 输出；
 *   • localStorage 实时求值 —— 无需重启应用即可开关；
 *   • 只记录，不改任何渲染/加载逻辑。
 *
 * 开启（DevTools Console，单行）：
 *   localStorage.setItem('fapiao.perf.switchTrace','1')
 *   __fapiaoSwitchTrace.dump()      // 输出分层耗时表
 *   __fapiaoSwitchTrace.reset()     // 清空（换测量轮次时先 reset）
 *
 * @module utils/previewSwitchTrace
 */

const FLAG = 'fapiao.perf.switchTrace'
const MAX_ROWS = 300

const state = {
  seq: 0,
  rows: [],
  lastUserSelect: null,
}

function enabled() {
  try {
    const v = window.localStorage.getItem(FLAG)
    return v === '1' || v === 'true'
  } catch (_e) {
    return false
  }
}

function now() {
  try {
    return performance.now()
  } catch (_e) {
    return Date.now()
  }
}

/**
 * ⚠️ 已知陷阱：Chrome 的 resource timing buffer **默认只有 250 条**。
 * vite dev 模式下每个 ES module 都是一个独立请求，几百个模块瞬间把 buffer 打满，
 * 之后产生的 /preview/ 条目**根本不会被记录** ——
 * 首轮真机数据里 cache 列 100% 是 unknown(no-resource-timing)，就是这个原因。
 *
 * 对策两条：
 *   1. 扩容 resource timing buffer（仅在探针开启时执行，关闭时零影响）；
 *   2. PerformanceObserver 在条目产生的瞬间就拷到自己的 Map —— 即使
 *      performance buffer 之后被清空，我们仍持有数据。
 */
const RT_BUFFER_SIZE = 5000

/** @type {Map<string, Object>} url -> 资源时序快照（自持，不依赖 performance buffer） */
const rtIndex = new Map()
let observerStarted = false

function snapshotEntry(e) {
  const transferSize = e.transferSize || 0
  const encodedBodySize = e.encodedBodySize || 0
  const decodedBodySize = e.decodedBodySize || 0
  const responseStatus = typeof e.responseStatus === 'number' ? e.responseStatus : 0
  return {
    startTime: Number((e.startTime || 0).toFixed(1)),
    responseEnd: Number((e.responseEnd || 0).toFixed(1)),
    duration: Number((e.duration || 0).toFixed(1)),
    transferSize,
    encodedBodySize,
    decodedBodySize,
    responseStatus,
    // 跨域且无 TAO 时：status=0 且三个 size 全为 0（真实请求不可能全 0）
    noTao: responseStatus === 0 && transferSize === 0 && decodedBodySize === 0,
  }
}

function startObserver() {
  if (observerStarted) return
  observerStarted = true
  try {
    if (typeof performance.setResourceTimingBufferSize === 'function') {
      performance.setResourceTimingBufferSize(RT_BUFFER_SIZE)
    }
  } catch (_e) { /* noop */ }
  try {
    if (typeof PerformanceObserver === 'undefined') return
    const po = new PerformanceObserver((list) => {
      try {
        const entries = list.getEntries ? list.getEntries() : []
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i]
          if (!e || typeof e.name !== 'string') continue
          if (e.name.indexOf('/preview/') < 0) continue
          rtIndex.set(e.name, snapshotEntry(e))
          if (rtIndex.size > 600) {
            // 粗粒度裁剪：丢掉最早写入的一批（Map 保持插入序）
            const it = rtIndex.keys()
            for (let k = 0; k < 200; k++) {
              const n = it.next()
              if (n.done) break
              rtIndex.delete(n.value)
            }
          }
        }
      } catch (_e) { /* noop */ }
    })
    po.observe({ type: 'resource', buffered: true })
  } catch (_e) { /* noop */ }
}

/**
 * 采集该 URL 最近一次资源加载的 PerformanceResourceTiming。
 *
 * ⚠️ 跨域资源（前端 origin ≠ 后端 origin）若后端未返回 `Timing-Allow-Origin`，
 *    Chrome 只会暴露 startTime/responseEnd/duration，
 *    transferSize/encodedBodySize/decodedBodySize/responseStatus 全部为 0
 *    ——此时**无法**判定缓存路径，必须标注 no-TAO 而不是猜。
 *
 * @param {string} url
 * @returns {Object|null}
 */
function collectResourceTiming(url) {
  try {
    // ① 优先用自持快照（不受 performance buffer 被清空影响）
    const hit = rtIndex.get(url)
    if (hit) return hit
    // ② 兜底：直接查 performance timeline
    const list = performance.getEntriesByName(url, 'resource')
    if (!list || list.length === 0) return null
    return snapshotEntry(list[list.length - 1])
  } catch (_e) {
    return null
  }
}

/**
 * 判定本次请求走的缓存路径。这是 Phase 2 最关键的产出。
 * @param {Object|null} rt
 * @returns {string}
 */
function classifyCache(rt) {
  if (!rt) return 'unknown(no-resource-timing)'
  if (rt.noTao) return 'NO-TAO(需后端 Timing-Allow-Origin)'
  if (rt.responseStatus === 304) return '304-revalidate'
  if (rt.transferSize === 0 && rt.decodedBodySize > 0) {
    // 无网络传输但拿到了解码后体积 ⇒ 命中本地缓存。
    // memory vs disk 无法从 API 精确区分，用 duration 给一个 hint（不可当结论）。
    return rt.duration < 3 ? 'cache(likely-memory)' : 'cache(likely-disk)'
  }
  if (rt.transferSize > 0 && rt.responseStatus === 200) return 'network-200'
  if (rt.transferSize > 0) return `network-${rt.responseStatus}`
  return 'other'
}

function shortUrl(u) {
  if (typeof u !== 'string') return '-'
  const i = u.indexOf('/preview/')
  if (i < 0) return u.slice(-28)
  return u.slice(i + 9, i + 34)
}

/**
 * T0：用户点击/选择新发票（由 App 层调用）。
 * 与 T1 的差值 = React 事件处理 + 状态传播 + 重渲染耗时。
 * @param {string} [label]
 */
export function markUserSelect(label) {
  if (!enabled()) return
  state.lastUserSelect = { t: now(), label: label || '' }
}

/**
 * T1：ViewerViewport 收到新的 previewUrl（effect 内调用）。
 * @param {string|null} url
 * @param {{docId?: string, pageIndex?: number, warm?: boolean}} [meta]
 * @returns {Object|null} token —— 传给 markLoaded / markVisible
 */
export function beginSwitch(url, meta = {}) {
  if (!enabled()) return null
  // 首次启用时启动 observer（之后产生的 /preview/ 条目才能被捕获）
  if (!observerStarted) startObserver()
  const row = {
    seq: ++state.seq,
    url: shortUrl(url),
    rawUrl: url,
    docId: meta.docId || '',
    pageIndex: meta.pageIndex ?? null,
    t0: state.lastUserSelect ? state.lastUserSelect.t : null,
    t1: now(),
    t4: null,
    t5: null,
    t6: null,
    natural: null,
    rt: null,
    cache: null,
    done: false,
  }
  state.lastUserSelect = null
  state.rows.push(row)
  if (state.rows.length > MAX_ROWS) state.rows.shift()
  return row
}

/**
 * T4/T5：img onload。同时采集资源时序并异步测 decode。
 * @param {Object|null} token - beginSwitch 返回值
 * @param {HTMLImageElement|null} img
 */
export function markLoaded(token, img) {
  if (!enabled() || !token || token.done) return
  token.t4 = now()
  if (img) {
    token.natural = `${img.naturalWidth || 0}x${img.naturalHeight || 0}`
    token.rt = collectResourceTiming(img.currentSrc || img.src)
    token.cache = classifyCache(token.rt)
    // decode 完成时刻：decoding="async" 时 onload 可能早于解码完成。
    if (typeof img.decode === 'function') {
      img.decode().then(() => {
        if (token.t5 == null) token.t5 = now()
      }).catch(() => {})
    } else {
      token.t5 = token.t4
    }
  }
  // resource timing 可能在 onload 之后才落定，补采一次
  setTimeout(() => {
    if (!token.rt && token.rawUrl) {
      token.rt = collectResourceTiming(token.rawUrl)
      token.cache = classifyCache(token.rt)
    }
  }, 0)
}

/**
 * T6：图片真正可见（dimensions known 后的下一帧）。
 * @param {Object|null} token
 */
export function markVisible(token) {
  if (!enabled() || !token || token.done) return
  token.t6 = now()
  // img.decode() 是异步的，可能晚于本帧才 resolve；此时 t5 还是 null，
  // 会在 dump 里表现为 T4→T5 缺失 / T5→T6 负值。以 load 时刻兜底。
  if (token.t5 == null) token.t5 = token.t4
  token.done = true
  finish(token)
}

function finish(row) {
  // decode 的 promise 可能在本帧之后才落定，导致 t5 晚于 t6、出现负值。
  // 这只是「decode 与可见实际同帧完成」的观测假象，clamp 成 0 以免误读。
  if (row.t5 != null && row.t6 != null && row.t5 > row.t6) row.t5 = row.t6
  const ms = (a, b) => (a != null && b != null ? Number((b - a).toFixed(1)) : null)
  const summary = {
    '#': row.seq,
    url: row.url,
    'T0→T1 状态传播': ms(row.t0, row.t1),
    'T1→T4 加载': ms(row.t1, row.t4),
    'T4→T5 decode': ms(row.t4, row.t5),
    'T5→T6 可见': ms(row.t5, row.t6),
    'T0→T6 总计': ms(row.t0, row.t6),
    'T1→T6 总计': ms(row.t1, row.t6),
    cache: row.cache,
    status: row.rt ? row.rt.responseStatus : '-',
    transfer: row.rt ? row.rt.transferSize : '-',
    decoded: row.rt ? row.rt.decodedBodySize : '-',
    natural: row.natural,
  }
  // 单行摘要，便于跟随切换顺序观察；完整表用 dump()
  try {
    console.debug('[switchTrace]', summary)
  } catch (_e) { /* noop */ }
}

/**
 * 输出完整分层表（console.table）。
 * @returns {Object[]}
 */
export function dump() {
  const rows = state.rows.map((r) => {
    const ms = (a, b) => (a != null && b != null ? Number((b - a).toFixed(1)) : null)
    return {
      '#': r.seq,
      url: r.url,
      docId: r.docId ? String(r.docId).slice(0, 10) : '',
      page: r.pageIndex,
      'T0→T1': ms(r.t0, r.t1),
      'T1→T4 加载': ms(r.t1, r.t4),
      'T4→T5 decode': ms(r.t4, r.t5),
      'T5→T6 可见': ms(r.t5, r.t6),
      'T1→T6': ms(r.t1, r.t6),
      cache: r.cache,
      status: r.rt ? r.rt.responseStatus : '-',
      transferB: r.rt ? r.rt.transferSize : '-',
      decodedB: r.rt ? r.rt.decodedBodySize : '-',
      natural: r.natural,
    }
  })
  // 自检行：buffer 是否被 vite dev 的模块请求打满 / 自持快照是否采到 —— 直接决定 cache 列可信度
  try {
    const total = typeof performance.getEntriesByType === 'function'
      ? performance.getEntriesByType('resource').length : -1
    console.debug(
      `[switchTrace] 自检: performance.resource=${total} 自持快照=${rtIndex.size} ` +
      `observer=${observerStarted}（resource 接近 ${RT_BUFFER_SIZE} 或快照=0 ⇒ cache 列不可信）`
    )
  } catch (_e) { /* noop */ }
  try {
    console.table(rows)
  } catch (_e) { /* noop */ }
  return rows
}

/** 清空记录（换测量轮次前调用）。 */
export function reset() {
  state.seq = 0
  state.rows = []
  state.lastUserSelect = null
}

/** 导出原始记录（便于粘贴取证）。 */
export function raw() {
  return JSON.parse(JSON.stringify(state.rows))
}

// 挂载到 window 便于 DevTools 调用（挂载本身零开销、零副作用）
try {
  window.__fapiaoSwitchTrace = { dump, reset, raw, enabled }
} catch (_e) { /* noop */ }

// 开关在刷新/重启后仍然保留在 localStorage ⇒ 模块加载阶段就扩容 + 挂 observer，
// 保证应用启动期发出的 /preview/ 请求也能被捕获。开关关闭时这里什么都不做。
try {
  if (enabled()) startObserver()
} catch (_e) { /* noop */ }
