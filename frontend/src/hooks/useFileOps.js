import { useState, useCallback, useRef, useEffect } from 'react'
import { useDropzone } from 'react-dropzone'
import { BACKEND_URL, SUPPORTED_EXTENSIONS, IMPORT_SCALE_V1 } from '../config'
import {
  getElectronAPI, getFilePath, getExtension, getExtensionWithDot,
  getMimeType, concurrentBatch, applySort, detectDuplicateInvoices, getPreviousYearInfo,
} from '../utils'
import { stripIdentity } from '../utils/fileHelpers'
import { applyFileUpdate } from '../utils/fileStateTransitions'
import { createPlaceholders } from '../utils/placeholderGenerator'
import { resolveFile } from '../services/FileResolver'
import { prepareBatchRequest } from '../services/ParseBatchClient'
import { consumeBatchStream } from '../services/StreamConsumer'
import { createTask, setTaskAbortController, updateTaskStatus, getTask, setTaskStream, cancelTask } from '../services/TaskRegistry'
import { createQueues, enqueueSplit, enqueueParse, dequeueSplit, dequeueParse, getSplitQueueLength, getParseQueueLength } from '../services/TaskScheduler'
import { createImportBatch, subscribeBatchProgress, cancelImportBatch, getBatchResults } from '../services/ImportBatchClient'
import { runParseTask } from '../runners/parseRunner'
import { runSplitTask } from '../runners/splitRunner'
import { runFallbackParseTask } from '../runners/fallbackParseRunner'
import { mapParseResultToFileUpdate } from '../mappers/parseResultMapper'
import { createImportSession, addFilesToSession, replaceFileItems, updateProgress, updateSessionStatus } from '../stores/ImportSessionStore'
import { processImportedFiles } from '../processors/invoicePostProcessor'
import { consumeParseResult } from '../consumers/parseResultConsumer'
import { createParseResult } from '../models/ParseResult'

// ── 状态迁移规则 ─────────────────────────────────────────
// 仅允许正向状态迁移，阻止回退（Import Pipeline Contract v1.2）
// 规则定义已迁至 ../utils/fileStateTransitions（与 applyFileUpdate 同模块，单一事实源）

export function useFileOps({ setFiles, settings, electronAPIRef, sortByRef, sortOrderRef }) {
  const [isNativeDragActive, setIsNativeDragActive] = useState(false)
  const [importing, setImporting] = useState(false)   // 整个导入流程（处理+解析）
  const [parsing, setParsing] = useState(false)
  const [parseProgress, setParseProgress] = useState({ current: 0, total: 0 })

  // ✅ 修复闭包陷阱：使用 ref 保存最新 settings
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  // ── Batch UI Sync ─────────────────────────────────────────
  // 批量状态更新队列，替代逐次 setFiles（Import Pipeline Contract v1.1）
  // Commit 2a: 仅替换 safeUpdate 实现，不改变状态迁移规则
  const pendingUpdatesRef = useRef(new Map())
  const flushScheduledRef = useRef(false)
  const pendingFrameRef = useRef(null)
  const setFilesRef = useRef(setFiles)
  setFilesRef.current = setFiles

  const flushUpdates = useCallback(() => {
    flushScheduledRef.current = false
    pendingFrameRef.current = null
    const pending = pendingUpdatesRef.current
    pendingUpdatesRef.current = new Map()
    if (pending.size === 0) return

    setFilesRef.current((prev) =>
      prev.map((f) => {
        const update = pending.get(f.key)
        if (!update) return f
        // payload 与状态迁移解耦：数据永远合并，状态仅在合法迁移时更新
        return applyFileUpdate(f, update)
      })
    )
  }, [])

  const scheduleFlush = useCallback(() => {
    if (flushScheduledRef.current) return
    flushScheduledRef.current = true

    const doFlush = () => { flushUpdates() }

    if (typeof requestIdleCallback === 'function') {
      pendingFrameRef.current = requestIdleCallback(doFlush, { timeout: 200 })
    } else {
      pendingFrameRef.current = setTimeout(doFlush, 100)
    }
  }, [flushUpdates])

  const queueUpdate = useCallback((key, newStatus, extra = {}) => {
    // Map 去重：同一文件只保留最新状态
    pendingUpdatesRef.current.set(key, { newStatus, extra })
    scheduleFlush()
  }, [scheduleFlush])

  // ============================
  // 任务状态枚举
  // ============================
  const TASK_STATUS = {
    PENDING: 'pending',
    READING: 'reading',
    UPLOADING: 'uploading',
    PARSING: 'parsing',
    SUCCESS: 'success',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
  }

  // ============================
  // 批量解析文件（单次请求提交所有文件）
  // ============================
  const parseFilesBatch = useCallback(async (filesToParse) => {
    const ipc = electronAPIRef.current?.ipcRenderer
    const autoOrient = settingsRef.current.autoOrient ?? false

    // 1. 通过 ParseBatchClient 准备请求（FormData + URL）
    const { url, formData } = await prepareBatchRequest(filesToParse, { ipc, autoOrient })

    // 2. 标记所有文件为 uploading（UI 状态初始同步）
    setFiles((prev) =>
      prev.map((f) =>
        filesToParse.some((fp) => fp.key === f.key)
          ? { ...f, status: 'uploading' }
          : f
      )
    )

    // 3. 通过 StreamConsumer + TaskRegistry 消费 SSE 流
    //    SSE 生命周期由 TaskRegistry 管理（AbortController 统一取消）
    //    ParseResultConsumer 将结果写入 ImportSessionStore + 返回 UI 更新
    const abortController = new AbortController()
    const task = createTask(filesToParse.map((f) => f.key))
    setTaskAbortController(task.id, abortController)

    const batchResult = await consumeBatchStream(url, formData, {
      signal: abortController.signal,
      onProgress: (msg) => {
        setParseProgress({ current: msg.current, total: msg.total })
      },
    })

    updateTaskStatus(task.id, 'completed')

    // 4. 消费批量结果：Consumer 写入 Store + 收集 UI 更新
    const updates = new Map()
    for (const item of batchResult.items) {
      const fileObj = filesToParse[item.index]
      if (!fileObj) continue

      if (item.success && item.data) {
        const result = createParseResult(item.data, fileObj.name)
        const update = consumeParseResult(result, fileObj, task.id)
        updates.set(fileObj.key, { ...update, status: result.status })
      } else {
        updates.set(fileObj.key, { status: 'error', errorMsg: item.error || '解析失败' })
      }
    }

    // 5. 批量同步到 React UI
    if (updates.size > 0) {
      setFiles((prev) =>
        prev.map((f) => {
          const update = updates.get(f.key)
          return update ? { ...f, ...update } : f
        })
      )
    }

    // 6. 进度已由 SSE onProgress 实时更新，不再重复计算
  }, [electronAPIRef])

  // ============================
  // 解析文件（带重试和限流处理）
  // ============================
  const parseFiles = useCallback(async (filesToParse) => {
    if (filesToParse.length === 0) return
    setParsing(true)
    let fallbackDoneCount = 0
    setParseProgress({ current: 0, total: filesToParse.length })

    // ✅ 降低并发限制，避免过多 OCR 任务同时运行
    const CONCURRENCY_LIMIT = 2
    const MAX_RETRY = 1

    try {
      const ipc = electronAPIRef.current?.ipcRenderer
      const autoOrient = settingsRef.current.autoOrient ?? false

      // 多文件时优先使用批量接口，失败时回退到逐个解析
      if (filesToParse.length > 1) {
        try {
          await parseFilesBatch(filesToParse)
          setFiles((prev) => {
            const duplicates = detectDuplicateInvoices(prev)
            const duplicateInfo = new Map()
            duplicates.forEach((dupFiles, groupIndex) => {
              dupFiles.forEach((file, idx) => {
                duplicateInfo.set(file.key, { groupIndex, isFirst: idx === 0 })
              })
            })
            return applySort(prev, sortByRef.current, sortOrderRef.current, duplicateInfo, getPreviousYearInfo(prev))
          })
          return
        } catch (batchErr) {
          console.warn('[parseFiles] 批量解析失败，回退逐个解析:', batchErr)
          fallbackDoneCount = 0  // 重置计数器，准备逐个解析
          setParseProgress({ current: 0, total: filesToParse.length })
          // 继续执行下方的逐个解析逻辑
        }
      }

      await concurrentBatch(filesToParse, async (fileObj) => {
        // 通过 fallbackParseRunner 执行单文件解析
        // Runner 处理：文件读取 + FormData + fetch + retry → ParseResult
        const task = { fileObj }
        const outcome = await runFallbackParseTask(task, { ipc, autoOrient, maxRetry: MAX_RETRY })

        if (outcome.success && outcome.result) {
          // 通过 Consumer 写入 Store + 生成 UI 更新
          consumeParseResult(outcome.result, fileObj, null)

          setFiles((prev) =>
            prev.map((f) =>
              f.key === fileObj.key
                ? { ...f, ...mapParseResultToFileUpdate(outcome.result, fileObj), status: outcome.status }
                : f
            )
          )
        } else {
          setFiles((prev) =>
            prev.map((f) =>
              f.key === fileObj.key
                ? { ...f, status: 'error', errorMsg: outcome.error || '解析失败' }
                : f
            )
          )
        }

        // 更新解析进度（本地计数器，不依赖全局 ref）
        fallbackDoneCount += 1
        setParseProgress({ current: fallbackDoneCount, total: filesToParse.length })
      }, CONCURRENCY_LIMIT)

      setFiles((prev) => {
        const duplicates = detectDuplicateInvoices(prev)
        const duplicateInfo = new Map()
        duplicates.forEach((dupFiles, groupIndex) => {
          dupFiles.forEach((file, idx) => {
            duplicateInfo.set(file.key, { groupIndex, isFirst: idx === 0 })
          })
        })
        return applySort(prev, sortByRef.current, sortOrderRef.current, duplicateInfo, getPreviousYearInfo(prev))
      })
    } finally {
      setParsing(false)
      setParseProgress({ current: 0, total: 0 })
    }
  }, [electronAPIRef, parseFilesBatch])

  /**
   * 处理文件添加（公共函数，消除重复逻辑）
   * @param {Array} files - 文件数组，每个元素包含 file, name, path
   */
  const processFilesForAddition = useCallback(async (files) => {
    if (files.length === 0) return

    // ✅ 立即显示导入弹窗
    setImporting(true)
    const ipc = electronAPIRef.current?.ipcRenderer
    const autoOrient = settingsRef.current.autoOrient ?? false

    // ── Step 1: 为每个文件生成占位项，立即显示 ──────────────
    const placeholders = createPlaceholders(files)

    // 创建导入会话（ImportSessionStore 成为文件状态的权威来源）
    const session = createImportSession()
    addFilesToSession(session.id, placeholders)

    // 所有占位一步添加到列表（从 Session 同步到 React state）
    setFiles((prev) => {
      const existingKeys = new Set(
        prev.map((f) => f.printPath || f.path || `${f.name}_${f.size}_${f.lastModified}`)
      )
      return [...prev, ...placeholders.filter((f) => !existingKeys.has(f.path || f.name))]
    })

    // ── 状态更新（批量队列） ─────────────────────────────
    // 使用 queueUpdate 替代直接的 setFiles 调用，通过 requestIdleCallback
    // 批量应用状态变更，避免大量文件导入时的渲染风暴。
    // VALID_TRANSITION 守卫在 flushUpdates 内部执行。
    // replaceWithItems 同时更新 Store 和 React state
    const replaceWithItems = (key, newItems) => {
      replaceFileItems(session.id, key, newItems)
      setFiles((prev) => {
        const idx = prev.findIndex((f) => f.key === key)
        if (idx === -1) return prev
        if (prev[idx].status !== 'splitting' && prev[idx].status !== 'uploading') return prev
        const copy = [...prev]
        copy.splice(idx, 1, ...newItems)
        return copy
      })
    }

    // ── Step 2: 并发 split_pdf + parse 流水线 ────────────
    const SPLIT_CONCURRENCY = 4
    const PARSE_CONCURRENCY = 2

    // 队列所有权已迁移至 TaskScheduler（Phase 1b-3-2/3）
    createQueues()
    const splitJobs = placeholders.map((p, i) => ({ p, file: files[i] }))
    enqueueSplit(splitJobs)
    let parsePipelineDone = false

    // 进度计数（同步写入 ImportSessionStore）
    let progressTotal = 0
    let progressDone = 0
    let splitDone = 0  // 拆分阶段完成计数（Phase Progress）

    // ── Import Scale v1: 批量收集器 ──────────────────────
    // 当 IMPORT_SCALE_V1 启用时，split 后的文件收集到此数组，
    // 待 split 全部完成后一次性提交到后端 batch API。
    // 当禁用时，走旧路径 enqueueParse → parseWorker。
    const readyFiles = []

    /**
     * 根据 feature flag 决定：收集到 readyFiles 或入队 parseQueue。
     * @param {Object} fileObj - 就绪文件对象
     */
    const collectOrEnqueue = (fileObj) => {
      if (IMPORT_SCALE_V1) {
        readyFiles.push(fileObj)
      } else {
        enqueueParse([{ fileObj }])
      }
    }

    // Parse 流水线（执行委托给 parseRunner，UI 更新在 orchestrator）
    // 仅在 IMPORT_SCALE_V1 = false 时启动（fallback 路径）
    async function parseWorker() {
      while (true) {
        if (getParseQueueLength() === 0 && parsePipelineDone) break
        if (getParseQueueLength() === 0) {
          await new Promise((r) => setTimeout(r, 50))
          continue
        }
        const job = dequeueParse()
        if (!job) continue

        const { fileObj } = job
        queueUpdate(fileObj.key, 'parsing')

        try {
          const result = await runParseTask(job, { ipc, autoOrient })
          const update = consumeParseResult(result, fileObj, session.id)
          queueUpdate(fileObj.key, result.status, update)
        } catch (err) {
          console.error(`[App] 解析失败: ${fileObj.name}`, err)
          queueUpdate(fileObj.key, 'error')
        } finally {
          progressDone += 1
          updateProgress(session.id, { completed: progressDone, total: progressTotal })
          setParseProgress({
            current: progressDone,
            total: progressTotal,
          })
        }
      }
    }

    // Split worker — 执行委托给 splitRunner，UI 更新在 orchestrator
    async function splitWorker() {
      while (getSplitQueueLength() > 0) {
        const job = dequeueSplit()
        if (!job) continue
        const { p, file: f } = job
        queueUpdate(p.key, 'splitting')

        try {
          const result = await runSplitTask(job)

          if (result.isPDF) {
            const { toAdd } = result
            if (toAdd.length === 1) {
              const toAddRest = stripIdentity(toAdd[0])
              queueUpdate(p.key, 'ready', toAddRest)
              progressTotal += 1
              const readyFile = { ...p, ...toAddRest }
              collectOrEnqueue(readyFile)
            } else if (toAdd.length > 1) {
              const pageItems = toAdd.map((pageObj) => ({
                ...pageObj,
                status: 'ready',
              }))
              replaceWithItems(p.key, pageItems)
              progressTotal += pageItems.length
              for (const pageObj of pageItems) {
                collectOrEnqueue(pageObj)
              }
            } else {
              queueUpdate(p.key, 'ready', { key: p.key })
              progressTotal += 1
              collectOrEnqueue({ ...p, key: p.key })
            }
          } else {
            const fileObjRest = stripIdentity(result.fileObj)
            queueUpdate(p.key, 'ready', fileObjRest)
            progressTotal += 1
            const readyFile = { ...p, ...fileObjRest }
            collectOrEnqueue(readyFile)
          }
        } catch (err) {
          console.error(`[App] 文件处理失败: ${f.name}`, err)
          queueUpdate(p.key, 'error')
        } finally {
          splitDone += 1
          setParseProgress({ current: splitDone, total: placeholders.length })
        }
      }
    }

    // 启动 split workers（通过 TaskScheduler 管理队列）
    const splitWorkers = []
    for (let i = 0; i < Math.min(SPLIT_CONCURRENCY, placeholders.length); i++) {
      splitWorkers.push(splitWorker())
    }

    setParsing(true)
    setParseProgress({ current: 0, total: placeholders.length })
    await Promise.all(splitWorkers)
    parsePipelineDone = true

    // ── Import Scale v1: 批量解析路径 ────────────────────
    // split 完成后，根据 feature flag 选择执行路径
    if (IMPORT_SCALE_V1 && readyFiles.length > 0) {
      // 批量路径：POST /import/batch + GET SSE
      console.log(`[ImportScale] 批量解析 ${readyFiles.length} 个文件`)

      // 标记所有就绪文件为 parsing（一次性）
      // 状态机已允许 splitting→parsing（Map 去重可能吞掉 ready 中间态）
      for (const fileObj of readyFiles) {
        queueUpdate(fileObj.key, 'parsing')
      }

      // 创建 TaskRegistry 任务（用于取消管理）
      const task = createTask(readyFiles.map((f) => f.key))
      const abortController = new AbortController()
      setTaskAbortController(task.id, abortController)
      updateTaskStatus(task.id, 'running')

      try {
        // 准备文件列表（需要 File 对象 + clientKey 用于结果匹配）
        const filesForBatch = readyFiles.map((fileObj) => ({
          file: fileObj.file,
          name: fileObj.name,
          clientKey: fileObj.key,
        }))
        console.log('[ImportScale] clientKeys 提交:', filesForBatch.map(f => f.clientKey ? f.clientKey.slice(0, 8) : 'EMPTY'))

        // 创建批量导入任务
        const { batchId, total } = await createImportBatch(filesForBatch, {
          autoOrient,
          signal: abortController.signal,
        })

        console.log(`[ImportScale] 批次已创建: ${batchId}, total=${total}`)

        // 监听 SSE 进度
        await new Promise((resolve, reject) => {
          const eventSource = subscribeBatchProgress(batchId, {
            // 注意：onProgress 只驱动任务级进度条，不触碰文件状态。
            // 文件状态仅在两处迁移：提交时 ready→parsing，hydration 时 parsing→parsed。
            onProgress: (progress) => {
              setParseProgress({
                current: progress.current,
                total: progress.total,
              })
              updateProgress(session.id, {
                completed: progress.current,
                total: progress.total,
              })
            },
            onComplete: async (progress) => {
              console.log('[ImportScale] onComplete enter, status=', progress.status)
              try {
                if (progress.status === 'completed') {
                  // ── Hydration：拉取字段数据，分块更新 UI ──
                  console.log('[ImportScale] calling getBatchResults, batchId=', batchId)
                  const items = await getBatchResults(batchId, abortController.signal)
                  console.log('[ImportScale hydration]', { resultCount: items.length, readyCount: readyFiles.length })

                  const resultMap = new Map()
                  for (const item of items) {
                    if (item.clientKey) {
                      resultMap.set(item.clientKey, item)
                    }
                  }

                  // 分块更新（每 100 个一批，避免长任务阻塞渲染）
                  const CHUNK = 100
                  for (let i = 0; i < readyFiles.length; i += CHUNK) {
                    const chunkFiles = readyFiles.slice(i, i + CHUNK)
                    for (const fileObj of chunkFiles) {
                      const item = resultMap.get(fileObj.key)
                      if (item) {
                        // 构造 ParseResult 兼容结构，复用 mapper
                        const hydrationResult = {
                          status: 'parsed',
                          fields: {
                            invoiceType: item.invoiceType || '',
                            invoiceNumber: item.invoiceNumber || '',
                            amount: item.amount || '',
                            invoiceDate: item.invoiceDate || '',
                            newName: item.newName || fileObj.name,
                            parseMethod: item.parseMethod || '',
                            fileFormat: fileObj.fileFormat || '',
                            previewImage: item.previewImage || null,
                            failedFields: item.failedFields || [],
                            invoiceFields: item.invoiceFields || null,
                            issuer: (item.invoiceFields || {}).kpr || '',
                            amountWithoutTax: (item.invoiceFields || {}).hjje || '',
                            taxAmount: (item.invoiceFields || {}).se || '',
                            lineItems: (item.invoiceFields || {}).line_items || [],
                            rawText: '',
                          },
                          raw: {},
                        }
                        const update = mapParseResultToFileUpdate(hydrationResult, fileObj)
                        queueUpdate(fileObj.key, 'parsed', update)
                      } else {
                        // 无匹配结果（失败文件）：仅更新状态
                        queueUpdate(fileObj.key, 'parsed')
                      }
                    }
                    // 让出主线程，允许渲染帧插入
                    if (i + CHUNK < readyFiles.length) {
                      await new Promise(r => setTimeout(r, 0))
                    }
                  }
                  console.log(`[ImportScale] Hydration 完成: ${resultMap.size}/${readyFiles.length} 个文件已填充字段`)
                } else {
                  // failed / cancelled：标记错误
                  for (const fileObj of readyFiles) {
                    queueUpdate(fileObj.key, 'error')
                  }
                }

                updateTaskStatus(task.id, 'completed')
                resolve(progress)
              } catch (err) {
                console.error('[ImportScale] onComplete FAILED:', err)
                // 回退：标记所有文件为 parsed（至少不卡住）
                for (const fileObj of readyFiles) {
                  queueUpdate(fileObj.key, 'parsed')
                }
                updateTaskStatus(task.id, 'completed')
                resolve(progress)
              }
            },
            onError: (err) => {
              console.error('[ImportScale] SSE 错误:', err)
              // SSE 连接失败，标记所有文件为错误
              for (const fileObj of readyFiles) {
                queueUpdate(fileObj.key, 'error')
              }
              updateTaskStatus(task.id, 'cancelled')
              reject(err)
            },
          })

          // 将 EventSource 绑定到 Task（用于取消时关闭）
          setTaskStream(task.id, eventSource)

          // 监听 AbortController（用户取消）
          abortController.signal.addEventListener('abort', () => {
            eventSource.close()
            // 通知后端取消
            cancelImportBatch(batchId).catch(() => {})
            for (const fileObj of readyFiles) {
              queueUpdate(fileObj.key, 'cancelled')
            }
            updateTaskStatus(task.id, 'cancelled')
            reject(new Error('用户取消'))
          })
        })
      } catch (err) {
        console.error('[ImportScale] 批量解析失败:', err)
        // 批量失败时，标记所有文件为错误（不回退到逐个解析，避免重复请求）
        for (const fileObj of readyFiles) {
          queueUpdate(fileObj.key, 'error')
        }
      }
    } else {
      // Fallback 路径：旧 parseWorker（逐个 /parse_invoice，2 并发）
      console.log(`[ImportScale] Fallback 到旧 parseWorker (${readyFiles.length} 个文件)`)

      // 注意：当 IMPORT_SCALE_V1 = false 时，文件已在 splitWorker 中通过 enqueueParse 入队
      // 当 IMPORT_SCALE_V1 = true 但 readyFiles.length = 0 时，无需解析
      const parseWorkers = []
      for (let i = 0; i < PARSE_CONCURRENCY; i++) {
        parseWorkers.push(parseWorker())
      }
      await Promise.all(parseWorkers)
    }

    // 解析完成后：强制刷新所有待处理更新（hydration 结果），再后处理
    flushUpdates()

    // 探针2+3：flush 后状态分布 + processImportedFiles 前完整状态
    setFiles((prev) => {
      const dist = prev.reduce((a, f) => { a[f.status] = (a[f.status] || 0) + 1; return a }, {})
      console.log('[ImportScale flush] 状态分布:', dist)
      const notDone = prev.filter(
        (f) => f.status !== 'parsed' && f.status !== 'error' && f.status !== 'cancelled'
      )
      if (notDone.length > 0) {
        console.warn(`[ImportScale before process] ${notDone.length} 个文件未到终态:`,
          notDone.slice(0, 20).map(f => `${f.name}:${f.status}`))
      }
      const { files: sortedFiles } = processImportedFiles(prev, sortByRef.current, sortOrderRef.current)
      return sortedFiles
    })
    setParsing(false)
    setParseProgress({ current: 0, total: 0 })
    setImporting(false)
    updateSessionStatus(session.id, 'completed')
  }, [setFiles, electronAPIRef, settingsRef, queueUpdate])

  // ============================
  // Native Drop（支持文件和文件夹）
  // ============================
  const handleNativeDrop = useCallback(async (e) => {
    e.preventDefault(); e.stopPropagation(); setIsNativeDragActive(false)
    const api = getElectronAPI()
    if (!api) return

    // 收集拖拽项的真实路径
    const paths = []
    for (let i = 0; i < e.dataTransfer.files.length; i++) {
      const nativeFile = e.dataTransfer.files[i]
      const realPath = api.getFilePath(nativeFile)
      if (realPath) {
        paths.push(realPath)
      }
    }

    if (paths.length === 0) return

    // 通过 IPC 扫描路径（支持文件和文件夹）
    try {
      const result = await api.ipcRenderer.invoke('scan-dropped-paths', { paths })
      if (!result.success || !result.files.length) return

      // 统一通过 FileResolver 读取文件内容
      // 入口只产生 { name, path }，不再拥有文件读取策略
      const droppedFiles = await Promise.all(
        result.files.map(async (f) => {
          const fileObj = await resolveFile({ name: f.name, path: f.path }, api.ipcRenderer)
          return { name: f.name, path: f.path, file: fileObj }
        })
      )

      await processFilesForAddition(droppedFiles)
    } catch (err) {
      console.error('[handleNativeDrop] scan-dropped-paths error:', err)
    }
  }, [processFilesForAddition])

  const handleNativeDragOver = useCallback((e) => {
    e.preventDefault(); e.stopPropagation(); setIsNativeDragActive(true)
  }, [])

  const handleNativeDragLeave = useCallback((e) => {
    e.preventDefault(); e.stopPropagation(); setIsNativeDragActive(false)
  }, [])

  // ✅ 监听 window dragend 事件，防止拖拽状态残留
  useEffect(() => {
    const handleDragEnd = () => {
      setIsNativeDragActive(false)
    }
    window.addEventListener('dragend', handleDragEnd)
    return () => {
      window.removeEventListener('dragend', handleDragEnd)
    }
  }, [])

  // ============================
  // Dropzone
  // ============================
  const onDrop = useCallback(async (acceptedFiles) => {
    if (acceptedFiles.length === 0) return
    const validFiles = acceptedFiles.filter(f => {
      const ext = getExtensionWithDot(f.name)
      return SUPPORTED_EXTENSIONS.includes(ext)
    })
    if (validFiles.length === 0) return

    // ✅ 使用公共函数处理文件添加
    const filesToAdd = validFiles.map(f => ({
      file: f,
      name: f.name,
      path: getFilePath(f)
    }))

    await processFilesForAddition(filesToAdd)
  }, [processFilesForAddition])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'application/octet-stream': ['.ofd'],
      'image/*': ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif'],
    },
    multiple: true,
  })

  // ============================
  // 打开文件对话框
  // ============================
  const handleOpenDialog = useCallback(async () => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return
    const result = await ipc.invoke('open-file-dialog')
    if (!result.success || result.files.length === 0) return

    // 统一通过 FileResolver 读取文件内容（入口只负责发现文件）
    const filesToAdd = await Promise.all(
      result.files.map(async (file) => {
        const fileObj = await resolveFile({ name: file.name, path: file.path }, ipc)
        return { file: fileObj, name: file.name, path: file.path }
      })
    )

    await processFilesForAddition(filesToAdd)
  }, [electronAPIRef, processFilesForAddition])

  // ============================
  // 打开文件夹对话框（添加文件夹）
  // ============================
  const handleOpenFolder = useCallback(async () => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return
    const result = await ipc.invoke('open-folder-dialog')
    if (!result.success || result.files.length === 0) return

    // 统一通过 FileResolver 读取文件内容
    const filesToAdd = await Promise.all(
      result.files.map(async (file) => {
        const fileObj = await resolveFile({ name: file.name, path: file.path }, ipc)
        return { file: fileObj, name: file.name, path: file.path }
      })
    )

    await processFilesForAddition(filesToAdd)
  }, [electronAPIRef, processFilesForAddition])

  return {
    importing,
    parseFiles, parsing, parseProgress,
    isNativeDragActive,
    handleNativeDrop, handleNativeDragOver, handleNativeDragLeave,
    getRootProps, getInputProps, isDragActive,
    handleOpenDialog,
    handleOpenFolder,
  }
}
