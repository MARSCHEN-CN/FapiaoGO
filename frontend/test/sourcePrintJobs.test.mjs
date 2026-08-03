/**
 * sourcePrintJobs.test.mjs — Commit 2 source 执行快照测试
 *
 * 目标（用户定义）：Plan 等价 ≠ executor 不漏字段。
 *  即使 buildPrintExecutionPlan == buildLegacyPrintPlan（A1.5 已证），
 *  executePrint 把 plan 映射成真实 job 列表时仍可能错位。
 *  本测试锁定：deriveSourcePrintJobs(plan) 产出的 _jobKey 序列
 *  == deriveSourcePrintJobs(legacyPlan) 产出序列（即旧 mergedJobs 序列）。
 *
 * 样例（A1.5 冻结）：
 *  A.pdf parsed+printPath
 *  B.ofd  parsed+printPath
 *  C.pdf  error          → 被 SOURCE_FILE_FILTER 排除
 *  D.pdf  parsed+printPath, invoiceType='专票' → 一普二专第 2 轮
 *
 * 期望 source 执行序列（_jobKey）：
 *  非 extraSpecial: [A, B, D]
 *  extraSpecial   : [A, B, D, D_v2]   （D 第 2 轮独立 _jobKey）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildPrintExecutionPlan, SOURCE_FILE_FILTER } from '../src/print/buildPrintExecutionPlan.js'
import { buildLegacyPrintPlan } from '../src/print/buildLegacyPrintPlan.js'
import { deriveSourcePrintJobs } from '../src/print/deriveSourcePrintJobs.js'

const files = [
  { key: 'A', name: 'A.pdf', status: 'parsed', printPath: '/a.pdf', fileFormat: 'pdf' },
  { key: 'B', name: 'B.ofd', status: 'parsed', printPath: '/b.pdf', fileFormat: 'ofd' },
  { key: 'C', name: 'C.pdf', status: 'error', printPath: '/c.pdf', fileFormat: 'pdf' },
  { key: 'D', name: 'D.pdf', status: 'parsed', printPath: '/d.pdf', fileFormat: 'pdf', invoiceType: '专票' },
]

const settings = (extraSpecial) => ({ mergeMode: 'none', landscape: false, paperSize: 'A4', extraSpecial })

test('source jobs (non-extraSpecial): [A,B,D] matches legacy mergedJobs', () => {
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: settings(false), fileRotations: {} })
  const legacyPlan = buildLegacyPrintPlan(files, { settings: settings(false), fileRotations: {} })

  const planKeys = deriveSourcePrintJobs(plan, files).map(j => j._jobKey)
  const legacyKeys = deriveSourcePrintJobs(legacyPlan, files).map(j => j._jobKey)

  assert.deepEqual(planKeys, ['A', 'B', 'D'])
  assert.deepEqual(planKeys, legacyKeys, 'executor must not miss fields vs legacy')
})

test('source jobs (extraSpecial): [A,B,D,D_v2] matches legacy mergedJobs', () => {
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: settings(true), fileRotations: {} })
  const legacyPlan = buildLegacyPrintPlan(files, { settings: settings(true), fileRotations: {} })

  const planKeys = deriveSourcePrintJobs(plan, files).map(j => j._jobKey)
  const legacyKeys = deriveSourcePrintJobs(legacyPlan, files).map(j => j._jobKey)

  // 第 2 轮专票项使用独立 _jobKey（+ '_v2'）
  assert.deepEqual(planKeys, ['A', 'B', 'D', 'D_v2'])
  assert.deepEqual(planKeys, legacyKeys, 'executor must not miss fields vs legacy')
})

test('source jobs preserve _round and file object fields', () => {
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: settings(true), fileRotations: {} })
  const jobs = deriveSourcePrintJobs(plan, files)

  assert.equal(jobs.length, 4)
  assert.equal(jobs[0]._round, 1)
  assert.equal(jobs[3]._round, 2)
  assert.equal(jobs[3]._jobKey, 'D_v2')
  // 文件业务字段透传（printAllSourceFiles 依赖 f.printPath / f.name）
  assert.equal(jobs[0].printPath, '/a.pdf')
  assert.equal(jobs[3].name, 'D.pdf')
})

test('source jobs order matches input order (round1 then round2)', () => {
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: settings(true), fileRotations: {} })
  const jobs = deriveSourcePrintJobs(plan, files)
  // round1 = 输入过滤序 [A,B,D]，round2 = 专票 [D]
  assert.deepEqual(
    jobs.map(j => [j._jobKey, j._round]),
    [['A', 1], ['B', 1], ['D', 1], ['D_v2', 2]],
  )
})
