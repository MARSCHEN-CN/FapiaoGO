import { useState, useCallback, useRef, useEffect } from 'react'
import { useDropzone } from 'react-dropzone'
import { BACKEND_URL, SUPPORTED_EXTENSIONS, IMPORT_SCALE_V1, IMPORT_CHUNK_SIZE } from '../config'
import {
  getElectronAPI, getFilePath, getExtension, getExtensionWithDot,
  getMimeType, concurrentBatch, applySort, getPreviousYearInfo,
} from '../utils'
import { buildDocumentViewModel, buildPageDuplicateInfo } from '../utils/documentViewModel'
import { stripIdentity } from '../utils/fileHelpers'
import { applyFileUpdate } from '../utils/fileStateTransitions'
import { createPlaceholders } from '../utils/placeholderGenerator'
import { resolveFile } from '../services/FileResolver'
import { prepareBatchRequest } from '../services/ParseBatchClient'
import { consumeBatchStream } from '../services/StreamConsumer'
import { createTask, setTaskAbortController, updateTaskStatus, getTask, setTaskStream, cancelTask, getActiveTasks } from '../services/TaskRegistry'
import { createQueues, enqueueSplit, enqueueParse, dequeueSplit, dequeueParse, getSplitQueueLength, getParseQueueLength } from '../services/TaskScheduler'
import { createImportBatch, subscribeBatchProgress, cancelImportBatch, getBatchResults } from '../services/ImportBatchClient'
import { runParseTask } from '../runners/parseRunner'
import { runSplitTask } from '../runners/splitRunner'
import { runFallbackParseTask } from '../runners/fallbackParseRunner'
import { runChunkedImport } from '../import/runChunkedImport'
import { ensureRenderContract, ensureDocumentMetadata } from '../services/renderDocument'
import { mapParseResultToFileUpdate } from '../mappers/parseResultMapper'
import { updateDocumentIdentity } from '../utils/identity'
import { resolveInstancePageFiles } from '../utils/instancePageOwnership'
import { createImportSession, getActiveSessionId, getSession, reactivateSession, addFilesToSession, replaceFileItems, updateProgress, addDocument, flushSessionNotifications } from '../stores/ImportSessionStore'
import { ensureDocumentFromFileObj, flushDocumentNotifications, getDocument, registerDocument } from '../stores/DocumentStore'
import { createDocument, createPageMeta } from '../models/InvoiceDocument'
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

  // ── 增强版导入进度（分阶段 + 日志） ──────────────────
  // stage: 'idle' | 'splitting' | 'parsing' | 'building' | 'completed'
  const [importStage, setImportStage] = useState('idle')
  const [importStats, setImportStats] = useState({
    originalCount: 0,    // 原始导入文件数
    totalFiles: 0,       // 最终用户可见文件总数（=原始文件数，用于显示 X/Y）
    currentFile: 0,      // 当前处理到第几个原始文件（1-based，显示用）
    splitDone: 0,        // 已拆分文件数
    splitTotal: 0,       // 拆分阶段总数（=原始文件数）
    parseDone: 0,        // 已解析物理文件数
    parseTotal: 0,       // 解析阶段总数（拆分后的物理文件数）
    buildDone: 0,        // 已组装文档数
    buildTotal: 0,       // 组装阶段总数
  })
  const [importLogs, setImportLogs] = useState([])  // 最新在前，最多保留50条
  const progressMonotonicRef = useRef(0)  // 单调递增百分比，防止回退
  const completeDismissTimerRef = useRef(null)  // 导入完成后延迟关闭弹窗的定时器
  const currentAbortRef = useRef(null)  // 当前导入的AbortController（用于取消）

  // 添加导入日志
  const addImportLog = useCallback((message) => {
    setImportLogs((prev) => {
      const next = [{ time: Date.now(), message }, ...prev]
      return next.slice(0, 50)  // 最多保留50条
    })
  }, [])

  // ✅ 修复闭包陷阱：使用 ref 保存最新 settings
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (completeDismissTimerRef.current) {
        clearTimeout(completeDismissTimerRef.current)
        completeDismissTimerRef.current = null
      }
    }
  }, [])

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

    // 13-A.3.5b：消费前并行确保各文件已拿 render doc_id（OFD 等走 Render Contract）。
    // 渲染契约为增强项，ensureRenderContract 内部已容错，不阻断主流程。
    await Promise.all(
      batchResult.items.map((item) => {
        const fileObj = filesToParse[item.index]
        return fileObj ? ensureRenderContract(fileObj) : Promise.resolve(null)
      })
    )

    // 4. 消费批量结果：Consumer 写入 Store + 收集 UI 更新
    const updates = new Map()
    for (const item of batchResult.items) {
      const fileObj = filesToParse[item.index]
      if (!fileObj) continue

      if (item.success && item.data) {
        const result = createParseResult(item.data, fileObj.name)
        // Step 10.5：传入整批文件作为 siblings，供 DocumentStore 聚合
        // 共享 docId 的拆分页为多页 Document（单页文件不受影响）。
        const update = consumeParseResult(result, fileObj, task.id, filesToParse)
        updates.set(fileObj.key, { ...update, status: result.status })

        // 13-A.3.5c：metadata 驱动纠正（OFD 多页 / 真实尺寸）。
        // 置 consume 之后为最终权威：后端 page contract 覆盖 siblings 对单文件多页的欠维注册。
        // 无 OFD 特判——以 docId 是否存在为准（PDF/PNG 未走 render registry 时 /metadata 404 静默降级）。
        if (update?.docId) {
          fileObj.docId = update.docId
          if (update.identity) fileObj.identity = update.identity
        }
        await ensureDocumentMetadata(fileObj)
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
            // D1：重复检测以 document 为单位，再投影到页 key 供 applySort 分区
            const { duplicateGroups } = buildDocumentViewModel(prev)
            return applySort(prev, sortByRef.current, sortOrderRef.current, buildPageDuplicateInfo(duplicateGroups), getPreviousYearInfo(prev))
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
          // Step 10.5：传入整批 filesToParse 作为 siblings，
          // 与批量路径（:145）一致，供 DocumentStore 聚合共享 docId 的拆分页。
          // 13-A.3.5b：消费前确保 render doc_id（OFD 走 Render Contract，容错不阻断）
          await ensureRenderContract(fileObj)
          const update = consumeParseResult(outcome.result, fileObj, null, filesToParse)

          // 13-A.3.5c：metadata 驱动纠正（OFD 多页 / 真实尺寸），置 consume 之后为最终权威
          // 同步更新 docId + identity，确保 resolveDocId() 取到正确值
          if (update?.docId) {
            fileObj.docId = update.docId
            if (update.identity) fileObj.identity = update.identity
          }
          await ensureDocumentMetadata(fileObj)

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
        // D1：重复检测以 document 为单位，再投影到页 key 供 applySort 分区
        const { duplicateGroups } = buildDocumentViewModel(prev)
        return applySort(prev, sortByRef.current, sortOrderRef.current, buildPageDuplicateInfo(duplicateGroups), getPreviousYearInfo(prev))
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

    // 清除上次导入完成的延迟关闭定时器（追加导入时）
    if (completeDismissTimerRef.current) {
      clearTimeout(completeDismissTimerRef.current)
      completeDismissTimerRef.current = null
    }

    // ✅ 立即显示导入弹窗
    setImporting(true)
    progressMonotonicRef.current = 0
    setImportStage('splitting')
    setImportLogs([])

    const ipc = electronAPIRef.current?.ipcRenderer
    const autoOrient = settingsRef.current.autoOrient ?? false

    // 复用活跃会话（追加导入），无活跃会话时创建新会话
    // 避免每次文件拖入都 createImportSession → activeSessionId 切换
    // → FileContext 读取新 session 丢失旧 session.documents。
    let session = getActiveSessionId() ? getSession(getActiveSessionId()) : null
    if (!session) {
      session = createImportSession()
    } else {
      // 复用已终态 session 前，清除 60s 清理定时器并重置状态，
      // 否则定时器在新导入进行中触发 removeSession 导致 session 被删除
      reactivateSession(session.id)
    }
    // 清除上次导入残留的 batch IDs，防止 gate 早返回后 onAbort
    // 用旧 batchId 调 cancelImportBatch 产生 404（IS-4.2.1）
    session.childBatchIds = []

    // ── Step 0: Import Admission Gate (IS-4.2.1) ────
    // 在创建占位符和进入 pipeline 之前按 absolutePath 阻断重复导入。
    // 不走 contentHash（用作 N 重复检测）或 fileName （不同路径同文件名应允许）。
    const normalizeImportPath = (p) => {
      if (!p) return ''
      return p.trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
    }
    const existingPaths = new Set(
      (session.files || []).flatMap((f) => {
        // session.files 中的 path 可能在解析替换后变 null，
        // printPath 始终保留原始路径（buildFileObj 存储规范）
        const p = normalizeImportPath(f.path)
        const pp = normalizeImportPath(f.printPath)
        const results = []
        if (p) results.push(p)
        if (pp && pp !== p) results.push(pp)
        return results
      })
    )
    console.log(`[IMPORT_ADMISSION] gate enter: existingPaths=${existingPaths.size}, incoming=${files.length}`)
    const seenInBatch = new Set()
    const acceptedFiles = files.filter((f) => {
      const np = normalizeImportPath(f.path)
      if (!np) return true // 浏览器 drag/drop 无 path → 不过滤
      if (existingPaths.has(np) || seenInBatch.has(np)) {
        console.log(`[IMPORT_ADMISSION] skip duplicate path: ${np}`)
        return false
      }
      seenInBatch.add(np)
      return true
    })
    if (acceptedFiles.length === 0) {
      setImporting(false)
      console.log('[IMPORT_ADMISSION] 所有文件均为重复，导入已跳过')
      return
    }
    if (acceptedFiles.length < files.length) {
      console.log(`[IMPORT_ADMISSION] 跳过 ${files.length - acceptedFiles.length} 个重复文件（路径）`)
    }

    // ── 初始化导入进度（基于 gate 过滤后的数量） ──
    setImportStats({
      originalCount: acceptedFiles.length,
      totalFiles: acceptedFiles.length,
      currentFile: 0,
      splitDone: 0,
      splitTotal: acceptedFiles.length,
      parseDone: 0,
      parseTotal: 0,
      buildDone: 0,
      buildTotal: 0,
    })
    addImportLog(`开始导入 ${acceptedFiles.length} 个文件...`)

    // ── Step 1: 为每个文件生成占位项，立即显示 ──────────────
    const placeholders = createPlaceholders(acceptedFiles)
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
    const splitJobs = placeholders.map((p, i) => ({ p, file: acceptedFiles[i] }))
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
        // 13-A.3.5b：解析成功后、消费前确保 render doc_id（OFD 走 Render Contract）
        await ensureRenderContract(fileObj)
        const update = consumeParseResult(result, fileObj, session.id)
          queueUpdate(fileObj.key, result.status, update)

          // 13-A.3.5c：metadata 驱动纠正（OFD 多页 / 真实尺寸），置 consume 之后为最终权威
          // 同步更新 docId + identity，确保 resolveDocId() 取到正确值
          if (update?.docId) {
            fileObj.docId = update.docId
            if (update.identity) fileObj.identity = update.identity
          }
          await ensureDocumentMetadata(fileObj)
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

        // 更新当前文件计数和日志
        const fileIdx = placeholders.findIndex((ph) => ph.key === p.key)
        const displayIdx = fileIdx >= 0 ? fileIdx + 1 : splitDone + 1
        setImportStats((prev) => ({ ...prev, currentFile: displayIdx }))
        addImportLog(`正在拆分 ${displayIdx}/${acceptedFiles.length}: ${f.name}`)

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
              addImportLog(`  → 拆分为 ${pageItems.length} 页`)
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
          addImportLog(`  → 拆分失败: ${err.message || '未知错误'}`)
        } finally {
          splitDone += 1
          // 更新拆分阶段进度
          setImportStats((prev) => ({ ...prev, splitDone, currentFile: splitDone }))
          // 兼容旧 parseProgress（拆分阶段显示拆分进度）
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

    // ── 拆分完成，切换到解析阶段 ──
    const parseFileCount = readyFiles.length
    addImportLog(`文件拆分完成，共 ${parseFileCount} 个待解析文件`)
    setImportStage('parsing')
    setImportStats((prev) => ({
      ...prev,
      splitDone: placeholders.length,
      parseTotal: parseFileCount,
      parseDone: 0,
      currentFile: 0,
    }))
    progressMonotonicRef.current = Math.max(progressMonotonicRef.current, 30)  // 拆分至少占30%

    // ── Import Scale v1: 批量解析路径 ────────────────────
    // split 完成后，根据 feature flag 选择执行路径
    if (IMPORT_SCALE_V1 && readyFiles.length > 0) {
      // 批量路径：POST /import/batch + GET SSE
      console.log(`[ImportScale] 批量解析 ${readyFiles.length} 个文件`)
      addImportLog(`开始批量解析 ${readyFiles.length} 个文件...`)

      // 标记所有就绪文件为 parsing（一次性）
      // 状态机已允许 splitting→parsing（Map 去重可能吞掉 ready 中间态）
      for (const fileObj of readyFiles) {
        queueUpdate(fileObj.key, 'parsing')
      }

      // 创建 TaskRegistry 任务（用于取消管理）
      const task = createTask(readyFiles.map((f) => f.key))
      const abortController = new AbortController()
      currentAbortRef.current = abortController  // 保存引用用于取消
      setTaskAbortController(task.id, abortController)
      updateTaskStatus(task.id, 'running')

      // 包装onAggregateProgress，更新增强版进度
      let lastLoggedParse = -1
      const onAggregateProgress = (prog) => {
        setParseProgress(prog)  // 兼容旧API
        setImportStats((prev) => ({
          ...prev,
          parseDone: prog.current,
          parseTotal: prog.total,
          currentFile: prog.current,
        }))
        // 每10个文件或每个文件输出一次日志（避免日志过多）
        if (prog.current > lastLoggedParse && prog.current > 0) {
          if (prog.current === 1 || prog.current % 5 === 0 || prog.current === prog.total) {
            addImportLog(`正在解析 ${prog.current}/${prog.total}...`)
            lastLoggedParse = prog.current
          }
        }
        if (prog.current > 0 && prog.total > 0) {
          const parsePct = (prog.current / prog.total) * 55  // 解析占55%（拆分30% + 组装15%）
          progressMonotonicRef.current = Math.max(progressMonotonicRef.current, 30 + parsePct)
        }
      }

      // ── 编排委托给纯模块（与 React 解耦，可 Node 验收，Commit 5）──
      // session 终态（completed/cancelled）由 runChunkedImport 统一归属（合同 §7）
      await runChunkedImport({
        sessionId: session.id,
        taskId: task.id,
        files: readyFiles,
        chunkSize: IMPORT_CHUNK_SIZE,
        autoOrient: settingsRef.current.autoOrient ?? false,
        deps: {
          client: { createImportBatch, subscribeBatchProgress, getBatchResults, cancelImportBatch },
          onFileUpdate: queueUpdate,
          onAggregateProgress,
          onTaskStatus: updateTaskStatus,
          onTaskStream: setTaskStream,
          hydrateChunk: async ({ batchId, chunk, signal, client, terminalFileKeys }) => {
            const HYDRATION_CHUNK = 100
            // 兼容两种返回形态：历史返回 Array（data.items），未来可返回 { items, documents }
            const _batchResults = await client.getBatchResults(batchId, signal)
            const items = Array.isArray(_batchResults) ? _batchResults : (_batchResults?.items || [])
            const documents = (!Array.isArray(_batchResults) && Array.isArray(_batchResults?.documents)) ? _batchResults.documents : []
            const resultMap = new Map()
            // 建立 key → 物理 docId 的直接映射，避免 queueUpdate 异步批量更新导致
            // assembly 阶段 f.docId 仍为旧值（父 PDF 的 sourceDocId），使所有页 renderDocId 相同
            const physicalDocIdByKey = new Map()
            for (const item of items) {
              if (item.clientKey) {
                resultMap.set(item.clientKey, item)
                if (item.docId) physicalDocIdByKey.set(item.clientKey, item.docId)
              }
            }
            let docsTouched = false
            let sessionDocsTouched = false
            for (let j = 0; j < chunk.length; j += HYDRATION_CHUNK) {
              const chunkFiles = chunk.slice(j, j + HYDRATION_CHUNK)
              for (const fileObj of chunkFiles) {
                const item = resultMap.get(fileObj.key)
                if (item) {
                  // 兼容两种命名：invoiceFields（驼峰，批量导入）和 invoice_fields（下划线，单文件解析）
                  const invFields = item.invoiceFields || item.invoice_fields || null
                  const hydrationResult = {
                    status: 'parsed',
                    doc_id: item.docId || '',
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
                      // 字段级失败明细（dict 列表，含真实 reason），来自后端
                      // invoice_fields.failed_fields（import_batch_manager 透传）或 item.failedFieldsDetail
                      failedFieldsDetail: (invFields || {}).failed_fields || item.failedFieldsDetail || [],
                      invoiceFields: invFields,
                      issuer: (invFields || {}).kpr || '',
                      buyerName: (invFields || {}).gmfmc || '',
                      buyerTaxNo: (invFields || {}).gmfsh || '',
                      sellerName: (invFields || {}).xsfmc || '',
                      sellerTaxNo: (invFields || {}).xsfsh || '',
                      amountWithoutTax: (invFields || {}).amountJe || '',
                      taxAmount: (invFields || {}).amountSe ?? '',
                      totalAmount: (invFields || {}).amountHj || item.amount || '',
                      lineItems: (invFields || {}).line_items || [],
                      rawText: '',
                    },
                    raw: {},
                  }
                  const update = mapParseResultToFileUpdate(hydrationResult, fileObj)
                  queueUpdate(fileObj.key, 'parsed', update)
                  terminalFileKeys.add(fileObj.key)
                } else {
                  queueUpdate(fileObj.key, 'parsed')
                  terminalFileKeys.add(fileObj.key)
                }
                const effectiveDocId = (item && item.docId) || fileObj.docId
                if (effectiveDocId) {
                  // 同步更新 fileObj.docId + fileObj.identity（与非批量导入路径 consumeParseResult 行为一致），
                  // 确保后续 assembly 阶段从 readyFiles 中取到的 f.docId / f.identity.docId 都是真实物理 docId，
                  // 避免 resolveDocId() 优先取 identity.docId 得到旧父 PDF sourceDocId，导致预览URL错误一直加载。
                  if (item?.docId && fileObj.docId !== item.docId) {
                    const enriched = updateDocumentIdentity(fileObj, item.docId)
                    fileObj.docId = enriched.docId
                    fileObj.identity = enriched.identity
                  }
                  const docFileObj = effectiveDocId !== fileObj.docId
                    ? { ...fileObj, docId: effectiveDocId }
                    : fileObj
                  const prev = getDocument(effectiveDocId)
                  const doc = ensureDocumentFromFileObj(docFileObj, readyFiles, { silent: true })
                  // 13-A.3.5c：metadata 驱动纠正（OFD 多页 / 真实尺寸），silent 跟随批处理统一 flush
                  const metaDoc = await ensureDocumentMetadata(
                    { ...docFileObj, docId: effectiveDocId },
                    { silent: true }
                  )
                  if ((doc && doc !== prev) || (metaDoc && metaDoc !== prev)) docsTouched = true
                }
              }
              if (docsTouched) {
                // 先 flush 文件状态（确保 files 带 docId），再通知 DocumentStore 变更，
                // 避免 GC 在 files 状态滞后时误删刚注册的文档（race condition）。
                flushUpdates()
                flushDocumentNotifications()
                docsTouched = false
              }
              if (j + HYDRATION_CHUNK < chunk.length) {
                await new Promise((r) => setTimeout(r, 0))
              }
            }

            // E-2.2: 使用后端组装结果创建 InvoiceDocument（多页分组）
            // 仅当 backend assembly 返回 documents 时启用；否则 session.documents 保持空，
            // buildDocumentViewModel 退化为 groupFilesByDocument（向后兼容）。
            const hasAssembledDocs = Array.isArray(documents) && documents.length > 0
            const assembledDocIds = new Set()

            if (hasAssembledDocs) {
              // 闸门拒绝的页按 per-file 独立展示
              const fallbackFiles = []
              for (const assembled of documents) {
                // FIX: 优先使用 assembled.pageClientKeys 精确匹配文件（而非通过 invoiceNumber 宽泛匹配）
                // 原因：当多个 assembled 共享相同 invoiceNumber 时，invoiceNumber 匹配会返回所有相关文件，
                // 导致单个 InvoiceDocument 包含不属于该 assembled 的页面。
                // pageClientKeys 是后端显式声明的精确页面成员，能够唯一标识每个 assembled 对应的页面。
                let matchingFiles
                if (Array.isArray(assembled.pageClientKeys) && assembled.pageClientKeys.length > 0) {
                  // 过滤掉空字符串，使用 pageClientKeys 精确匹配
                  const validClientKeys = assembled.pageClientKeys.filter(Boolean)
                  if (validClientKeys.length > 0) {
                    const keySet = new Set(validClientKeys)
                    matchingFiles = readyFiles.filter(f => keySet.has(f.key))
                  } else {
                    matchingFiles = []
                  }
                } else {
                  // 回退：通过 invoiceNumber 匹配（兼容旧数据）
                  const matchingItems = items.filter(i =>
                    i.invoiceNumber === assembled.invoiceNumber
                  )
                  const matchingKeys = new Set(
                    matchingItems.map(i => i.clientKey).filter(Boolean)
                  )
                  matchingFiles = readyFiles.filter(f => matchingKeys.has(f.key))
                }

                // ── 模型边界约束（冻结；IS-4.2 Step 4.3 升级为实例身份）──
                // 一个 InvoiceDocument 的所有 pages 必须属于同一个文件实例。
                // 仅按 invoiceNumber 全局匹配会把「两张不同发票同号」错误收敛进同一个 Document；
                // 同内容 A.pdf/B.pdf 又共享 sourceDocId（内容哈希），按 sourceDocId 过滤仍会互相吸收页面。
                // instanceId（文件实例身份，前端 producer 生成、assembly 透传）比 sourceDocId 更严格：
                // A/B 实例不同 → 各自只收自己的页；多页 PDF 的所有拆分页共享同一 instanceId → 正确聚合。
                // 注意：instanceId 只管 Page Ownership；InvoiceDocument Identity 仍由下方 invDocId
                // （实例 × 发票）承担——一个文件实例可产出多张发票（多票 PDF），DocumentStore 键不能用裸 instanceId。
                // 归属解析委托纯模块（与 React 解耦，可 Node 验收）；异常回退在此据返回标志告警，不静默退化。
                const { files: sameInstanceFiles, fallback } = resolveInstancePageFiles(matchingFiles, assembled)
                if (fallback === 'instance-mismatch') {
                  console.warn('[hydrateChunk] assembled instanceId=%s 匹配不到 fileObj.instanceId，回退 sourceDocId 过滤（invoiceNumber=%s）', assembled.instanceId, assembled.invoiceNumber)
                } else if (fallback === 'missing-instanceId') {
                  console.warn('[hydrateChunk] assembled 缺少 instanceId，使用 legacy sourceDocId 过滤（invoiceNumber=%s）', assembled.invoiceNumber)
                }

                if (sameInstanceFiles.length === 0) {
                  console.warn('[hydrateChunk] assembled 文档匹配不到同实例 file（invoiceNumber=%s），跳过该组装结果以免静默丢失', assembled.invoiceNumber)
                  continue
                }

                // ── 消费 assembled 文档 ──
                // 后端 PageResultStore 收齐所有页并成功 assemble 后才出现在 assembled_documents 中，
                // 不要求 pageCount >= 2：单页 assembled 文档仍携带发票号等解析元数据，
                // 应生成 _inv_ docId 供后续处理，而非退回 fallback 失去业务身份。
                // FIX: 按 pageNum 升序排列，确保首页作为 representative、页面顺序正确
                // pageNum 可能为 0（第一页），0 是 falsy，不能用 || 1 导致排序错乱
                const sortedFiles = [...sameInstanceFiles].sort(
                  (a, b) => (a.pageNum ?? 0) - (b.pageNum ?? 0)
                )
                const repFile = sortedFiles[0]
                // Step E1.1: Document identity 绑定文件实例（key），而非内容哈希（sourceDocId）。
                // 同内容但不同文件实例（同发票复制、两次导入）产生不同 docId，不被 ImportSessionStore
                // 的 docId 去重吃掉。instanceKey = repFile.key（前端文件实例唯一键，跨 session 不重复）。
                const instanceKey = repFile?.key || assembled.sourceDocId || ''
                const invDocId = `${instanceKey}_inv_${assembled.invoiceNumber || ''}`
                const prev = getDocument(invDocId)
                // 绕过 ensureDocumentFromFileObj（它按 docId 过滤文件，但 assembly 的 docId ≠ 文件 docId），
                // 直接由 sortedFiles 构造 InvoiceDocument
                const pages = sortedFiles.map((f, i) =>
                  createPageMeta({
                    docId: invDocId,
                    index: i,
                    width: 0,
                    height: 0,
                    sourceRotation: 0,
                    // render 身份桥：每页的物理渲染 docId（与业务 invDocId 不同）
                    // 优先从 physicalDocIdByKey 获取（当前 chunk 中后端返回的权威值），
                    // 跨 chunk 页回退到 f.docId（已被前序 chunk 同步更新）
                    renderDocId: physicalDocIdByKey.get(f.key) || f.docId,
                    // 每个物理文件都是单页，物理页码始终为 1（不是业务 index+1）
                    renderPage: 1,
                  })
                )
                const doc = createDocument({
                  docId: invDocId,
                  fileKey: repFile.key || '',
                  sourceHash: repFile.identity?.sourceHash || '',
                  pages,
                })
                registerDocument(doc)
                if (doc !== prev) docsTouched = true
                // E-2.2: 记录 sourceDocId + 该发票的精确页面 fileKey 列表（按页码排序）
                doc.sourceDocId = repFile.docId || assembled.sourceDocId || ''
                // Commit 2：优先用后端显式声明的 pageClientKeys（精确页面成员），
                // 回退到本地按页码推导（历史 session / 老数据 / 后端未下发时）。
                // FIX: 过滤掉空字符串，避免 _pageKeys 包含无效的空字符串导致 invoiceDocumentToRow 匹配失败
                const validPageClientKeys = Array.isArray(assembled.pageClientKeys)
                  ? assembled.pageClientKeys.filter(Boolean)
                  : []
                doc._pageKeys = validPageClientKeys.length > 0
                  ? validPageClientKeys
                  : sortedFiles.map(f => f.key)
                // Commit 2：补全业务字段，使 invoiceDocumentViewModel 能用 Document 字段
                // 覆盖 Page 字段（金额/日期）。null/undefined 时由 view model 回退 rep 字段。
                doc.amount = assembled.amount
                doc.invoiceDate = assembled.invoiceDate
                if (session?.id) {
                  addDocument(session.id, doc, { silent: true })
                  sessionDocsTouched = true
                  console.log('[ADD DOCUMENT][assembly]', {
                    id: doc?.id || doc?.docId,
                    pages: doc?.pages?.length,
                    sourceDocId: doc?.sourceDocId,
                    _pageKeys: doc?._pageKeys?.length,
                  })
                }
                assembledDocIds.add(invDocId)
              }

              // 处理被闸门拒绝的页：通过 per-file 路径独立 addDocument
              // 这些页有相同 invoiceNumber 但缺少 pageNum/totalPages 分页标识，
              // 不作为多页 InvoiceDocument，由文件列表独立展示（可能进入重复组）。
              for (const fileObj of fallbackFiles) {
                const item = resultMap.get(fileObj.key)
                const effectiveDocId = (item && item.docId) || fileObj.docId
                if (effectiveDocId) {
                  const docFileObj = effectiveDocId !== fileObj.docId
                    ? { ...fileObj, docId: effectiveDocId }
                    : fileObj
                  const prev = getDocument(effectiveDocId)
                  const doc = ensureDocumentFromFileObj(docFileObj, readyFiles, { silent: true })
                  if (doc && doc !== prev) docsTouched = true
                  if (doc && session?.id) {
                    // 为单页文档设置 _pageKeys（强身份匹配），与 assembly 多页文档一致，
                    // 避免 invoiceDocumentToRow 弱身份回退匹配失败导致文档不显示
                    if (!doc._pageKeys) doc._pageKeys = [fileObj.key]
                    addDocument(session.id, doc, { silent: true })
                    sessionDocsTouched = true
                    console.log('[ADD DOCUMENT][gate-reject]', {
                      id: doc?.id || doc?.docId,
                      effectiveDocId,
                      reason: '闸门拒绝：缺少分页标识',
                    })
                  }
                }
              }

              if (docsTouched) {
                flushUpdates()
                flushDocumentNotifications()
                docsTouched = false
              }
              if (sessionDocsTouched) {
                flushSessionNotifications(session.id)
                sessionDocsTouched = false
              }
            }

            // P0 修复：恢复 left-thumbnail golden path 的 fallback。
            // master 相对 left-thumbnail 的回归点：删除了本块。
            // 当后端未返回 assembled documents 时，必须把 per-file Document 经 addDocument 写进 session.documents，
            // 否则 buildDocumentViewModel 退回 groupFilesByDocument(files)，导致同票多页拆成多行 + 统计按行计数异常。
            // 注意：此处仅补 session.documents；上方 per-file 循环对全局 DocumentStore 的 ensure* 写入保留（供 P10 DocumentViewer）。
            if (!hasAssembledDocs) {
              for (const fileObj of chunk) {
                const item = resultMap.get(fileObj.key)
                const effectiveDocId = fileObj.key // Step E1.1: fallback 路径也使用文件实例键避免同内容 dedup
                if (effectiveDocId) {
                  const docFileObj = effectiveDocId !== fileObj.docId
                    ? { ...fileObj, docId: effectiveDocId }
                    : fileObj
                  const prev = getDocument(effectiveDocId)
                  const doc = ensureDocumentFromFileObj(docFileObj, readyFiles, { silent: true })
                  if (doc && doc !== prev) docsTouched = true
                  if (doc && session?.id) {
                    // 为单页文档设置 _pageKeys（强身份匹配）
                    if (!doc._pageKeys) doc._pageKeys = [fileObj.key]
                    addDocument(session.id, doc, { silent: true })
                    sessionDocsTouched = true
                    console.log('[ADD DOCUMENT][fallback]', {
                      id: doc?.id || doc?.docId,
                      pages: doc?.pages?.length,
                      effectiveDocId,
                    })
                  }
                }
              }
            }
            if (docsTouched) {
              flushUpdates()
              flushDocumentNotifications()
              docsTouched = false
            }
            if (sessionDocsTouched) {
              flushSessionNotifications(session.id)
              sessionDocsTouched = false
            }
          },
        },
        signal: abortController.signal,
      })
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

    // 解析完成后：进入组装阶段
    setImportStage('building')
    progressMonotonicRef.current = Math.max(progressMonotonicRef.current, 85)
    addImportLog('正在组装文档...')

    // 强制刷新所有待处理更新（hydration 结果），再后处理
    flushUpdates()

    // 探针2+3：flush 后状态分布 + processImportedFiles 前完整状态
    let successCount = 0
    let errorCount = 0
    setFiles((prev) => {
      const dist = prev.reduce((a, f) => { a[f.status] = (a[f.status] || 0) + 1; return a }, {})
      console.log('[ImportScale flush] 状态分布:', dist)
      successCount = dist.parsed || 0
      errorCount = dist.error || 0
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

    // 导入完成：先显示100%完成状态，等主界面渲染稳定后再关闭弹窗，避免闪烁
    addImportLog(`导入完成：成功 ${successCount} 个，失败 ${errorCount} 个`)
    setImportStage('completed')
    progressMonotonicRef.current = 100
    setImportStats((prev) => ({
      ...prev,
      parseDone: prev.parseTotal,
      buildDone: prev.buildTotal || successCount,
      currentFile: prev.totalFiles,
    }))

    // 清除之前的定时器（防止多次导入时叠加）
    if (completeDismissTimerRef.current) {
      clearTimeout(completeDismissTimerRef.current)
      completeDismissTimerRef.current = null
    }

    // 等待主界面DOM稳定后再关闭弹窗：
    // 1) 双 requestAnimationFrame：确保 React commit → 浏览器 layout/paint 完成一轮
    //    （flushUpdates + setFiles排序触发的大规模重渲染需要至少一帧完成）
    // 2) 额外 250ms 停留：让用户看到100%完成状态，同时浏览器完成缩略图/预览区首帧绘制
    // 3) 然后再关闭弹窗：弹窗面板先快速淡出(150ms)，遮罩在面板完全消失后再淡出(200ms)，
    //    此时主界面已完全就绪，不会出现"闪一下"。
    const waitFramesAndDismiss = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          completeDismissTimerRef.current = setTimeout(() => {
            completeDismissTimerRef.current = null
            currentAbortRef.current = null
            setParsing(false)
            setParseProgress({ current: 0, total: 0 })
            setImporting(false)
          }, 250)
        })
      })
    }
    // 用setTimeout(0)将等待推迟到当前宏任务结束，确保setImportStage('completed')的状态更新先被React处理
    completeDismissTimerRef.current = setTimeout(waitFramesAndDismiss, 0)
  }, [setFiles, electronAPIRef, settingsRef, queueUpdate, addImportLog])

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

  // 取消导入
  const cancelImport = useCallback(() => {
    // 中止进行中的请求
    if (currentAbortRef.current) {
      currentAbortRef.current.abort()
      currentAbortRef.current = null
    }
    // 清除延迟关闭定时器
    if (completeDismissTimerRef.current) {
      clearTimeout(completeDismissTimerRef.current)
      completeDismissTimerRef.current = null
    }
    // 取消所有活跃任务（兜底）
    try {
      getActiveTasks().forEach((t) => cancelTask(t.id))
    } catch (e) { /* 忽略 */ }
    // 重置导入状态
    setImportStage('idle')
    setParsing(false)
    setParseProgress({ current: 0, total: 0 })
    setImporting(false)
    addImportLog('导入已取消')
  }, [addImportLog])

  return {
    importing,
    parseFiles, parsing, parseProgress,
    cancelImport,
    // 增强版进度信息（分阶段 + 日志）
    importStage, importStats, importLogs,
    isNativeDragActive,
    handleNativeDrop, handleNativeDragOver, handleNativeDragLeave,
    getRootProps, getInputProps, isDragActive,
    handleOpenDialog,
    handleOpenFolder,
  }
}
