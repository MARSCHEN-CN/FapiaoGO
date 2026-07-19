import { useState, useCallback, useRef, useEffect } from 'react'
import { PREVIEW_DPI, PRINT_PIPELINE, PRINT_SETTINGS_DEFAULTS } from '../config'
import {
  isMergeMode, b64toBlob, getExtension,
} from '../utils'
import { rotateContentOnPaper } from '../utils/canvasUtils'
import { getForcedLandscape } from '../utils/mergeMode'
import { renderPrintContent } from '../utils/printRenderer'
import { buildRenderModel } from '../utils/renderModelBuilder'
import { validateRenderModel } from '../utils/renderModelValidator'
import { detectDocumentOrientation } from '../utils/detectOrientation'
import { printSingleSourceFile as printSingleSource, printMergedImages } from '../services/PrintService'
import { runMergedPrintTasks } from '../runners/printRunner'

// ✅ 懒加载 PDF 渲染模块，避免首屏加载 1.4 MB 的 pdfjs-dist + react-pdf
let _printRenderers = null
async function getPrintRenderers() {
  if (!_printRenderers) {
    _printRenderers = await import('../renderers')
  }
  return _printRenderers
}

// 打印队列配置
const PRINT_BATCH_SIZE = 3  // 并发渲染数量

// 直接打印支持的文件扩展名
const DIRECT_PRINT_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif']

function canDirectPrint(filePath) {
  if (!filePath) return false
  const ext = getExtension(filePath)
  return DIRECT_PRINT_EXTENSIONS.includes('.' + ext)
}

// ==========================================
// 辅助函数：Canvas → Uint8Array（PNG 格式）
// 替换 toDataURL：避免 base64 33% 膨胀 + 内存翻倍
// 返回 Uint8Array 供 IPC 传输（Electron 结构化克隆原生支持）
// ==========================================
async function canvasToUint8Array(canvas) {
  if (!canvas) return null
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 1.0))
  if (!blob || blob.size === 0) return null
  const buffer = await blob.arrayBuffer()
  return new Uint8Array(buffer)
}

// ==========================================
// Blob URL 管理工具（在本地作用域内管理，避免泄漏）
// ==========================================
function createAndTrackBlobUrl(blob, ref) {
  const url = URL.createObjectURL(blob)
  ref.push(url)
  return url
}

function revokeBlobUrl(url, ref) {
  if (!url) return
  try {
    URL.revokeObjectURL(url)
  } catch (e) { /* ignore already revoked */ }
  const idx = ref.indexOf(url)
  if (idx > -1) ref.splice(idx, 1)
}

function revokeBlobUrls(urls, ref) {
  urls.forEach(url => revokeBlobUrl(url, ref))
}

export function usePrint({ files, settings, fileRotations, setFiles, electronAPIRef, submitPrintIntent }) {
  const [printing, setPrinting] = useState(false)
  const [printProgress, setPrintProgress] = useState({})
  const [printFiles, setPrintFiles] = useState([])
  const [alertModal, setAlertModal] = useState(null)
  // 当前直接打印的 jobId
  const [currentJobId, setCurrentJobId] = useState(null)
  // 打印确认弹窗
  const [printConfirmModal, setPrintConfirmModal] = useState(false)
  const [triggerPrint, setTriggerPrint] = useState(false)
  // 打印队列状态
  const [printQueueStatus, setPrintQueueStatus] = useState({
    pending: 0,
    printing: 0,
    completed: 0,
    failed: 0,
  })

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      // 取消所有进行中的操作
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      // 清除超时定时器
      if (printTimeoutRef.current) {
        clearTimeout(printTimeoutRef.current)
      }
      // 释放所有未释放的 blob URLs
      pendingBlobUrlsRef.current.forEach(url => {
        try {
          URL.revokeObjectURL(url)
        } catch (e) { /* ignore */ }
      })
      pendingBlobUrlsRef.current = []
    }
  }, [])

  const printProgressRef = useRef({})
  const printTimeoutRef = useRef(null)
  const printFilesRef = useRef([])
  // ✅ 完成计数 ref，避免 O(n) 遍历检查是否全部完成
  const completedCountRef = useRef(0)
  // URL 内存泄漏修复：追踪所有创建的 blob URL
  const pendingBlobUrlsRef = useRef([])
  // 打印队列 refs
  const printQueueRef = useRef({
    pending: [],    // 待处理
    printing: [],   // 处理中
    completed: [],  // 完成
    failed: [],     // 失败
  })
  // ✅ 打印队列状态 ref（用于同步）
  const printQueueStatusRef = useRef({
    pending: 0,
    printing: 0,
    completed: 0,
    failed: 0,
  })
  const isPrintingRef = useRef(false)
  const abortControllerRef = useRef(null)
  const nextTaskIdRef = useRef(0)

  // 同步 printFilesRef
  // 通过在 setter 中同步来保持一致
  const setPrintFilesAndRef = useCallback((value) => {
    setPrintFiles(prev => {
      const next = typeof value === 'function' ? value(prev) : value
      printFilesRef.current = next
      return next
    })
  }, [])

  const clearPrintState = useCallback(() => {
    setPrintProgress({})
  }, [])

  // ── 更新队列状态 ──
  const updateQueueStatus = useCallback(() => {
    const queue = printQueueRef.current
    const status = {
      pending: queue.pending.length,
      printing: queue.printing.length,
      completed: queue.completed.length,
      failed: queue.failed.length,
    }
    // ✅ 同步到 ref
    printQueueStatusRef.current = status
    setPrintQueueStatus(status)
  }, [])

  // ✅ renderImageBlobToCanvas 已移除，现在统一使用 renderMultipleItemsToCanvas 以支持安全边距

  // ── 单个文件渲染为打印图片 ──
  // ✅ 改为使用 renderMultipleItemsToCanvas，以支持打印安全边距
  const renderFileToPrintImage = useCallback(async (f, ipc) => {
    const rotation = fileRotations[f.key] || 0
    const localBlobUrls = []
    
    try {
      // ✅ 加载文件数据，构建 items 数组
      const items = []
      
      if (f.fileFormat === 'pdf' || (!f.fileFormat && !f.previewImage)) {
        // PDF 文件
        const fileData = await ipc.invoke('read-file', f.printPath)
        if (fileData.success) {
          items.push({ ...f, _pdfData: new Uint8Array(await fileData.data.arrayBuffer()) })
        } else {
          console.error('[usePrint] 读取 PDF 文件失败:', f.printPath)
          return null
        }
      } else if (f.fileFormat === 'image' || f.fileFormat === 'ofd') {
        // 图片或 OFD 文件
        let blob
        if (f.previewImage) {
          blob = b64toBlob(f.previewImage, 'image/png')
        } else {
          const fileData = await ipc.invoke('read-file', f.printPath)
          if (fileData.success) {
            blob = new Blob([fileData.data])
          } else {
            console.error('[usePrint] 读取图片文件失败:', f.printPath)
            return null
          }
        }
        const blobUrl = createAndTrackBlobUrl(blob, localBlobUrls)
        items.push({ ...f, _previewImageUrl: blobUrl })
      } else {
        console.error('[usePrint] 未知文件格式:', f.fileFormat)
        return null
      }
      
      if (items.length === 0) {
        console.warn('[usePrint] 没有成功加载任何文件数据')
        return null
      }
      
      // ✅ 使用 renderMultipleItemsToCanvas 渲染（支持安全边距）
      const { renderMultipleItemsToCanvas } = await getPrintRenderers()
      
      const canvas = await renderMultipleItemsToCanvas(
        items,
        settings.paperSize || 'A4',
        PREVIEW_DPI,
        settings.landscape,
        { [f.key]: rotation },  // rotations
        1,  // slotCount = 1（单个文件）
        false,  // ✅ isPrint = false（与预览保持一致）
        false,  // showSafeMargin
        { strategy: 'vertical', customPaper: settings.customPaper }
      )
      
      if (!canvas) {
        console.warn('[usePrint] renderMultipleItemsToCanvas 返回 null')
        return null
      }

      // ✅ 返回 Uint8Array
      const data = await canvasToUint8Array(canvas)
      return data ? { key: f.key, name: f.name, data, printPath: f.printPath } : null
      
    } catch (error) {
      console.error('[usePrint] renderFileToPrintImage 异常:', error)
      return null
    } finally {
      // 所有路径（包括异常）都必须释放本地 blob URL
      revokeBlobUrls(localBlobUrls, pendingBlobUrlsRef.current)
    }
  }, [fileRotations, settings.paperSize, settings.landscape])

  // ── 合并模式渲染多文件到一页 ──
  const renderMergeGroupToPrintImage = useCallback(async (group, ipc, groupSize) => {
    const localBlobUrls = []

    try {
      // 加载每个文件的渲染数据（与预览路径相同的结构）
      const items = await Promise.all(group.map(async (f) => {
        try {
          if (f.fileFormat === 'pdf' || (!f.fileFormat && !f.previewImage)) {
            const fileData = await ipc.invoke('read-file', f.printPath)
            if (fileData.success) {
              return { ...f, _pdfData: new Uint8Array(await fileData.data.arrayBuffer()) }
            }
          } else if (f.fileFormat === 'ofd' && f.previewImage) {
            const blob = b64toBlob(f.previewImage, 'image/png')
            const blobUrl = URL.createObjectURL(blob)
            localBlobUrls.push(blobUrl)
            return { ...f, _previewImageUrl: blobUrl }
          } else if (f.fileFormat === 'image') {
            if (f.previewImage) {
              const blob = b64toBlob(f.previewImage, 'image/png')
              const blobUrl = URL.createObjectURL(blob)
              localBlobUrls.push(blobUrl)
              return { ...f, _previewImageUrl: blobUrl }
            }
            const fileData = await ipc.invoke('read-file', f.printPath)
            if (fileData.success) {
              const blob = new Blob([fileData.data])
              const blobUrl = URL.createObjectURL(blob)
              localBlobUrls.push(blobUrl)
              return { ...f, _previewImageUrl: blobUrl }
            }
          }
        } catch (e) {
          console.error('加载合并项失败:', f.name, e)
        }
        return null
      }))

      const validItems = items.filter(Boolean)
      if (validItems.length === 0) return null

      // ✅ 懒加载 PDF 渲染器
      const { renderMultipleItemsToCanvas } = await getPrintRenderers()

      // ✅ 合并模式强制方向（merge2/3=竖向, merge4=横向），纸张用用户设置
      const forcedLandscape = getForcedLandscape(settings.mergeMode, settings.landscape)

      const canvas = await renderMultipleItemsToCanvas(
        validItems,
        settings.paperSize || 'A4',
        PREVIEW_DPI,
        forcedLandscape,
        fileRotations,
        groupSize,
        false,  // ✅ isPrint = false（与预览保持一致）
        false,  // showSafeMargin
        { strategy: groupSize === 4 ? 'grid' : 'vertical', gridCols: 2, gridRows: 2, customPaper: settings.customPaper }
      )

      // ✅ 返回 Uint8Array 而非 blob URL
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 1.0))
      if (!blob) return null
      const buffer = await blob.arrayBuffer()
      return {
        key: group.map(f => f.key).join('+'),
        names: group.map(f => f.name),
        data: new Uint8Array(buffer),
      }
    } finally {
      localBlobUrls.forEach(url => revokeBlobUrl(url, pendingBlobUrlsRef.current))
    }
  }, [fileRotations, settings.paperSize, settings.landscape, settings.mergeMode])


  const handlePrintClose = useCallback(() => {
    setPrinting(false); setPrintProgress({})
    setFiles((prev) => prev.map((f) => f.status === 'printing' ? { ...f, status: 'parsed' } : f))
  }, [setFiles])

  // ── 打印前确认弹窗 ──
  const handlePrintShowConfirm = useCallback(() => {
    setPrintConfirmModal(true)
  }, [])

  const handlePrintConfirm = useCallback(() => {
    setPrintConfirmModal(false)
    // ⛔ Step 3.1: setTriggerPrint(true) 已移除
    // handlePrintConfirm 仅关闭弹窗，不再间接触发 doPrint()
    // Legacy 打印由 App.jsx 通过 executeLegacyPrint() 显式调用
  }, [])

  const handlePrintCancel = useCallback(() => {
    setPrintConfirmModal(false)
  }, [])

  // ── 离线队列打印系统 ──
  const doPrint = useCallback(async () => {
    // 防重入：已在打印中，忽略重复点击
    if (isPrintingRef.current) return

    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc || typeof ipc.invoke !== 'function') {
      setAlertModal({
        visible: true,
        title: '环境限制',
        message: '打印功能仅在 Electron 桌面端可用',
        type: 'warning',
      })
      return
    }

    // 创建新的取消控制器
    const abortController = new AbortController()
    abortControllerRef.current = abortController
    const { signal } = abortController

    // 支持已解析和解析失败的文件（只要有 printPath 就能打印）
    const parsedFiles = files.filter(f => {
      if (!f.printPath) return false
      if (f.status !== 'parsed' && f.status !== 'error') return false
      if ((f.fileFormat === 'ofd') && !f.previewImage) return false
      return true
    })
    if (parsedFiles.length === 0) {
      setAlertModal({
        visible: true,
        title: '提示',
        message: '没有可打印的文件',
        type: 'warning',
      })
      return
    }

    // 初始化打印队列
    printQueueRef.current = {
      pending: [],
      printing: [],
      completed: [],
      failed: [],
    }
    setPrintProgress({})
    setPrinting(true)
    completedCountRef.current = 0
    isPrintingRef.current = true

    setFiles((prev) =>
      prev.map((f) =>
        parsedFiles.some((pf) => pf.key === f.key) ? { ...f, status: 'printing' } : f
      )
    )

    // 给每个任务分配唯一 ID
    const assignTaskId = (data) => ({ id: nextTaskIdRef.current++, data })

    // 准备队列任务
    const mergeMode = settings.mergeMode || 'none'
    const isMerge = isMergeMode(mergeMode)
    const groupSize = parseInt(mergeMode.replace('merge', '')) || 2
    // ✅ 合并模式强制方向：merge4=横向，其他=竖向
    const forcedLandscape = isMerge ? getForcedLandscape(mergeMode, settings.landscape) : settings.landscape
    if (isMerge) {
      // 合并模式：根据 mergeMode 动态分组
      const groups = []
      for (let i = 0; i < parsedFiles.length; i += groupSize) {
        groups.push(assignTaskId(parsedFiles.slice(i, i + groupSize)))
      }
      printQueueRef.current.pending = groups
      setPrintFilesAndRef(groups.map(t => ({
        key: t.data.map(f => f.key).join('+'),
        name: t.data.map(f => f.name).join(' + '),
      })))
    } else {
      // 普通模式：单文件
      printQueueRef.current.pending = parsedFiles.map(f => assignTaskId(f))
      setPrintFilesAndRef(parsedFiles.map(f => ({ key: f.key, printPath: f.printPath, name: f.name })))
    }
    updateQueueStatus()

    // 超时保护
    if (printTimeoutRef.current) clearTimeout(printTimeoutRef.current)
    printTimeoutRef.current = setTimeout(() => {
      abortController.abort()
      isPrintingRef.current = false
      setPrinting(false)
      setPrintProgress({})
      printQueueRef.current = { pending: [], printing: [], completed: [], failed: [] }
      setFiles((prev) => prev.map((f) => f.status === 'printing' ? { ...f, status: 'parsed' } : f))
    }, 120000) // 2分钟超时

    // ── 队列处理循环（通过 PrintRunner 编排执行） ──
    const processQueue = async () => {
      const queue = printQueueRef.current
      // 包装渲染函数（与 React state 解耦的纯执行）
      const renderFn = async (task) => {
        if (signal.aborted) return null
        try {
          const result = isMerge
            ? await renderMergeGroupToPrintImage(task.data || task, ipc, groupSize)
            : await renderFileToPrintImage(task.data || task, ipc)
          return result
        } catch (error) {
          console.error('渲染失败:', task.name || task.data?.name, error)
          return null
        }
      }
      // 包装合并打印函数
      const mergedPrintFn = async (images, ctx) => {
        const printOptions = { ...settings, landscape: forcedLandscape }
        return await printMergedImages(images, ipc, printOptions)
      }

      // 委托给 PrintRunner 执行
      const { results, mergedResult } = await runMergedPrintTasks(
        queue.pending,
        renderFn,
        mergedPrintFn,
        { signal, batchSize: PRINT_BATCH_SIZE }
      )

      if (signal.aborted) return

      // 处理结果 → React 状态
      const completed = results.filter(r => r.success)
      const failed = results.filter(r => !r.success)
      queue.completed = completed
      queue.failed = failed

      // 队列完成
      if (printTimeoutRef.current) clearTimeout(printTimeoutRef.current)
      isPrintingRef.current = false
      setPrinting(false)
      setPrintProgress({})

      // 更新文件状态
      setFiles((prev) => prev.map((f) => {
        if (f.status === 'printing') {
          return { ...f, status: 'parsed' }
        }
        return f
      }))

      // 显示结果摘要
      const compLen = queue.completed ? queue.completed.length : 0
      const failLen = queue.failed ? queue.failed.length : 0
      if (failLen > 0) {
        setAlertModal({
          visible: true,
          title: '打印完成（部分失败）',
          message: `成功: ${compLen} 个，失败: ${failLen} 个`,
          type: 'warning',
        })
      } else if (completed.length > 0) {
        setAlertModal({
          visible: true,
          title: '打印完成',
          message: `已发送 ${completed.length} 个文件到打印队列`,
          type: 'success',
        })
      }
    }

    processQueue()
  }, [files, settings, setAlertModal, setPrintProgress, setPrinting, setFiles, setPrintFilesAndRef, updateQueueStatus, renderFileToPrintImage, renderMergeGroupToPrintImage])

  // 触发打印：仅当 PRINT_PIPELINE_V2=false 时生效（legacy fallback）
  // V2 模式下此 effect 永不触发，doPrint 只能通过 executeLegacyPrint 显式调用
  useEffect(() => {
    if (triggerPrint) {
      setTriggerPrint(false)
      if (!PRINT_PIPELINE_V2) {
        console.log('[PRINT] Legacy triggerPrint → doPrint()')
        doPrint()
      }
    }
  }, [triggerPrint, doPrint])

  // ═══════════════════════════════════════════════════════════
  // executeSourcePrint — 新管道：源文件直通 Sumatra
  // ═══════════════════════════════════════════════════════════
  const executeSourcePrint = useCallback(async (previewFile, printSettings) => {
    if (!previewFile) return
    const file = files.find(f => f.key === previewFile.key)
    if (!file) {
      console.error('[print] File not found in files[]:', previewFile.key)
      return
    }

    setPrinting(true)
    setPrintFilesAndRef([{ key: file.key, name: file.name }])
    setPrintProgress({ [file.key]: { status: 'printing' } })

    const failProgress = (msg) => {
      setPrintProgress(prev => ({
        ...prev,
        [file.key]: { status: 'error', error: msg },
      }))
    }

    try {
      // 确定文件格式
      let fileFormat = file.fileFormat || 'pdf'
      const ext = getExtension(file.name)
      if (!fileFormat || fileFormat === 'unknown') {
        if (ext === 'ofd') fileFormat = 'ofd'
        else if (['jpg', 'jpeg', 'png', 'bmp', 'tiff', 'tif', 'gif'].includes(ext)) fileFormat = 'image'
        else fileFormat = 'pdf'
      }

      // 确定文件路径
      const filePath = file.printPath || file.path
      if (!filePath) {
        failProgress('文件路径不存在')
        return
      }

      // 确定打印机名称
      const printerName = printSettings?.printerName
        || printSettings?.printer
        || settings.printerName
        || ''
      if (!printerName) {
        failProgress('请选择打印机')
        return
      }

      // 构建 PrintSettings（rotation 按文件独立，从 fileRotations 读取）
      const fileRotation = fileRotations?.[file.key] || 0

      // 从文件元数据获取内容方向（前端在导入时已检测）
      const contentOrientation = detectDocumentOrientation(file)

      const ps = {
        rotation: fileRotation,
        paperkind: settings.paperkind || printSettings?.paperkind,
        paper: printSettings?.paperSize || settings.paperSize || PRINT_SETTINGS_DEFAULTS.paper,
        fit: printSettings?.fit || PRINT_SETTINGS_DEFAULTS.fit,
        contentOrientation,
        duplex: printSettings?.duplex ?? PRINT_SETTINGS_DEFAULTS.duplex,
        grayscale: printSettings?.grayscale ?? settings.grayscale ?? PRINT_SETTINGS_DEFAULTS.grayscale,
        copies: printSettings?.copies ?? settings.copies ?? PRINT_SETTINGS_DEFAULTS.copies,
        marginLeft: settings.marginLeft ?? 3,
        marginRight: settings.marginRight ?? 3,
        marginTop: settings.marginTop ?? 3,
        marginBottom: settings.marginBottom ?? 3,
        customPaper: settings.customPaper,
      }

      console.log('[PRINT] contentOrientation:', contentOrientation, '(from detectDocumentOrientation)')

      const ipc = electronAPIRef.current?.ipcRenderer
      if (!ipc) {
        failProgress('Electron IPC 不可用')
        return
      }

      console.log('[PRINT] Source pipeline: file=%s format=%s printer=%s', filePath, fileFormat, printerName)
      console.log('[PRINT] PrintSettings:', JSON.stringify(ps))

      const userSettings = { ...settings, ...(printSettings || {}) }
      const result = await printSingleSource(file, ipc, userSettings, fileRotations, detectDocumentOrientation)

      console.log('[PRINT] Source pipeline result:', result)

      if (result?.success) {
        setPrintProgress(prev => ({
          ...prev,
          [file.key]: { status: 'done' },
        }))
        setTimeout(() => {
          setPrinting(false)
          setPrintProgress({})
          setAlertModal({ visible: true, title: '打印成功', message: '已发送至打印机队列', type: 'success' })
        }, 1200)
      } else {
        const msg = result?.message || result?.error || '打印失败'
        failProgress(msg)
        console.error('[PRINT] Source pipeline failed:', msg)
      }
    } catch (err) {
      console.error('[print] Source pipeline error:', err)
      failProgress(err?.message || '未知异常')
    }
  }, [files, settings, fileRotations, electronAPIRef])

  /**
   * 打印单个源文件（调用 IPC 直通 Sumatra，不管理全局进度）
   * 用于批量场景中逐文件调用
   */
  const printSingleSourceFile = useCallback(async (f, printSettings) => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return { success: false, error: 'IPC 不可用' }

    // 合并 settings + printSettings 作为 userSettings
    const userSettings = { ...settings, ...(printSettings || {}) }

    const result = await printSingleSource(f, ipc, userSettings, fileRotations, detectDocumentOrientation)

    return {
      success: result.success,
      message: result.error || '',
      error: result.error || null,
    }
  }, [settings, fileRotations, electronAPIRef, detectDocumentOrientation])

  /**
   * 批量打印（source 管线），管理总进度
   */
  const printAllSourceFiles = useCallback(async (filesToPrint, printSettings) => {
    if (filesToPrint.length === 0) return
    const completed = []
    const failed = []

    setPrinting(true)
    setPrintFilesAndRef(filesToPrint.map(f => ({ key: f.key, name: f.name })))
    const init = {}
    for (const f of filesToPrint) init[f.key] = { status: 'waiting' }
    setPrintProgress(init)

    for (const f of filesToPrint) {
      setPrintProgress(prev => ({ ...prev, [f.key]: { status: 'printing' } }))
      try {
        const result = await printSingleSourceFile(f, printSettings)
        if (result?.success) {
          setPrintProgress(prev => ({ ...prev, [f.key]: { status: 'done' } }))
          completed.push(f)
        } else {
          const msg = result?.message || result?.error || '打印失败'
          setPrintProgress(prev => ({ ...prev, [f.key]: { status: 'error', error: msg } }))
          failed.push(f)
        }
      } catch (err) {
        setPrintProgress(prev => ({ ...prev, [f.key]: { status: 'error', error: err?.message || '未知异常' } }))
        failed.push(f)
      }
    }

    setPrinting(false)

    // ✅ 打印完成，释放 L2 缓存（~1GB 峰值），保留 L1 加速下次预览重建
    try {
      const renderers = await getPrintRenderers()
      if (renderers.clearRenderCache) renderers.clearRenderCache()
      console.log('[Cache] L2 cleared after print.')
    } catch (_) {}

    return { completed: completed.length, failed: failed.length }
  }, [printSingleSourceFile])

  /**
   * 显示打印完成摘要
   */
  const showPrintSummary = useCallback((completed, failed) => {
    if (failed > 0) {
      setAlertModal({
        visible: true, title: '打印完成（部分失败）',
        message: `成功: ${completed} 个，失败: ${failed} 个`, type: 'warning',
      })
    } else {
      setAlertModal({
        visible: true, title: '打印完成',
        message: `已发送 ${completed} 个文件到打印队列`, type: 'success',
      })
    }
  }, [setAlertModal])

  // ═══════════════════════════════════════════════════════════
  // executePrint — 唯一打印执行入口 (Step 3.2)
  // V2 orchestration: load → render (pure) → submit
  // ═══════════════════════════════════════════════════════════
  const executePrint = useCallback(async (previewFile, printSettings) => {
    // ✅ 合并模式：委托给 doPrint()
    const mergeMode = settings.mergeMode || 'none'
    if (isMergeMode(mergeMode)) {
      console.log('[PRINT] Merge mode detected → doPrint()')
      return doPrint()
    }

    const allParsed = files.filter(f => f.status === 'parsed' && (f.printPath || f.path))
    if (allParsed.length === 0) return

    // ── Source 管线：批量打印所有已解析文件 ──
    if (PRINT_PIPELINE.mode === 'source') {
      if (settings.extraSpecial) {
        // 一普二专：合并两轮进度为一个连续序列，避免进度条重置
        const specialFiles = allParsed.filter(f => f.invoiceType?.includes('专票'))
        // 第二轮专票项使用独立 key（+ '_v2'），在进度列表中单独展示
        const mergedJobs = [
          ...allParsed.map(f => ({ ...f, _jobKey: f.key, _round: 1 })),
          ...specialFiles.map(f => ({ ...f, _jobKey: f.key + '_v2', _round: 2 })),
        ]
        console.log('[PRINT] 一普二专: 合并 %d 个任务（第1轮%d + 第2轮%d）',
          mergedJobs.length, allParsed.length, specialFiles.length)

        // printAllSourceFiles 内部用 _jobKey 替代 f.key 追踪进度
        const originalKey = 'key'
        for (const job of mergedJobs) {
          job.key = job._jobKey
        }
        const r = await printAllSourceFiles(mergedJobs, printSettings)
        // 恢复原始 key（不影响外部状态）
        for (const job of mergedJobs) {
          job.key = job._jobKey.replace('_v2', '')
        }
        showPrintSummary(r.completed, r.failed)
      } else {
        console.log('[PRINT] Source → 批量打印 %d 个文件', allParsed.length)
        const r = await printAllSourceFiles(allParsed, printSettings)
        showPrintSummary(r.completed, r.failed)
      }
      return
    }

  // Legacy V2 pipeline (PRINT_PIPELINE.mode === 'legacy')
  console.log('[PRINT] Legacy V2 router → orchestrate')

    // ── 1. Locate file ──
    if (!previewFile) return
    const file = files.find(f => f.key === previewFile.key)
    if (!file) {
      console.error('[print] File not found in files[]:', previewFile.key)
      return
    }

    // ── Show progress bar ──
    setPrinting(true)
    setPrintFilesAndRef([{ key: file.key, name: file.name }])
    setPrintProgress({ [file.key]: { status: 'printing' } })

    const failProgress = (errorMsg) => {
      setPrintProgress(prev => ({
        ...prev,
        [file.key]: { status: 'error', error: errorMsg },
      }))
    }

    try {
      // ── 2. Direct print check ──
      const filePath = file.printPath || file.path
      if (canDirectPrint(filePath)) {
        console.log('[PRINT] Direct print mode for:', filePath)
        const ipc = electronAPIRef.current
        const result = await ipc.ipcRenderer.invoke('print-file-direct', {
          filePath,
          settings: printSettings,
        })

        if (!result?.success) {
          console.error('[print] Direct print failed:', result?.message)
          failProgress(result?.message || '直接打印失败')
          return
        }

        console.log('[PRINT] Direct print submitted, jobId:', result.jobId)
          setCurrentJobId(result.jobId)
          // 等待事件通知完成/失败
          return
      }

      // ── 3. Load binary via IPC ──
      const ipc = electronAPIRef.current
      const fileData = await ipc.ipcRenderer.invoke('read-file', filePath)
        if (!fileData?.success) {
          console.error('[print] Failed to read file:', file.printPath)
          failProgress('文件读取失败')
          return
        }

        // ── 3. Build DTO items (clean, no underscore prefixes) ──
        const dtoItems = []
        if (file.fileFormat === 'pdf' || (!file.fileFormat && !file.previewImage)) {
          dtoItems.push({ key: file.key, name: file.name, fileFormat: 'pdf', pdfData: new Uint8Array(await fileData.data.arrayBuffer()) })
        } else {
          const blob = new Blob([fileData.data])
          const blobUrl = URL.createObjectURL(blob)
          dtoItems.push({ key: file.key, name: file.name, fileFormat: file.fileFormat || 'image', imageUrl: blobUrl })
        }

        // ── 4. Build RenderModel (contract layer) ──
        const renderModel = buildRenderModel(
          { items: dtoItems },
          {
            paperSize: printSettings.paperSize || 'A4',
            landscape: printSettings.landscape || false,
            rotations: { [file.key]: fileRotations[file.key] || 0 },
            slotCount: 1,
          }
        )
        if (!renderModel) {
          console.error('[print] buildRenderModel returned null')
          failProgress('渲染模型构建失败')
          return
        }

        // ── 4.1 Validate RenderModel (fail fast) ──
        const validation = validateRenderModel(renderModel)
        if (!validation.valid) {
          console.error('[print] RenderModel validation failed:', validation.errors)
          failProgress('渲染校验失败: ' + (validation.errors?.join('; ') || '未知'))
          return
        }

        // ── 5. Pure render (printRenderer.js) ──
        const canvasBuffer = await renderPrintContent(renderModel)
        if (!canvasBuffer) {
          console.error('[print] renderPrintContent returned null')
          failProgress('渲染失败')
          return
        }

        // ── 6. Submit via print pipeline ──
        const result = await submitPrintIntent({
          canvasBuffer,
          paperSize: printSettings.paperSize,
          orientation: printSettings.landscape ? 'landscape' : 'portrait',
          printerName: printSettings.printerName,
          customPaper: printSettings.customPaper,
        })

        if (result?.success) {
          setPrintProgress(prev => ({
            ...prev,
            [file.key]: { status: 'done' },
          }))
          setTimeout(() => {
            setPrinting(false)
            setPrintProgress({})
            setAlertModal({ visible: true, title: '打印成功', message: '已发送至打印机队列', type: 'success' })
          }, 1200)
        } else {
          failProgress(result?.message || '打印失败')
        }
      } catch (err) {
        console.error('[print] executePrint V2 error:', err)
        failProgress(err?.message || '未知异常')
      }
  }, [files, fileRotations, settings, electronAPIRef, submitPrintIntent, doPrint])

  const cancelPrint = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    isPrintingRef.current = false
    setPrinting(false)
    setPrintProgress({})
    printQueueRef.current = { pending: [], printing: [], completed: [], failed: [] }
    setFiles((prev) => prev.map((f) => f.status === 'printing' ? { ...f, status: 'parsed' } : f))
    if (printTimeoutRef.current) {
      clearTimeout(printTimeoutRef.current)
      printTimeoutRef.current = null
    }
  }, [setFiles])

  const closeAlert = useCallback(() => setAlertModal(null), [])

  // ── 监听直接打印结果事件 ──
  useEffect(() => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return

    const handlePrintCompleted = (event, { jobId }) => {
      console.log('[PRINT] Direct print completed, jobId:', jobId)
      if (jobId === currentJobId) {
        setPrintProgress(prev => {
          const keys = Object.keys(prev)
          if (keys.length > 0) {
            return { ...prev, [keys[0]]: { status: 'done' } }
          }
          return prev
        })
        setCurrentJobId(null)
        setTimeout(() => {
          setPrinting(false)
          setPrintProgress({})
          setAlertModal({ visible: true, title: '打印成功', message: '已发送至打印机队列', type: 'success' })
        }, 1200)
      }
    }

    const handlePrintFailed = (event, { jobId, message }) => {
      console.error('[PRINT] Direct print failed, jobId:', jobId, 'message:', message)
      if (jobId === currentJobId) {
        setPrintProgress(prev => {
          const keys = Object.keys(prev)
          if (keys.length > 0) {
            return { ...prev, [keys[0]]: { status: 'error', error: message } }
          }
          return prev
        })
        setCurrentJobId(null)
      }
    }

    ipc.on('print-job-completed', handlePrintCompleted)
    ipc.on('print-job-failed', handlePrintFailed)

    return () => {
      ipc.removeListener('print-job-completed', handlePrintCompleted)
      ipc.removeListener('print-job-failed', handlePrintFailed)
    }
  }, [electronAPIRef, currentJobId])

  // ── 组件卸载清理（内存泄漏修复） ──
  useEffect(() => {
    return () => {
      // 清理所有未释放的 blob URL
      pendingBlobUrlsRef.current.forEach(url => {
        try {
          URL.revokeObjectURL(url)
        } catch (e) {
          // 忽略已失效的 URL
        }
      })
      pendingBlobUrlsRef.current = []
    }
  }, [])

  return {
    printing, setPrinting,
    printProgress, setPrintProgress,
    printFiles, setPrintFiles: setPrintFilesAndRef,
    printProgressRef, printTimeoutRef, printFilesRef, completedCountRef,
    printQueueStatus,
    alertModal, closeAlert,
    printConfirmModal,
    handlePrint: handlePrintShowConfirm, handlePrintConfirm, handlePrintCancel,
    handlePrintClose, clearPrintState,
    cancelPrint,
    executePrint,  // Step 3.2: 唯一打印执行入口
  }
}
