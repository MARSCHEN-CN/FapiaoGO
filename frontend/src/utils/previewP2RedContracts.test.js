/**
 * previewP2RedContracts.test.js — P2-X2/X3 契约红测试（2026-09-04）
 *
 * 状态：🔴 本文件在 X2/X3 最小实现落地前保持「红」——这是预期，不是事故。
 *   X2/X3 的生产逻辑现在内联在 usePreview.js（debounce L2102-2124 / commit fuse L1766），
 *   没有可测纯 seam。本文件先钉住「将要新增到决策层的纯函数契约」：
 *     - resolveDebouncePrecedence(pending, incoming) → { intent, key }   （X2）
 *     - isDisplayablePreview(file) → boolean                            （X3）
 *   seam 落地前：每测抛 `TypeError: sched.resolveDebouncePrecedence is not a function`
 *   （导入正常、调用缺失导出）= 契约已钉、实现未到。
 *   seam 落地后：本文件整体转绿 = 验收。
 *
 * 运行：node --test src/utils/previewP2RedContracts.test.js
 * Runtime 依据：outputs/perf-runs/preview-r2-8files-20260904.json
 *   - X2: seq 55-60 App scenario-2/3 select（docId=d8bf968f 已就绪）进 debounce
 *         → seq 61-63 auto-nav-3 refresh 同 key 后到，无脑 clearTimeout 顶掉 select → 意图丢失
 *   - X3: seq 38-43 v6 半壳（docId=null + _pdfData=true）COMMIT_SUCCESS → 展示区空白固化
 *
 * 契约草案（step 5 冻结）：
 *   resolveDebouncePrecedence(pending, incoming)：
 *     - pending 为 null 或 key 不同        → { intent: incoming.intent, key: incoming.key }（新 selection 覆盖）
 *     - pending select + incoming refresh（同 key）→ { intent: 'select', key }  ← 保留 select，不降级（本文件核心）
 *     - 其余（refresh→select 升级 / 同 intent）    → { intent: incoming.intent, key }
 *     hook 用法：以返回值的 intent 重排定时器（payload 一律取 incoming 最新引用），
 *     绝不直接用 incoming.intent 覆盖 pending select。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as sched from './previewScheduler.js'

// ════════════════════════════════════════════════════════════
// P2-X2 — debounce 意图优先级（同窗口 select + refresh → select 必须赢）
// ════════════════════════════════════════════════════════════

test('P2-X2-1: pending select + incoming refresh（同 key）→ 保留 select（不降级为 refresh）', () => {
  // dump seq 55-63：scenario-2/3 select(docId 就绪) 被 auto-nav-3 refresh 顶掉 → 意图丢失
  const effective = sched.resolveDebouncePrecedence(
    { intent: 'select', key: 'K' },
    { intent: 'refresh', key: 'K' },
  )
  assert.equal(effective.intent, 'select',
    'docId-ready select 是唯一能 supersede 僵尸 transaction 的意图，不得被普通 refresh 顶掉')
  assert.equal(effective.key, 'K')
})

test('P2-X2-2: pending refresh + incoming select（同 key）→ 升级为 select', () => {
  const effective = sched.resolveDebouncePrecedence(
    { intent: 'refresh', key: 'K' },
    { intent: 'select', key: 'K' },
  )
  assert.equal(effective.intent, 'select', 'select 语义（++version supersede）必须胜出')
})

test('P2-X2-3: 不同 key → incoming 覆盖（新 selection，INV-PS3）', () => {
  const effective = sched.resolveDebouncePrecedence(
    { intent: 'select', key: 'K' },
    { intent: 'select', key: 'L' },
  )
  assert.equal(effective.key, 'L', '新 key 的 selection 必须覆盖 pending')
  assert.equal(effective.intent, 'select')
})

test('P2-X2-4: 同 key 同 intent（refresh+refresh / select+select）→ last-wins incoming', () => {
  const r = sched.resolveDebouncePrecedence(
    { intent: 'refresh', key: 'K' },
    { intent: 'refresh', key: 'K' },
  )
  assert.equal(r.intent, 'refresh')
  const s2 = sched.resolveDebouncePrecedence(
    { intent: 'select', key: 'K' },
    { intent: 'select', key: 'K' },
  )
  assert.equal(s2.intent, 'select', 'INV-PS3：同 key 连续 select 仍 select')
})

test('P2-X2-5: pending 为 null（首拍）→ 直接用 incoming', () => {
  const effective = sched.resolveDebouncePrecedence(null, { intent: 'refresh', key: 'K' })
  assert.equal(effective.intent, 'refresh')
  assert.equal(effective.key, 'K')
})

// ════════════════════════════════════════════════════════════
// P2-X3 — 半壳 commit gate（不可展示快照不得成为 committed preview）
// 字段口径对齐 previewTrace.snapshotFlags（_pdfData/_previewImageUrl）+ docIdOf
// （identity.docId 或 docId 任一非空即视为身份就绪）
// ════════════════════════════════════════════════════════════

test('P2-X3-1: pdf-backed 半壳（_pdfData=true, docId=null）→ 不可 commit', () => {
  // dump seq 43 v6 半壳：docId=null + pdfData=true → COMMIT_SUCCESS → DisplayAdapter miss → 空白
  const halfShell = { key: '26317000', _pdfData: true, docId: null, identity: { docId: null } }
  assert.equal(sched.isDisplayablePreview(halfShell), false,
    'pdf-backed 快照无 docId → DocumentStore 按 docId 哈希 miss → 展示空白，禁止 commit')
})

test('P2-X3-2: pdf-backed 且 docId 就绪 → 可 commit', () => {
  const ready = { key: '26317000', _pdfData: true, docId: 'd8bf968f' }
  assert.equal(sched.isDisplayablePreview(ready), true)
  const readyViaIdentity = { key: 'K', _pdfData: true, identity: { docId: 'abc123' } }
  assert.equal(sched.isDisplayablePreview(readyViaIdentity), true, 'identity.docId 注入（4.1.3）同样就绪')
})

test('P2-X3-3: pdf split-page（sourceDocId 存在）→ 以 sourceDocId 判定就绪', () => {
  // 对齐 usePreview.js L1993-1994：isParsedSplitPage = sourceDocId && docId !== sourceDocId
  const splitReady = { key: 'P', _pdfData: true, sourceDocId: 'srcDoc1', docId: 'pageDoc2' }
  assert.equal(sched.isDisplayablePreview(splitReady), true, 'split-page 用 sourceDocId 寻档')
})

test('P2-X3-4: 纯图像（_previewImageUrl 就绪，不经 DocumentStore）→ 无 docId 也允许', () => {
  const image = { key: 'IMG', _previewImageUrl: 'blob:preview', _fileFormat: 'image/png' }
  assert.equal(sched.isDisplayablePreview(image), true, '图像预览不依赖 docId 哈希，不误伤')
})

test('P2-X3-5: null / 空对象 → 不可 commit', () => {
  assert.equal(sched.isDisplayablePreview(null), false)
  assert.equal(sched.isDisplayablePreview(undefined), false)
})
