/**
 * A1.5 等价性测试：Legacy Oracle == buildPrintExecutionPlan
 *
 * 三层验证（用户定稿）：
 *   1. 结构等价：normalizePlan(legacy) deepEqual normalizePlan(new) —— 证明「新函数 == 系统当前真实行为」
 *   2. 黄金快照：legacy / new 均 deepEqual 手验期望（legacy_executePrint_snapshot.json）
 *   3. 冻结不变量：merge 模式忽略 extraSpecial（extraSpecial 不参与 merge）
 *
 * 关键：buildLegacyPrintPlan 是从 executePrint/doPrint 内联逻辑忠实抽取的 Oracle，
 * 不是测试里重写的第二份旧代码。两者独立实现、预期等价（projection 性质）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPrintExecutionPlan,
  SOURCE_FILE_FILTER,
  MERGE_FILE_FILTER,
} from '../src/print/buildPrintExecutionPlan.js'
import { buildLegacyPrintPlan } from '../src/print/buildLegacyPrintPlan.js'
import { normalizePlan, compareLegacyPlan, printPlanCompareEnabled } from '../src/print/compareLegacyPlan.js'

const golden = JSON.parse(
  readFileSync(new URL('./legacy_executePrint_snapshot.json', import.meta.url), 'utf8'),
)

// ── 样例数据（与生成脚本一致；见 golden._meta 注释） ──
const A = { key: 'A', name: 'A.pdf', status: 'parsed', printPath: '/a.pdf', fileFormat: 'pdf' }
const B = { key: 'B', name: 'B.ofd', status: 'parsed', docId: 'doc-b', previewImage: 'img-b', printPath: '/b.ofd', fileFormat: 'ofd' }
const C = { key: 'C', name: 'C.pdf', status: 'error', printPath: '/c.pdf', fileFormat: 'pdf' }
const D = { key: 'D', name: 'D.pdf', status: 'parsed', printPath: '/d.pdf', fileFormat: 'pdf', invoiceType: '专票' }
const E = { key: 'E', name: 'E.pdf', status: 'parsed', printPath: '/e.pdf', fileFormat: 'pdf', invoiceType: '专票' }

const sourceFiles = [A, B, C, D]
const mergeFiles = [A, B, C, D, E]
const fileRotations = { A: 90, B: 0, C: 270, D: 180, E: 0 }

test('SOURCE extraSpecial=false: legacy == new == golden', () => {
  const legacy = buildLegacyPrintPlan(sourceFiles, { settings: { landscape: false }, fileRotations })
  const next = buildPrintExecutionPlan(sourceFiles, {
    filter: SOURCE_FILE_FILTER,
    settings: { landscape: false },
    fileRotations,
  })
  assert.deepStrictEqual(normalizePlan(legacy), normalizePlan(next), 'legacy 与 new 结构应等价')
  assert.deepStrictEqual(next, golden.source_extraSpecial_false, 'new 应匹配黄金快照')
  assert.deepStrictEqual(legacy, golden.source_extraSpecial_false, 'legacy 应匹配黄金快照')
})

test('SOURCE extraSpecial=true: 一普二专展开 round2（extraPages=[D]）', () => {
  const legacy = buildLegacyPrintPlan(sourceFiles, { settings: { landscape: false, extraSpecial: true }, fileRotations })
  const next = buildPrintExecutionPlan(sourceFiles, {
    filter: SOURCE_FILE_FILTER,
    settings: { landscape: false, extraSpecial: true },
    fileRotations,
  })
  assert.deepStrictEqual(normalizePlan(legacy), normalizePlan(next))
  assert.deepStrictEqual(next, golden.source_extraSpecial_true)
  assert.deepStrictEqual(legacy, golden.source_extraSpecial_true)
  // 明确断言 round2 含专票 D
  assert.deepStrictEqual(next.extraPages.map((p) => p.source.fileId), ['D'])
})

test('MERGE2: 分组 [A,B],[C,D],[E]，含 error 文件 C', () => {
  const legacy = buildLegacyPrintPlan(mergeFiles, { settings: { mergeMode: 'merge2', landscape: false }, fileRotations })
  const next = buildPrintExecutionPlan(mergeFiles, {
    filter: MERGE_FILE_FILTER,
    settings: { mergeMode: 'merge2', landscape: false },
    fileRotations,
  })
  assert.deepStrictEqual(normalizePlan(legacy), normalizePlan(next))
  assert.deepStrictEqual(next, golden.merge2)
  assert.deepStrictEqual(legacy, golden.merge2)
  assert.deepStrictEqual(
    next.pages.map((p) => p.slots.map((s) => s.fileId)),
    [['A', 'B'], ['C', 'D'], ['E']],
  )
})

test('冻结不变量: merge 模式忽略 extraSpecial（extraPages 恒为空）', () => {
  const legacy = buildLegacyPrintPlan(mergeFiles, { settings: { mergeMode: 'merge2', landscape: false, extraSpecial: true }, fileRotations })
  const next = buildPrintExecutionPlan(mergeFiles, {
    filter: MERGE_FILE_FILTER,
    settings: { mergeMode: 'merge2', landscape: false, extraSpecial: true },
    fileRotations,
  })
  assert.deepStrictEqual(normalizePlan(legacy), normalizePlan(next))
  assert.deepStrictEqual(next.extraPages, [], 'merge 路径不应展开 round2')
  assert.deepStrictEqual(legacy.extraPages, [], 'legacy merge 路径不应展开 round2')
  assert.deepStrictEqual(next, golden.merge2_extraSpecial_true)
})

test('归一化保留文件顺序、旋转、方向', () => {
  const next = buildPrintExecutionPlan(sourceFiles, {
    filter: SOURCE_FILE_FILTER,
    settings: { landscape: true },
    fileRotations,
  })
  const norm = normalizePlan(next)
  // source 过滤排除 C(error) → [A, B, D]
  assert.deepStrictEqual(norm.map((p) => p.fileIds[0]), ['A', 'B', 'D'])
  assert.deepStrictEqual(norm.map((p) => p.orientation), ['landscape', 'landscape', 'landscape'])
  assert.deepStrictEqual(norm[0].slots[0].rotation, 90)
  assert.deepStrictEqual(norm[2].slots[0].rotation, 180)
})

test('compareLegacyPlan 影子比较：new plan 与 legacy oracle 一致（match=true）', () => {
  const next = buildPrintExecutionPlan(sourceFiles, {
    filter: SOURCE_FILE_FILTER,
    settings: { landscape: false, extraSpecial: true },
    fileRotations,
  })
  const res = compareLegacyPlan(next, { files: sourceFiles, settings: { landscape: false, extraSpecial: true }, fileRotations })
  assert.strictEqual(res.match, true)
})

test('影子比较守卫 printPlanCompareEnabled() 在 node 环境下为 false（生产构建不可达）', () => {
  // node 无 import.meta.env.DEV / localStorage → 守卫返回 false
  assert.strictEqual(typeof printPlanCompareEnabled, 'function')
  assert.strictEqual(printPlanCompareEnabled(), false)
})
