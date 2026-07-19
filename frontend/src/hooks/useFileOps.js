import { useState, useCallback, useRef, useEffect } from 'react'
import { useDropzone } from 'react-dropzone'
import { BACKEND_URL, SUPPORTED_EXTENSIONS } from '../config'
import {
  getElectronAPI, getFilePath, getFileFormat, getExtension, getExtensionWithDot,
  getMimeType, concurrentBatch, applySort, buildSearchText, detectDuplicateInvoices,
} from '../utils'
import { buildFileObj, generateFileKey, processPdfFile, stripIdentity } from '../utils/fileHelpers'
import { createPlaceholders } from '../utils/placeholderGenerator'
import { resolveFile } from '../services/FileResolver'
import { consumeBatchStream } from '../services/StreamConsumer'
import { createTask, setTaskAbortController, updateTaskStatus, cancelTask, getTask } from '../services/TaskRegistry'
import { createQueues, enqueueSplit, enqueueParse, startSplitWorkers, startParseWorkers, getSplitQueueLength, isQueueEmpty, clearQueues } from '../services/TaskScheduler'
import { runParseTask } from '../runners/parseRunner'
import { runSplitTask } from '../runners/splitRunner'
import { mapParseResultToFileUpdate } from '../mappers/parseResultMapper'
import { createImportSession, addFilesToSession, replaceFileItems, updateProgress, updateSessionStatus } from '../stores/ImportSessionStore'
import { db } from '../db'

// ── 状态迁移规则 ─────────────────────────────────────────
// 仅允许正向状态迁移，阻止回退（Import Pipeline Contract v1.1）
const VALID_TRANSITION = {
  uploading: ['splitting', 'ready', 'parsing'],
  splitting: ['ready', 'error'],
  ready: ['parsing', 'error'],
  parsing: ['parsed', 'error'],
  parsed: [],
  error: ['parsing'],
}

export function useFileOps({ setFiles, settings, electronAPIRef, sortByRef, sortOrderRef }) {
  const [isNativeDragActive, setIsNativeDragActive] = useState(false)
  const [importing, setImporting] = useState(false)   // 整个导入流程（处理+解析）
  const [parsing, setParsing] = useState(false)
  const [parseProgress, setParseProgress] = useState({ current: 0, total: 0 })
  const completedRef = useRef(0)  // ✅ 跟踪已完成文件数（避免闭包陷阱）

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
        const { newStatus, extra } = update
        const allowed = VALID_TRANSITION[f.status]
        if (allowed && !allowed.includes(newStatus)) return f
        return { ...f, ...extra, status: newStatus }
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

    // 准备所有文件的 File 对象
    const preparedFiles = []
    for (const fileObj of filesToParse) {
      if (fileObj.file) {
        preparedFiles.push(fileObj.file)
      } else if ((fileObj.printPath || fileObj.path) && ipc) {
        const file = await resolveFile(fileObj, ipc)
        preparedFiles.push(file)
      } else {
        preparedFiles.push(null)
      }
    }

    const formData = new FormData()
    for (let i = 0; i < preparedFiles.length; i++) {
      if (preparedFiles[i]) {
        formData.append('files', preparedFiles[i], filesToParse[i].name)
      }
    }
    formData.append('autoOrient', autoOrient ? '1' : '0')

    // 标记所有文件为 uploading
    setFiles((prev) =>
      prev.map((f) =>
        filesToParse.some((fp) => fp.key === f.key)
          ? { ...f, status: 'uploading' }
          : f
      )
    )

    // 通过 StreamConsumer + TaskRegistry 消费 SSE 流
    // SSE 生命周期由 TaskRegistry 管理（AbortController 统一取消）
    const abortController = new AbortController()
    const task = createTask(filesToParse.map((f) => f.key))
    setTaskAbortController(task.id, abortController)

    const batchResult = await consumeBatchStream(`${BACKEND_URL}/parse_batch`, formData, {
      signal: abortController.signal,
      onProgress: (msg) => {
        completedRef.current = msg.current
        setParseProgress({ current: msg.current, total: msg.total })
      },
    })

    updateTaskStatus(task.id, 'completed')

    // 收集所有更新，单次应用（避免 O(n²) 数组复制）
    const updates = new Map()
    let completedCount = 0

    for (const item of batchResult.items) {
      const fileObj = filesToParse[item.index]
      if (!fileObj) continue

      if (item.success && item.data) {
        const d = item.data
        // ✅ 后端 parse_invoice_service 已自动入库，前端无需重复 upsert

        updates.set(fileObj.key, {
          status: 'parsed',
          invoiceType: d.db_record?.type || d.invoice_type || '',
          invoiceNumber: d.db_record?.number || d.invoice_number || '',
          amount:
            d.db_record?.amount != null
              ? String(d.db_record.amount)
              : d.amount || '',
          invoiceDate: d.db_record?.date || d.invoice_date || '',
          newName: d.new_name || fileObj.name,
          parseMethod: d.parse_method || '',
          fileFormat: d.file_format || getFileFormat(fileObj.name),
          previewImage: null,
          failedFields: d.failed_fields || [],
          invoiceFields: d.invoice_fields || null,
          issuer:
            d.db_record?.issuer || d.invoice_fields?.kpr || '',
          amountWithoutTax:
            d.db_record?.tax_amount != null
              ? String(
                  Math.round(
                    (parseFloat(d.db_record.amount || 0) -
                      parseFloat(d.db_record.tax_amount || 0)) *
                      100
                  ) / 100
                )
              : d.invoice_fields?.amountJe || '',
          taxAmount:
            d.db_record?.tax_amount != null
              ? String(d.db_record.tax_amount)
              : d.invoice_fields?.amountSe || '',
          lineItems: d.invoice_fields?.line_items || [],
          rawText: d.raw_text || '',
          searchText: buildSearchText({
            name: fileObj.name,
            invoiceNumber:
              d.db_record?.number || d.invoice_number || '',
            invoiceType:
              d.db_record?.type || d.invoice_type || '',
            amount:
              d.db_record?.amount != null
                ? String(d.db_record.amount)
                : d.amount || '',
            invoiceDate: d.db_record?.date || d.invoice_date || '',
            invoice_fields: d.invoice_fields || {},
            rawText: d.raw_text || '',
          }),
        })
      } else {
        updates.set(fileObj.key, {
          status: 'error',
          errorMsg: item.error || '解析失败',
        })
      }

      completedCount++
    }

    // 单次批量更新，O(n) 而非 O(n²)
    if (updates.size > 0) {
      setFiles((prev) =>
        prev.map((f) => {
          const update = updates.get(f.key)
          return update ? { ...f, ...update } : f
        })
      )
    }

    completedRef.current += completedCount
    setParseProgress({
      current: completedRef.current,
      total: filesToParse.length,
    })
  }, [electronAPIRef])

  // ============================
  // 解析文件（带重试和限流处理）
  // ============================
  const parseFiles = useCallback(async (filesToParse) => {
    if (filesToParse.length === 0) return
    setParsing(true)
    completedRef.current = 0  // ✅ 重置完成计数器
    setParseProgress({ current: 0, total: filesToParse.length })

    // ✅ 降低并发限制，避免过多 OCR 任务同时运行
    const CONCURRENCY_LIMIT = 2
    const MAX_RETRY = 1
    const RETRY_DELAY_MS = 2000

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
            return applySort(prev, sortByRef.current, sortOrderRef.current, duplicateInfo)
          })
          return
        } catch (batchErr) {
          console.warn('[parseFiles] 批量解析失败，回退逐个解析:', batchErr)
          completedRef.current = 0  // 重置计数器，准备逐个解析
          setParseProgress({ current: 0, total: filesToParse.length })
          // 继续执行下方的逐个解析逻辑
        }
      }

      await concurrentBatch(filesToParse, async (fileObj) => {
        let retries = 0
        let lastError = null

        while (retries <= MAX_RETRY) {
          try {
            let resp

            // 更新状态为 reading
            setFiles((prev) =>
              prev.map((f) =>
                f.key === fileObj.key ? { ...f, status: 'reading' } : f
              )
            )

            if (fileObj.file) {
              const formData = new FormData()
              formData.append('file', fileObj.file)
              formData.append('autoOrient', autoOrient ? '1' : '0')
              // ✅ 批量模式不返回预览图和原始文本，减少数据传输
              formData.append('mode', 'batch')

              // 更新状态为 uploading
              setFiles((prev) =>
                prev.map((f) =>
                  f.key === fileObj.key ? { ...f, status: 'uploading' } : f
                )
              )

              resp = await fetch(`${BACKEND_URL}/parse_invoice`, { method: 'POST', body: formData })
            } else if ((fileObj.printPath || fileObj.path) && ipc) {
              const file = await resolveFile(fileObj, ipc)
              if (!file) throw new Error('IPC read-file failed: ' + fileObj.name)
              const formData = new FormData()
              formData.append('file', file)
              formData.append('autoOrient', autoOrient ? '1' : '0')
              formData.append('mode', 'batch')

              setFiles((prev) =>
                prev.map((f) =>
                  f.key === fileObj.key ? { ...f, status: 'uploading' } : f
                )
              )

              resp = await fetch(`${BACKEND_URL}/parse_invoice`, { method: 'POST', body: formData })
            }

            if (!resp) {
              throw new Error('无法获取响应')
            }

            // ✅ 处理 429 限流错误，延迟重试
            if (resp.status === 429) {
              if (retries < MAX_RETRY) {
                console.log(`[parseFiles] 服务器繁忙，等待 ${RETRY_DELAY_MS}ms 后重试: ${fileObj.key}`)
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
                retries++
                continue
              }
              throw new Error('服务器繁忙，请稍后重试')
            }

            if (resp.ok) {
              const data = await resp.json()

              // ✅ 后端 parse_invoice_service 已自动入库，前端无需重复 upsert

              setFiles((prev) =>
                prev.map((f) =>
                  f.key === fileObj.key
                    ? {
                        ...f,
                        status: 'parsed',
                        // 优先从数据库记录读取（单数据源），回退到 API 响应字段
                        invoiceType: data.db_record?.type || data.invoice_type || data.invoiceType || '',
                        invoiceNumber: data.db_record?.number || data.invoice_number || data.invoiceNumber || '',
                        amount: data.db_record?.amount != null ? String(data.db_record.amount) : (data.amount || ''),
                        invoiceDate: data.db_record?.date || data.invoice_date || data.invoiceDate || '',
                        newName: data.new_name || data.newName || fileObj.name,
                        parseMethod: data.parse_method || data.parseMethod || '',
                        fileFormat: data.file_format || data.fileFormat || getFileFormat(fileObj.name),
                        previewImage: data.preview_image || data.previewImage || null,
                        failedFields: data.failed_fields || data.failedFields || [],
                        // 兼容新旧架构：invoice_fields（旧/蛇形）和 invoiceFields（新/驼峰）
                        invoiceFields: data.invoice_fields || data.invoiceFields || null,
                        // 以下字段优先从 db_record 读取，确保显示值与数据库一致
                        issuer: data.db_record?.issuer || (data.invoice_fields || data.invoiceFields || {})?.kpr || '',
                        amountWithoutTax: data.db_record?.tax_amount != null
                          ? String(Math.round((parseFloat(data.db_record.amount || 0) - parseFloat(data.db_record.tax_amount || 0)) * 100) / 100)
                          : (data.invoice_fields || data.invoiceFields || {})?.amountJe || '',
                        taxAmount: data.db_record?.tax_amount != null ? String(data.db_record.tax_amount) : (data.invoice_fields || data.invoiceFields || {})?.amountSe || '',
                        lineItems: (data.invoice_fields || data.invoiceFields || {})?.line_items || [],
                        rawText: data.raw_text || '',
                        searchText: buildSearchText({
                          name: f.name,
                          invoiceNumber: data.db_record?.number || data.invoice_number || data.invoiceNumber || '',
                          invoiceType: data.db_record?.type || data.invoice_type || data.invoiceType || '',
                          amount: data.db_record?.amount != null ? String(data.db_record.amount) : (data.amount || ''),
                          invoiceDate: data.db_record?.date || data.invoice_date || data.invoiceDate || '',
                          invoice_fields: data.invoice_fields || data.invoiceFields || {},
                          rawText: data.raw_text || '',
                        }),
                      }
                    : f
                )
              )
              // ✅ 更新解析进度
              completedRef.current += 1
              setParseProgress({ current: completedRef.current, total: filesToParse.length })
              return
            } else {
              throw new Error(`解析失败: HTTP ${resp.status}`)
            }

          } catch (err) {
            lastError = err
            console.warn('[parseFiles] 解析文件失败:', fileObj.key, err.message)

            if (retries < MAX_RETRY) {
              console.log(`[parseFiles] 重试第 ${retries + 1} 次: ${fileObj.key}`)
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
              retries++
            } else {
              break
            }
          }
        }

        // 重试后仍然失败
        setFiles((prev) =>
          prev.map((f) =>
            f.key === fileObj.key
              ? { ...f, status: 'error', errorMsg: lastError?.message || '解析失败' }
              : f
          )
        )
      }, CONCURRENCY_LIMIT)

      setFiles((prev) => {
        const duplicates = detectDuplicateInvoices(prev)
        const duplicateInfo = new Map()
        duplicates.forEach((dupFiles, groupIndex) => {
          dupFiles.forEach((file, idx) => {
            duplicateInfo.set(file.key, { groupIndex, isFirst: idx === 0 })
          })
        })
        return applySort(prev, sortByRef.current, sortOrderRef.current, duplicateInfo)
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

    // 解析进度计数（用对象 ref 规避闭包陷阱，parseWorker 并发累加）
    const totalParseJobsRef = { current: 0 }
    const doneParseJobsRef = { current: 0 }

    // Parse 流水线（执行委托给 parseRunner，UI 更新在 orchestrator）
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
          queueUpdate(fileObj.key, result.status, mapParseResultToFileUpdate(result, fileObj))
        } catch (err) {
          console.error(`[App] 解析失败: ${fileObj.name}`, err)
          queueUpdate(fileObj.key, 'error')
        } finally {
          doneParseJobsRef.current += 1
          setParseProgress({
            current: doneParseJobsRef.current,
            total: totalParseJobsRef.current,
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
              totalParseJobsRef.current += 1
              const readyFile = { ...p, ...toAddRest }
              enqueueParse([{ fileObj: readyFile }])
            } else if (toAdd.length > 1) {
              const pageItems = toAdd.map((pageObj) => ({
                ...pageObj,
                status: 'ready',
              }))
              replaceWithItems(p.key, pageItems)
              totalParseJobsRef.current += pageItems.length
              for (const pageObj of pageItems) {
                enqueueParse([{ fileObj: pageObj }])
              }
            } else {
              queueUpdate(p.key, 'ready', { key: p.key })
              totalParseJobsRef.current += 1
              enqueueParse([{ fileObj: { ...p, key: p.key } }])
            }
          } else {
            const fileObjRest = stripIdentity(result.fileObj)
            queueUpdate(p.key, 'ready', fileObjRest)
            totalParseJobsRef.current += 1
            const readyFile = { ...p, ...fileObjRest }
            enqueueParse([{ fileObj: readyFile }])
          }
        } catch (err) {
          console.error(`[App] 文件处理失败: ${f.name}`, err)
          queueUpdate(p.key, 'error')
        }
      }
    }

    // 启动 split workers（通过 TaskScheduler 管理队列）+ parse workers
    const splitWorkers = []
    for (let i = 0; i < Math.min(SPLIT_CONCURRENCY, placeholders.length); i++) {
      splitWorkers.push(splitWorker())
    }
    const parseWorkers = []
    for (let i = 0; i < PARSE_CONCURRENCY; i++) {
      parseWorkers.push(parseWorker())
    }

    setParsing(true)
    await Promise.all(splitWorkers)
    parsePipelineDone = true
    await Promise.all(parseWorkers)

    // 解析完成后：重排序（与旧 parseFiles 行为一致）+ 收尾状态
    setFiles((prev) => {
      const duplicates = detectDuplicateInvoices(prev)
      const duplicateInfo = new Map()
      duplicates.forEach((dupFiles, groupIndex) => {
        dupFiles.forEach((file, idx) => {
          duplicateInfo.set(file.key, { groupIndex, isFirst: idx === 0 })
        })
      })
      return applySort(prev, sortByRef.current, sortOrderRef.current, duplicateInfo)
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
