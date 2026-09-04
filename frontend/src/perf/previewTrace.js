/**
 * previewTrace — PERF-WHITE-1 · R2 Preview Runtime Probe
 *
 * ════════════════════════════════════════════════════════════════
 * 目的（R2：Runtime Preview Evidence Audit）
 * ────────────────────────────────────────────────────────────────
 * 只回答 4 个事实问题，不修任何逻辑：
 *   R2-1  自动预览到底调用了多少次？每次的 intent / key / docId / version / 来源
 *   R2-2  每次为什么被取消？（START / DEBOUNCED / SUPERSEDED / ABORTED / ...）
 *   R2-3  loadFilePreview 实际返回了什么？（空壳快照是否被 commit）
 *   R2-4  失败后有没有重试机会？
 *
 * ════════════════════════════════════════════════════════════════
 * 🔴 硬约束（改本文件前必读）
 * ────────────────────────────────────────────────────────────────
 * 1. **本模块永不被业务代码消费做决策**——它只写日志与环形缓冲，
 *    任何调用点都必须是 `if (previewTrace.on) previewTrace.log(...)`，
 *    不得出现 `const x = previewTrace.log(...)` 之类参与控制流的写法。
 * 2. **默认关闭**。未开启时 `log()` / `state()` 首行 return，
 *    不建对象、不取栈、不碰 console——热路径零开销。
 * 3. **不得引入定时器**（setTimeout / setInterval / rAF）。
 *    本审计本身就在查「导入完成后谁还在后台跑」，探针不能再加一个。
 * 4. 本模块是纯 ESM、零依赖，必须能被 `node --test` 直接 import。
 *
 * ════════════════════════════════════════════════════════════════
 * 用法（DevTools，单行）
 * ────────────────────────────────────────────────────────────────
 *   __PREVIEW_TRACE__.enable(); __PREVIEW_TRACE__.reset()
 *   // …复现（导入 / 点击）…
 *   copy(__PREVIEW_TRACE__.dump())          // 剪贴板
 *   __PREVIEW_TRACE__.report().counters     // 只看计数
 *
 * 跨刷新开启（需在 app 启动前写入）：
 *   localStorage.setItem('FAPIAOGO_PREVIEW_TRACE', '1')
 *
 * @module perf/previewTrace
 */

const STORAGE_KEY = 'FAPIAOGO_PREVIEW_TRACE'
const GLOBAL_FLAG = '__FAPIAOGO_PREVIEW_TRACE__'

/** 环形缓冲上限：防止长会话无限增长（超出丢弃最旧，计入 dropped） */
const MAX_EVENTS = 4000

/** 识别本模块自身栈帧（供 callerOf 剔除）：perf/previewTrace.js 的任意构建形态 */
const SELF_FRAME_RE = /perf[\\/]previewTrace\.(?:js|mjs|cjs|ts)/

let enabled = false
let started = false
let t0 = 0
let seq = 0
let dropped = 0
let events = []
const counters = Object.create(null)

function clock() {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now()
    }
  } catch (_) { /* 无 performance（node 老版本）→ 回落 Date */ }
  return Date.now()
}

function readEnvironmentFlag() {
  try {
    if (globalThis[GLOBAL_FLAG] === true) return true
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(STORAGE_KEY)
    return raw === '1' || raw === 'true' || raw === 'verbose'
  } catch (_) {
    return false
  }
}

/**
 * 快照内容就绪度（R2-3 的核心判据）。
 * 「空壳」定义：key 有值，但 _previewImageUrl / _pdfData / previewImage 全空。
 *
 * @param {*} obj loadFilePreview 的返回值
 * @returns {{hasPreviewImageUrl: boolean, hasPdfData: boolean, hasPreviewImage: boolean}}
 */
export function snapshotFlags(obj) {
  return {
    hasPreviewImageUrl: !!(obj && obj._previewImageUrl),
    hasPdfData: !!(obj && obj._pdfData),
    hasPreviewImage: !!(obj && obj.previewImage),
  }
}

/**
 * 三处 docId 约定的统一读取（避免各探针点各写一套导致口径不一致）。
 * identity.docId 优先（4.1.3 注入），回落 docId；空串归一为 null。
 *
 * @param {*} obj
 * @returns {string|null}
 */
export function docIdOf(obj) {
  if (!obj) return null
  const d = obj.docId != null ? obj.docId : (obj.identity && obj.identity.docId)
  if (d == null || d === '') return null
  return d
}

/**
 * 把 V8 栈帧归一为「函数名@目录/文件:行:列」。
 *
 * 例：
 *   'handlePreview (http://localhost:5173/src/hooks/usePreview.js:2008:11)'
 *     → 'handlePreview@hooks/usePreview.js:2008:11'
 *   'http://localhost:5173/src/App.jsx:994:7'
 *     → 'App.jsx:994:7'
 *
 * @param {string} raw
 * @returns {string}
 */
export function parseFrame(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^at\s+/, '')
  if (!s) return 'unknown'

  let fn = ''
  let loc = s
  const paren = /^(.*?)\s*\((.*)\)$/.exec(s)
  if (paren) {
    fn = paren[1].trim()
    loc = paren[2].trim()
  }

  let path = loc
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(loc)) {
    const idx = loc.indexOf('/', loc.indexOf('//') + 2)
    path = idx >= 0 ? loc.slice(idx) : loc
  }
  path = path.split('?')[0]

  const segs = path.split('/').filter(Boolean)
  const tail = segs.length > 1 ? segs.slice(-2).join('/') : (segs[0] || loc)
  const shortFn = fn ? fn.split('.').slice(-1)[0] : ''
  return shortFn ? `${shortFn}@${tail}` : tail
}

/**
 * 从栈里挑出「真正来源」帧。
 *
 * skip 语义（跳过几个**非本模块**帧）：
 *   skip=0 → log() 的直接调用者（handlePreview 自身）
 *   skip=1 → 它的调用者（App.jsx:994 / FileList 点击 / effect 行）
 *
 * previewTrace 自身帧一律剔除，所以调用点不需要关心嵌套层数。
 *
 * @param {string} stack  new Error().stack
 * @param {number} [skip=0]
 * @returns {string}
 */
/**
 * 取最靠前的 n 个非本模块帧，组成调用链。
 *
 * 为什么需要「链」而不是单帧：⚠️ **V8 会把小函数内联并抹掉它的栈帧**
 * （实测：JIT 预热后，三级嵌套小函数全部消失，栈里只剩 node 内部帧）。
 * 单帧归因在极端情况下会指到完全无关的位置，让证据说谎。
 * 存一条链可以在事后核对「skip=N 到底落在谁身上」。
 *
 * @param {string} stack
 * @param {number} [n=3]
 * @returns {string[]}
 */
export function callerFrames(stack, n = 3) {
  if (!stack) return []
  const lines = String(stack).split('\n')
  const frames = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith('at ')) continue
    if (SELF_FRAME_RE.test(line)) continue
    frames.push(parseFrame(line))
    if (frames.length >= n) break
  }
  return frames
}

export function callerOf(stack, skip = 0) {
  if (!stack) return 'unknown'
  const lines = String(stack).split('\n')
  const frames = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith('at ')) continue
    if (line.includes('previewTrace')) continue
    frames.push(parseFrame(line))
    if (frames.length >= 8) break
  }
  if (!frames.length) return 'unknown'
  const idx = skip < 0 ? 0 : (skip > frames.length - 1 ? frames.length - 1 : skip)
  return frames[idx]
}

function emit(type, fields, caller) {
  const ev = {
    seq: ++seq,
    t: Math.round((clock() - t0) * 100) / 100,
    type,
    caller,
    fields: fields || {},
  }
  events.push(ev)
  if (events.length > MAX_EVENTS) {
    events.shift()
    dropped += 1
  }
  counters[type] = (counters[type] || 0) + 1
  try {
    // fields 以对象形式打印（DevTools 可展开），不 JSON.stringify：
    // 快照对象含 File/Blob 时 stringify 会抛，观测点不该因取数而崩。
    console.log('[P2-PREVIEW]', `${ev.t}ms`, type, ev.caller, ev.fields)
  } catch (_) { /* 观测失败不得影响业务 */ }
  return ev
}

/**
 * 记录一次事件（带栈归因）。未开启时直接返回 null。
 *
 * @param {string} type    事件类型，见文件头事件表
 * @param {object} fields  结构化字段
 * @param {{skip?: number, stack?: string}} [opts]
 *        skip  跳过的非本模块帧数（0=直接调用者，1=调用者的调用者）
 *        stack 外部传入的栈（用于跨 await 归因），缺省内部取
 * @returns {object|null}
 */
export function previewTraceLog(type, fields, opts) {
  if (!enabled) return null
  const stack = (opts && opts.stack) || (new Error().stack)
  return emit(type, fields, callerOf(stack, (opts && opts.skip) || 0))
}

/**
 * 记录一次无栈事件（effect / React 内部回调等栈无意义的位置）。
 *
 * @param {string} type
 * @param {object} fields
 * @param {string} [callerTag] 人工标注来源（如 'usePreview:2129-docId-retry'）
 * @returns {object|null}
 */
export function previewTraceState(type, fields, callerTag) {
  if (!enabled) return null
  return emit(type, fields, callerTag || 'explicit')
}

/** 清空缓冲与计数（每次复现前调用，保证时间轴从 0 起算） */
export function previewTraceReset() {
  seq = 0
  dropped = 0
  events = []
  for (const k of Object.keys(counters)) delete counters[k]
  t0 = clock()
  started = enabled
}

/**
 * 开关。首次开启时把 t0 定在此刻（时间轴相对开启瞬间）。
 *
 * @param {boolean} v
 * @returns {boolean}
 */
export function previewTraceSetEnabled(v) {
  enabled = !!v
  if (enabled && !started) {
    started = true
    t0 = clock()
  }
  return enabled
}

/**
 * 读数。返回结构：
 * { enabled, eventCount, dropped, counters: {TYPE: n}, events: [{seq,t,type,caller,fields}] }
 *
 * @returns {object}
 */
export function previewTraceReport() {
  return {
    enabled,
    eventCount: events.length,
    dropped,
    counters: { ...counters },
    events: events.slice(),
  }
}

export const previewTrace = {
  get on() { return enabled },
  get events() { return events },
  get dropped() { return dropped },
  log: previewTraceLog,
  state: previewTraceState,
  flags: snapshotFlags,
  docId: docIdOf,
  enable: () => previewTraceSetEnabled(true),
  disable: () => previewTraceSetEnabled(false),
  reset: previewTraceReset,
  report: previewTraceReport,
  dump: () => {
    try {
      return JSON.stringify(previewTraceReport(), null, 2)
    } catch (_) {
      return '{"error":"serialize failed"}'
    }
  },
}

// ── 初始化：读环境开关，并挂到 window 供 DevTools 调用 ──
enabled = readEnvironmentFlag()
if (enabled) {
  started = true
  t0 = clock()
}
try {
  if (typeof globalThis !== 'undefined') {
    globalThis.__PREVIEW_TRACE__ = previewTrace
  }
} catch (_) { /* 无 globalThis（理论不可能）→ 仅失去 DevTools 入口 */ }

export default previewTrace
