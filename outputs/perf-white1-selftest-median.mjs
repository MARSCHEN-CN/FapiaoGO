#!/usr/bin/env node
/**
 * PERF-WHITE-1 — 分析链路自检（node 直跑，零依赖）
 *
 * 用途：在你真机跑完 3 runs 之前，先验证「探针输出 → 聚合器」这条链路是通的。
 *       避免「跑了 3 轮才发现格式对不上、数据废掉」。
 *
 * 用法：node outputs/perf-white1-selftest-median.mjs
 *
 * 覆盖 4 个真实风险点：
 *   1. 紧凑单行 JSON（推荐存 jsonl 的格式）
 *   2. pretty 多行 JSON（探针 clipboard 模式的默认输出 —— 逐行解析会失败）
 *   3. [PERF_REPORT] 前缀行
 *   4. 缺少 derived 的脏行（应被跳过而不是崩溃）
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGG = resolvePath(HERE, 'perf-white1-median.mjs')

// ── 造样例报告（结构与 importPerfProbe.buildReport 完全一致）──────────────
function rep(id, ws, lt) {
  return {
    id,
    label: 'S-200',
    meta: { fileCount: 200 },
    t0Wall: `2026-09-02T10:0${id}:00`,
    finishReason: 'T5+6000ms',
    marksRel: { T0: 0, T1: 120, T2: 48000, T3: 49200, T4: 49300, T5: 49550, T6: 49550 + ws, T7: 53000 },
    derived: {
      splitMs: 120, parseMs: 47880, hydrateMs: 1200, sealMs: 100,
      dismissDelayMs: 250, whiteScreenMs: ws, paintGapMs: 16,
      whiteToPaintMs: ws + 16, previewLagMs: 3450, totalMs: 53000,
    },
    counters: { importHistoryQuery: 40, applySort: 6, invoiceDocumentToRow: 200 },
    durations: { displayFiles: { n: 12, total: 900, max: 210, avg: 75 } },
    longTasks: {
      supported: true, count: lt.n, totalMs: lt.ms, top10: [],
      whiteWindow: { from: 49300, to: 49550 + ws, count: lt.wn, totalMs: lt.wms, top5: [] },
    },
  }
}

// 三次 run 的白屏值 4200 / 5100 / 4600 → 期望 median = 4600
const ROWS = [
  rep(1, 4200, { n: 30, ms: 3100, wn: 12, wms: 2400 }),
  rep(2, 5100, { n: 34, ms: 3600, wn: 15, wms: 2900 }),
  rep(3, 4600, { n: 31, ms: 3250, wn: 13, wms: 2600 }),
]

// ── 测试执行器 ─────────────────────────────────────────────
let pass = 0
let fail = 0
const tmp = mkdtempSync(join(tmpdir(), 'perf-selftest-'))

function runAgg(content, label) {
  const f = join(tmp, `${label.replace(/\W+/g, '_')}.jsonl`)
  writeFileSync(f, content, 'utf8')
  try {
    const out = execFileSync(process.execPath, [AGG, f], { encoding: 'utf8' })
    return { ok: true, out }
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') }
  }
}

function check(label, content, expectOk, expectContains) {
  const r = runAgg(content, label)
  let ok = r.ok === expectOk
  if (ok && expectContains) {
    for (const s of expectContains) {
      if (!r.out.includes(s)) { ok = false; break }
    }
  }
  if (ok) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}`)
    console.log(`        exit ok=${r.ok} (expect ${expectOk})`)
    for (const s of expectContains || []) {
      console.log(`        contains "${s}" -> ${r.out.includes(s)}`)
    }
    console.log(`        --- output head ---`)
    console.log(r.out.split('\n').slice(0, 6).map((l) => `        ${l}`).join('\n'))
  }
}

console.log('=== PERF-WHITE-1 分析链路自检 ===\n')

// 1. 紧凑单行 JSON（3 行 jsonl）
check(
  '1. 紧凑单行 JSON ×3 → median 4600',
  ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n',
  true,
  ['★ T5→T6 WHITE_SCREEN | 4600.0', '3/3', 'S-200'],
)

// 2. pretty 多行 JSON（探针 clipboard 默认格式）
check(
  '2. pretty 多行 JSON ×3 → median 4600',
  ROWS.map((r) => JSON.stringify(r, null, 2)).join('\n') + '\n',
  true,
  ['★ T5→T6 WHITE_SCREEN | 4600.0', '3/3'],
)

// 3. [PERF_REPORT] 前缀行
check(
  '3. [PERF_REPORT] 前缀行 ×3 → median 4600',
  ROWS.map((r) => `[PERF_REPORT] ${JSON.stringify(r)}`).join('\n') + '\n',
  true,
  ['★ T5→T6 WHITE_SCREEN | 4600.0', '3/3'],
)

// 4. 混合格式 + 脏行
check(
  '4. 混合格式 + 脏行 → 脏行跳过不崩溃',
  [
    JSON.stringify(ROWS[0]),
    '这不是 JSON',
    JSON.stringify(ROWS[1], null, 2),
    '{"foo":"bar"}',          // 有 JSON 但无 derived → 应跳过
    '[PERF_REPORT] ' + JSON.stringify(ROWS[2]),
    '',
  ].join('\n'),
  true,
  ['★ T5→T6 WHITE_SCREEN | 4600.0', '3/3'],
)

// 5. 全脏输入 → 应报错退出 1（而不是输出空表）
check(
  '5. 全为无效输入 → 退出 1 并提示',
  'hello world\n{"noDerived":1}\n',
  false,
  ['未解析到任何报告'],
)

// 6. counters / durations / longTasks 三张附表都要出
const r6 = runAgg(ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n', 't6')
const needTables = [
  ['counters 附表', 'importHistoryQuery'],
  ['durations 附表', 'displayFiles · total(ms)'],
  ['longTasks 附表', '白屏窗口 · LT busyMs'],
]
for (const [name, needle] of needTables) {
  if (r6.ok && r6.out.includes(needle)) { pass++; console.log(`  PASS  6. ${name}`) }
  else { fail++; console.log(`  FAIL  6. ${name}（缺 "${needle}"）`) }
}

// 7. 字符串值里含花括号 —— 配平扫描最容易翻车的地方，必须跳过字符串内的 {}
const tricky = ROWS.map((r) => ({
  ...r,
  label: 'S-200{batch}',
  finishReason: 'T5+6000ms {"note":"}{"}',
}))
check(
  '7. 字符串内含 {} → 不误判配平',
  tricky.map((r) => JSON.stringify(r, null, 2)).join('\n') + '\n',
  true,
  ['★ T5→T6 WHITE_SCREEN | 4600.0', '3/3', 'S-200{batch}'],
)

// 8. 紧凑 + pretty 混排在同一文件（真实粘贴场景：有时手改过格式）
check(
  '8. 紧凑与 pretty 混排 → 全部识别',
  [JSON.stringify(ROWS[0]), JSON.stringify(ROWS[1], null, 2), JSON.stringify(ROWS[2])].join('\n') + '\n',
  true,
  ['★ T5→T6 WHITE_SCREEN | 4600.0', '3/3'],
)

// ── 输出预览（让你确认表格长什么样）──────────────────────────
console.log('\n=== 样例输出预览（三次 run：4200 / 5100 / 4600 ms）===\n')
console.log(runAgg(ROWS.map((r) => JSON.stringify(r, null, 2)).join('\n') + '\n', 'preview').out)

rmSync(tmp, { recursive: true, force: true })

console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
console.log(fail === 0 ? '✅ 分析链路可用，可以放心开始真机 3 runs。' : '❌ 链路有问题，先修聚合器再跑真机。')
process.exit(fail === 0 ? 0 : 1)
