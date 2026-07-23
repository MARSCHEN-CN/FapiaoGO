/**
 * IS-1 Acceptance Harness — 编排层验收（Commit 5）
 *
 * 不碰 React / DOM / 浏览器 File API / Electron IPC / 真实 SSE EventSource。
 * 仅验证纯编排模块 runChunkedImport 在 mock ImportBatchClient 下的行为：
 *   - 顺序分块提交（N=250 → 3 批 [100,100,50]）
 *   - SSE 进度聚合到 session（0 → 250）
 *   - cooperative cancel（取消已提交批次、不提交后续批次、session 标 CANCELLED）
 *
 * 运行（显式路径，避免本环境 node --test <dir> 的 CJS 怪癖）：
 *   node --test frontend/tests/acceptance/importSession.acceptance.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createImportSession,
  getSession,
  getChildBatchIds,
  removeSession,
} from '../../src/stores/ImportSessionStore.js'
import { runChunkedImport } from '../../src/import/runChunkedImport.js'

// ── 测试辅助 ──────────────────────────────────────────────

const tick = () => new Promise((r) => setTimeout(r, 0))

async function waitUntil(fn, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitUntil timeout: ' + fn.toString())
    await tick()
  }
}

/**
 * 构造 mock ImportBatchClient。subscribeBatchProgress 不自动发事件，由测试手动驱动
 * （emitProgress / emitComplete），以精确控制异步时序（尤其 cancel 场景）。
 */
function makeMockClient() {
  const created = [] // [{ batchId, keys:[clientKey], total }]
  const cancelled = [] // [batchId]
  const sse = new Map() // batchId -> callback
  let counter = 0

  const client = {
    createImportBatch: async (filesForBatch) => {
      const batchId = 'batch-' + ++counter
      created.push({ batchId, keys: filesForBatch.map((f) => f.clientKey), total: filesForBatch.length })
      return { batchId, total: filesForBatch.length }
    },
    subscribeBatchProgress: (batchId, cb) => {
      sse.set(batchId, cb)
      return { close() {} }
    },
    getBatchResults: async () => [],
    cancelImportBatch: async (batchId) => {
      cancelled.push(batchId)
      return true
    },
  }

  return {
    client,
    created,
    cancelled,
    emitProgress: (batchId, current, total) => {
      const cb = sse.get(batchId)
      if (cb) cb.onProgress({ status: 'running', current, total })
    },
    emitComplete: (batchId, status = 'completed', error = null) => {
      const cb = sse.get(batchId)
      if (cb) cb.onComplete({ status, current: 0, total: 0, error })
    },
  }
}

function makeSession(n) {
  const files = []
  for (let i = 0; i < n; i++) {
    files.push({ key: 'f' + i, name: 'file' + i + '.pdf', file: null })
  }
  return createImportSession(files)
}

// 文件 key 形如 'f0'..'f249'：默认 .sort() 是字典序（f0,f1,f10,f11,...,f19,f2,...），
// 会与数值序的期望值错位。统一用数值感知的 key 排序做断言比较。
const byKeyNum = (a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)

function makeDeps(mock, record) {
  return {
    client: mock.client,
    onFileUpdate: (key, status) => record.fileUpdates.push({ key, status }),
    onAggregateProgress: (p) => record.progressUpdates.push({ ...p }),
    onTaskStatus: (taskId, status) => record.taskStatuses.push({ taskId, status }),
    // onTaskStream / hydrateChunk 省略：测试不验证 React 流与 hydration 字段填充
  }
}

// ── 验收用例 ──────────────────────────────────────────────

test('N=250 → 3 个顺序批次 [100,100,50]，SSE 聚合 session 0→250，最终 COMPLETED', async () => {
  const n = 250
  const session = makeSession(n)
  const mock = makeMockClient()
  const record = { fileUpdates: [], progressUpdates: [], taskStatuses: [] }

  const runPromise = runChunkedImport({
    sessionId: session.id,
    taskId: 'task-1',
    files: session.files,
    chunkSize: 100,
    autoOrient: false,
    deps: makeDeps(mock, record),
  })

  // batch1：30/100 → 100/100 → 完成
  await waitUntil(() => mock.created.length >= 1)
  assert.equal(mock.created[0].batchId, 'batch-1')
  mock.emitProgress('batch-1', 30, 100)
  mock.emitProgress('batch-1', 100, 100)
  mock.emitComplete('batch-1', 'completed')
  await tick()

  // batch2：50/100 → 100/100 → 完成
  await waitUntil(() => mock.created.length >= 2)
  assert.equal(mock.created[1].batchId, 'batch-2')
  mock.emitProgress('batch-2', 50, 100)
  mock.emitProgress('batch-2', 100, 100)
  mock.emitComplete('batch-2', 'completed')
  await tick()

  // batch3：20/50 → 50/50 → 完成
  await waitUntil(() => mock.created.length >= 3)
  assert.equal(mock.created[2].batchId, 'batch-3')
  mock.emitProgress('batch-3', 20, 50)
  mock.emitProgress('batch-3', 50, 50)
  mock.emitComplete('batch-3', 'completed')
  await tick()

  await runPromise

  // ── 分块断言 ──
  assert.equal(mock.created.length, 3, '应创建 3 个批次')
  assert.equal(mock.created[0].keys.length, 100)
  assert.equal(mock.created[1].keys.length, 100)
  assert.equal(mock.created[2].keys.length, 50)
  assert.deepEqual(mock.created[0].keys, Array.from({ length: 100 }, (_, i) => 'f' + i))
  assert.deepEqual(mock.created[1].keys, Array.from({ length: 100 }, (_, i) => 'f' + (100 + i)))
  assert.deepEqual(mock.created[2].keys, Array.from({ length: 50 }, (_, i) => 'f' + (200 + i)))

  // ── 聚合：childBatchIds 顺序正确 ──
  assert.deepEqual(getChildBatchIds(session.id), ['batch-1', 'batch-2', 'batch-3'])

  // ── SSE 聚合：session 进度 0 → 250 ──
  const last = record.progressUpdates[record.progressUpdates.length - 1]
  assert.equal(last.current, 250, '最终 session 进度 current=250')
  assert.equal(last.total, 250)
  // 单调递增
  for (let i = 1; i < record.progressUpdates.length; i++) {
    assert.ok(record.progressUpdates[i].current >= record.progressUpdates[i - 1].current, '进度应单调不减')
  }
  assert.equal(getSession(session.id).progress.completed, 250, 'store session 进度应聚合到 250')

  // ── 终态 ──
  assert.equal(getSession(session.id).status, 'completed', '无取消时应 COMPLETED')
  assert.deepEqual(record.taskStatuses.at(-1), { taskId: 'task-1', status: 'completed' })

  removeSession(session.id)
})

test('cooperative cancel：batch1 完成 + batch2 提交中 abort → 不提交 batch3，两批均请求 cancel，session CANCELLED', async () => {
  const n = 250
  const session = makeSession(n)
  const mock = makeMockClient()
  const record = { fileUpdates: [], progressUpdates: [], taskStatuses: [] }
  const controller = new AbortController()

  const runPromise = runChunkedImport({
    sessionId: session.id,
    taskId: 'task-1',
    files: session.files,
    chunkSize: 100,
    autoOrient: false,
    deps: makeDeps(mock, record),
    signal: controller.signal,
  })

  // batch1 完成
  await waitUntil(() => mock.created.length >= 1)
  mock.emitProgress('batch-1', 30, 100)
  mock.emitProgress('batch-1', 100, 100)
  mock.emitComplete('batch-1', 'completed')
  await tick()

  // batch2 已提交（SSE 挂起，循环在 await new Promise 处阻塞）
  await waitUntil(() => mock.created.length >= 2)
  assert.equal(mock.created[1].batchId, 'batch-2')

  // 在 batch2 的 SSE 挂起时 abort（确定性：abort 解析挂起的 SSE promise，循环下一轮 break）
  controller.abort()
  await runPromise

  // ── batch3 不得提交 ──
  assert.equal(mock.created.length, 2, 'abort 后不应提交 batch3')
  assert.equal(mock.created[1].batchId, 'batch-2')

  // ── 两个已提交批次都应请求 cancel ──
  assert.deepEqual(mock.cancelled.sort(), ['batch-1', 'batch-2'], '应取消所有已提交子批次')

  // ── childBatchIds 仅含已提交批次 ──
  assert.deepEqual(getChildBatchIds(session.id), ['batch-1', 'batch-2'])

  // ── session 终态 ──
  assert.equal(getSession(session.id).status, 'cancelled', 'abort 后 session 应为 CANCELLED')
  assert.deepEqual(record.taskStatuses.at(-1), { taskId: 'task-1', status: 'cancelled' })

  // ── 已完成文件不被回退，未提交/运行中文件被标记 cancelled ──
  const parsedKeys = record.fileUpdates.filter((u) => u.status === 'parsed').map((u) => u.key)
  const cancelledKeys = record.fileUpdates.filter((u) => u.status === 'cancelled').map((u) => u.key)
  // batch1 (f0..f99) 应 parsed
  assert.deepEqual(parsedKeys.sort(byKeyNum), Array.from({ length: 100 }, (_, i) => 'f' + i))
  // batch2+batch3 文件 (f100..f249) 应 cancelled（运行中/挂起被取消，未提交被取消）
  assert.deepEqual(cancelledKeys.sort(byKeyNum), Array.from({ length: 150 }, (_, i) => 'f' + (100 + i)))
  // 已完成文件绝不被标记为 cancelled
  assert.ok(!cancelledKeys.includes('f0'), '已完成文件 f0 不得被回退为 cancelled')

  removeSession(session.id)
})

test('N=1 → 单批 [1]，childBatchIds=[batch-1]，session COMPLETED', async () => {
  const session = makeSession(1)
  const mock = makeMockClient()
  const record = { fileUpdates: [], progressUpdates: [], taskStatuses: [] }

  const runPromise = runChunkedImport({
    sessionId: session.id,
    taskId: 'task-1',
    files: session.files,
    chunkSize: 100,
    autoOrient: false,
    deps: makeDeps(mock, record),
  })

  await waitUntil(() => mock.created.length >= 1)
  mock.emitProgress('batch-1', 1, 1)
  mock.emitComplete('batch-1', 'completed')
  await tick()
  await runPromise

  assert.equal(mock.created.length, 1)
  assert.equal(mock.created[0].keys.length, 1)
  assert.deepEqual(getChildBatchIds(session.id), ['batch-1'])
  assert.equal(getSession(session.id).progress.completed, 1)
  assert.equal(getSession(session.id).status, 'completed')

  removeSession(session.id)
})

test('N=0 → 不创建任何批次，session 直接 COMPLETED（空循环）', async () => {
  const session = makeSession(0)
  const mock = makeMockClient()
  const record = { fileUpdates: [], progressUpdates: [], taskStatuses: [] }

  const { wasAborted } = await runChunkedImport({
    sessionId: session.id,
    taskId: 'task-1',
    files: session.files,
    chunkSize: 100,
    autoOrient: false,
    deps: makeDeps(mock, record),
  })

  assert.equal(mock.created.length, 0, '空文件不应创建批次')
  assert.equal(wasAborted, false)
  assert.equal(getSession(session.id).status, 'completed')
  assert.deepEqual(getChildBatchIds(session.id), [])

  removeSession(session.id)
})

test('批次失败（status=failed）→ 本 chunk 文件标记 error（失败隔离），其余 chunk 不受影响', async () => {
  const session = makeSession(150) // 2 批：100 + 50
  const mock = makeMockClient()
  const record = { fileUpdates: [], progressUpdates: [], taskStatuses: [] }

  const runPromise = runChunkedImport({
    sessionId: session.id,
    taskId: 'task-1',
    files: session.files,
    chunkSize: 100,
    autoOrient: false,
    deps: makeDeps(mock, record),
  })

  // batch1 完成
  await waitUntil(() => mock.created.length >= 1)
  mock.emitComplete('batch-1', 'completed')
  await tick()

  // batch2 失败
  await waitUntil(() => mock.created.length >= 2)
  mock.emitComplete('batch-2', 'failed', 'boom')
  await tick()
  await runPromise

  assert.equal(mock.created.length, 2)
  const parsedKeys = record.fileUpdates.filter((u) => u.status === 'parsed').map((u) => u.key)
  const errorKeys = record.fileUpdates.filter((u) => u.status === 'error').map((u) => u.key)
  // batch1 全部 parsed
  assert.deepEqual(parsedKeys.sort(byKeyNum), Array.from({ length: 100 }, (_, i) => 'f' + i))
  // batch2 全部 error（失败隔离，仅本 chunk）
  assert.deepEqual(errorKeys.sort(byKeyNum), Array.from({ length: 50 }, (_, i) => 'f' + (100 + i)))
  // session 不因某批失败而整体 cancelled
  assert.equal(getSession(session.id).status, 'completed')

  removeSession(session.id)
})
