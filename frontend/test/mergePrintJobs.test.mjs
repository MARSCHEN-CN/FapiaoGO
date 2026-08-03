/**
 * Commit 3 验收测试：doPrint merge 分支消费 MERGE Plan 的等价性
 *
 * 命门（用户定稿）：A1.5 已证 newPlan == oldPlan（结构等价）；
 * 本测试锁定「legacy doPrint executor input == new plan executor input」——
 * 即旧 `parsedFiles.slice(i,i+groupSize)` 产生的分组参数序列，
 * 必须等于 `deriveMergePrintJobs(plan, files)` 产生的分组序列。
 *
 * 同时包含用户要求的 Merge Execution Snapshot：
 *   [A,B,C,D,E] merge2 → [["A","B"],["C","D"],["E"]]
 *   [A,B,C,C,D,E] merge4 → [["A","B","C","D"],["E"]]
 *
 * 不重新实现第二份旧逻辑：legacy 分组以 buildLegacyPrintPlan（A1.5 Oracle）为唯一基线。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPrintExecutionPlan, MERGE_FILE_FILTER } from '../src/print/buildPrintExecutionPlan.js'
import { deriveMergePrintJobs } from '../src/print/deriveMergePrintJobs.js'
import { buildLegacyPrintPlan } from '../src/print/buildLegacyPrintPlan.js'
import { normalizePlan, compareLegacyPlan } from '../src/print/compareLegacyPlan.js'
import { getForcedLandscape } from '../src/utils/mergeMode.js'

function mk(key, over = {}) {
  return {
    key,
    name: `${key}.pdf`,
    status: 'parsed',
    printPath: `/${key}.pdf`,
    fileFormat: 'pdf',
    ...over,
  }
}

// [A,B,C,D,E] 五个已解析 PDF
const five = ['A', 'B', 'C', 'D', 'E'].map((k) => mk(k))

function groupsOf(files, mergeMode, fileRotations = {}) {
  const plan = buildPrintExecutionPlan(files, { filter: MERGE_FILE_FILTER, settings: { mergeMode }, fileRotations })
  return deriveMergePrintJobs(plan, files).map((j) => j.files.map((f) => f.key))
}

test('Merge Execution Snapshot: merge2 分组 = [A,B],[C,D],[E]', () => {
  assert.deepStrictEqual(groupsOf(five, 'merge2'), [['A', 'B'], ['C', 'D'], ['E']])
})

test('Merge Execution Snapshot: merge4 分组 = [A,B,C,D],[E]', () => {
  assert.deepStrictEqual(groupsOf(five, 'merge4'), [['A', 'B', 'C', 'D'], ['E']])
})

test('merge3 分组 = [A,B,C],[D,E]', () => {
  assert.deepStrictEqual(groupsOf(five, 'merge3'), [['A', 'B', 'C'], ['D', 'E']])
})

test('Equivalence vs Legacy Oracle：merge2 分组序列逐组相等', () => {
  const plan = buildPrintExecutionPlan(five, { filter: MERGE_FILE_FILTER, settings: { mergeMode: 'merge2' } })
  const jobs = deriveMergePrintJobs(plan, five)
  const legacy = normalizePlan(buildLegacyPrintPlan(five, { settings: { mergeMode: 'merge2' } }))
  const a = jobs.map((j) => ({ fileIds: j.files.map((f) => f.key), orientation: j.orientation }))
  const b = legacy.map((p) => ({ fileIds: p.fileIds, orientation: p.orientation }))
  assert.deepStrictEqual(a, b)
})

test('Equivalence vs Legacy Oracle：merge4 分组序列逐组相等', () => {
  const plan = buildPrintExecutionPlan(five, { filter: MERGE_FILE_FILTER, settings: { mergeMode: 'merge4' } })
  const jobs = deriveMergePrintJobs(plan, five)
  const legacy = normalizePlan(buildLegacyPrintPlan(five, { settings: { mergeMode: 'merge4' } }))
  const a = jobs.map((j) => ({ fileIds: j.files.map((f) => f.key), orientation: j.orientation }))
  const b = legacy.map((p) => ({ fileIds: p.fileIds, orientation: p.orientation }))
  assert.deepStrictEqual(a, b)
})

test('error 状态文件（有 printPath）参与 merge 分组', () => {
  const files = [mk('A'), mk('B', { status: 'error' }), mk('C')]
  // MERGE_FILE_FILTER 允许 error；故 [A,B],[C]
  assert.deepStrictEqual(groupsOf(files, 'merge2'), [['A', 'B'], ['C']])
})

test('OFD 需 docId 或 previewImage 方过 MERGE 过滤', () => {
  const ofdDoc = mk('O', { fileFormat: 'ofd', docId: 'doc-o', name: 'O.ofd', printPath: '/O.ofd' })
  const ofdNoDoc = mk('N', { fileFormat: 'ofd', name: 'N.ofd', printPath: '/N.ofd' }) // 缺 docId/previewImage
  const files = [mk('A'), ofdDoc, ofdNoDoc]
  // N 被过滤 → sourceFiles=[A,O] → 单组 [A,O]
  assert.deepStrictEqual(groupsOf(files, 'merge2'), [['A', 'O']])
})

test('orientation：merge4→landscape，merge2→portrait（与 getForcedLandscape 一致）', () => {
  const p4 = buildPrintExecutionPlan(five, { filter: MERGE_FILE_FILTER, settings: { mergeMode: 'merge4' } })
  assert.strictEqual(p4.pages[0].orientation, 'landscape')
  const p2 = buildPrintExecutionPlan(five, { filter: MERGE_FILE_FILTER, settings: { mergeMode: 'merge2' } })
  assert.strictEqual(p2.pages[0].orientation, 'portrait')
  // deriveMergePrintJobs 透传 orientation
  const jobs4 = deriveMergePrintJobs(p4, five)
  assert.strictEqual(jobs4[0].orientation, getForcedLandscape('merge4', false) ? 'landscape' : 'portrait')
  assert.strictEqual(jobs4[0].orientation, 'landscape')
})

test('groupIndex 顺序连续 0,1,2（merge2）', () => {
  const plan = buildPrintExecutionPlan(five, { filter: MERGE_FILE_FILTER, settings: { mergeMode: 'merge2' } })
  const jobs = deriveMergePrintJobs(plan, five)
  assert.deepStrictEqual(jobs.map((j) => j.groupIndex), [0, 1, 2])
})

test('每文件 slot rotation 随 fileRotations 透传（等价性含 rotation）', () => {
  const rot = { A: 90, B: 0, C: 180, D: 0, E: 270 }
  const plan = buildPrintExecutionPlan(five, { filter: MERGE_FILE_FILTER, settings: { mergeMode: 'merge2' }, fileRotations: rot })
  const jobs = deriveMergePrintJobs(plan, five)
  const legacy = normalizePlan(buildLegacyPrintPlan(five, { settings: { mergeMode: 'merge2' }, fileRotations: rot }))
  const a = jobs.map((j) => ({ fileIds: j.files.map((f) => f.key) }))
  const b = legacy.map((p) => ({ fileIds: p.fileIds }))
  assert.deepStrictEqual(a, b)
  // 校验 rotation 值也保留在 plan slots（renderFn 内部会据此构图）
  assert.deepStrictEqual(plan.pages[0].slots.map((s) => s.rotation), [90, 0])
})

test('compareLegacyPlan 在 merge 模式返回 match=true（影子比较 helper 覆盖 merge）', () => {
  const plan = buildPrintExecutionPlan(five, { filter: MERGE_FILE_FILTER, settings: { mergeMode: 'merge2' } })
  const r = compareLegacyPlan(plan, { files: five, settings: { mergeMode: 'merge2' } })
  assert.strictEqual(r.match, true)
})
