/**
 * previewPolicyRedContracts.test.js — P2-X3 契约红测试（2026-09-04）
 *
 * 状态：🔴 本文件在 X3 最小实现落地前保持「红」——这是预期，不是事故。
 *   seam = 新纯模块 `src/utils/previewPolicy.js`（P2-GATE 决定：displayability 属于
 *   preview snapshot policy，不属于 transaction scheduler，故不塞 previewScheduler.js）。
 *   模块尚不存在 → import 阶段 `ERR_MODULE_NOT_FOUND` → 文件级红（契约已钉、实现未到）。
 *   seam 落地后：本文件整体转绿 = 验收。
 *
 * 运行：node --test src/utils/previewPolicyRedContracts.test.js
 * Runtime 依据：outputs/perf-runs/preview-r2-8files-20260904.json
 *   X3: seq 38-43 v6 半壳（docId=null + _pdfData=true）COMMIT_SUCCESS → 展示区空白固化
 *
 * 范围纪律（P2-GATE 重申）：
 *   isDisplayablePreview 是 **commit eligibility predicate**——只回答
 *   「这个 snapshot 能不能成为 committed preview？」；不得滚成第二套渲染判断。
 *   只依赖冻结事实：effective docId（identity.docId/docId/split-page sourceDocId）、
 *   _pdfData、_previewImageUrl、_fileFormat。不 import、不触碰 DisplayAdapter。
 *
 * 字段口径：
 *   - pdf-backed = _pdfData 或 _fileFormat==='pdf'
 *   - split-page（对齐 usePreview.js L1993：sourceDocId && docId !== sourceDocId）
 *     → 以 sourceDocId 作为 effective docId 判定
 *   - 纯图像（_previewImageUrl 就绪、非 pdf-backed）不经 DocumentStore → 无 docId 也允许
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as policy from './previewPolicy.js'

// ════════════════════════════════════════════════════════════
// P2-X3 — 半壳 commit gate（不可展示快照不得成为 committed preview）
// ════════════════════════════════════════════════════════════

test('P2-X3-1: pdf-backed 半壳（_pdfData=true, docId=null）→ 不可 commit', () => {
  // dump seq 43 v6 半壳：docId=null + pdfData=true → COMMIT_SUCCESS → DisplayAdapter miss → 空白
  const halfShell = { key: '26317000', _pdfData: true, docId: null, identity: { docId: null } }
  assert.equal(policy.isDisplayablePreview(halfShell), false,
    'pdf-backed 快照无 docId → DocumentStore 按 docId 哈希 miss → 展示空白，禁止 commit')
})

test('P2-X3-2: pdf-backed 且 docId 就绪 → 可 commit', () => {
  const ready = { key: '26317000', _pdfData: true, docId: 'd8bf968f' }
  assert.equal(policy.isDisplayablePreview(ready), true)
  const readyViaIdentity = { key: 'K', _pdfData: true, identity: { docId: 'abc123' } }
  assert.equal(policy.isDisplayablePreview(readyViaIdentity), true, 'identity.docId 注入（4.1.3）同样就绪')
})

test('P2-X3-3: pdf split-page（sourceDocId 存在）→ 以 sourceDocId 判定就绪', () => {
  // 对齐 usePreview.js L1993-1994：isParsedSplitPage = sourceDocId && docId !== sourceDocId
  const splitReady = { key: 'P', _pdfData: true, sourceDocId: 'srcDoc1', docId: 'pageDoc2' }
  assert.equal(policy.isDisplayablePreview(splitReady), true, 'split-page 用 sourceDocId 寻档')
})

test('P2-X3-4: 纯图像（_previewImageUrl 就绪，不经 DocumentStore）→ 无 docId 也允许', () => {
  const image = { key: 'IMG', _previewImageUrl: 'blob:preview', _fileFormat: 'image/png' }
  assert.equal(policy.isDisplayablePreview(image), true, '图像预览不依赖 docId 哈希，不误伤')
})

test('P2-X3-5: null / 空对象 → 不可 commit', () => {
  assert.equal(policy.isDisplayablePreview(null), false)
  assert.equal(policy.isDisplayablePreview(undefined), false)
})
