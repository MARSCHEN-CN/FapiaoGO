/**
 * runChunkedImport — IS-1 纯编排层（与 React 解耦）。
 *
 * 职责：
 *   将就绪文件顺序分块提交到 ImportBatchClient，聚合各子批次 SSE 进度到 session，
 *   处理 cooperative cancel（合同 §4 顺序 / §7 cancel）。
 *
 * 设计边界：
 *   - 不依赖 React / DOM / 真实 EventSource。所有 React 绑定（queueUpdate /
 *     setParseProgress / TaskRegistry 状态）通过 deps 注入，便于 Node 下 mock 验收
 *     （Commit 5 Acceptance Harness）。
 *   - ImportSessionStore 的纯函数是本模块直接依赖（无 React），Node 可直接 import。
 *   - 真实 hydration（字段回填 + DocumentStore 通知）由 hook 通过 deps.hydrateChunk
 *     注入；测试可省略，此时完成批次仅标记文件 parsed。
 *
 * 与 useFileOps 的关系：
 *   hook 负责创建 session / task、持有 abortController，把 React 回调与 ImportBatchClient
 *   注入本函数后委托执行；本函数只负责编排，不改变任何 UI 状态机规则。
 *
 * @module import/runChunkedImport
 */

import {
  addChildBatch,
  getChildBatchIds,
  attachFilesToBatch,
  updateFileError,
  updateProgress,
  updateSessionStatus,
} from '../stores/ImportSessionStore.js'

/**
 * @typedef {Object} ChunkedImportClient
 * @property {(files: Array<{file:any,name:string,clientKey?:string}>, opts:{autoOrient:boolean,signal?:AbortSignal}) => Promise<{batchId:string,total:number}>} createImportBatch
 * @property {(batchId:string, cb:{onProgress:Function,onComplete:Function,onError:Function}) => any} subscribeBatchProgress
 * @property {(batchId:string, signal?:AbortSignal) => Promise<Array>} getBatchResults
 * @property {(batchId:string, signal?:AbortSignal) => Promise<boolean>} cancelImportBatch
 */

/**
 * @typedef {Object} ChunkedImportDeps
 * @property {ChunkedImportClient} client
 * @property {(key:string, status:string, extra?:object) => void} onFileUpdate - 替换 hook 的 queueUpdate
 * @property {(p:{current:number,total:number}) => void} [onAggregateProgress] - 替换 hook 的 setParseProgress
 * @property {(taskId:string, status:string) => void} [onTaskStatus] - 替换 TaskRegistry.updateTaskStatus
 * @property {(taskId:string, eventSource:any) => void} [onTaskStream] - 替换 hook 的 setTaskStream
 * @property {(ctx:{batchId:string,chunk:Array,signal?:AbortSignal,client:ChunkedImportClient,terminalFileKeys:Set<string>}) => Promise<void>} [hydrateChunk] - 真实 hydration（hook 注入；测试省略）
 */

/**
 * 顺序分块提交编排。
 *
 * @param {Object} args
 * @param {string} args.sessionId
 * @param {string} args.taskId
 * @param {Array<{key:string,name:string,file?:any,fileFormat?:string,docId?:string}>} args.files - readyFiles
 * @param {number} args.chunkSize
 * @param {boolean} args.autoOrient
 * @param {ChunkedImportDeps} args.deps
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{wasAborted:boolean}>}
 */
export async function runChunkedImport({ sessionId, taskId, files, chunkSize, autoOrient, deps, signal }) {
  const {
    client,
    onFileUpdate,
    onAggregateProgress,
    onTaskStatus,
    onTaskStream,
    hydrateChunk,
  } = deps

  const { createImportBatch, subscribeBatchProgress, getBatchResults, cancelImportBatch } = client

  const eventSources = []
  const batchProgress = new Map() // batchId -> {current,total}
  // fileKeys 已达终态（parsed/error/cancelled）；abort 时只回退未达终态的文件
  const terminalFileKeys = new Set()
  // 声明在 try 之外，供 catch 块访问（提交阶段致命失败时用 loopIndex 计算未提交 chunk 范围）
  let loopIndex = 0

  // 固定总文件数：total 不随 chunk 提交动态累加，避免新 chunk 加入时 total 跳增导致百分比回退
  // current 单调累加所有 batch 的已完成数：已完成 batch 的 current=total（贡献等量增长），
  // 活跃 batch 的 current 从后端 SSE 实时更新。两者相加保证进度严格单调递增。
  const TOTAL_FILES = files.length

  const aggregateProgress = () => {
    let current = 0
    for (const p of batchProgress.values()) {
      current += p.current
    }
    // current 上限钳制：不超过 TOTAL_FILES（防御性，正常情况下不会超出）
    if (current > TOTAL_FILES) current = TOTAL_FILES
    if (onAggregateProgress) onAggregateProgress({ current, total: TOTAL_FILES })
    updateProgress(sessionId, { completed: current, total: TOTAL_FILES })
  }

  // ── cooperative cancel（合同 §7）─────────────────────────
  // 停止提交 + 请求子 batch cancel + session 标记 CANCELLED。不保证 kill 在途 OCR worker。
  let wasAborted = false
  let currentResolve = null
  const onAbort = () => {
    wasAborted = true
    for (const es of eventSources) {
      if (es && typeof es.close === 'function') es.close()
    }
    for (const bid of getChildBatchIds(sessionId)) cancelImportBatch(bid).catch(() => {})
    // 仅回退尚未达终态的文件（已 parsed 的 chunk 保持，避免取消时把已完成文件误标 cancelled）
    for (const fileObj of files) {
      if (!terminalFileKeys.has(fileObj.key)) onFileUpdate(fileObj.key, 'cancelled')
    }
    if (onTaskStatus) onTaskStatus(taskId, 'cancelled')
    updateSessionStatus(sessionId, 'cancelled')
    if (currentResolve) {
      const r = currentResolve
      currentResolve = null
      r()
    }
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort)
  }

  try {
    // IS-1 Commit 2: 顺序分块提交（合同 §4：顺序，不并行）。
    // 一次用户导入 = 一个 session 聚合多个 batch；后端 SUBMIT_WINDOW=50 兜底背压。
    for (let i = 0; i < files.length; i += chunkSize) {
      if (signal && signal.aborted) break
      loopIndex = i
      const chunk = files.slice(i, i + chunkSize)
      const filesForBatch = chunk.map((fileObj) => ({
        file: fileObj.file,
        name: fileObj.name,
        clientKey: fileObj.key,
        // [Identity Bridge] 与 files 一一对应，经 ImportBatchClient 透传为 pageMetas
        sourceDocId: fileObj.sourceDocId || fileObj.docId || '',
        // IS-4.2 Step2：文档实例身份透传（producer 见 fileHelpers.buildFileObj）。
        // 与 sourceDocId（内容哈希）语义独立：同内容 A/B → sourceDocId 同、instanceId 异。
        instanceId: fileObj.instanceId || '',
        pageNum: fileObj.pageNum ?? null,
        totalPages: fileObj.totalPages ?? null,
      }))

      // 提交本批（createImportBatch 抛错 = 致命，跳出循环交由 catch 处理剩余 chunk）
      const { batchId, total } = await createImportBatch(filesForBatch, {
        autoOrient,
        signal,
      })

      // 记录到 session（Commit 1 新增：childBatchIds / file-level batchId）
      addChildBatch(sessionId, batchId)
      attachFilesToBatch(sessionId, chunk.map((f) => f.key), batchId)
      batchProgress.set(batchId, { current: 0, total })

      // 监听本批 SSE（hydration 仅处理本 chunk 文件 → 失败隔离）
      await new Promise((resolve) => {
        currentResolve = resolve
        const eventSource = subscribeBatchProgress(batchId, {
          onProgress: (progress) => {
            batchProgress.set(batchId, { current: progress.current, total: progress.total })
            aggregateProgress()
          },
          onComplete: async (progress) => {
            try {
              // 用户已在处理本 chunk 期间取消：不再 hydration，避免覆盖 cancelled
              if (signal && signal.aborted) {
                for (const fileObj of chunk) {
                  if (!terminalFileKeys.has(fileObj.key)) onFileUpdate(fileObj.key, 'cancelled')
                }
                currentResolve = null
                resolve(progress)
                return
              }
              if (progress.status === 'completed' || progress.status === 'completed_with_errors') {
                if (hydrateChunk) {
                  await hydrateChunk({ batchId, chunk, signal, client: { getBatchResults }, terminalFileKeys })
                }
                // 完成批次：状态迁移 + 字段回填均已由 hydrateChunk 完成（parsed + 富字段）。
                // 此处仅做 bookkeeping 登记，不再重复 onFileUpdate('parsed')——
                // 否则 queueUpdate 的 Map last-write-wins 会用空 extra 覆盖 hydrateChunk 写入的解析字段。
                for (const fileObj of chunk) {
                  terminalFileKeys.add(fileObj.key)
                }
              } else {
                // failed / cancelled：仅标记本 chunk 文件（失败隔离）
                const st = progress.status === 'cancelled' ? 'cancelled' : 'error'
                for (const fileObj of chunk) {
                  onFileUpdate(fileObj.key, st)
                  terminalFileKeys.add(fileObj.key)
                  updateFileError(sessionId, fileObj.key, progress.error || (st === 'cancelled' ? '已取消' : '解析失败'))
                }
              }
              currentResolve = null
              resolve(progress)
            } catch (err) {
              console.error('[runChunkedImport] onComplete FAILED:', err)
              // 回退：标记本 chunk 文件为 parsed（至少不卡住）
              for (const fileObj of chunk) {
                onFileUpdate(fileObj.key, 'parsed')
                terminalFileKeys.add(fileObj.key)
              }
              currentResolve = null
              resolve(progress)
            }
          },
          onError: (err) => {
            console.error('[runChunkedImport] SSE 错误:', err)
            // 仅标记本 chunk 文件错误（失败隔离），继续后续 chunk
            for (const fileObj of chunk) {
              onFileUpdate(fileObj.key, 'error')
              terminalFileKeys.add(fileObj.key)
              updateFileError(sessionId, fileObj.key, err?.message || 'SSE 连接失败')
            }
            currentResolve = null
            // onError 作用域内无 progress 变量（它是 onComplete 的参数）；
            // 此前 resolve(progress) 抛 ReferenceError，Promise 永不 settle、导入卡死。
            // 用结构化错误对象 settle（而非 null），使上层 `result?.status === 'error'`
            // 可显式分支，错误不被静默吞掉。
            resolve({ status: 'error', error: err })
          },
        })
        eventSources.push(eventSource)
        if (onTaskStream) onTaskStream(taskId, eventSource)
      })
    }
    if (!wasAborted) {
      if (onTaskStatus) onTaskStatus(taskId, 'completed')
      // session 终态由编排层统一归属（合同 §7）：completed 与 cancelled 对称
      updateSessionStatus(sessionId, 'completed')
    }
  } catch (err) {
    console.error('[runChunkedImport] 批量解析失败:', err)
    // 仅标记尚未提交/未完成的 chunk 文件为错误（不回退逐个解析，避免重复请求）
    const remaining = files.slice(loopIndex)
    for (const fileObj of remaining) {
      // 提交阶段致命失败：未提交 chunk 标记错误；若因 abort 中断则标记 cancelled
      onFileUpdate(fileObj.key, signal && signal.aborted ? 'cancelled' : 'error')
    }
    throw err
  }

  return { wasAborted }
}
