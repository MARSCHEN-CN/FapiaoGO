/**
 * normalizePrintSources.test — 多页文档打印源归一化测试
 *
 * 测试目标：
 *   1. 多页文档完整选择 → 聚合为单个 source 打印目标
 *   2. 多页文档部分选择 → 保持逐页模式
 *   3. 单页文件 → 保持原样
 *   4. 混合场景（多页 + 单页）
 *   5. 边界条件（空数组、null、单页多页混合等）
 *
 * @module print/__tests__/normalizePrintSources
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePrintSources } from '../buildPrintExecutionPlan.js'

// ─── Mock 数据生成器 ───

function createMockPage({
  instanceId = 'inst-1',
  sourceDocId = 'doc-1',
  pageNum = 0,
  totalPages = 2,
  key,
  printPath = '/path/to/file.pdf',
  ...overrides
} = {}) {
  return {
    key: key || `page-${instanceId}-${sourceDocId}-${pageNum}`,
    instanceId,
    sourceDocId,
    pageNum,
    totalPages,
    printPath,
    fileFormat: 'pdf',
    status: 'parsed',
    name: `page_${pageNum}.pdf`,
    ...overrides,
  }
}

// ─── 测试用例 ───

test('Case 1: 多页文档完整选择 → 聚合为单个 source 目标', () => {
  // 2页文档，用户选择全部
  const pages = [
    createMockPage({ pageNum: 0, totalPages: 2 }),
    createMockPage({ pageNum: 1, totalPages: 2 }),
  ]

  const result = normalizePrintSources(pages)

  // 应该聚合为1个 source 目标
  assert.equal(result.length, 1, '应该聚合为1个 source 目标')

  const aggregated = result[0]
  assert.equal(aggregated._isAggregatedSource, true, '应该标记为聚合 source')
  assert.ok(aggregated.key.startsWith('__source_'), 'key 应该以 __source_ 开头')
  assert.equal(aggregated._aggregatedPageCount, 2, '应该包含2页')
  assert.equal(aggregated._aggregatedPages.length, 2, '聚合页面数组应该有2个元素')
})

test('Case 2: 多页文档部分选择 → 保持逐页模式', () => {
  // 3页文档，用户只选了第1页和第3页
  const pages = [
    createMockPage({ pageNum: 0, totalPages: 3 }),
    createMockPage({ pageNum: 2, totalPages: 3 }),
  ]

  const result = normalizePrintSources(pages)

  // 部分选择，应该保持逐页模式
  assert.equal(result.length, 2, '应该保持2个独立文件')
  for (const item of result) {
    assert.equal(item._isAggregatedSource, undefined, '不应该有聚合标记')
    assert.ok(!item.key.startsWith('__source_'), 'key 不应该以 __source_ 开头')
  }
})

test('Case 3: 单页文件 → 保持原样', () => {
  // 单页 PDF（无 sourceDocId 或 totalPages=1）
  const singlePage = createMockPage({
    instanceId: undefined,
    sourceDocId: undefined,
    totalPages: 1,
    pageNum: null,
    key: 'single-file-1',
  })

  const result = normalizePrintSources([singlePage])

  assert.equal(result.length, 1, '应该只有1个文件')
  assert.equal(result[0].key, 'single-file-1', 'key 应该保持不变')
  assert.equal(result[0]._isAggregatedSource, undefined, '不应该有聚合标记')
})

test('Case 4: 混合场景（多页 + 单页）', () => {
  // 2页多页文档 + 1个单页文件
  const multiPage = [
    createMockPage({ instanceId: 'inst-1', sourceDocId: 'doc-1', pageNum: 0, totalPages: 2 }),
    createMockPage({ instanceId: 'inst-1', sourceDocId: 'doc-1', pageNum: 1, totalPages: 2 }),
  ]
  const singlePage = createMockPage({
    instanceId: undefined,
    sourceDocId: undefined,
    totalPages: 1,
    pageNum: null,
    key: 'single-file-1',
  })

  const files = [...multiPage, singlePage]
  const result = normalizePrintSources(files)

  // 1个聚合 source + 1个单页 = 2个
  assert.equal(result.length, 2, '应该有2个文件（1个聚合 + 1个单页）')

  const aggregated = result.find(r => r._isAggregatedSource)
  const single = result.find(r => !r._isAggregatedSource)

  assert.ok(aggregated, '应该有1个聚合 source')
  assert.equal(aggregated._aggregatedPageCount, 2, '聚合 source 应该包含2页')
  assert.ok(single, '应该有1个单页文件')
  assert.equal(single.key, 'single-file-1', '单页文件 key 应该保持不变')
})

test('Case 5: 多个独立多页文档', () => {
  // 两个不同的多页文档（不同的 instanceId/sourceDocId）
  const docA = [
    createMockPage({ instanceId: 'inst-A', sourceDocId: 'doc-A', pageNum: 0, totalPages: 2 }),
    createMockPage({ instanceId: 'inst-A', sourceDocId: 'doc-A', pageNum: 1, totalPages: 2 }),
  ]
  const docB = [
    createMockPage({ instanceId: 'inst-B', sourceDocId: 'doc-B', pageNum: 0, totalPages: 3 }),
    createMockPage({ instanceId: 'inst-B', sourceDocId: 'doc-B', pageNum: 1, totalPages: 3 }),
    createMockPage({ instanceId: 'inst-B', sourceDocId: 'doc-B', pageNum: 2, totalPages: 3 }),
  ]

  const files = [...docA, ...docB]
  const result = normalizePrintSources(files)

  // 2个聚合 source
  assert.equal(result.length, 2, '应该有2个聚合 source')

  assert.equal(result[0]._aggregatedPageCount, 2, 'doc-A 应该有2页')
  assert.equal(result[1]._aggregatedPageCount, 3, 'doc-B 应该有3页')
})

test('Case 6: 边界条件 - 空数组', () => {
  const result = normalizePrintSources([])
  assert.equal(result.length, 0, '空数组应该返回空数组')
})

test('Case 7: 边界条件 - null/undefined 输入', () => {
  const result = normalizePrintSources(null)
  assert.equal(result.length, 0, 'null 应该返回空数组')

  const result2 = normalizePrintSources(undefined)
  assert.equal(result2.length, 0, 'undefined 应该返回空数组')
})

test('Case 8: 重复页面去重', () => {
  // 模拟同一页被重复选择的情况（理论上不应该发生，但需要防御）
  const pages = [
    createMockPage({ instanceId: 'inst-1', sourceDocId: 'doc-1', pageNum: 0, totalPages: 2 }),
    createMockPage({ instanceId: 'inst-1', sourceDocId: 'doc-1', pageNum: 0, totalPages: 2 }), // 重复
    createMockPage({ instanceId: 'inst-1', sourceDocId: 'doc-1', pageNum: 1, totalPages: 2 }),
  ]

  const result = normalizePrintSources(pages)

  // 应该去重后聚合为1个 source
  assert.equal(result.length, 1, '应该聚合为1个 source')
  assert.equal(result[0]._aggregatedPageCount, 2, '应该只有2页（去重后）')
})

test('Case 9: 降级 - 无 instanceId 但有 sourceDocId', () => {
  // 某些 legacy 数据可能没有 instanceId
  const pages = [
    createMockPage({ instanceId: undefined, sourceDocId: 'doc-legacy', pageNum: 0, totalPages: 2 }),
    createMockPage({ instanceId: undefined, sourceDocId: 'doc-legacy', pageNum: 1, totalPages: 2 }),
  ]

  const result = normalizePrintSources(pages)

  // 应该仍然能聚合
  assert.equal(result.length, 1, '应该能聚合')
  assert.ok(result[0]._isAggregatedSource, '应该标记为聚合 source')
})

test('Case 10: 不同导入的相同内容文件不应合并', () => {
  // 相同 sourceDocId 但不同 instanceId（两次导入相同文件）
  const import1 = [
    createMockPage({ instanceId: 'import-1', sourceDocId: 'same-doc', pageNum: 0, totalPages: 2 }),
    createMockPage({ instanceId: 'import-1', sourceDocId: 'same-doc', pageNum: 1, totalPages: 2 }),
  ]
  const import2 = [
    createMockPage({ instanceId: 'import-2', sourceDocId: 'same-doc', pageNum: 0, totalPages: 2 }),
    createMockPage({ instanceId: 'import-2', sourceDocId: 'same-doc', pageNum: 1, totalPages: 2 }),
  ]

  const files = [...import1, ...import2]
  const result = normalizePrintSources(files)

  // 应该分为2组（不同 instanceId）
  assert.equal(result.length, 2, '应该分为2组（不同 instanceId）')
  for (const item of result) {
    assert.ok(item._isAggregatedSource, '每组都应该是聚合 source')
    assert.equal(item._aggregatedPageCount, 2, '每组都应该有2页')
  }
})

test('Case 11: 聚合后保持原始文件信息', () => {
  const pages = [
    createMockPage({
      instanceId: 'inst-1',
      sourceDocId: 'doc-1',
      pageNum: 0,
      totalPages: 2,
      printPath: '/path/to/source.pdf',
      fileFormat: 'pdf',
      status: 'parsed',
      name: 'source_file.pdf',
    }),
    createMockPage({
      instanceId: 'inst-1',
      sourceDocId: 'doc-1',
      pageNum: 1,
      totalPages: 2,
      printPath: '/path/to/source.pdf',
    }),
  ]

  const result = normalizePrintSources(pages)

  assert.equal(result.length, 1, '应该聚合为1个 source')

  const aggregated = result[0]
  // 应该保留原始文件的关键字段
  assert.equal(aggregated.printPath, '/path/to/source.pdf', 'printPath 应该保持不变')
  assert.equal(aggregated.fileFormat, 'pdf', 'fileFormat 应该保持不变')
  assert.equal(aggregated.status, 'parsed', 'status 应该保持不变')
  assert.equal(aggregated.name, 'source_file.pdf', 'name 应该保持不变')
})

// ─── 用户要求的 Case C: OFD 多页保持逐页 ───

test('Case 12: OFD 多页文档选择全部 → 保持逐页模式（不聚合）', () => {
  // OFD 不支持源文件打印，必须逐页渲染
  const pages = [
    createMockPage({
      instanceId: 'inst-ofd-1',
      sourceDocId: 'doc-ofd-1',
      pageNum: 0,
      totalPages: 2,
      fileFormat: 'ofd',
      printPath: '/path/to/file.ofd',
    }),
    createMockPage({
      instanceId: 'inst-ofd-1',
      sourceDocId: 'doc-ofd-1',
      pageNum: 1,
      totalPages: 2,
      fileFormat: 'ofd',
      printPath: '/path/to/file.ofd',
    }),
  ]

  const result = normalizePrintSources(pages)

  // OFD 即使全选，也必须保持逐页（不聚合）
  assert.equal(result.length, 2, 'OFD 应该保持2个独立文件（逐页模式）')
  for (const item of result) {
    assert.equal(item._isAggregatedSource, undefined, 'OFD 不应该有聚合标记')
    assert.ok(!item.key.startsWith('__source_'), 'OFD key 不应该以 __source_ 开头')
  }
})

// ─── 用户要求: createPrintPlanInput 在 merge 模式下跳过 normalize ───

import { createPrintPlanInput } from '../buildPrintExecutionPlan.js'

test('Case 13: createPrintPlanInput 在 merge 模式下跳过 normalizePrintSources', () => {
  const multiPage = [
    createMockPage({ instanceId: 'inst-1', sourceDocId: 'doc-1', pageNum: 0, totalPages: 2 }),
    createMockPage({ instanceId: 'inst-1', sourceDocId: 'doc-1', pageNum: 1, totalPages: 2 }),
  ]

  // 非 merge 模式：会聚合
  const nonMergeInput = createPrintPlanInput(multiPage, { mergeMode: 'none' })
  assert.equal(nonMergeInput.files.length, 1, '非 merge 模式下应该聚合为1个 source')
  assert.ok(nonMergeInput.files[0]._isAggregatedSource, '非 merge 模式应该有聚合标记')

  // merge 模式：不聚合，保持原样
  const mergeInput = createPrintPlanInput(multiPage, { mergeMode: 'merge2' })
  assert.equal(mergeInput.files.length, 2, 'merge 模式下应该保持2个文件（不聚合）')
  for (const f of mergeInput.files) {
    assert.equal(f._isAggregatedSource, undefined, 'merge 模式下不应该有聚合标记')
  }
})

// ── Bug A-1: 页序随文件列表 ──

test('Case 14 (Bug A-1): 单页文件在前 → 保持在前', () => {
  // [B, A_p1, A_p2] → B 应在 A 前面
  const single = createMockPage({
    key: 'B', instanceId: undefined, sourceDocId: undefined,
    totalPages: 1, pageNum: null,
  })
  const multi = [
    createMockPage({ instanceId: 'inst-A', sourceDocId: 'docA', pageNum: 0, totalPages: 2, key: 'A_p1' }),
    createMockPage({ instanceId: 'inst-A', sourceDocId: 'docA', pageNum: 1, totalPages: 2, key: 'A_p2' }),
  ]

  const result = normalizePrintSources([single, ...multi])
  assert.equal(result.length, 2, '1 单页 + 1 聚合 = 2')

  // 单页文件应排在第一位
  assert.equal(result[0].key, 'B', 'B 应在第 1 位')
  assert.ok(result[1]._isAggregatedSource, 'A 聚合源应在第 2 位')
})

test('Case 15 (Bug A-1): 单页文件夹在两个多页文档之间 → 保持中间位置', () => {
  // [A_p1,A_p2, B, C_p1,C_p2] → 顺序 = A, B, C
  const docA = [
    createMockPage({ instanceId: 'inst-A', sourceDocId: 'docA', pageNum: 0, totalPages: 2, key: 'A_p1' }),
    createMockPage({ instanceId: 'inst-A', sourceDocId: 'docA', pageNum: 1, totalPages: 2, key: 'A_p2' }),
  ]
  const single = createMockPage({
    key: 'B', instanceId: undefined, sourceDocId: undefined,
    totalPages: 1, pageNum: null,
  })
  const docC = [
    createMockPage({ instanceId: 'inst-C', sourceDocId: 'docC', pageNum: 0, totalPages: 2, key: 'C_p1' }),
    createMockPage({ instanceId: 'inst-C', sourceDocId: 'docC', pageNum: 1, totalPages: 2, key: 'C_p2' }),
  ]

  const result = normalizePrintSources([...docA, single, ...docC])
  assert.equal(result.length, 3, 'A 聚合 + B 单页 + C 聚合 = 3')

  assert.ok(result[0]._isAggregatedSource, 'A 聚合源应在第 1 位')
  assert.equal(result[1].key, 'B', 'B 单页应在第 2 位（保持在 A 和 C 之间）')
  assert.ok(result[2]._isAggregatedSource, 'C 聚合源应在第 3 位')
})
