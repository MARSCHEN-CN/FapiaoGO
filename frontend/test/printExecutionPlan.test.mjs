/**
 * buildPrintExecutionPlan 快照 / 行为不变式测试（A1）
 *
 * 目标：锁定「打印执行计划」纯函数的输出结构，确保 A1 抽取后不改变现有打印行为语义：
 *   - 单 PDF         → 1 page / 1 slot（type single）
 *   - 多页（N 文件）  → N pages / 各 1 slot
 *   - merge2 (4 文件) → 2 pages / 各 2 slots（multi-ticket，竖向）
 *   - merge4 (4 文件) → 1 page / 4 slots（multi-ticket，强制横向）
 *   - 一普二专        → pages=全部, extraPages=专票（第 2 轮）
 *   - rotation        → slot.rotation 反映每文件旋转
 *   - 行为不变量       → merge 模式忽略一普二专；source/merge 过滤口径差异保留
 *
 * 运行（frontend/ 目录）：
 *   node --loader ./test/resolve-js-loader.mjs --test test/printExecutionPlan.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPrintExecutionPlan,
  createPrintPlanInput,
  SOURCE_FILE_FILTER,
  MERGE_FILE_FILTER,
} from '../src/print/buildPrintExecutionPlan.js'

// 构造最小文件对象（仅含提取逻辑读取的字段）
const mk = (key, over = {}) => ({
  key,
  status: 'parsed',
  printPath: `/tmp/${key}.pdf`,
  fileFormat: 'pdf',
  ...over,
})

test('Case 1: 单 PDF → 1 page / 1 slot (single)', () => {
  const files = [mk('A'), mk('B')]
  const plan = buildPrintExecutionPlan(files, {
    filter: SOURCE_FILE_FILTER,
    settings: {},
  })
  assert.equal(plan.pages.length, 2)
  assert.equal(plan.pages[0].type, 'single')
  assert.deepEqual(plan.pages[0].slots, [{ fileId: 'A', rotation: 0 }])
  assert.deepEqual(plan.pages[0].source, { fileId: 'A', pageIndex: 0 })
  assert.equal(plan.extraPages.length, 0)
  assert.equal(plan.mergeMode, 'none')
  assert.equal(plan.strategy.oneNormalTwoSpecial, false)
})

test('Case 2: 多页（N 文件单模式）→ N pages 各 1 slot', () => {
  const files = [mk('A'), mk('B'), mk('C')]
  const plan = buildPrintExecutionPlan(files, {
    filter: SOURCE_FILE_FILTER,
    settings: {},
  })
  assert.equal(plan.pages.length, 3)
  plan.pages.forEach((p, i) => {
    assert.equal(p.type, 'single')
    assert.equal(p.slots.length, 1)
    assert.equal(p.slots[0].fileId, files[i].key)
  })
})

test('Case 3: merge2 (4 文件) → 2 pages / 各 2 slots (portrait)', () => {
  const files = [mk('A'), mk('B'), mk('C'), mk('D')]
  const plan = buildPrintExecutionPlan(files, {
    filter: MERGE_FILE_FILTER,
    settings: { mergeMode: 'merge2' },
  })
  assert.equal(plan.pages.length, 2)
  assert.equal(plan.pages[0].type, 'multi-ticket')
  assert.equal(plan.pages[0].slots.length, 2)
  assert.deepEqual(plan.pages[0].slots, [
    { fileId: 'A', rotation: 0 },
    { fileId: 'B', rotation: 0 },
  ])
  assert.deepEqual(plan.pages[1].slots, [
    { fileId: 'C', rotation: 0 },
    { fileId: 'D', rotation: 0 },
  ])
  assert.equal(plan.pages[0].orientation, 'portrait') // merge2 强制竖向
  assert.equal(plan.mergeMode, 'merge2')
})

test('Case 4: merge4 (4 文件) → 1 page / 4 slots (landscape)', () => {
  const files = [mk('A'), mk('B'), mk('C'), mk('D')]
  const plan = buildPrintExecutionPlan(files, {
    filter: MERGE_FILE_FILTER,
    settings: { mergeMode: 'merge4' },
  })
  assert.equal(plan.pages.length, 1)
  assert.equal(plan.pages[0].slots.length, 4)
  assert.deepEqual(
    plan.pages[0].slots.map((s) => s.fileId),
    ['A', 'B', 'C', 'D']
  )
  assert.equal(plan.pages[0].orientation, 'landscape') // merge4 强制横向
})

test('Case 5: 一普二专（source）→ pages=全部, extraPages=专票第2轮', () => {
  const files = [
    mk('A', { invoiceType: '普票' }),
    mk('B', { invoiceType: '专票' }),
    mk('C', { invoiceType: '普票' }),
    mk('D', { invoiceType: '专票' }),
  ]
  const plan = buildPrintExecutionPlan(files, {
    filter: SOURCE_FILE_FILTER,
    settings: { extraSpecial: true },
  })
  assert.equal(plan.pages.length, 4)
  assert.equal(plan.extraPages.length, 2)
  assert.deepEqual(
    plan.extraPages.map((p) => p.source.fileId),
    ['B', 'D']
  )
  assert.equal(plan.extraPages[0]._round, 2)
  assert.equal(plan.strategy.oneNormalTwoSpecial, true)
})

test('Case 6: rotation → slot.rotation 反映每文件旋转', () => {
  const files = [mk('A'), mk('B')]
  const plan = buildPrintExecutionPlan(files, {
    filter: SOURCE_FILE_FILTER,
    settings: {},
    fileRotations: { A: 90 },
  })
  assert.equal(plan.pages[0].slots[0].rotation, 90)
  assert.equal(plan.pages[1].slots[0].rotation, 0)
})

test('Case 7: 行为不变量 — merge 模式忽略一普二专（保留 doPrint 现状）', () => {
  const files = [mk('A', { invoiceType: '专票' }), mk('B')]
  const plan = buildPrintExecutionPlan(files, {
    filter: MERGE_FILE_FILTER,
    settings: { mergeMode: 'merge2', extraSpecial: true },
  })
  assert.equal(plan.extraPages.length, 0) // doPrint 不展开第 2 轮
  assert.equal(plan.strategy.oneNormalTwoSpecial, true) // 事实仍记录
})

test('Case 8: 行为不变量 — source/merge 过滤口径差异保留', () => {
  const errFile = mk('E', { status: 'error' })
  assert.equal(SOURCE_FILE_FILTER(errFile), false) // source 仅 parsed
  assert.equal(MERGE_FILE_FILTER(errFile), true) // merge 允许 parsed||error
})

test('Case 9: 单文件 landscape 设置 → orientation=landscape', () => {
  const plan = buildPrintExecutionPlan([mk('A')], {
    filter: SOURCE_FILE_FILTER,
    settings: { landscape: true },
  })
  assert.equal(plan.pages[0].orientation, 'landscape')
})

test('Case 10: 无 filter 时使用原始 files 副本（不污染入参）', () => {
  const files = [mk('A'), mk('B')]
  const snapshot = files.map((f) => ({ ...f }))
  buildPrintExecutionPlan(files, { settings: {} })
  assert.deepEqual(files, snapshot) // 入参未被修改
})

// ── createPrintPlanInput 契约（Commit 1 后审计收尾）──
// 目的：锁定「mergeMode → filter」唯一决策点——所有 plan 必须经同一 input
// resolver 获得打印事实，防止未来 execute/preview 各自解释业务规则再次漂移。

test('PPI-01: 非 merge（none/缺省）→ SOURCE_FILE_FILTER（普通打印）', () => {
  assert.equal(createPrintPlanInput([], { mergeMode: 'none' }).options.filter, SOURCE_FILE_FILTER)
  assert.equal(createPrintPlanInput([]).options.filter, SOURCE_FILE_FILTER, 'mergeMode 缺省 → SOURCE')
  assert.equal(createPrintPlanInput([], {}).options.filter, SOURCE_FILE_FILTER, 'settings 空 → SOURCE')
})

test('PPI-02: merge 模式（merge2/merge3/merge4）→ MERGE_FILE_FILTER', () => {
  for (const mergeMode of ['merge2', 'merge3', 'merge4']) {
    assert.equal(
      createPrintPlanInput([], { mergeMode }).options.filter,
      MERGE_FILE_FILTER,
      `mergeMode=${mergeMode} → MERGE_FILE_FILTER`,
    )
  }
})

test('PPI-03: 输入透传——files/settings/fileRotations 原样进入 plan options', () => {
  const files = [mk('A', { status: 'error' })] // merge 口径下应被 MERGE filter 放行
  const fileRotations = { A: 90 }
  const { files: outFiles, options } = createPrintPlanInput(files, { mergeMode: 'merge2' }, fileRotations)
  assert.equal(outFiles, files, 'files 引用透传（不复制）')
  assert.equal(options.fileRotations, fileRotations)
  // 端到端：MERGE filter 放行 error 态文件（与 doPrint 行为一致）
  const plan = buildPrintExecutionPlan(outFiles, options)
  assert.equal(plan.pages[0].slots[0].fileId, 'A')
  assert.equal(plan.pages[0].slots[0].rotation, 90)
})
