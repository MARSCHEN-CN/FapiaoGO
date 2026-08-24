/**
 * deriveSourcePrintJobs.multiPageSource.test — 多页 PDF 聚合源打印 job 派生回归测试
 *
 * 回归背景（2026-08-24）：
 *   da3dee4（R2 metadata 把真实页数 materialize 到 fileObj.pageCount）激活了
 *   normalizePrintSources 聚合路径后，executePrint 的 source 分支用「原始 files」
 *   调用 deriveSourcePrintJobs，而 plan 的 source identity 来自「归一化 planFiles」
 *   （聚合源 key = __source_<instanceId>::<sourceDocId>），导致聚合源在 fileById
 *   反查中 miss → return null → 3 页 PDF 整文件被丢弃。
 *
 * 本测试锁定修复契约：
 *   deriveSourcePrintJobs(plan, planFiles) 必须产出含聚合源的 3 个 job（T1/T3）；
 *   deriveSourcePrintJobs(plan, originalFiles) 仍只产出 2 个 job（T2，文档化旧语义）。
 *
 * @module print/__tests__/deriveSourcePrintJobs.multiPageSource
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrintPlanInput, buildPrintExecutionPlan } from '../buildPrintExecutionPlan.js'
import { deriveSourcePrintJobs } from '../deriveSourcePrintJobs.js'

// ─── Mock 数据生成器（镜像 normalizePrintSources.test.js 约定） ───

function createMockPage({
  key,
  instanceId = 'inst-1',
  sourceDocId = 'doc-1',
  pageNum = 0,
  totalPages = 2,
  printPath = '/path/to/file.pdf',
  fileFormat = 'pdf',
  status = 'parsed',
  ...overrides
} = {}) {
  return {
    key: key || `page-${instanceId}-${sourceDocId}-${pageNum}`,
    instanceId,
    sourceDocId,
    pageNum,
    totalPages,
    printPath,
    fileFormat,
    status,
    name: key || `page_${pageNum}.pdf`,
    ...overrides,
  }
}

const SETTINGS = { mergeMode: 'none', paperSize: 'A4', landscape: false }

// 输入：OFD 单页 + PDF 单页 + PDF 3 页同票（page-level 条目）
function buildInputFiles() {
  return [
    createMockPage({ key: 'ofd', fileFormat: 'ofd', printPath: '/tmp/ofd.ofd', name: 'ofd.ofd' }),
    createMockPage({ key: 'pdf1', totalPages: 1, printPath: '/tmp/single.pdf', name: 'single.pdf' }),
    createMockPage({ key: 'p1', instanceId: 'I', sourceDocId: 'S', pageNum: 0, totalPages: 3, printPath: '/tmp/3page.pdf' }),
    createMockPage({ key: 'p2', instanceId: 'I', sourceDocId: 'S', pageNum: 1, totalPages: 3, printPath: '/tmp/3page.pdf' }),
    createMockPage({ key: 'p3', instanceId: 'I', sourceDocId: 'S', pageNum: 2, totalPages: 3, printPath: '/tmp/3page.pdf' }),
  ]
}

test('T1 [回归核心]: deriveSourcePrintJobs(plan, planFiles) 产出 3 jobs 且含聚合源', () => {
  const files = buildInputFiles()
  const { files: planFiles, options } = createPrintPlanInput(files, SETTINGS)

  // 前提：normalize 后应为 OFD + PDF 单 + 聚合源 3 项
  assert.equal(planFiles.length, 3, 'normalizePrintSources 应聚合 3 页 PDF 为 1 个 source 目标')

  const plan = buildPrintExecutionPlan(planFiles, options)
  const jobs = deriveSourcePrintJobs(plan, planFiles)

  assert.equal(jobs.length, 3, '修复后应派生 3 个 job（OFD + PDF 单 + 聚合源）')

  const aggregated = jobs.find((j) => j._isAggregatedSource)
  assert.ok(aggregated, '应存在聚合源 job')
  assert.ok(aggregated.key.startsWith('__source_'), `聚合源 job key 应以 __source_ 开头（实际 ${aggregated.key}）`)
  assert.equal(aggregated.printPath, '/tmp/3page.pdf', '聚合源 job 应携带 representative 的 printPath（Sumatra 打完整源文件）')
  assert.equal(aggregated._round, 1, '聚合源 job 应在第 1 轮')
})

test('T2 [旧语义固化]: deriveSourcePrintJobs(plan, originalFiles) 仍丢弃聚合源（2 jobs）', () => {
  const files = buildInputFiles()
  const { files: planFiles, options } = createPrintPlanInput(files, SETTINGS)
  const plan = buildPrintExecutionPlan(planFiles, options)

  // 旧调用（传原始 files）：聚合源 key 反查 miss → job 被丢弃
  const jobs = deriveSourcePrintJobs(plan, files)

  assert.equal(jobs.length, 2, '旧语义：聚合源被丢弃，仅 OFD + PDF 单')
  assert.ok(!jobs.some((j) => j._isAggregatedSource), '旧语义：无聚合源 job')
})

test('T3: job 顺序保持归一化顺序（ofd → pdf1 → 聚合源）', () => {
  const files = buildInputFiles()
  const { files: planFiles, options } = createPrintPlanInput(files, SETTINGS)
  const plan = buildPrintExecutionPlan(planFiles, options)
  const jobs = deriveSourcePrintJobs(plan, planFiles)

  const keys = jobs.map((j) => j.key)
  assert.equal(keys[0], 'ofd')
  assert.equal(keys[1], 'pdf1')
  assert.ok(keys[2].startsWith('__source_'), `第 3 个 job 应为聚合源（实际 ${keys[2]}）`)
})
