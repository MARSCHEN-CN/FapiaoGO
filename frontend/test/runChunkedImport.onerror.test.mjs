/**
 * #1 回归：SSE onError 触发后，runChunkedImport 的 Promise 必须正常 settle（不得卡死）。
 *
 * 修复前（runChunkedImport.js 旧 :208）：
 *   onError 回调写作 `resolve(progress)`，但 `progress` 只是 onComplete 的形参，
 *   onError 作用域内并不存在 → 抛 ReferenceError。该错误逃出 SSE 错误处理器，
 *   `resolve` 永不被调用 → `await new Promise(...)` 永不 settle → chunk 循环卡死、
 *   parsing/importing 恒为 true，用户只能刷新。
 *
 * 修复后：onError 改为 `resolve(null)`，Promise 正常 settle，chunk 循环继续收尾，
 *   本 chunk 文件被标记 error（失败隔离）。
 *
 * 本 harness 利用 runChunkedImport 的依赖注入边界（文件头 :8-14 声明"不依赖
 * React/DOM/真实 EventSource，所有 React 绑定通过 deps 注入，便于 Node 下 mock 验收"）：
 *   注入一个 subscribeBatchProgress 会异步触发 onError 的 mock client，
 *   再用 Promise.race 对超时断言——若 Promise 在超时内未 settle 即判定回归。
 *
 * 运行：frontend/ 目录下  node test/runChunkedImport.onerror.test.mjs
 */
import assert from 'node:assert/strict'
import { runChunkedImport } from '../src/import/runChunkedImport.js'
import { createImportSession } from '../src/stores/ImportSessionStore.js'

const TIMEOUT_MS = 3000

async function main() {
  // 建立真实 session，让 store 调用（attachFilesToBatch / updateFileError / updateSessionStatus）落到位
  const session = createImportSession()
  const sessionId = session.id

  let onErrorFired = false
  const client = {
    createImportBatch: async (files) => ({ batchId: 'B-test-1', total: files.length }),
    // 模拟 SSE 连接错误：异步触发 onError（真实场景由 EventSource.onerror 驱动）
    subscribeBatchProgress: (batchId, cb) => {
      setTimeout(() => {
        onErrorFired = true
        cb.onError(new Error('SSE 连接失败'))
      }, 0)
      return { close() {} }
    },
    getBatchResults: async () => [],
    cancelImportBatch: async () => true,
  }

  const updates = []
  const deps = {
    client,
    onFileUpdate: (key, status) => updates.push({ key, status }),
  }

  const files = [{ key: 'k1', name: 'a.pdf' }]

  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        'TIMEOUT: runChunkedImport 的 Promise 在 ' + TIMEOUT_MS + 'ms 内未 settle ' +
        '（#1 回归失败：onError 仍引用未定义变量 progress，resolve 永不触发）'
      ))
    }, TIMEOUT_MS)
  })

  const result = await Promise.race([
    runChunkedImport({ sessionId, taskId: 'T1', files, chunkSize: 50, autoOrient: false, deps }),
    timeout,
  ])
  clearTimeout(timer)

  // 断言：onError 被触发、文件被标记 error、编排正常收尾（非 abort）
  assert.equal(onErrorFired, true, 'onError 应被触发')
  assert.ok(
    updates.some((u) => u.key === 'k1' && u.status === 'error'),
    '出错 chunk 的文件应被标记为 error（失败隔离）'
  )
  assert.equal(result.wasAborted, false, '非取消路径，wasAborted 应为 false')

  console.log('PASS #1: SSE onError 后 Promise 正常 settle，文件标记 error，导入未卡死')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL #1:', err && err.message ? err.message : err)
    process.exit(1)
  })
