/**
 * aggregatedSourceIdentity.test — 聚合源 identity 的旋转/placement 继承回归
 *
 * R-2 背景：normalizePrintSources 把多页完整选择聚合成 key='__source_<groupKey>'
 * 的单一 source 目标（buildPrintExecutionPlan.js:170），但 fileRotations /
 * placements 两个 map 仍按【原始页 key】键控。聚合对象的 key 在两个 map 中
 * 均查不到 → 用户对多页 PDF 的 UI 旋转与布局在聚合打印时静默丢失（恒 0/null）。
 *
 * 修复（方案 A）：聚合对象保留 _sourceOriginalKey（= representative 原始 key），
 * 查询统一走 resolveSourceIdentity.js 的 fallback（聚合 key → 原始 key → default）。
 *
 * 冻结边界：不改 fileRotations/placements 数据结构、不改聚合模型、不触碰
 * PrintPreviewModel / Sumatra / margin contract。
 *
 * @module print/__tests__/aggregatedSourceIdentity
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFileRotation, resolveFilePlacement } from '../resolveSourceIdentity.js'
import { buildPrintExecutionPlan } from '../buildPrintExecutionPlan.js'

// ─── fixture ───

const AGGREGATED_FILE = {
  key: '__source_inst-1::doc-1',
  _isAggregatedSource: true,
  _sourceOriginalKey: 'page-1',
  printPath: '/path/to/file.pdf',
  fileFormat: 'pdf',
  status: 'parsed',
  name: 'file.pdf',
  instanceId: 'inst-1',
  sourceDocId: 'doc-1',
  pageNum: 0,
  totalPages: 3,
}

const ORIGINAL_FILE = {
  key: 'page-1',
  printPath: '/path/to/file.pdf',
  fileFormat: 'pdf',
  status: 'parsed',
  name: 'file.pdf',
  instanceId: 'inst-1',
  sourceDocId: 'doc-1',
  pageNum: 0,
  totalPages: 3,
}

const FILE_ROTATIONS = { 'page-1': 90 }
const PLACEMENTS = { 'page-1': { x: 10, y: 10, scale: 1, offsetX: 0, offsetY: 0 } }

// ─── T1: 聚合源 rotation fallback（resolver = buildPrintSettings 内部同源逻辑） ───

test('T1: aggregated source falls back to original key for rotation', () => {
  // 当前代码（红）：fileRotations['__source_inst-1::doc-1'] miss → 0
  // 修复后（绿）：fileRotations['page-1']=90 → 90
  assert.equal(resolveFileRotation(AGGREGATED_FILE, FILE_ROTATIONS), 90,
    'rotation 应从 _sourceOriginalKey fallback')
})

// ─── T2: 聚合源 placement fallback（resolver + plan 层集成） ───

test('T2: aggregated source falls back to original key for placement', () => {
  // resolver 层
  const placement = resolveFilePlacement(AGGREGATED_FILE, PLACEMENTS)
  assert.ok(placement, 'placement 应从 _sourceOriginalKey fallback（非 null）')

  // plan 层集成（buildPrintExecutionPlan 的 perFilePlacement/perFileRotation 消费同一 resolver）
  const plan = buildPrintExecutionPlan(
    [AGGREGATED_FILE],
    { settings: { mergeMode: 'none' }, fileRotations: FILE_ROTATIONS, placements: PLACEMENTS },
  )
  const slot = plan.pages[0].slots[0]
  assert.ok(slot.placement, 'plan slot placement 非 null')
  assert.equal(slot.contentRotation, 90, 'plan slot contentRotation 应 fallback')
})

// ─── T3: 普通单页零变化 ───

test('T3: single-page file keeps direct key lookup (no behavior change)', () => {
  assert.equal(resolveFileRotation(ORIGINAL_FILE, FILE_ROTATIONS), 90)
  assert.ok(resolveFilePlacement(ORIGINAL_FILE, PLACEMENTS))
  const plan = buildPrintExecutionPlan(
    [ORIGINAL_FILE],
    { settings: { mergeMode: 'none' }, fileRotations: FILE_ROTATIONS, placements: PLACEMENTS },
  )
  assert.equal(plan.pages[0].slots[0].contentRotation, 90)
  assert.ok(plan.pages[0].slots[0].placement)
})

// ─── T4: 无 fallback 的默认行为保持安全 ───

test('T4: aggregated source without _sourceOriginalKey keeps defaults (0 / null)', () => {
  const bare = { ...AGGREGATED_FILE, _sourceOriginalKey: undefined }
  assert.equal(resolveFileRotation(bare, FILE_ROTATIONS), 0)
  assert.equal(resolveFilePlacement(bare, PLACEMENTS), null)
})
