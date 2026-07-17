import { useState, useCallback, useRef, useEffect } from 'react'
import { useDropzone } from 'react-dropzone'
import { BACKEND_URL, SUPPORTED_EXTENSIONS } from '../config'
import {
  getElectronAPI, getFilePath, getFileFormat, getExtension, getExtensionWithDot,
  getMimeType, concurrentBatch, applySort, buildSearchText, detectDuplicateInvoices,
} from '../utils'
import { buildFileObj, generateFileKey, processPdfFile, stripIdentity } from '../utils/fileHelpers'
import { db } from '../db'

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
      } else if (fileObj.printPath && ipc) {
        const fileData = await ipc.invoke('read-file', fileObj.printPath)
        if (fileData.success) {
          const ext = getExtension(fileObj.name)
          const mimeType = getMimeType(ext)

          const blob = new Blob([new Uint8Array(fileData.data)], { type: mimeType })
          preparedFiles.push(new File([blob], fileObj.name, { type: mimeType }))
        } else {
          preparedFiles.push(null)
        }
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

    const res = await fetch(`${BACKEND_URL}/parse_batch`, {
      method: 'POST',
      body: formData,
    })

    if (!res.ok) {
      throw new Error(`批量解析失败: HTTP ${res.status}`)
    }

    // 消费 SSE 事件流，实时更新进度
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let batchResult = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const msg = JSON.parse(line.slice(6))
            // 有 items 字段 → 最终结果
            if (msg.items) {
              batchResult = msg
            } else if (msg.current !== undefined) {
              // 进度事件
              completedRef.current = msg.current
              setParseProgress({ current: msg.current, total: msg.total })
              setFiles((prev) =>
                prev.map((f) =>
                  filesToParse.some((fp) => fp.key === f.key)
                    ? { ...f, status: f.status === 'parsed' ? 'parsed' : 'uploading' }
                    : f
                )
              )
            }
          } catch (_) { /* ignore parse errors */ }
        }
      }
    }

    if (!batchResult || !batchResult.success) {
      throw new Error(batchResult?.error || '批量解析失败')
    }

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
            } else if (fileObj.printPath && ipc) {
              const fileData = await ipc.invoke('read-file', fileObj.printPath)
              if (fileData.success) {
                const ext = getExtension(fileObj.name)
                const mimeType = getMimeType(ext)

                const blob = new Blob([new Uint8Array(fileData.data)], { type: mimeType })
                const file = new File([blob], fileObj.name, { type: mimeType })
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
              } else {
                throw new Error(fileData.error)
              }
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
    const placeholders = []
    for (const f of files) {
      let fileData = f.file

      if (!fileData && f.path && ipc) {
        const result = await ipc.invoke('read-file', f.path)
        if (result.success) {
          const ext = getExtension(f.name)
          const mimeType = getMimeType(ext)
          const blob = new Blob([new Uint8Array(result.data)], { type: mimeType })
          fileData = new File([blob], f.name, { type: mimeType })
        } else {
          console.error('[processFilesForAddition] IPC read-file failed:', f.path, result.error)
        }
      }

      const key = generateFileKey(f.name)
      placeholders.push({
        key,
        name: f.name,
        path: f.path,
        file: fileData,
        status: 'uploading',
        fileFormat: getFileFormat(f.name),
        searchText: buildSearchText({ name: f.name }),
      })
    }

    // 所有占位一步添加到列表
    setFiles((prev) => {
      const existingKeys = new Set(
        prev.map((f) => f.printPath || f.path || `${f.name}_${f.size}_${f.lastModified}`)
      )
      return [...prev, ...placeholders.filter((f) => !existingKeys.has(f.path || f.name))]
    })

    // ── 安全更新 helper（仅允许正向状态迁移，阻止回退） ────────────────
    // 放宽到真实存在的流转路径：
    //  - PDF：uploading→splitting→ready→parsing→parsed
    //  - 非 PDF：uploading→ready→parsing→parsed（buildFileObj 默认 parsing）
    //  - 任意：→error；error→parsing（允许重试）
    const VALID_TRANSITION = {
      uploading: ['splitting', 'ready', 'parsing'],
      splitting: ['ready', 'error'],
      ready: ['parsing', 'error'],
      parsing: ['parsed', 'error'],
      parsed: [],
      error: ['parsing'],
    }
    const safeUpdate = (key, newStatus, extra = {}) => {
      setFiles((prev) =>
        prev.map((f) => {
          if (f.key !== key) return f
          const allowed = VALID_TRANSITION[f.status]
          if (allowed && !allowed.includes(newStatus)) {
            // 不允许降级，静默忽略
            return f
          }
          return { ...f, ...extra, status: newStatus }
        })
      )
    }
    const replaceWithItems = (key, newItems) => {
      setFiles((prev) => {
        const idx = prev.findIndex((f) => f.key === key)
        if (idx === -1) return prev
        // 只允许从 splitting 状态替换
        if (prev[idx].status !== 'splitting' && prev[idx].status !== 'uploading') return prev
        const copy = [...prev]
        copy.splice(idx, 1, ...newItems)
        return copy
      })
    }

    // ── Step 2: 并发 split_pdf + parse 流水线 ────────────
    const SPLIT_CONCURRENCY = 4
    const splitQueue = placeholders.map((p, i) => ({ p, file: files[i] }))
    const parseQueue = []
    let parsePipelineDone = false

    // 解析进度计数（用对象 ref 规避闭包陷阱，parseWorker 并发累加）
    const totalParseJobsRef = { current: 0 }
    const doneParseJobsRef = { current: 0 }

    // Parse 流水线（从 parseQueue 消费，并发 2）
    const PARSE_CONCURRENCY = 2

    async function parseWorker() {
      while (true) {
        if (parseQueue.length === 0 && parsePipelineDone) break
        if (parseQueue.length === 0) {
          await new Promise((r) => setTimeout(r, 50))
          continue
        }
        const job = parseQueue.shift()
        if (!job) continue

        const { fileObj } = job
        // only parse if still ready (might have been removed)
        safeUpdate(fileObj.key, 'parsing')

        try {
          const f = fileObj
          let resp

          console.log('[parseWorker] Processing:', f.name, 'file:', !!f.file, 'printPath:', !!f.printPath, 'path:', !!f.path)

          if (f.file) {
            console.log('[parseWorker] Using f.file branch')
            const fd = new FormData()
            fd.append('file', f.file)
            fd.append('autoOrient', autoOrient ? '1' : '0')
            fd.append('mode', 'batch')

            try {
              resp = await fetch(`${BACKEND_URL}/parse_invoice`, {
                method: 'POST', body: fd,
              })
              console.log('[parseWorker] Fetch response:', resp.status, resp.statusText)
            } catch (fetchErr) {
              console.error('[parseWorker] Fetch failed:', fetchErr.message, fetchErr)
              throw fetchErr
            }
          } else if ((f.printPath || f.path) && ipc) {
            console.log('[parseWorker] Using printPath/path branch')
            const filePath = f.printPath || f.path
            const fileData = await ipc.invoke('read-file', filePath)
            if (fileData.success) {
              const ext = getExtension(f.name)
              const mimeType = getMimeType(ext)
              const blob = new Blob([new Uint8Array(fileData.data)], { type: mimeType })
              const file = new File([blob], f.name, { type: mimeType })
              const fd = new FormData()
              fd.append('file', file)
              fd.append('autoOrient', autoOrient ? '1' : '0')
              fd.append('mode', 'batch')
              resp = await fetch(`${BACKEND_URL}/parse_invoice`, {
                method: 'POST', body: fd,
              })
            } else {
              throw new Error(fileData.error)
            }
          }

          if (!resp) throw new Error('无法读取文件')

          if (resp.ok) {
            const data = await resp.json()
            console.log('[parseWorker] Response data:', {
              type: data.invoice_type,
              number: data.invoice_number,
              amount: data.amount,
              date: data.invoice_date,
              failed_fields: data.failed_fields,
              parse_method: data.parse_method
            })
            const fields = data.invoice_fields || data.invoiceFields || {}
            safeUpdate(f.key, 'parsed', {
              invoiceType: data.invoice_type || data.invoiceType || '',
              invoiceNumber: data.invoice_number || data.invoiceNumber || '',
              amount: data.amount != null ? String(data.amount) : '',
              invoiceDate: data.invoice_date || data.invoiceDate || '',
              newName: data.new_name || data.newName || f.name,
              parseMethod: data.parse_method || data.parseMethod || '',
              fileFormat: data.file_format || data.fileFormat || getFileFormat(f.name),
              previewImage: data.preview_image || data.previewImage || null,
              failedFields: data.failed_fields || data.failedFields || [],
              invoiceFields: fields,
              // 与旧版 parseFiles 单文件分支保持一致的完整字段
              issuer: fields?.kpr || '',
              amountWithoutTax: fields?.amountJe != null ? String(fields.amountJe) : '',
              taxAmount: fields?.amountSe != null ? String(fields.amountSe) : '',
              lineItems: fields?.line_items || [],
              rawText: data.raw_text || '',
              searchText: buildSearchText({
                name: f.name,
                invoiceNumber: data.invoice_number || data.invoiceNumber || '',
                invoiceType: data.invoice_type || data.invoiceType || '',
                amount: data.amount != null ? String(data.amount) : '',
                invoiceDate: data.invoice_date || data.invoiceDate || '',
                invoice_fields: fields,
                rawText: data.raw_text || '',
              }),
            })
          } else {
            throw new Error(`parse_invoice returned ${resp.status}`)
          }
        } catch (err) {
          console.error(`[App] 解析失败: ${fileObj.name}`, err)
          safeUpdate(fileObj.key, 'error')
        } finally {
          // 无论成功/失败都推进进度，保证进度条能走到 100%
          doneParseJobsRef.current += 1
          setParseProgress({
            current: doneParseJobsRef.current,
            total: totalParseJobsRef.current,
          })
        }
      }
    }

    // Split worker
    async function splitWorker() {
      while (splitQueue.length > 0) {
        const job = splitQueue.shift()
        const { p, file: f } = job
        safeUpdate(p.key, 'splitting')

        try {
          if (f.name.toLowerCase().endsWith('.pdf')) {
            const { toAdd, toParse: newToParse } = await processPdfFile(
              { file: p.file, name: f.name },
              () => f.path
            )

            if (toAdd.length === 1) {
              // 单页 PDF — 原地更新占位项为 ready
              // ✅ 防御性：剥离 toAdd[0] 自带的身份字段（key 等），
              //    用 p.key 作为唯一身份，避免身份被覆盖导致 parse 结果丢失（Blocker 2）
              const toAddRest = stripIdentity(toAdd[0])
              safeUpdate(p.key, 'ready', toAddRest)
              totalParseJobsRef.current += 1

              // 立即加入 parse 队列（key 由 ...p 提供 = p.key，身份不被 toAdd 覆盖）
              const readyFile = { ...p, ...toAddRest }
              parseQueue.push({ fileObj: readyFile })
            } else if (toAdd.length > 1) {
              // 多页 PDF — 用拆出的页项替换占位（pageItems 自带独立 key，与 parse 队列一致）
              const pageItems = toAdd.map((pageObj) => ({
                ...pageObj,
                status: 'ready',
              }))
              replaceWithItems(p.key, pageItems)

              // 全部加入 parse 队列
              totalParseJobsRef.current += pageItems.length
              for (const pageObj of pageItems) {
                parseQueue.push({ fileObj: pageObj })
              }
            } else {
              // split 产出为空 — 兜底：直接把原始占位项送去解析
              safeUpdate(p.key, 'ready', { key: p.key })
              totalParseJobsRef.current += 1
              parseQueue.push({ fileObj: { ...p, key: p.key } })
            }
          } else {
            // 非 PDF — 直接 ready（同样保留占位 key，避免被 fileObj 自带 key 覆盖）
            const fileObj = buildFileObj(p.file, f.name, f.path)
            // ✅ 防御性：剥离 fileObj 自带身份字段，用 p.key 作为唯一身份
            const fileObjRest = stripIdentity(fileObj)
            safeUpdate(p.key, 'ready', fileObjRest)
            totalParseJobsRef.current += 1

            const readyFile = { ...p, ...fileObjRest }
            parseQueue.push({ fileObj: readyFile })
          }
        } catch (err) {
          console.error(`[App] 文件处理失败: ${f.name}`, err)
          safeUpdate(p.key, 'error')
        }
      }
    }

    // 启动 split workers + parse workers
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
  }, [setFiles, electronAPIRef, settingsRef])

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

      // 转换为 processFilesForAddition 需要的格式
      const droppedFiles = result.files.map(f => ({
        name: f.name,
        path: f.path,
        // 注意：文件夹扫描的文件没有 File 对象，后续读取会通过 IPC read-file
      }))

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

    const filesToAdd = []

    for (const file of result.files) {
      const isPDF = file.name.toLowerCase().endsWith('.pdf')

      if (isPDF) {
        try {
          const fileData = await ipc.invoke('read-file', file.path)
          if (fileData.success) {
            const blob = new Blob([new Uint8Array(fileData.data)], { type: 'application/pdf' })
            const pdfFile = new File([blob], file.name, { type: 'application/pdf' })
            filesToAdd.push({
              file: pdfFile,
              name: file.name,
              path: file.path
            })
            continue
          }
        } catch (err) {
          console.error('[App] 多页 PDF 检测/拆分失败:', err)
        }
      }

      // 非 PDF 文件或 PDF 读取失败
      filesToAdd.push({
        file: null,
        name: file.name,
        path: file.path
      })
    }

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

    const filesToAdd = []

    for (const file of result.files) {
      const isPDF = file.name.toLowerCase().endsWith('.pdf')

      if (isPDF) {
        try {
          const fileData = await ipc.invoke('read-file', file.path)
          if (fileData.success) {
            const blob = new Blob([new Uint8Array(fileData.data)], { type: 'application/pdf' })
            const pdfFile = new File([blob], file.name, { type: 'application/pdf' })
            filesToAdd.push({
              file: pdfFile,
              name: file.name,
              path: file.path
            })
            continue
          }
        } catch (err) {
          console.error('[App] 多页 PDF 检测/拆分失败:', err)
        }
      }

      filesToAdd.push({
        file: null,
        name: file.name,
        path: file.path
      })
    }

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
