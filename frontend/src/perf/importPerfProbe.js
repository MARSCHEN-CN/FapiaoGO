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
 *   ── 预览渲染尝试（PERF-WHITE-1 1B 新增，canvas 路径 renderToCanvas）──
 *   previewRenderStart  一次渲染尝试的起点（renderToCanvas 进入即打点）
 *   previewRenderEnd    渲染完成点（与 T7 同点：setPreviewCanvas 之后）
 *   二者与 T6/T6p/T7 一样随 T4 重置并留档 *_pre，捕获「100% 之后的首次
 *   渲染尝试/完成」。配合 T5+15s 观察窗区分四种情形：
 *     A 未触发        → start 缺失
 *     B 触发但很晚    → start 很晚（T5+ 大）
 *     C 开始但未完成  → start 有、end 缺失/很晚（观察窗内）
 *     D 已完成        → start/end 齐备且 end 早于白屏感知
 *
 *   核心 KPI：WHITE_SCREEN = T6 - T5（弹窗关闭 → 列表首次 commit）
 *   辅助 KPI：PAINT_GAP   = T6p - T6（commit → 真正上屏）
 *            PREVIEW_LAG = T7 - T5
 *   注：T4 到达时会重置 T6/T6p/T7/previewRenderStart/previewRenderEnd ——
 *       导入过程中占位符也会让 FileList commit / 触发渲染尝试，
 *       只有「100% 之后的首个锚点」才是白屏窗口的终点。
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
 * @param {string} name T0|T1|T2|T3|T4|T5|T6|T6p|T7|previewRenderStart|previewRenderEnd
 */
export function mark(name) {
  if (!mode || !session) return
  if (session.marks[name] !== undefined) return
  session.marks[name] = r1(now())
  // T4（进度 100%）= 白屏窗口起点，清除其后的可见性锚点
  if (name === 'T4') {
    // ⚠️ 重置前先留档。原因（2026-09-02 定位）：
    // 只保留「T4 之后的 T6」会丢失一个关键判据 —— 列表在弹窗关闭前是否已经渲染完成。
    // 若 T6_pre 存在且早于 T5，说明白屏**不是**列表渲染问题（列表早就画好了，
    // 用户看到的是别的东西：被弹窗遮罩挡住 / 预览区空白 / 布局塌陷等），
    // 归因方向完全不同。没有 T6_pre 就无法区分「白屏」和「从未白屏」。
    // 1B 起 previewRenderStart/End 一并留档：导入期若有渲染尝试，同样会在
    // 100% 时被清掉 —— 只有「100% 之后的首次尝试/完成」才能回答 A/B/C/D。
    for (const k of ['T6', 'T6p', 'T7', 'previewRenderStart', 'previewRenderEnd']) {
      if (session.marks[k] !== undefined) session.marks[k + '_pre'] = session.marks[k]
      delete session.marks[k]
    }
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

    // ── 白屏归因判据（T4 重置前留档，见 mark() 注释）──
    // 首次 commit 相对 T0 的时刻（无论发生在 T4 前后）
    firstCommitMs: gap('T0', 'T6_pre') ?? gap('T0', 'T6'),
    // ★ 判据：列表首次 commit 相对「弹窗关闭」的时刻。
    //   <= 0 → 弹窗关闭时列表已 commit，白屏不是列表渲染问题（归因需换方向）
    //   >  0 → 列表确实在弹窗关闭之后才 commit，白屏窗口真实存在
    //   null → T6 从未触发（列表始终未 commit，或 files 在 T4 后未再变化）
    commitVsDismissMs: gap('T5', 'T6_pre') ?? gap('T5', 'T6'),

    // ── 预览渲染归因判据（PERF-WHITE-1 1B：previewRenderStart/End 随 T4 重置留档）──
    //   start 缺失            → 100% 后无渲染尝试（A 方向：未触发，非渲染慢）
    //   start 有、end 缺失    → 渲染已开始但观察窗内未完成（B/C 方向：慢/卡/被取消）
    //   start/end 齐备        → 渲染完成（D 方向：白屏若仍存在，查渲染之外环节）
    previewStartAfterDismissMs: gap('T5', 'previewRenderStart'),
    previewEndAfterDismissMs: gap('T5', 'previewRenderEnd'),
    previewWorkMs: gap('previewRenderStart', 'previewRenderEnd'),
  }

  // T4 之前是否已有渲染尝试（*_pre 留档存在性）：
  //   区分「全程从未渲染」（null）vs「仅导入期渲染过、100% 后无新尝试」（true）
  //   vs「渲染发生在 100% 之后」（false）。
  derived.previewStartedBeforeDismiss =
    marks.previewRenderStart_pre !== undefined
      ? true
      : marks.previewRenderStart !== undefined || marks.previewRenderEnd !== undefined
        ? false
        : null

  // 弹窗关闭前列表是否已 commit（布尔，便于直接看）。
  // 取「最早的那个 commit 锚点」：有 T6_pre 就用它，否则用 T6。
  // ⚠️ 不能写成「有 T6 就直接判 false」——T4 到 T5 之间还有 2 帧 + 250ms 的窗口，
  //    列表完全可能在这段时间内 commit（T6 < T5），那种情况同样是「关闭前已渲染」。
  const commitAnchor = marks.T6_pre !== undefined ? marks.T6_pre : marks.T6
  derived.listReadyBeforeDismiss =
    commitAnchor !== undefined && marks.T5 !== undefined ? commitAnchor <= marks.T5 : null

  // 缺失锚点清单：让「某个 T 没打上」这件事在报告里显式可见，
  // 而不是只表现为一堆 null 让人猜。
  // 1B 起纳入 T7 与 previewRenderStart/End —— run-261 曾出现 T7 缺失但 missingMarks
  // 只有 T6 的情况（证据盲区）；预览锚点缺失正是 A（未触发）的直接信号。
  const missingMarks = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'previewRenderStart', 'previewRenderEnd']
    .filter((k) => marks[k] === undefined)

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
    missingMarks,
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
  ]

  // ── 归因判据：这一行决定「白屏」到底该往哪归因 ──
  if (d.listReadyBeforeDismiss === true) {
    lines.push(`★ 判据: 弹窗关闭时列表**已经**commit（T6_pre−T5=${d.commitVsDismissMs}ms ≤ 0）→ 白屏不是列表渲染问题，请查遮罩/预览区/布局`)
  } else if (d.listReadyBeforeDismiss === false) {
    lines.push(`★ 判据: 弹窗关闭时列表**尚未**commit → 白屏窗口真实存在，WHITE_SCREEN 有效`)
  } else if (d.firstCommitMs != null) {
    lines.push(`★ 判据: 列表首次 commit 在 T0+${d.firstCommitMs}ms（T4 之前已完成，T4 后未再变化）`)
  } else {
    lines.push(`⚠️ 判据: T6 从未触发 —— 列表在测量窗口内始终未 commit。检查 FileList 是否挂载、files 是否非空`)
  }

  if (r.missingMarks && r.missingMarks.length) {
    lines.push(`⚠️ 缺失锚点: ${r.missingMarks.join(', ')}（对应指标将为 null）`)
  }

  // ── 预览渲染判据（1B）：A/B/C/D 一眼可判 ──
  const ps = d.previewStartAfterDismissMs
  const pe = d.previewEndAfterDismissMs
  if (ps == null) {
    lines.push(`★ 预览判据: 100% 后无渲染尝试（start 缺失；曾尝试=${d.previewStartedBeforeDismiss}）→ A「未触发」，查自动预览触发条件/RE 路径是否占用`)
  } else if (pe == null) {
    lines.push(`★ 预览判据: 渲染已开始于 T5+${ps}ms 但观察窗内未完成 → B/C「开始但未完成」，主线程阻塞或渲染中`)
  } else {
    lines.push(`★ 预览判据: 渲染完成于 T5+${pe}ms（start=T5+${ps}ms, work=${d.previewWorkMs}ms）→ D「渲染完成」；白屏若仍久则查 commit→paint 环节`)
  }

  lines.push(
    `longTasks n=${r.longTasks.count} busyMs=${r.longTasks.totalMs} | whiteWindow n=${r.longTasks.whiteWindow.count} busyMs=${r.longTasks.whiteWindow.totalMs}`,
    `counters ${JSON.stringify(r.counters)}`,
    `durations ${JSON.stringify(r.durations)}`,
  )
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
