#!/usr/bin/env node
/**
 * PERF-WHITE-1 — 基线中位数聚合器（node 直跑，零依赖）
 *
 * 用途：把多次 run 的探针报告聚合为「取中位数」的对比表，
 *       让 SOP 的「每组 3 runs 取 median」变成一条命令。
 *
 * 输入（二选一，格式随意，能认出 JSON 对象就行）：
 *   1. 文件参数：一个或多个文件，里面每个探针报告一个 JSON 对象
 *      node outputs/perf-white1-median.mjs runs-s200.jsonl runs-ofd.jsonl
 *   2. --stdin：从 stdin 粘贴（配合 pbpaste / 直接粘贴）
 *      node outputs/perf-white1-median.mjs --stdin
 *
 *   三种格式都吃：紧凑单行 · pretty 多行（剪贴板默认）· [PERF_REPORT] 前缀行；
 *   非 JSON 的脏行、缺 derived 的 JSON 一律静默跳过。
 *
 * 输出：按 report.label 分组，每个字段输出 median / min / max / n。
 *       ★ 关键 KPI = derived.whiteScreenMs（T5→T6）
 *
 * 自检：node outputs/perf-white1-selftest-median.mjs（8 项，跑真机前建议先跑一次）
 */
import { readFileSync } from 'node:fs'

// ── 解析 ─────────────────────────────────────────────────────
/**
 * 从任意文本里抽出所有「顶层 JSON 对象」，逐个校验后保留带 derived 的。
 *
 * 为什么不能用「逐行 JSON.parse」：
 *   探针 clipboard 模式写的是 JSON.stringify(report, null, 2) —— pretty 多行格式。
 *   逐行解析时每一行都不是完整 JSON，会导致「一条都解析不出来」，3 轮基线直接作废。
 *   这里改用花括号配平扫描（跳过字符串内的花括号），同时兼容：
 *     · 紧凑单行 jsonl        {"id":1,...,"derived":{...}}
 *     · pretty 多行           同一对象跨若干行
 *     · [PERF_REPORT] 前缀     行首有标记
 *     · 脏行                  非 JSON 文本 / 无 derived 的 JSON —— 静默跳过
 */
function extractJsonObjects(text) {
  const out = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      if (depth === 0) continue // 多余的右括号，跳过
      depth--
      if (depth === 0) {
        const slice = text.slice(start, i + 1)
        try {
          const obj = JSON.parse(slice)
          if (obj && typeof obj === 'object' && obj.derived) out.push(obj)
        } catch { /* 不是合法 JSON → 跳过 */ }
        start = -1
      }
    }
  }
  return out
}

function parseText(raw) {
  return extractJsonObjects(raw)
}

function parseInput(files) {
  const reports = []
  for (const f of files) {
    const raw = readFileSync(f, 'utf8')
    reports.push(...parseText(raw))
  }
  return reports
}

function parseStdin() {
  return parseText(readFileSync(0, 'utf8'))
}

// ── 中位数 ───────────────────────────────────────────────────
const median = (arr) => {
  if (arr.length === 0) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const fmt = (v) => (v === null ? '-' : (Math.round(v * 10) / 10).toFixed(1))

// ── 聚合 ─────────────────────────────────────────────────────
function aggNumbers(values) {
  const nums = values.filter((v) => v !== null && v !== undefined)
  return {
    n: values.length,
    valid: nums.length,
    median: median(nums),
    min: nums.length ? Math.min(...nums) : null,
    max: nums.length ? Math.max(...nums) : null,
  }
}

function renderTable(groupLabel, runs, fieldDefs) {
  const rows = []
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
  for (const [key, label] of fieldDefs) {
    const vals = runs.map((r) => getPath(r, key))
    const a = aggNumbers(vals)
    if (a.valid === 0) continue
    rows.push(`| ${label} | ${fmt(a.median)} | ${fmt(a.min)} | ${fmt(a.max)} | ${a.valid}/${a.n} |`)
  }
  const header = `| 指标 | median | min | max | 有效/n |\n|------|--------|-----|-----|--------|`
  return `### ${groupLabel}（${runs.length} runs）\n\n${header}\n${rows.join('\n')}`
}

// ── 主流程 ───────────────────────────────────────────────────
const isStdin = process.argv.includes('--stdin')
const files = process.argv.slice(2).filter((a) => a !== '--stdin')
let reports
try {
  reports = isStdin ? parseStdin() : parseInput(files.length ? files : ['-'])
} catch (e) {
  console.error('[median] 解析失败:', e.message)
  process.exit(1)
}

if (reports.length === 0) {
  console.error('[median] 未解析到任何报告。')
  console.error('        输入需含至少一个带 derived 字段的探针报告对象；')
  console.error('        紧凑单行 / pretty 多行 / [PERF_REPORT] 前缀行都支持，脏行会跳过。')
  process.exit(1)
}

// 按 label 分组（无 label → "(unnamed)"）
const groups = new Map()
for (const r of reports) {
  const g = r.label || '(unnamed)'
  if (!groups.has(g)) groups.set(g, [])
  groups.get(g).push(r)
}

const derivedFields = [
  ['derived.splitMs', 'T0→T1 split'],
  ['derived.parseMs', 'T1→T2 parse'],
  ['derived.hydrateMs', 'T2→T3 hydrate'],
  ['derived.sealMs', 'T3→T4 seal'],
  ['derived.dismissDelayMs', 'T4→T5 dismissDelay'],
  ['derived.whiteScreenMs', '★ T5→T6 WHITE_SCREEN'],
  ['derived.paintGapMs', 'T6→T6p paintGap'],
  ['derived.whiteToPaintMs', 'T5→T6p whiteToPaint'],
  ['derived.previewLagMs', 'T5→T7 PREVIEW_LAG'],
  ['derived.totalMs', 'T0→T7 total'],
  // ── 归因判据（T4 重置前留档，见 importPerfProbe.mark 注释）──
  ['derived.commitVsDismissMs', '判据 T5→首次commit（≤0=关闭前已渲染）'],
  ['derived.firstCommitMs', 'T0→首次commit（含 T4 前）'],
]

const out = []
out.push('# PERF-WHITE-1 基线中位数报告')
out.push('')
out.push(`- 报告数: ${reports.length}`)
out.push(`- 分组: ${[...groups.keys()].join(', ')}`)
out.push('')

for (const [g, runs] of groups) {
  out.push(renderTable(g, runs, derivedFields))
  out.push('')

  // counters（并集）
  const counterNames = new Set()
  for (const r of runs) for (const k of Object.keys(r.counters || {})) counterNames.add(k)
  if (counterNames.size) {
    out.push(renderTable(`${g} · counters`, runs,
      [...counterNames].map((k) => [`counters.${k}`, k])))
    out.push('')
  }

  // durations（并集）
  const durNames = new Set()
  for (const r of runs) for (const k of Object.keys(r.durations || {})) durNames.add(k)
  for (const dn of durNames) {
    const fields = [
      [`durations.${dn}.n`, `${dn} · n`],
      [`durations.${dn}.total`, `${dn} · total(ms)`],
      [`durations.${dn}.max`, `${dn} · max(ms)`],
      [`durations.${dn}.avg`, `${dn} · avg(ms)`],
    ]
    out.push(renderTable(`${g} · ${dn}`, runs, fields))
    out.push('')
  }

  // longTasks
  out.push(renderTable(`${g} · longTasks`, runs, [
    ['longTasks.count', 'longTasks · count'],
    ['longTasks.totalMs', 'longTasks · busyMs'],
    ['longTasks.whiteWindow.count', '白屏窗口 · LT count'],
    ['longTasks.whiteWindow.totalMs', '白屏窗口 · LT busyMs'],
  ]))
  out.push('')
}

console.log(out.join('\n'))
