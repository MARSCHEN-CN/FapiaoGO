#!/usr/bin/env node
/**
 * PERF-WHITE-1 · R2 Preview Runtime Evidence — 离线判读器
 *
 * 把实机 `copy(__PREVIEW_TRACE__.dump())` 的 JSON 落盘后喂给它，
 * 输出 R2 四个事实问题的结构化判定（不依赖任何业务代码，纯分析）。
 *
 * ════════════════════════════════════════════════════════════════
 * 用法
 * ────────────────────────────────────────────────────────────────
 *   node outputs/preview-r2-adjudicate.mjs <dump.json>
 *   node outputs/preview-r2-adjudicate.mjs -            # 从 stdin 读
 *   node outputs/preview-r2-adjudicate.mjs --selftest   # 合成数据自检
 *
 * 输入 schema（previewTrace.js 的 dump() 输出）：
 *   { enabled, eventCount, dropped, counters:{TYPE:n},
 *     events:[{seq,t,type,caller,fields:{…}}] }
 *
 * ════════════════════════════════════════════════════════════════
 * 判定口径（全部来自接线点实码，勿凭记忆改）
 * ────────────────────────────────────────────────────────────────
 * · HANDLE_PREVIEW（log skip:1，caller=真实来源）在 handlePreview 入口
 *   （usePreview.js:2090），防抖到期执行路径不补打（:2119 直达 doLoadPreview）
 *   ⇒  HANDLE = DEBOUNCED + 立即执行；SCHED = 立即执行 + 防抖到期执行
 * · SCHED_DECISION（:1619）打在 decision 之后、action 分叉之前，无条件
 *   ⇒  SCHED = START + MERGE_DEFERRED + IGNORED + INVALIDATED   [硬校验]
 * · 每 START 进入 loading loop ⇒ LOAD_START / LOAD_RETURN 各一；终局 ∈
 *   {COMMIT_SUCCESS, COMMIT_CACHE, COMMIT_SKIPPED_VERSION, COMMIT_MERGE,
 *    TERMINATED, FUSE_BLOCK, ABORTED(at), RESTART(at)}            [硬校验]
 * · 空壳判据（R2-3）：COMMIT_* 事件 fields 中 docId==null 且三 flag 全 false
 *   = 全空壳；docId!=null 且三 flag 全 false =「有身份无载荷」（docId 先到、
 *   载荷后到的窗口形态——与空壳同属不可展示 commit，只是成因不同）
 * · 末次 START 结局：dump 内最后（seq 最大）一个 START 的终局事件；
 *   无终局 = 该加载在 dump 时点悬空（会话中断 or 永不 commit）
 * · 静默窗口：相邻事件最大 t 间隔（空壳 commit 后若无人重试，会出现
 *   一个「无任何 AUTO/retry 事件」的长窗——这是凝固证据的重要形态）
 *
 * @module outputs/preview-r2-adjudicate
 */

import fs from 'node:fs'

// ── 终局事件集合（一个 START 的加载 loop 结束后可能落到的结局）──
const TERMINAL = new Set([
  'COMMIT_SUCCESS', 'COMMIT_CACHE', 'COMMIT_SKIPPED_VERSION', 'COMMIT_MERGE',
  'TERMINATED', 'FUSE_BLOCK', 'ABORTED', 'RESTART',
])
const COMMIT_KINDS = ['COMMIT_SUCCESS', 'COMMIT_CACHE', 'COMMIT_MERGE']
const ABORT_LABEL = { 'after-loadDocFacts': 'A1', 'before-saveDocFacts': 'A2', 'after-saveDocFacts': 'A3', 'before-commit': 'A4' }

const f = (fields, k) => (fields && fields[k] !== undefined ? fields[k] : null)
const empty = (obj) => obj === null || obj === undefined || obj === ''

function snapshotOf(ev) {
  const fd = ev.fields || {}
  return {
    docId: fd.docId ?? null,
    hasPreviewImageUrl: !!fd.hasPreviewImageUrl,
    hasPdfData: !!fd.hasPdfData,
    hasPreviewImage: !!fd.hasPreviewImage,
  }
}

/**
 * 空壳分级：
 *   payload(有载荷+有 docId) / half-shell(有载荷但 docId=null——载荷在、身份缺，
 *   展示区若以 docId/identity 定位渲染资源则不可显示) / id-only(有身份无载荷) /
 *   empty-shell(全空)
 */
function shellGrade(snap) {
  const anyPayload = snap.hasPreviewImageUrl || snap.hasPdfData || snap.hasPreviewImage
  if (anyPayload) {
    if (empty(snap.docId)) return 'half-shell'
    return 'payload'
  }
  if (!empty(snap.docId)) return 'id-only'
  return 'empty-shell'
}

// ────────────────────────── 主判定 ──────────────────────────

function adjudicate(dump) {
  const out = []
  const push = (s) => out.push(s)
  const events = Array.isArray(dump.events) ? dump.events : []
  const counters = dump.counters || {}
  const issues = []

  // ── 0. 会话总览 ──
  push('══════════ 0 · 会话总览 ══════════')
  push(`enabled=${!!dump.enabled}  eventCount=${dump.eventCount}（events 数组实际 ${events.length}）  dropped=${dump.dropped}`)
  if (events.length) {
    const t0 = events[0].t
    const t1 = events[events.length - 1].t
    push(`时间轴跨度 ${t0}ms → ${t1}ms（${(t1 - t0).toFixed(0)}ms）`)
  }

  // ── 1. 事件数组 vs counters 一致性（防粘贴截断/防探针漏记）──
  push('')
  push('══════════ 1 · 证据完整性校验 ══════════')
  const recount = {}
  for (const ev of events) recount[ev.type] = (recount[ev.type] || 0) + 1
  let recountOk = true
  for (const k of Object.keys(counters)) {
    const want = counters[k]
    const got = recount[k] || 0
    const ok = dump.dropped > 0 ? got <= want : got === want
    if (!ok) recountOk = false
    push(`  ${ok ? '[PASS]' : '[FAIL]'} ${k.padEnd(24)} counters=${String(want).padStart(3)}  events实际=${String(got).padStart(3)}${dump.dropped ? '（含 dropped 淘汰，允许 ≤）' : ''}`)
  }
  for (const k of Object.keys(recount)) {
    if (!(k in counters)) { recountOk = false; push(`  [FAIL] counters 缺失类型 ${k}（events 有 ${recount[k]} 条）—— dump 可能来自不同会话或计数被清`) }
  }
  if (recountOk) push('  ⇒ 事件数组与 counters 一致，无截断/无漏记')
  else issues.push('事件数组与 counters 不一致——可能是粘贴截断，或探针自身缺陷，判读前先解决')

  // ── 2. 配平账目（硬校验）──
  push('')
  push('══════════ 2 · 事件配平（漏斗账目）══════════')
  const n = (t) => counters[t] || 0
  const HANDLE = n('HANDLE_PREVIEW'), DEB = n('DEBOUNCED')
  const SCHED = n('SCHED_DECISION')
  const START = n('START'), MERGE = n('MERGE_DEFERRED'), IGN = n('IGNORED'), INV = n('INVALIDATED')
  const LS = n('LOAD_START'), LR = n('LOAD_RETURN')
  const immediate = HANDLE - DEB

  // 校验 A：HANDLE = DEBOUNCED + 立即执行
  const aOk = immediate >= 0
  push(`  HANDLE(${HANDLE}) = DEBOUNCED(${DEB}) + 立即执行(${immediate})  ${aOk ? '[OK]' : '[FAIL: 立即执行为负，探针缺事件]'}`)

  // 校验 B：SCHED = START + MERGE + IGNORED + INVALIDATED
  const bSum = START + MERGE + IGN + INV
  const bOk = SCHED === bSum
  push(`  SCHED(${SCHED}) == START(${START}) + MERGE_DEFERRED(${MERGE}) + IGNORED(${IGN}) + INVALIDATED(${INV}) = ${bSum}  ${bOk ? '[PASS]' : '[FAIL]'}`)

  // 校验 C：立即执行 ≤ SCHED（多出的 SCHED 来自防抖到期执行）
  const expiry = SCHED - immediate
  const cOk = immediate <= SCHED && expiry >= 0 && expiry <= DEB
  push(`  立即执行(${immediate}) ≤ SCHED(${SCHED})；防抖到期执行 = ${expiry}（≤ DEBOUNCED ${DEB}）  ${cOk ? '[OK]' : '[FAIL]'}`)

  // 校验 D：START == LOAD_START == LOAD_RETURN
  const dOk = START === LS && LS === LR
  push(`  START(${START}) == LOAD_START(${LS}) == LOAD_RETURN(${LR})  ${dOk ? '[PASS]' : '[FAIL: 加载中段有非预期退出或探针漏记]'}`)

  if (!aOk || !bOk || !cOk || !dOk) issues.push('配平账目不过——事件漏斗不自洽，先修探针/重贴，勿直接下结论')

  // ── 3. R2-3 空壳判定：每次 COMMIT_* commit 了什么 ──
  push('')
  push('══════════ 3 · R2-3 COMMIT 内容审计（空壳判据）══════════')
  const commits = events.filter((ev) => COMMIT_KINDS.includes(ev.type) || ev.type === 'COMMIT_ATTEMPT')
  if (!commits.length) {
    push('  （无任何 COMMIT_* 事件）')
  }
  let emptyCommitted = 0
  let idOnlyCommitted = 0
  let halfShellCommitted = 0
  for (const ev of commits) {
    const snap = snapshotOf(ev)
    const grade = shellGrade(snap)
    const tag = ev.type === 'COMMIT_ATTEMPT' ? '尝试' : '✔'
    const flag = `[${snap.hasPreviewImageUrl ? 'T' : 'F'},${snap.hasPdfData ? 'T' : 'F'},${snap.hasPreviewImage ? 'T' : 'F'}]`
    if (ev.type !== 'COMMIT_ATTEMPT') {
      if (grade === 'empty-shell') emptyCommitted++
      if (grade === 'id-only') idOnlyCommitted++
      if (grade === 'half-shell') halfShellCommitted++
    }
    const mark = grade === 'payload' ? '  正常(载荷+docId)' : grade === 'half-shell' ? '  🟠 半壳(载荷在但 docId=null)' : grade === 'id-only' ? '  🟡 有身份无载荷' : '  🔴 空壳'
    push(`  seq=${String(ev.seq).padStart(3)} t=${String(ev.t).padStart(8)} ${ev.type.padEnd(22)} ${tag} key=${f(ev.fields, 'key')} docId=${snap.docId} img/pdf/img3=${flag}${mark}${ev.type === 'COMMIT_ATTEMPT' ? `（currentVersion=${f(ev.fields, 'currentVersion')}）` : ''}`)
  }
  if (emptyCommitted) push(`  ⇒ 🔴 空壳被 commit：${emptyCommitted} 次（docId=null + 三 flag 全 false）—— 「空壳被 commit」从静态嫌疑升级为 runtime 事实`)
  if (halfShellCommitted) push(`  ⇒ 🟠 半壳 commit：${halfShellCommitted} 次（docId=null 但有载荷）——「docId 就绪 ≠ 载荷就绪」的另一半：载荷先到、docId 后到；若展示区渲染以 docId/identity 定位资源，则半壳与空壳同样不可显示`)
  if (idOnlyCommitted) push(`  ⇒ 🟡 有身份无载荷 commit：${idOnlyCommitted} 次（docId 已就绪但载荷未到）——「docId 就绪 ≠ 载荷就绪」窗口的 runtime 证据`)
  if (emptyCommitted || halfShellCommitted || idOnlyCommitted) issues.push(`${emptyCommitted ? '空壳' : ''}${halfShellCommitted ? '半壳' : ''}${idOnlyCommitted ? 'id-only' : ''} commit 存在——若其后展示区空白，需要看这些 commit 是否被后续 SUCCESS 覆盖、中间有没有重试`)

  // ── 4. 末次 START 结局 + 全部 START 终局矩阵 ──
  push('')
  push('══════════ 4 · R2-2 每次 START 的终局（谁取消了/谁成功了）══════════')
  const starts = events.filter((ev) => ev.type === 'START')
  // 匹配：①优先同 key+同 version（同 key 多版本可并行在途，按 key 会错配）；
  //      ②无同 version 时退回同 key 最近未结
  const open = starts.map((s) => ({ ...s, ended: false, endType: null, endSeq: null, endAt: null }))
  const orphans = []
  for (const ev of events) {
    if (!TERMINAL.has(ev.type)) continue
    const key = f(ev.fields, 'key')
    const version = f(ev.fields, 'version')
    let hit = null
    if (version !== null && version !== undefined) {
      for (let i = open.length - 1; i >= 0; i--) {
        if (!open[i].ended && open[i].fields.key === key && open[i].fields.version === version) { hit = open[i]; break }
      }
    }
    if (!hit) {
      for (let i = open.length - 1; i >= 0; i--) {
        if (!open[i].ended && (open[i].fields.key === key || key === null)) { hit = open[i]; break }
      }
    }
    if (hit) { hit.ended = true; hit.endType = ev.type; hit.endSeq = ev.seq; hit.endAt = f(ev.fields, 'at') }
    else orphans.push(ev)
  }
  const unended = open.filter((s) => !s.ended)
  for (const s of open) {
    const snap = snapshotOf(s)
    const end = s.endType
      ? `${s.endType}${s.endType === 'ABORTED' ? `@${ABORT_LABEL[s.endAt] || s.endAt}` : ''}${s.endType === 'RESTART' ? `@${s.endAt}` : ''}`
      : '（dump 时点仍在途/悬空）'
    push(`  START seq=${String(s.seq).padStart(3)} t=${String(s.t).padStart(8)} key=${f(s.fields, 'key')} ver=${f(s.fields, 'version')} docId=${snap.docId}  →  ${end}`)
  }
  if (orphans.length) push(`  ⚠️ ${orphans.length} 个终局事件未匹配到 START（孤儿终局，seq=${orphans.map((o) => o.seq).join(',')}）`)
  const lastStart = starts.length ? starts[starts.length - 1] : null
  if (lastStart) {
    const lu = open.find((s) => s.seq === lastStart.seq)
    const luEnd = lu && lu.endType ? `${lu.endType}${lu.endType === 'ABORTED' ? '@' + (ABORT_LABEL[lu.endAt] || lu.endAt) : ''}${lu.endType === 'RESTART' ? '@' + lu.endAt : ''}` : '仍在途'
    push(`  ⇒ 末次 START（seq=${lastStart.seq}, key=${f(lastStart.fields, 'key')}）终局 = ${luEnd}`)
    if (lu && (lu.endType === 'ABORTED' || lu.endType === 'TERMINATED' || lu.endType === 'FUSE_BLOCK')) {
      push('     🔴 末次加载被取消——若这是自动预览的加载，展示区停留在上一次 commit（陈旧或空白）')
    }
    if (lu && !lu.endType) push('     🟡 末次加载在 dump 时点无终局——加载悬空（被中断/永不 commit）或会话提前 dump')
  } else {
    push('  （无 START 事件）')
    issues.push('会话中没有任何 START——自动预览从未进入加载，需查 AUTO_PREVIEW 分支为何全部未触发')
  }

  // ── 5. AUTO_PREVIEW 来源分支分布（R2-1）──
  push('')
  push('══════════ 5 · R2-1 自动预览来源分支（AUTO_PREVIEW）══════════')
  const branches = {}
  for (const ev of events) {
    if (ev.type !== 'AUTO_PREVIEW') continue
    const b = f(ev.fields, 'branch') || 'unknown'
    branches[b] = branches[b] || []
    branches[b].push(ev)
  }
  if (!Object.keys(branches).length) push('  （无 AUTO_PREVIEW 事件）')
  for (const [b, evs] of Object.entries(branches)) {
    const seqs = evs.map((e) => e.seq)
    push(`  ${b.padEnd(36)} ×${String(evs.length).padStart(2)}  seq=${seqs.join(',')}`)
    // 关键守卫字段透视（首条即可，同一分支守卫值通常同构）
    const probe = evs[evs.length - 1].fields
    const extra = Object.keys(probe || {}).filter((k) => k !== 'branch').map((k) => `${k}=${JSON.stringify(probe[k])}`).join(' ')
    if (extra) push(`      last: ${extra}`)
  }

  // ── 6. HANDLE_PREVIEW caller 来源（用户点击 vs 自动 vs docId-retry）──
  push('')
  push('══════════ 6 · R2-1 HANDLE_PREVIEW 调用来源（caller 栈）══════════')
  const byCaller = {}
  for (const ev of events) {
    if (ev.type !== 'HANDLE_PREVIEW') continue
    const c = ev.caller || 'unknown'
    byCaller[c] = byCaller[c] || []
    byCaller[c].push(ev)
  }
  if (!Object.keys(byCaller).length) push('  （无 HANDLE_PREVIEW）')
  for (const [c, evs] of Object.entries(byCaller)) {
    const intents = {}
    for (const e of evs) { const i = f(e.fields, 'intent') || '?'; intents[i] = (intents[i] || 0) + 1 }
    push(`  ${String(evs.length).padStart(2)}×  ${c}    intents=${Object.entries(intents).map(([k, v]) => `${k}×${v}`).join(' ')}`)
  }

  // ── 7. DOCID_RETRY 链（R2-4）──
  push('')
  push('══════════ 7 · R2-4 docId 重试链 ══════════')
  const retries = events.filter((ev) => ev.type.startsWith('DOCID_RETRY'))
  if (!retries.length) push('  （无 DOCID_RETRY_* 事件）')
  for (const ev of retries) {
    if (ev.type === 'DOCID_RETRY_SKIP') {
      push(`  seq=${String(ev.seq).padStart(3)} t=${String(ev.t).padStart(8)} SKIP reason=${f(ev.fields, 'reason')} ${f(ev.fields, 'reason') === 'no-previewFile' ? '(previewFile 为 null——若出现在「本应已自动预览成功」之后=凝固证据)' : ''}`)
    } else {
      push(`  seq=${String(ev.seq).padStart(3)} t=${String(ev.t).padStart(8)} EVAL pfKey=${f(ev.fields, 'pfKey')} pfDocId=${f(ev.fields, 'pfDocId')} liveDocId=${f(ev.fields, 'liveDocId')} changed=${f(ev.fields, 'changed')}${f(ev.fields, 'changed') ? ' → 走 refresh 重试' : ' → 不重试（docId 未变，载荷维度本 effect 不救）'}`)
    }
  }

  // ── 8. 静默窗口（空壳 commit 后无人重试的凝固证据）──
  push('')
  push('══════════ 8 · 静默窗口（相邻事件最大 t 间隔 Top5）══════════')
  const gaps = []
  for (let i = 1; i < events.length; i++) {
    gaps.push({ gap: events[i].t - events[i - 1].t, from: events[i - 1], to: events[i] })
  }
  gaps.sort((a, b) => b.gap - a.gap)
  const top = gaps.slice(0, 5)
  if (!top.length) push('  （事件 <2，无间隔可算）')
  for (const g of top) {
    push(`  ${g.gap.toFixed(0)}ms  ${g.from.type}(seq=${g.from.seq}, key=${f(g.from.fields, 'key')}) → ${g.to.type}(seq=${g.to.seq}, key=${f(g.to.fields, 'key')})`)
  }

  // ── 9. 综合判定 ──
  push('')
  push('══════════ 9 · 综合判定 ══════════')
  if (issues.length) {
    for (const i of issues) push(`  ⚠️ ${i}`)
  }
  const lastCommit = [...events].reverse().find((ev) => COMMIT_KINDS.includes(ev.type))
  const lastCommitEmpty = lastCommit && shellGrade(snapshotOf(lastCommit)) !== 'payload'
  const lastStartEndedAborted = (() => {
    const lu = lastStart ? open.find((s) => s.seq === lastStart.seq) : null
    return lu && (lu.endType === 'ABORTED' || lu.endType === 'TERMINATED' || lu.endType === 'FUSE_BLOCK')
  })()

  const verdicts = []
  if (emptyCommitted) verdicts.push(`🔴 空壳 commit ×${emptyCommitted} —— 已由 runtime 证据坐实（此前为静态嫌疑）`)
  if (halfShellCommitted) verdicts.push(`🟠 半壳 commit ×${halfShellCommitted}（载荷在但 docId=null）——若展示区以 docId/identity 定位资源，半壳 commit 后同样空白且屏蔽后续重试`)
  if (lastCommitEmpty && !lastStartEndedAborted && !unended.length) {
    const grade = lastCommit && shellGrade(snapshotOf(lastCommit))
    verdicts.push(`🔴 展示区空白的机制证据链完整：最后一次 commit 内容不可展示（${grade}），其后无重试（见静默窗口）——「自动预览失效」=「${grade} commit 后无人覆盖」`)
  } else if (!lastCommitEmpty && lastCommit && !unended.length) {
    verdicts.push('🟢 最后一次 commit 有载荷且有 docId——若展示区仍空白，问题不在 commit 内容而在 commit 之后（渲染/资源解析），或你 dump 的是对照组会话')
  }
  if (lastStartEndedAborted) verdicts.push('🟡 末次 START 终结于取消（abort/terminate/fuse）——展示区可能停在更早的陈旧 commit')
  if (unended.length) verdicts.push(`🟡 ${unended.length} 个 START 悬空未终结——加载被中断或会话提前 dump`)
  if (!Object.keys(branches).length && !counters.HANDLE_PREVIEW) verdicts.push('🟡 全程无任何自动预览/手动预览事件——探针是否在复现前 enable+reset？')
  if (!verdicts.length) verdicts.push('（数据不足以给出判定，参见上方明细）')
  for (const v of verdicts) push(`  ${v}`)

  console.log(out.join('\n'))
  return { ok: recountOk, issues, commits: { empty: emptyCommitted, idOnly: idOnlyCommitted }, verdicts }
}

// ────────────────────────── CLI ──────────────────────────

function readInput(file) {
  if (file === '-') return fs.readFileSync(0, 'utf8')
  return fs.readFileSync(file, 'utf8')
}

function normalize(dump) {
  // DevTools 直接 Ctrl+V 粘贴时可能带前后缀/缩进，宽容处理：events 缺失则尝试取嵌套
  if (!dump.events && dump.d && Array.isArray(dump.d.events)) return dump.d
  return dump
}

const arg = process.argv[2]
if (arg === '--selftest') {
  // ── 合成场景自检 ──
  const mk = (type, fields, seq, t, caller) => ({ seq, t, type, caller: caller || 'test', fields })
  const healthy = { enabled: true, eventCount: 5, dropped: 0, counters: { HANDLE_PREVIEW: 2, DEBOUNCED: 1, SCHED_DECISION: 2, START: 2, LOAD_START: 2, LOAD_RETURN: 2, COMMIT_ATTEMPT: 2, COMMIT_SUCCESS: 2 }, events: [] }
  let seq = 1
  healthy.events = [
    mk('HANDLE_PREVIEW', { intent: 'select', key: 'K1', docId: null, version: 0 }, seq++, 0, 'App.jsx:1002:9'),
    mk('HANDLE_PREVIEW', { intent: 'select', key: 'K2', docId: 'D2', version: 0 }, seq++, 60, 'FileList.jsx:440:11'),
    mk('DEBOUNCED', { key: 'K2', intent: 'select', sinceLastSwitchMs: 30, hadPendingTimer: false }, seq++, 61, 'handlePreview:debounce'),
    mk('SCHED_DECISION', { source: 'handlePreview:immediate', intent: 'select', key: 'K1', action: 'start-execution', version: 1 }, seq++, 0, 'doLoadPreview:handlePreview:immediate'),
    mk('START', { source: 'handlePreview:immediate', intent: 'select', key: 'K1', version: 1, docId: 'D1', hasPreviewImageUrl: true, hasPdfData: false, hasPreviewImage: false }, seq++, 2, 'doLoadPreview:handlePreview:immediate'),
    mk('LOAD_START', { iter: 0, key: 'K1', version: 1, docId: 'D1' }, seq++, 3, 'loadFilePreview'),
    mk('LOAD_RETURN', { iter: 0, key: 'K1', version: 1, docId: 'D1', hasPreviewImageUrl: true, hasPdfData: false, hasPreviewImage: false }, seq++, 400, 'loadFilePreview'),
    mk('COMMIT_ATTEMPT', { key: 'K1', version: 1, currentVersion: 1, docId: 'D1', hasPreviewImageUrl: true, hasPdfData: false, hasPreviewImage: false }, seq++, 401, 'commit:normal'),
    mk('COMMIT_SUCCESS', { key: 'K1', version: 1, docId: 'D1', hasPreviewImageUrl: true, hasPdfData: false, hasPreviewImage: false }, seq++, 402, 'commit:normal'),
  ]
  // healthy 场景的 SCHED==START 校验：上面 HANDLE 2 = DEB 1 + immediate 1，但 SCHED 2 含一个 timeout 执行 → 需补一个 timeout 分支
  // 补：SCHED 第二个来自 K2 的防抖到期执行
  healthy.events.splice(healthy.events.length, 0,
    mk('SCHED_DECISION', { source: 'handlePreview:timeout', intent: 'select', key: 'K2', action: 'start-execution', version: 1 }, seq++, 210, 'doLoadPreview:handlePreview:timeout'),
    mk('START', { source: 'handlePreview:timeout', intent: 'select', key: 'K2', version: 1, docId: 'D2', hasPreviewImageUrl: false, hasPdfData: true, hasPreviewImage: false }, seq++, 211, 'doLoadPreview:handlePreview:timeout'),
    mk('LOAD_START', { iter: 0, key: 'K2', version: 1, docId: 'D2' }, seq++, 212, 'loadFilePreview'),
    mk('LOAD_RETURN', { iter: 0, key: 'K2', version: 1, docId: 'D2', hasPreviewImageUrl: false, hasPdfData: true, hasPreviewImage: false }, seq++, 800, 'loadFilePreview'),
    mk('COMMIT_ATTEMPT', { key: 'K2', version: 1, currentVersion: 1, docId: 'D2', hasPreviewImageUrl: false, hasPdfData: true, hasPreviewImage: false }, seq++, 801, 'commit:normal'),
    mk('COMMIT_SUCCESS', { key: 'K2', version: 1, docId: 'D2', hasPreviewImageUrl: false, hasPdfData: true, hasPreviewImage: false }, seq++, 802, 'commit:normal'),
  )
  healthy.eventCount = healthy.events.length
  healthy.counters.SCHED_DECISION = 2; healthy.counters.START = 2; healthy.counters.LOAD_START = 2; healthy.counters.LOAD_RETURN = 2
  healthy.counters.COMMIT_ATTEMPT = 2; healthy.counters.COMMIT_SUCCESS = 2

  const emptyShell = { enabled: true, eventCount: 0, dropped: 0, counters: { AUTO_PREVIEW: 1, HANDLE_PREVIEW: 1, SCHED_DECISION: 1, START: 1, LOAD_START: 1, LOAD_RETURN: 1, COMMIT_ATTEMPT: 1, COMMIT_SUCCESS: 1, DOCID_RETRY_EVAL: 1 }, events: [] }
  seq = 1
  emptyShell.events = [
    mk('AUTO_PREVIEW', { branch: 'App:scenario-2-docid-arrives', firstDocId: 'D1', pvHasDocumentId: false, hasPreviewFile: false }, seq++, 100, 'App:auto-preview'),
    mk('HANDLE_PREVIEW', { intent: 'select', key: 'K1', docId: null, version: 0 }, seq++, 101, 'App.jsx:1018:9'),
    mk('SCHED_DECISION', { source: 'handlePreview:immediate', intent: 'select', key: 'K1', action: 'start-execution', version: 1 }, seq++, 102, 'doLoadPreview:handlePreview:immediate'),
    mk('START', { source: 'handlePreview:immediate', intent: 'select', key: 'K1', version: 1, docId: null, hasPreviewImageUrl: false, hasPdfData: false, hasPreviewImage: false }, seq++, 103, 'doLoadPreview:handlePreview:immediate'),
    mk('LOAD_START', { iter: 0, key: 'K1', version: 1, docId: null }, seq++, 104, 'loadFilePreview'),
    mk('LOAD_RETURN', { iter: 0, key: 'K1', version: 1, docId: null, hasPreviewImageUrl: false, hasPdfData: false, hasPreviewImage: false }, seq++, 500, 'loadFilePreview'),
    mk('COMMIT_ATTEMPT', { key: 'K1', version: 1, currentVersion: 1, docId: null, hasPreviewImageUrl: false, hasPdfData: false, hasPreviewImage: false }, seq++, 501, 'commit:normal'),
    mk('COMMIT_SUCCESS', { key: 'K1', version: 1, docId: null, hasPreviewImageUrl: false, hasPdfData: false, hasPreviewImage: false }, seq++, 502, 'commit:normal'),
    mk('DOCID_RETRY_EVAL', { pfKey: 'K1', pfDocId: null, liveDocId: null, changed: false }, seq++, 700, 'usePreview:docid-retry'),
  ]
  emptyShell.eventCount = emptyShell.events.length

  console.log('——— selftest: 健康收敛（应无空壳、末次 START=COMMIT_SUCCESS payload）———')
  const r1 = adjudicate(healthy)
  console.log('——— selftest: 空壳复现（应判 1 次空壳 commit、末次 START=SUCCESS 空壳、retry changed=false 不救）———')
  const r2 = adjudicate(emptyShell)

  const failures = []
  if (!r1.ok) failures.push('健康场景一致性校验失败')
  if (r1.commits.empty !== 0) failures.push('健康场景误判空壳')
  if (r2.commits.empty !== 1) failures.push('空壳场景漏判（期望 1 次空壳）')
  if (!r2.verdicts.some((v) => v.includes('空壳'))) failures.push('空壳场景未产出空壳判定')
  console.log(failures.length ? `\nSELFTEST FAIL:\n${failures.join('\n')}` : '\nSELFTEST PASS')
  process.exit(failures.length ? 1 : 0)
}

if (!arg) {
  console.error('用法: node outputs/preview-r2-adjudicate.mjs <dump.json> | - | --selftest')
  process.exit(2)
}

let raw
try {
  raw = readInput(arg)
} catch (e) {
  console.error(`读文件失败: ${e.message}`)
  process.exit(1)
}
let dump
try {
  dump = normalize(JSON.parse(raw))
} catch (e) {
  console.error(`JSON 解析失败（贴入内容可能被截断或含注释）: ${e.message}`)
  process.exit(1)
}
adjudicate(dump)
