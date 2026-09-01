#!/usr/bin/env node
/**
 * PERF-WHITE-1 — 基线中位数聚合器（node 直跑，零依赖）
 *
 * 用途：把多次 run 的探针报告聚合为「取中位数」的对比表，
 *       让 SOP 的「每组 3 runs 取 median」变成一条命令。
 *
 * 输入（二选一）：
 *   1. 文件参数：每行一个完整报告 JSON（JSONL），或粘贴的 [PERF_REPORT] 行
 *      node outputs/perf-white1-median.mjs runs-s200.jsonl runs-ofd.jsonl
 *   2. --stdin：从 stdin 粘贴（自动提取 JSON 对象）
 *      node outputs/perf-white1-median.mjs --stdin
 *
 * 输出：按 report.label 分组，每个字段输出 median / min / max / n。
 *       ★ 关键 KPI = derived.whiteScreenMs（T5→T6）
 */
import { readFileSync } from 'node:fs'

// ── 解析 ─────────────────────────────────────────────────────
function extractJson(line) {
  const t = line.trim()
  if (!t) return null
  // 优先整行 JSON
  try {
    const obj = JSON.parse(t)
    if (obj && typeof obj === 'object' && obj.derived) return obj
  } catch { /* 继续 */ }
  // [PERF_REPORT] {…} 形式：找第一个 { 到行尾
  const i = t.indexOf('{')
  if (i >= 0) {
    try {
      const obj = JSON.parse(t.slice(i))
      if (obj && typeof obj === 'object' && obj.derived) return obj
    } catch { /* 忽略 */ }
  }
  return null
}

function parseInput(files) {
  const reports = []
  for (const f of files) {
    const raw = readFileSync(f, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const r = extractJson(line)
      if (r) reports.push(r)
    }
  }
  return reports
}

function parseStdin() {
  const raw = readFileSync(0, 'utf8')
  const reports = []
  for (const line of raw.split(/\r?\n/)) {
    const r = extractJson(line)
    if (r) reports.push(r)
  }
  return reports
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
  console.error('[median] 未解析到任何报告。输入应为 JSONL（每行一个完整报告）或 [PERF_REPORT] 行。')
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
