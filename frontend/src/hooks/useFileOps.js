import { useState, useCallback, useRef, useEffect } from 'react'
import { useDropzone } from 'react-dropzone'
import { BACKEND_URL, SUPPORTED_EXTENSIONS } from '../config'
import {
  getElectronAPI, getFilePath, getFileFormat, getExtension, getExtensionWithDot,
  getMimeType, concurrentBatch, applySort, buildSearchText,
} from '../utils'
import { buildFileObj, processPdfFile } from '../utils/fileHelpers'
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

    const data = await res.json()
    if (!data.success) {
      throw new Error(data.error || '批量解析失败')
    }

    // 收集所有更新，单次应用（避免 O(n²) 数组复制）
    const updates = new Map()
    let completedCount = 0

    for (const item of data.items) {
      const fileObj = filesToParse[item.index]
      if (!fileObj) continue

      if (item.success && item.data) {
        const d = item.data
        if (d.db_record) {
          db.upsert(d.db_record).catch((err) =>
            console.error('[useFileOps] 写入 datastore 失败:', err)
          )
        }

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
          setFiles((prev) =>
            applySort(prev, sortByRef.current, sortOrderRef.current)
          )
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

              if (data.db_record) {
                db.upsert(data.db_record).catch(err =>
                  console.error('[useFileOps] 写入 datastore 失败:', err)
                )
              }

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
        return applySort(prev, sortByRef.current, sortOrderRef.current)
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

    try {
      const newFilesToAdd = []
      const newFilesToParse = []
      const ipc = electronAPIRef.current?.ipcRenderer

      for (const f of files) {
        let fileData = f.file

        // 如果没有 File 对象，通过 IPC 读取
        if (!fileData && f.path && ipc) {
          const result = await ipc.invoke('read-file', f.path)
          if (result.success) {
            const ext = getExtension(f.name)
            const mimeType = getMimeType(ext)

            const blob = new Blob([new Uint8Array(result.data)], { type: mimeType })
            fileData = new File([blob], f.name, { type: mimeType })
          }
        }

        if (f.name.toLowerCase().endsWith('.pdf')) {
          const { toAdd, toParse } = await processPdfFile(
            { file: fileData, name: f.name },
            () => f.path
          )
          newFilesToAdd.push(...toAdd)
          newFilesToParse.push(...toParse)
        } else {
          const fileObj = buildFileObj(fileData, f.name, f.path)
          newFilesToAdd.push(fileObj)
          newFilesToParse.push(fileObj)
        }
      }

      if (newFilesToAdd.length > 0) {
        setFiles((prev) => {
          const existingKeys = new Set(prev.map((f) => {
            if (f.printPath) return f.printPath
            if (f.path) return f.path
            return `${f.name}_${f.size}_${f.lastModified}`
          }))
          return [...prev, ...newFilesToAdd.filter((f) => {
            const key = f.printPath || f.path || `${f.name}_${(f.file?.size || 0)}_${(f.file?.lastModified || 0)}`
            return !existingKeys.has(key)
          })]
        })
        // 启动解析，解析完成后由 parseFiles 的 finally 清除 importing
        await parseFiles(newFilesToParse)
      }
    } finally {
      setImporting(false)
    }
  }, [parseFiles, setFiles, electronAPIRef])

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
