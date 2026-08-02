/**
 * 5.1b-3b 契约测试：frontend transport 层必须让 `completed_with_errors` 完整穿过
 * 前后端边界而不被吞掉、不被误当成 `failed`。
 *
 * 风险背景（用户冻结契约裁决）：
 *   `completed_with_errors` 是 5.1b 新增的唯一终态，语义 = "有成功页、但部分页
 *   缺失/worker 失败"。transport 层只负责透传 status + missingPages/failedPages，
 *   绝不提前解释为 failed（否则会把成功页也连带标 error，引发已有 UI 行为改变）。
 *
 * 本测试锁定四条边界：
 *   Case 1  SSE 事件 {status:"completed_with_errors", missingPages:[...]}
 *           → onComplete 收到的 status 必须是原值 "completed_with_errors"，且 missingPages 透传。
 *   Case 2  SSE 事件 {status:"completed"}
 *           → onComplete 收到 status="completed"，且不应携带 missingPages/failedPages（旧契约，completed 保持干净 payload）。
 *   Case 3  SSE 事件 {status:"completed_with_errors"}
 *           → 必须触发 onComplete（即 Promise resolve、SSE close 停止 polling），而非继续轮询卡死。
 *   Case 4  runChunkedImport 收到 {status:"completed_with_errors"}
 *           → 必须调用 hydrateChunk（成功页回填），绝不能把整 chunk 文件标 error（回归护栏：
 *             若 transport 漏识别，会落入 else 分支把全部文件标 error）。
 *
 * 运行：frontend/ 目录下
 *   node test/importBatchClient.5_1b_3b.test.mjs
 *
 * 红基线验证：还原 ImportBatchClient.js / runChunkedImport.js 的未提交改动后，
 *   Case 1/3/4 必红（completed_with_errors 不被识别为终态、被误标 error），证明本测试锁的是机制。
 */
import assert from 'node:assert/strict'

// ── Node 无原生 EventSource，注入 mock ──────────────────────────────
// ImportBatchClient.subscribeBatchProgress 内部 `new EventSource(url)`，
// 我们提供一个可手动触发 onmessage 的 mock，从而在不依赖真实 SSE 的情况下
// 精确验证"终态判断 + 透传"。
class MockEventSource {
  constructor(url) {
    this.url = url
    this.onmessage = null
    this.onerror = null
    this.closed = false
  }
  close() {
    this.closed = true
  }
}
globalThis.EventSource = MockEventSource

const { subscribeBatchProgress } = await import('../src/services/ImportBatchClient.js')
const { runChunkedImport } = await import('../src/import/runChunkedImport.js')
const { createImportSession } = await import('../src/stores/ImportSessionStore.js')

/**
 * 模拟一次 SSE：注入一条终态事件，等待 onComplete / onError。
 * 带超时守卫：若 completed_with_errors 未被识别为终态，onComplete 永不触发 → 超时 reject（红）。
 */
function runSSE(progressPayload, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `SSE 未在 ${timeoutMs}ms 内触发 onComplete —— completed_with_errors 未被识别为终态（Case 1/3 回归）`
      ))
    }, timeoutMs)
    const es = subscribeBatchProgress('B-test', {
      onProgress: () => {},
      onComplete: (p) => {
        clearTimeout(timer)
        resolve({ p, es })
      },
      onError: () => {
        clearTimeout(timer)
        resolve({ error: true, es })
      },
    })
    // 模拟 SSE 推送一条终态事件
    setImmediate(() => es.onmessage({ data: JSON.stringify(progressPayload) }))
  })
}

async function main() {
  // ── Case 1: completed_with_errors 透传 status + missingPages ──────
  {
    const payload = {
      status: 'completed_with_errors',
      missingPages: [{ sourceDocId: 'a', pages: [2] }],
      failedPages: [{ sourceDocId: 'a', pages: [1] }],
    }
    const { p } = await runSSE(payload)
    assert.equal(p.status, 'completed_with_errors',
      'Case 1: onComplete 收到的 status 必须保持原值 completed_with_errors，transport 层不得改写/吞掉')
    assert.deepEqual(p.missingPages, [{ sourceDocId: 'a', pages: [2] }],
      'Case 1: missingPages 必须透传，不得被 transport 层丢弃')
    assert.deepEqual(p.failedPages, [{ sourceDocId: 'a', pages: [1] }],
      'Case 1: failedPages 必须透传，不得被 transport 层丢弃')
  }
  console.log('PASS Case 1: completed_with_errors 的 status / missingPages / failedPages 完整透传')

  // ── Case 2: completed 保持干净 payload（不携带 missingPages/failedPages） ──
  {
    const { p } = await runSSE({ status: 'completed' })
    assert.equal(p.status, 'completed', 'Case 2: completed 的 status 透传正确')
    assert.equal(p.missingPages, undefined,
      'Case 2: completed 不应携带 missingPages（旧契约，后端 get_batch_dict 对 completed 不注入）')
    assert.equal(p.failedPages, undefined,
      'Case 2: completed 不应携带 failedPages（旧契约）')
  }
  console.log('PASS Case 2: completed 不携带 missingPages/failedPages（契约干净）')

  // ── Case 3: completed_with_errors 必须触发 onComplete（resolve + 停止 polling） ──
  {
    const { p, es } = await runSSE({ status: 'completed_with_errors' })
    assert.equal(p.status, 'completed_with_errors', 'Case 3: onComplete 被触发')
    assert.equal(es.closed, true,
      'Case 3: 终态后 SSE 必须 close() 停止轮询，否则前端继续 polling 卡死')
  }
  console.log('PASS Case 3: completed_with_errors 触发 onComplete 并关闭 SSE（停止 polling）')

  // ── Case 4: runChunkedImport 收到 completed_with_errors 必须 hydrate，不得整批标 error ──
  {
    const session = createImportSession()
    const sessionId = session.id
    let hydrateCalled = false
    const client = {
      createImportBatch: async (files) => ({ batchId: 'B-x', total: files.length }),
      // 模拟 SSE 立即推送 completed_with_errors 终态
      subscribeBatchProgress: (batchId, cb) => {
        setImmediate(() => cb.onComplete({
          status: 'completed_with_errors',
          missingPages: [{ sourceDocId: 'a', pages: [2] }],
        }))
        return { close() {} }
      },
      // 无成功 item（缺页场景）：completed_with_errors 但 items 空
      getBatchResults: async () => [],
      cancelImportBatch: async () => true,
    }
    const updates = []
    const deps = {
      client,
      onFileUpdate: (key, status, extra) => updates.push({ key, status, extra }),
      hydrateChunk: async () => { hydrateCalled = true },
    }
    const files = [{ key: 'k1', name: 'a.pdf' }]
    await runChunkedImport({ sessionId, taskId: 'T1', files, chunkSize: 50, autoOrient: false, deps })

    assert.equal(hydrateCalled, true,
      'Case 4: completed_with_errors 必须触发 hydrateChunk（成功页回填路径），而非被当成 failed 跳过')
    const markedError = updates.some((u) => u.key === 'k1' && u.status === 'error')
    assert.equal(markedError, false,
      'Case 4: completed_with_errors 不得把整 chunk 文件标 error（回归护栏：transport 漏识别时才会整批 error）')
  }
  console.log('PASS Case 4: runChunkedImport 对 completed_with_errors 调 hydrateChunk，不整批标 error')

  console.log('\n✅ 5.1b-3b 全部 4 个 Case 通过：completed_with_errors 完整穿过 frontend transport 边界。')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ FAIL:', err && err.message ? err.message : err)
    process.exit(1)
  })
