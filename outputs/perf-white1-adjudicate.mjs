#!/usr/bin/env node
/**
 * PERF-WHITE-1 1B — 复跑报告判读器（node 直跑，零依赖）
 *
 * 数据一到手就跑它，输出 4 段：
 *   1. 签名校验      —— 这份报告是不是新版探针（T5+15000ms + preview 锚点）跑出来的？
 *   2. A/B/C/D 判定  —— 预览渲染归因（1B 要补的那刀证据）
 *   3. 可比性守卫    —— 与 run-261 基线是否同一代码路径（冷/热路径交叉校验）
 *   4. 新旧对比表    —— 自动加载 run-261 基线做关键字段 diff
 *
 * 用法：
 *   node outputs/perf-white1-adjudicate.mjs <file.json...>   # 显式文件
 *   node outputs/perf-white1-adjudicate.mjs --stdin          # 把报告粘到 stdin
 *   node outputs/perf-white1-adjudicate.mjs                  # 自动找 outputs/perf-runs/run-261-1B*.json
 *   node outputs/perf-white1-adjudicate.mjs --selftest       # 内置自检（4 情形 + 签名 + 可比性）
 *
 * 基线文件（存在才做新旧对比）：outputs/perf-runs/run-261-user-raw.json
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), 'perf-runs', 'run-261-user-raw.json')
const SELF = process.argv.includes('--selftest')

// ── 解析（与 median.mjs 同源的花括号配平扫描，兼容 pretty 多行 / [PERF_REPORT] 前缀）──
function extractJsonObjects(text) {
  const out = []
  let depth = 0, start = -1, inStr = false, esc = false
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
      if (depth === 0) continue
      depth--
      if (depth === 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1))
          if (obj && typeof obj === 'object' && obj.derived) out.push(obj)
        } catch { /* 非合法 JSON */ }
        start = -1
      }
    }
  }
  return out
}

// ── 1. 签名校验 ──────────────────────────────────────────────
function signature(r) {
  const lines = []
  const hasNewFields = r.derived && typeof r.derived.previewStartAfterDismissMs !== 'undefined'
  const reason = r.finishReason || ''
  let pass = true
  if (hasNewFields) {
    lines.push('✅ 探针版本：新版（含 previewStartAfterDismissMs 判据字段）')
  } else {
    pass = false
    lines.push('🔴 探针版本：旧版（无 preview 判据字段）—— 这是用旧代码跑的，结果不能用于 1B 判定')
  }
  if (reason === 'T5+15000ms') {
    lines.push(`✅ 观察窗：${reason}（15s，符合 1B 预期）`)
  } else if (reason === 'T5+6000ms') {
    pass = false
    lines.push(`🔴 观察窗：${reason} —— 旧 6s 窗口代码，必须用新版重跑`)
  } else {
    lines.push(`⚠️ 观察窗：${reason}（非标准结算原因，人工确认）`)
  }
  const c = r.counters || {}
  lines.push(`   counters: previewRenderAttempts=${c.previewRenderAttempts ?? '(无)'} previewRenderCompleted=${c.previewRenderCompleted ?? '(无)'}`)
  const miss = (r.missingMarks || []).filter((k) => k.startsWith('preview') || k === 'T7')
  if (miss.length) lines.push(`   ⚠️ 缺失(预览相关): ${miss.join(', ')}`)
  return { pass, lines }
}

// ── 2. A/B/C/D 判定 ─────────────────────────────────────────
function classify(r) {
  const d = r.derived || {}
  const s = d.previewStartAfterDismissMs          // T5 → start（null = 无尝试）
  const e = d.previewEndAfterDismissMs             // T5 → end（null = 窗口内未完成）
  const pre = d.previewStartedBeforeDismiss        // true=仅 100% 前渲染过 / false=100% 后 / null=全程无
  const c = r.counters || {}
  const lines = []
  let verdict = '?'

  if (s == null) {
    if (pre === true) {
      verdict = 'A-（导入期渲染过，100% 后无新尝试）'
      lines.push(`★ ${verdict}：previewRenderStart 缺失（T5 后无渲染尝试），但 *_pre 留档存在 → 渲染曾发生在导入期。`)
      lines.push('   含义：弹窗关闭后预览渲染**没有被触发/没有被调度** → 白屏与「渲染慢」无关，查自动预览触发条件、RE 路径占用、或当前选中文件未变导致无重渲。')
    } else if (pre === false) {
      verdict = 'A-异常（有 100% 后渲染记录但 start 缺失）'
      lines.push(`★ ${verdict}：数据自相矛盾（end 有而 start 无），人工核对 marksRel。`)
    } else {
      verdict = 'A（全程无渲染尝试）'
      lines.push(`★ ${verdict}：previewRenderStart 缺失且全程无渲染记录 → 预览渲染从未被触发。`)
    }
  } else if (e == null) {
    verdict = 'C（开始但观察窗内未完成）'
    lines.push(`★ ${verdict}：渲染开始于 T5+${s}ms，但 T5+15s 观察窗内未完成（attempts=${c.previewRenderAttempts ?? '?'}, completed=${c.previewRenderCompleted ?? '?'}）。`)
    lines.push('   含义：渲染在跑但 >15s 没画完 / 被取消 / 卡死 → 主线程长任务阻塞方向（renderers/LRU/pdf.js）。')
  } else {
    const late = s >= 3000 ? `（⚠️ 开始得很晚：T5+${s}ms）` : ''
    if (late) {
      verdict = 'B（触发很晚）'
      lines.push(`★ ${verdict}${late}：渲染完成于 T5+${e}ms（work=${d.previewWorkMs}ms）→ 渲染本身不慢，是「开始得晚」。查触发调度。`)
    } else {
      verdict = 'D（渲染完成）'
      lines.push(`★ ${verdict}：渲染完成于 T5+${e}ms（start=T5+${s}ms, work=${d.previewWorkMs}ms）→ 预览渲染不是瓶颈；白屏若仍久，查 commit→paint / 占位 / 遮罩。`)
    }
  }
  lines.push(`   辅助: previewStartedBeforeDismiss=${pre}  commitVsDismissMs=${d.commitVsDismissMs}  listReadyBeforeDismiss=${d.listReadyBeforeDismiss}`)
  return { verdict, lines }
}

// ── 3. 可比性守卫 ───────────────────────────────────────────
function comparability(r, base) {
  const lines = []
  const c = r.counters || {}
  const bc = base?.counters || {}
  let ok = true
  // P1-A 起计数器改名：importHistoryWrite → importHistoryResponse（响应命中数，语义不变）。
  // 兼容读取：旧报告只有 Write；新报告只有 Response。
  const histHit = c.importHistoryWrite ?? c.importHistoryResponse ?? 0
  if (histHit > 0) {
    ok = false
    lines.push(`🔴 importHistory ${histHit} 次命中（Write=${c.importHistoryWrite ?? '—'}/Response=${c.importHistoryResponse ?? '—'}）→ 热路径已激活（importCount≥2），与 run-261 冷路径不可比。检查是否忘记重置导入历史。`)
  } else {
    lines.push(`✅ importHistory 命中=0（Write=${c.importHistoryWrite ?? '—'}/Response=${c.importHistoryResponse ?? '—'} → 冷路径，importCount=1）`)
  }
  // P1-A publication batching 观察：454 响应 → N 发布（N << 命中数）+ noop 计数
  if (c.importHistoryPublish !== undefined || c.importHistoryNoop !== undefined) {
    const hit = c.importHistoryResponse ?? c.importHistoryWrite ?? '?'
    lines.push(`   importHistory publication: Response=${hit} → Publish=${c.importHistoryPublish ?? '?'}（Noop=${c.importHistoryNoop ?? '?'}）`)
  }
  const fc = r.meta?.fileCount ?? r.meta?.rawCount ?? '?'
  const bfc = base?.meta?.fileCount ?? '?'
  lines.push(`   文件数: 本轮 ${fc} vs 基线 ${bfc}${fc === bfc ? '（一致）' : '（⚠️ 不一致）'}`)
  const rows = c.invoiceDocumentToRow ?? '?'
  const brows = bc.invoiceDocumentToRow ?? '?'
  const ratio = (typeof rows === 'number' && typeof brows === 'number' && brows > 0) ? rows / brows : null
  if (ratio !== null && ratio > 0.5 && ratio < 2) {
    lines.push(`   invoiceDocumentToRow: 本轮 ${rows} vs 基线 ${brows}（ratio=${ratio.toFixed(2)}，量级相近 → 派生负载可比）`)
  } else {
    lines.push(`⚠️ invoiceDocumentToRow: 本轮 ${rows} vs 基线 ${brows}${ratio === null ? '' : `（ratio=${ratio.toFixed(2)} 偏离 0.5~2 倍，负载不可比，人工确认）`}`)
    ok = ratio !== null ? false : ok
  }
  return { ok, lines }
}

// ── 4. 新旧对比表 ───────────────────────────────────────────
const fmt = (v) => (v === null || v === undefined ? '-' : (Math.round(v * 10) / 10).toFixed(1))
function diffTable(base, cur) {
  if (!base) return []
  const keys = new Set([...Object.keys(base.derived || {}), ...Object.keys(cur.derived || {})])
  const rows = []
  for (const k of keys) {
    const b = base.derived?.[k]
    const c = cur.derived?.[k]
    if (typeof b !== 'number' && typeof c !== 'number') continue
    const delta = (typeof b === 'number' && typeof c === 'number') ? Math.round((c - b) * 10) / 10 : null
    rows.push([k, b, c, delta])
  }
  // 按 |Δ| 排序，突出变化大的
  rows.sort((x, y) => (Math.abs(y[3] ?? 0)) - (Math.abs(x[3] ?? 0)))
  const out = []
  out.push('| derived 字段 | run-261 基线 | 本轮 | Δ |')
  out.push('|--------------|-------------|------|----|')
  for (const [k, b, c, delta] of rows.slice(0, 18)) {
    out.push(`| ${k} | ${fmt(b)} | ${fmt(c)} | ${delta === null ? '-' : (delta > 0 ? '+' : '') + delta} |`)
  }
  return out
}

// ── 主流程 ───────────────────────────────────────────────────
function loadReports(args) {
  const files = args.filter((a) => a !== '--stdin' && a !== '--selftest')
  if (args.includes('--stdin')) return extractJsonObjects(readFileSync(0, 'utf8'))
  if (files.length) {
    const all = []
    for (const f of files) all.push(...extractJsonObjects(readFileSync(f, 'utf8')))
    return all
  }
  // 自动发现
  const dir = dirname(BASELINE)
  if (existsSync(dir)) {
    const cands = readdirSync(dir).filter((f) => /run-261-1B.*\.json$/.test(f)).sort().reverse()
    if (cands.length) {
      const p = join(dir, cands[0])
      console.error(`[adjudicate] 自动取用报告: ${p}`)
      return extractJsonObjects(readFileSync(p, 'utf8'))
    }
  }
  console.error('[adjudicate] 未找到报告。用法: <file...> | --stdin | 放 outputs/perf-runs/run-261-1B*.json')
  process.exit(1)
}

// ── 自检 ─────────────────────────────────────────────────────
function selftest() {
  const mk = (over) => {
    const r = {
      id: 1, label: 'import:261', meta: { fileCount: 261 },
      finishReason: 'T5+15000ms', missingMarks: [],
      derived: { previewStartAfterDismissMs: null, previewEndAfterDismissMs: null, previewWorkMs: null, previewStartedBeforeDismiss: null, commitVsDismissMs: -65284.5, listReadyBeforeDismiss: true },
      counters: { previewRenderAttempts: 1, previewRenderCompleted: 0, importHistoryWrite: 0, invoiceDocumentToRow: 561 },
    }
    return Object.assign(r, over)
  }
  const cases = [
    ['A 全程无尝试', mk({ derived: { ...mk({}).derived } }), 'A'],
    ['A- 仅导入期渲染过', mk({ derived: { previewStartedBeforeDismiss: true } }), 'A-'],
    ['C 开始未完成', mk({ derived: { previewStartAfterDismissMs: 120, previewEndAfterDismissMs: null, previewStartedBeforeDismiss: false } }), 'C'],
    ['B 很晚才开始', mk({ derived: { previewStartAfterDismissMs: 6500, previewEndAfterDismissMs: 6800, previewWorkMs: 300, previewStartedBeforeDismiss: false } }), 'B'],
    ['D 完成', mk({ derived: { previewStartAfterDismissMs: 150, previewEndAfterDismissMs: 900, previewWorkMs: 750, previewStartedBeforeDismiss: false } }), 'D'],
  ]
  let fail = 0
  for (const [name, r, want] of cases) {
    const { verdict } = classify(r)
    const ok = verdict.startsWith(want)
    console.log(`${ok ? 'PASS' : 'FAIL'} 判定[${name}] → ${verdict}${ok ? '' : `（期望 ${want}）`}`)
    if (!ok) fail++
  }
  // 签名
  const old = mk({ finishReason: 'T5+6000ms', derived: { splitMs: 0 } })
  const newR = mk({ derived: { previewStartAfterDismissMs: null } })
  console.log(`${signature(newR).pass ? 'PASS' : 'FAIL'} 签名[新版 15s]`)
  if (!signature(newR).pass) fail++
  console.log(`${!signature(old).pass ? 'PASS' : 'FAIL'} 签名[旧版 6s 应拒绝]`)
  if (signature(old).pass) fail++
  // 可比性热路径
  const hot = mk({ counters: { importHistoryWrite: 5, invoiceDocumentToRow: 800 } })
  console.log(`${!comparability(hot, mk({})).ok ? 'PASS' : 'FAIL'} 可比性[热路径应告警]`)
  if (comparability(hot, mk({})).ok) fail++
  console.log(fail === 0 ? 'SELFTEST 全 PASS' : `SELFTEST ${fail} FAIL`)
  process.exit(fail ? 1 : 0)
}

if (SELF) selftest()

const reports = loadReports(process.argv.slice(2))
if (reports.length === 0) {
  console.error('[adjudicate] 未解析到任何报告（需含 derived 字段）。')
  process.exit(1)
}
const base = existsSync(BASELINE) ? extractJsonObjects(readFileSync(BASELINE, 'utf8'))[0] : null
if (!base) console.log('（无基线 run-261-user-raw.json，跳过新旧对比）\n')

for (const r of reports) {
  console.log(`# PERF-WHITE-1 1B 判读 · run#${r.id} ${r.label || ''} (${r.t0Wall || '?'})`)
  console.log('')
  console.log('## 1. 签名校验')
  const sig = signature(r)
  console.log(sig.lines.join('\n'))
  console.log('')
  console.log('## 2. 预览渲染 A/B/C/D 判定')
  const cl = classify(r)
  console.log(cl.lines.join('\n'))
  console.log('')
  console.log('## 3. 可比性守卫（vs run-261 冷路径）')
  const cp = comparability(r, base)
  console.log(cp.lines.join('\n'))
  console.log('')
  if (base) {
    console.log('## 4. 新旧对比（derived 关键字段，|Δ| 排序）')
    console.log(diffTable(base, r).join('\n'))
    console.log('')
  }
  console.log(`> 判定结论：${cl.verdict}`)
  console.log('')
  if (!sig.pass || !cp.ok) {
    console.log('⚠️ 签名或可比性不通过 → 本报告不能作为 1B 判定依据，先按提示修正后重跑。')
    process.exit(2)
  }
}
