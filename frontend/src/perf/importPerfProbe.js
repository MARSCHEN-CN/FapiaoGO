/**
 * importPerfProbe — PERF-WHITE-1 Baseline Evidence Gate 探针（Gate 0）
 *
 * ── 设计约束（冻结）────────────────────────────────────────────
 * 1. **只观测，不改行为**：本模块所有导出函数在关闭态必须是纯 no-op，
 *    不得改变任何业务分支、返回值或执行顺序。
 * 2. **默认关闭**。开启方式（renderer 内执行，然后刷新页面）：
 *      localStorage.setItem('FAPIAOGO_PERF_PROBE', '1')          // 采集 + 结束时一条 console.log
 *      localStorage.setItem('FAPIAOGO_PERF_PROBE', 'clipboard')  // 额外自动写入剪贴板（无 DevTools 环境取数）
 *    运行时切换：window.__perfProbe.enable('1') / .disable() / .dump()
 * 3. **唯一输出** = 会话结束时**一条** console.log（禁止在 per-file 路径打日志，
 *    否则探针本身变成被测热点 —— 见 Gate 0 "不增加 console" 纪律）。
 * 4. 报告同时写入内存与 localStorage，便于「DevTools 关闭跑测量 → 跑完开 DevTools 取数」。
 *
 * ── 时间线语义（T0–T7）─────────────────────────────────────────
 *   T0  导入开始（processFilesForAddition 入口）
 *   T1  split 完成（await Promise.all(splitWorkers)）
 *   T2  后端解析完成（进入 building 阶段前）
 *   T3  hydration 完成（末次 flushUpdates）
 *   T4  进度 100%（progressMonotonicRef = 100）
 *   T5  导入弹窗关闭（setImporting(false)）
 *   ── 白屏窗口 ──
 *   T6  FileList 首次 commit（useLayoutEffect，DOM 已变更、未 paint）
 *   T6p FileList 首次 paint（commit 后 rAF + setTimeout(0)）
 *   T7  预览首帧渲染完成（setPreviewCanvas(canvas)）
 *
 *   核心 KPI：WHITE_SCREEN = T6 - T5（弹窗关闭 → 列表首次 commit）
 *   辅助 KPI：PAINT_GAP   = T6p - T6（commit → 真正上屏）
 *            PREVIEW_LAG = T7 - T5
 *   注：T4 到达时会重置 T6/T6p/T7 —— 导入过程中占位符也会让 FileList commit，
 *       只有「100% 之后的首次 commit」才是白屏窗口的终点。
 *
 * @module perf/importPerfProbe
 */

const ENABLE_KEY = 'FAPIAOGO_PERF_PROBE'
const REPORT_KEY = 'FAPIAOGO_PERF_REPORT'
const MAX_LONG_TASKS = 300
const VALID_MODES = new Set(['1', 'clipboard'])

/** @type {'' | '1' | 'clipboard'} 空串 = 关闭态（所有导出函数退化为 no-op） */
let mode = ''
try {
  const v = globalThis.localStorage?.getItem(ENABLE_KEY)
  if (VALID_MODES.has(v)) mode = v
} catch {
  mode = ''
}

/** @type {null | Object} 当前采集会话 */
let session = null
/** @type {null | PerformanceObserver} */
let longTaskObserver = null
let sessionSeq = 0

const now = () => performance.now()
const r1 = (n) => Math.round(n * 10) / 10

function noop() {}

// ── 会话管理 ──────────────────────────────────────────────────

/**
 * 开始一次采集会话。若已有会话在途，先结算（不丢数据）。
 * @param {string} [label]
 */
export function startSession(label = '') {
  if (!mode) return
  if (session) finishSession('restart')
  session = {
    id: ++sessionSeq,
    label,
    meta: {},
    t0Wall: new Date().toISOString(),
    marks: Object.create(null),
    counters: Object.create(null),
    durations: Object.create(null),
    longTasks: [],
    finished: false,
    finishReason: '',
  }
  mark('T0')
  startLongTaskObserver()
}

/**
 * 补充会话元信息（如最终文件数）。
 * @param {Object} patch
 */
export function setMeta(patch) {
  if (!mode || !session) return
  Object.assign(session.meta, patch || {})
}

// ── 打点 ──────────────────────────────────────────────────────

/**
 * 记录时间线锚点。语义：**首次写入优先**（first-wins），
 * 同一锚点重复调用不覆盖 —— 保证 T6 是「100% 之后的首次 commit」。
 * @param {string} name T0|T1|T2|T3|T4|T5|T6|T6p|T7
 */
export function mark(name) {
  if (!mode || !session) return
  if (session.marks[name] !== undefined) return
  session.marks[name] = r1(now())
  // T4（进度 100%）= 白屏窗口起点，清除其后的可见性锚点
  if (name === 'T4') {
    delete session.marks.T6
    delete session.marks.T6p
    delete session.marks.T7
  }
}

/** 计数（累加）。用于统计 per-file 路径被触发的次数。 */
export function count(name, n = 1) {
  if (!mode || !session) return
  session.counters[name] = (session.counters[name] || 0) + n
}

/**
 * 开始一段计时，返回结束函数（关闭态返回 noop，调用方无需判空）。
 * @param {string} name
 * @returns {() => void}
 */
export function begin(name) {
  if (!mode || !session) return noop
  const t0 = now()
  let done = false
  return () => {
    if (done) return
    done = true
    const d = now() - t0
    const slot = session.durations[name] || (session.durations[name] = { n: 0, total: 0, max: 0 })
    slot.n += 1
    slot.total += d
    if (d > slot.max) slot.max = d
  }
}

/**
 * 包裹一个同步函数计时（纯函数包装，返回值透传）。
 * 用于 wrap 派生函数；关闭态直接原样调用，零开销。
 */
export function time(name, fn) {
  if (!mode || !session) return fn()
  const end = begin(name)
  try {
    return fn()
  } finally {
    end()
  }
}

// ── Long Task 观测 ────────────────────────────────────────────

function startLongTaskObserver() {
  if (longTaskObserver) {
    try { longTaskObserver.disconnect() } catch { /* 忽略 */ }
    longTaskObserver = null
  }
  if (typeof PerformanceObserver !== 'function') return
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      if (!session) return
      try {
        for (const e of list.getEntries()) {
          if (session.longTasks.length >= MAX_LONG_TASKS) return
          session.longTasks.push({ start: r1(e.startTime), dur: r1(e.duration) })
        }
      } catch { /* 忽略 */ }
    })
    longTaskObserver.observe({ entryTypes: ['longtask'] })
  } catch {
    longTaskObserver = null // 环境不支持 longtask → 该项缺失，其余指标仍有效
  }
}

// ── 报告 ──────────────────────────────────────────────────────

function buildReport(src) {
  const marks = src.marks
  const rel = Object.create(null)
  const base = marks.T0 ?? 0
  for (const k of Object.keys(marks)) rel[k] = r1(marks[k] - base)

  const gap = (a, b) => (marks[a] !== undefined && marks[b] !== undefined ? r1(marks[b] - marks[a]) : null)

  const derived = {
    splitMs: gap('T0', 'T1'),
    parseMs: gap('T1', 'T2'),
    hydrateMs: gap('T2', 'T3'),
    sealMs: gap('T3', 'T4'),
    dismissDelayMs: gap('T4', 'T5'),
    // ★ 核心 KPI
    whiteScreenMs: gap('T5', 'T6'),
    paintGapMs: gap('T6', 'T6p'),
    whiteToPaintMs: gap('T5', 'T6p'),
    previewLagMs: gap('T5', 'T7'),
    totalMs: gap('T0', 'T7') ?? gap('T0', 'T6p'),
  }

  const durations = {}
  for (const [k, v] of Object.entries(src.durations)) {
    durations[k] = { n: v.n, total: r1(v.total), max: r1(v.max), avg: r1(v.total / v.n) }
  }

  // Long Task：全窗口 + 白屏窗口（T4 → T6p，无 T6p 时退化为 T6）
  const lt = src.longTasks
  const totalMs = r1(lt.reduce((s, x) => s + x.dur, 0))
  const top = (arr, k) => arr.slice().sort((a, b) => b.dur - a.dur).slice(0, k).map((x) => ({ ...x }))
  const winStart = marks.T4
  const winEnd = marks.T6p ?? marks.T6 ?? (marks.T5 != null ? marks.T5 + 3000 : null)
  const inWin = winStart != null && winEnd != null
    ? lt.filter((x) => x.start >= winStart && x.start <= winEnd)
    : []
  const longTasks = {
    supported: lt.length > 0 || longTaskObserver !== null,
    count: lt.length,
    totalMs,
    top10: top(lt, 10),
    whiteWindow: {
      from: winStart ?? null,
      to: winEnd ?? null,
      count: inWin.length,
      totalMs: r1(inWin.reduce((s, x) => s + x.dur, 0)),
      top5: top(inWin, 5),
    },
  }

  return {
    id: src.id,
    label: src.label,
    meta: src.meta,
    t0Wall: src.t0Wall,
    finishReason: src.finishReason,
    marksRel: rel,
    derived,
    counters: { ...src.counters },
    durations,
    longTasks,
  }
}

/** 结算当前会话并输出报告（幂等：重复调用只重新输出，不重新计算）。 */
export function finishSession(reason = 'manual') {
  if (!mode || !session) return null
  if (!session.finished) {
    session.finished = true
    session.finishReason = reason
  }
  const report = buildReport(session)
  try {
    globalThis.localStorage?.setItem(REPORT_KEY, JSON.stringify(report))
  } catch { /* 存储不可用 → 仅内存保留 */ }

  if (mode === 'clipboard') {
    try {
      globalThis.navigator?.clipboard?.writeText(JSON.stringify(report, null, 2))
    } catch { /* 剪贴板不可用 → 忽略 */ }
  }
  // 唯一输出：一条 console.log
  console.log('[PERF_REPORT]', report)
  return report
}

/** 取最近一次报告（未结算则现场结算，不改状态）。 */
export function getReport() {
  if (!mode) return null
  if (!session) {
    try {
      const raw = globalThis.localStorage?.getItem(REPORT_KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }
  return buildReport(session)
}

/** 人类可读摘要（单行表格化文本，便于贴到 issue / 对比表）。 */
export function summaryText() {
  const r = getReport()
  if (!r) return '(perf probe disabled or no session)'
  const d = r.derived
  const lines = [
    `# PERF-WHITE-1 run#${r.id} ${r.label || ''} (${r.t0Wall})`,
    `fileCount=${r.meta.fileCount ?? '?'} finishReason=${r.finishReason}`,
    `T0→T1 split=${d.splitMs}  T1→T2 parse=${d.parseMs}  T2→T3 hydrate=${d.hydrateMs}  T3→T4 seal=${d.sealMs}`,
    `T4→T5 dismissDelay=${d.dismissDelayMs}`,
    `★ T5→T6 WHITE_SCREEN=${d.whiteScreenMs}  T6→T6p paintGap=${d.paintGapMs}  T5→T6p=${d.whiteToPaintMs}  T5→T7 preview=${d.previewLagMs}`,
    `longTasks n=${r.longTasks.count} busyMs=${r.longTasks.totalMs} | whiteWindow n=${r.longTasks.whiteWindow.count} busyMs=${r.longTasks.whiteWindow.totalMs}`,
    `counters ${JSON.stringify(r.counters)}`,
    `durations ${JSON.stringify(r.durations)}`,
  ]
  return lines.join('\n')
}

// ── 运行时开关 ────────────────────────────────────────────────

export function enable(nextMode = '1') {
  mode = VALID_MODES.has(nextMode) ? nextMode : '1'
  try { globalThis.localStorage?.setItem(ENABLE_KEY, mode) } catch { /* 忽略 */ }
  return mode
}

export function disable() {
  mode = ''
  if (longTaskObserver) {
    try { longTaskObserver.disconnect() } catch { /* 忽略 */ }
    longTaskObserver = null
  }
  session = null
  try { globalThis.localStorage?.removeItem(ENABLE_KEY) } catch { /* 忽略 */ }
}

export function isEnabled() {
  return mode !== ''
}

export function dump() {
  const r = getReport()
  console.log(summaryText())
  return r
}

/**
 * 聚合入口：调用方统一 `import { perfProbe } from '../perf/importPerfProbe'`。
 * 具名导出保留给需要单一 API 的场景；两者共享同一份会话状态。
 * 关闭态下每个成员都是 `if (!mode) return` 的 no-op，调用方无需判空。
 */
export const perfProbe = {
  startSession, setMeta, mark, count, begin, time,
  finishSession, getReport, summaryText, dump,
  enable, disable, isEnabled,
}

// DevTools / 自动化取数入口
try {
  globalThis.__perfProbe = { enable, disable, isEnabled, getReport, finishSession, dump, summaryText, startSession, mark, count }
} catch { /* 忽略 */ }
