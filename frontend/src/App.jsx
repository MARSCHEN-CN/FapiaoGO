import { useState, useCallback, useEffect, useRef, useMemo, Suspense, lazy } from 'react'
import { FileProvider, useFileContext } from './contexts/FileContext'

// 懒加载设置窗口（已有）
const SettingsWindow = lazy(() => import('./components/SettingsWindow'))

// 懒加载弹窗组件（优化首屏加载）
const PrintProgressModal = lazy(() => import('./components/PrintProgressModal'))
const RenamePreviewModal = lazy(() => import('./components/RenamePreviewModal'))
const PackProgressModal = lazy(() => import('./components/PackProgressModal'))
const AlertModal = lazy(() => import('./components/AlertModal'))
const PrintConfirmModal = lazy(() => import('./components/PrintConfirmModal'))
const ImportProgressModal = lazy(() => import('./components/ImportProgressModal'))
const ExportProgressModal = lazy(() => import('./components/ExportProgressModal'))
const PdfExportConfirmModal = lazy(() => import('./components/PdfExportConfirmModal'))
const ExcelExportFieldsModal = lazy(() => import('./components/ExcelExportFieldsModal'))
const PackConfirmModal = lazy(() => import('./components/PackConfirmModal'))
const TaskProgressModal = lazy(() => import('./components/TaskProgressModal'))
const CalculatorWindow = lazy(() => import('./components/CalculatorWindow'))
const DevDocumentViewerDemo = lazy(() => import('./components/DevDocumentViewerDemo').then(m => ({ default: m.DevDocumentViewerDemo })))

import { PREVIEW_DPI, SUPPORTED_EXTENSIONS, ZOOM_STEPS, PUBLIC_BASE } from './config'
import {
  getElectronAPI, getFilePath, getFileFormat, isMergeMode, getMergeGroupStart,
  getPreviousYearInfo,
} from './utils'
import { buildDocumentViewModel, documentPages } from './utils/documentViewModel'
import { buildFileObj } from './utils/fileHelpers'
import { getForcedLandscape } from './utils/mergeMode'

import { useSettings } from './hooks/useSettings'
import { useExcelExportSettings } from './hooks/useExcelExportSettings'
import { useSort } from './hooks/useSort'
import { usePreview } from './hooks/usePreview'
import { useFileOps } from './hooks/useFileOps'
import { usePrint } from './hooks/usePrint'
import { usePrintIntent } from './hooks/usePrintIntent'
import { useRenamePack } from './hooks/useRenamePack'
import { useExport } from './hooks/useExport'
import { useExportSession } from './hooks/useExportSession'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useAlertQueue } from './hooks/useAlertQueue'

import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import { DisplayAdapter, resolveDocId, isPdfFile } from './components/DisplayAdapter'
import { ZoomToolbar } from './components/ZoomToolbar'
import { useDocument } from './hooks/useDocument'
import { removeDocument, getRegisteredDocIds } from './stores/DocumentStore'
import StatusIndicator from './components/StatusIndicator'
import ActionBar from './components/ActionBar'
import InvoiceDetail from './components/InvoiceDetail'

// PrintProgressModal, RenamePreviewModal, PackProgressModal, AlertModal 已懒加载

const ModalFallback = () => (
  <div className="modal-overlay" style={{ zIndex: 1000 }}>
    <div className="canvas-loading-spinner" />
  </div>
);

// ── Derived Snapshot: fileIndexMap ───────────────────────
// 通过结构键比较避免 status-only 更新触发 O(n) Map 重建。
// 返回的 Map 引用在 key/order 不变时保持稳定，使下游 useMemo
// 不会因属性更新而 invalidate（Import Pipeline Contract v1.1, Phase 0.5）
function useFileIndexMap(files) {
  const prevStructureKeyRef = useRef('')
  const mapRef = useRef(new Map())

  const structureKey = useMemo(
    () => files.map(f => f.key).join('\x00'),
    [files]
  )

  if (structureKey !== prevStructureKeyRef.current) {
    prevStructureKeyRef.current = structureKey
    const map = new Map()
    files.forEach((f, i) => map.set(f.key, i))
    mapRef.current = map
  }
  return mapRef.current
}

function App() {
  return (
    <FileProvider>
      <AppContent />
    </FileProvider>
  )
}

function AppContent() {
  const isSettingsWindow = window.location.hash === '#/settings'
  const isCalculatorWindow = window.location.hash === '#/calculator'
  const isDevViewer = window.location.hash === '#/dev-viewer' || new URLSearchParams(window.location.search).get('dev') === 'viewer'

  // ── Display Refactor: Mock E2E 验证入口（开发用）──
  if (isDevViewer) {
    return (
      <Suspense fallback={<ModalFallback />}>
        <DevDocumentViewerDemo />
      </Suspense>
    )
  }

  const electronAPIRef = useRef(null)

  // ============================
  // 共享状态
  // ============================
  const { files, setFiles, setMergeMode, printableCount } = useFileContext()

  // ============================
  // Hooks
  // ============================
  const {
    settings, setSettings, saveSettings, updateSettings,
    settingsWindowOpen, setSettingsWindowOpen,
    printers, setPrinters, openSettings,
  } = useSettings(electronAPIRef)

  // Excel 导出字段选择持久化（Commit 4B）
  const excelExportSettings = useExcelExportSettings(electronAPIRef)

  const {
    sortBy, sortOrder, toggleSort, sortByRef, sortOrderRef,
  } = useSort(setFiles, files)

  const preview = usePreview({ files, settings, electronAPIRef })
  // ✅ 从正确的分组中解构属性
  const {
    previewFile, mergePair, numPages, previewPage, previewCanvas,
    previewUrl,
    previewRenderVersion,
    previewLoading,
    previewRotation, paperOrientation, autoActive, fileRotations, showLeftArrow, showRightArrow,
    paperLayout, contentLayout, containerSize,
  } = preview.state

  // Display Area Refactor Step 10：当前预览文件是否已注册 InvoiceDocument。
  // 用于门控 legacy 加载遮罩（新路径 DocumentViewer 自行管理加载态）。
  const activeDocument = useDocument(resolveDocId(previewFile))

  // D2-4.1：DocumentViewer 路径是否激活（与 DisplayAdapter 路由条件严格一致）。
  // 激活时 control-bar 的缩放控件改由 ZoomToolbar 渲染（状态源 useViewerState，经 controller
  // 桥接上抬），UI 位置保持在用户习惯的 control-bar；detail 按钮与方向控件保留。
  // legacy 路径（图片/OFD）继续用旧 preview.zoom 工具栏。
  const documentViewerActive = isPdfFile(previewFile) && activeDocument && activeDocument.pageCount > 0

  // D2-4.1：viewer 缩放控制桥接接收端。DocumentViewer 经 onViewerController 上抬
  // {mode, zoomPercent, actions}（仅 zoom 显示/档位相关值变化时更新，拖拽平移不触发）；
  // 卸载时清空回 null。非空 ⟺ DocumentViewer 已挂载并上报，control-bar 据此渲染 ZoomToolbar。
  const [viewerController, setViewerController] = useState(null)

  const {
    handlePreview, preloadHD, handleRotate, handlePaperOrientationChange, prevPage, nextPage,
    handlePrevFile, handleNextFile, cleanupPreviewUrl,
    clearFilePreviewCache, clearAllPreviewCache,
  } = preview.actions
  const {
    percent: zoomPercent, mode: zoomMode, menuOpen: zoomMenuOpen, menuClosing: zoomMenuClosing,
    zoomIn, zoomOut, setAdaptive, setManualScale, handleCloseZoomMenu,
  } = preview.zoom
  const {
    previewContainerRef, zoomDropdownRef,
  } = preview.refs
  const {
    setPreviewFile, setNumPages, handleCanvasMouseMove, handleCanvasMouseLeave,
    setZoomMenuOpen,
    skipAutoNavRef,
  } = preview.internal

  // ── Invoice Detail Edit Modal ──
  const [detailFile, setDetailFile] = useState(null)

  // ── Calculator window (opens as separate Electron window) ──
  const openCalculator = useCallback(() => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (ipc) ipc.send('open-calculator-window')
  }, [])

  const {
    importing, parseFiles, parsing, parseProgress,
    isNativeDragActive,
    handleNativeDrop, handleNativeDragOver, handleNativeDragLeave,
    getRootProps, getInputProps, isDragActive,
    handleOpenDialog,
    handleOpenFolder,
  } = useFileOps({ setFiles, settings, electronAPIRef, sortByRef, sortOrderRef })

  // ── Print Intent (OS Trust Delegation) ──
  const { submitPrintIntent } = usePrintIntent(electronAPIRef)

  // ── Unified Print Hook ──
  const {
    printing, printProgress, printFiles, setPrintFiles,
    printTimeoutRef, printFilesRef,
    handlePrint, handlePrintClose, clearPrintState, setPrinting, setPrintProgress,
    alertModal: printAlert, closeAlert: closePrintAlert,
    printConfirmModal, handlePrintCancel,
    executePrint,  // Step 3.2: 唯一打印执行入口
  } = usePrint({ files, settings, fileRotations, setFiles, electronAPIRef, submitPrintIntent })

  // ── Print progress refs (local; IPC print-progress handler 专用) ──
  // 这两个 ref 仅在 App.jsx 的 IPC 'print-progress' handler 中使用，
  // 用于同步判定 wasDone（防止 transition-to-done 重复计数）。
  // 原先从 usePrint return 解构，但 usePrint 内部从未定义（导致 ReferenceError），
  // 现本地创建，grep progressMapRef → 0。
  const progressMapRef = useRef({})        // key → progress snapshot（IPC 事件镜像）
  const completedCountRef = useRef(0)      // 已完成文件计数（收尾判定）

  // ── Print confirm: close modal → executePrint ──
  const onPrintConfirm = useCallback(() => {
    handlePrintCancel()
    executePrint(previewFile, settings)
  }, [previewFile, settings, executePrint, handlePrintCancel])

  // ── Ctrl+P: close any state → executePrint ──
  const onCtrlP = useCallback(() => {
    handlePrintClose()
    executePrint(previewFile, settings)
  }, [previewFile, settings, executePrint, handlePrintClose])

  // ── PDF 导出弹窗状态 ──
  const [showPdfExport, setShowPdfExport] = useState(false)

  // ── Excel 导出字段确认弹窗状态（Commit 4A） ──
  const [showExcelFields, setShowExcelFields] = useState(false)

  // ── 压缩包导出确认弹窗状态 ──
  const [showPackConfirm, setShowPackConfirm] = useState(false)

  const {
    packing, packProgress, packResult, setPackResult, setPacking,
    renamePreviewVisible, setRenamePreviewVisible,
    renamePreviewFiles, renameResult, setRenameResult,
    renamedPreviewKey,
    alertModal: renamePackAlert, closeAlert: closeRenamePackAlert,
    handleRename, handleRenameConfirm, handlePack,
  } = useRenamePack({ files, settings, setFiles, parseFiles, electronAPIRef })

  const handleRenameCancel = useCallback(() => {
    setRenamePreviewVisible(false)
  }, [])

  const handleRenameCloseResult = useCallback(() => {
    setRenameResult(null)
    setRenamePreviewVisible(false)
  }, [])

  // ============================
  // 跨 hook 的简单操作
  // ============================
  // ✅ 用 ref 保存最新 files / previewFile，避免 removeFile 因 files 变化反复重建身份，
  // 进而避免传给 React.memo(Sidebar) 的 removeFile 频繁变动导致 Sidebar 不必要重渲染（M8）。
  // removeFile 在调用时读取 ref.current，始终拿到最新值，行为与闭包捕获 files 一致。
  const filesRef = useRef(files)
  filesRef.current = files
  const previewFileRef = useRef(previewFile)
  previewFileRef.current = previewFile

  // ── 重命名完成后，重新导入（预览）该发票 ──
  // 根因：重命名把新文件追加、再删除旧文件；usePreview 的自动导航只会跳到 files[0]，
  // 批量重命名时那不是被重命名的文件 → 预览停留在骨架屏（contentReady=false，
  // 用 paperLayout.displayRect 兜底 → 容器被撑得特别大）。此处用重命名时记录的 key，
  // ── 用 ref 打破 handlePreview 的依赖闭环 ──
  const handlePreviewRef = useRef(handlePreview)
  useEffect(() => { handlePreviewRef.current = handlePreview }, [handlePreview])

  // 在最新 files 状态里取出「已解析、带 docId」的对象重新导入，保证 Render Engine 预览正确。
  useEffect(() => {
    if (!renameResult?.success || !renamedPreviewKey) return
    const f = filesRef.current.find(x => x.key === renamedPreviewKey)
    if (f && f.status === 'parsed') {
      skipAutoNavRef.current = true
      handlePreviewRef.current(f)
    }
  }, [renameResult, renamedPreviewKey, skipAutoNavRef])

  const removeFile = useCallback((key) => {
    // 先找到当前预览文件在列表中的位置（读取 ref 中的最新 files / previewFile）
    const liveFiles = filesRef.current
    const livePreview = previewFileRef.current
    const currentIndex = livePreview ? liveFiles.findIndex(f => f.key === livePreview.key) : -1
    const isPreviewing = livePreview && livePreview.key === key

    if (isPreviewing) {
      cleanupPreviewUrl()
    }

    // ✅ 删除文件时清理预览缓存（释放 Blob/Uint8Array 内存）
    clearFilePreviewCache(key)

    // 计算下一个要预览的文件（在 setFiles 之前计算，避免在 updater 中执行副作用）
    let nextPreviewFile = null
    if (isPreviewing) {
      if (currentIndex > 0) {
        nextPreviewFile = liveFiles[currentIndex - 1]
      } else if (liveFiles.length > 1) {
        nextPreviewFile = liveFiles.find(f => f.key !== key)
      }
    }

    setFiles((prev) => prev.filter((f) => f.key !== key))

    if (nextPreviewFile) {
      // ✅ 直接在 React 18 批处理中调用 handlePreview，移除 setTimeout hack
      // skipAutoNavRef 阻止 usePreview 的自动导航 useEffect 重复触发
      skipAutoNavRef.current = true
      handlePreview(nextPreviewFile)
    }
  }, [cleanupPreviewUrl, handlePreview, skipAutoNavRef, clearFilePreviewCache])

  const clearFiles = useCallback(() => {
    setFiles([])
    cleanupPreviewUrl()
    setPreviewFile(null)
    clearPrintState()
    // ✅ 清空所有预览缓存
    clearAllPreviewCache()
  }, [cleanupPreviewUrl, clearPrintState, clearAllPreviewCache])

  // ── Step 10.6: Display Lifecycle Cleanup ─────────────────────
  // 展示状态生命周期必须跟随 selection 生命周期释放。
  //
  // 问题背景：removeFile 删除"正在预览的最后一个文件"或"分组删除多页发票"时，
  // nextPreviewFile 计算基于删除前的快照，可能为 null 或指向同样将被删除的分页，
  // 导致 files=[] 但 previewFile 仍持有旧文件 → 空状态页上残留旧 viewer。
  //
  // 反应式修复：只要 previewFile 的 key 不再存在于 files（任何删除路径），
  // 立即释放展示状态。DocumentViewer 随 previewFile=null 卸载（ViewerState
  // 是 useState，卸载即丢弃，无需手动 reset）。
  useEffect(() => {
    if (!previewFile) return
    if (files.some((f) => f.key === previewFile.key)) return
    cleanupPreviewUrl()
    setPreviewFile(null)
  }, [files, previewFile, cleanupPreviewUrl, setPreviewFile])

  // DocumentStore 生命周期 GC：files 中无任何文件引用的 docId → 回收 Document。
  // 覆盖单删/分组删/清空/删失败文件等全部路径，防止 Store 残留。
  useEffect(() => {
    const referenced = new Set()
    for (const f of files) {
      const docId = resolveDocId(f)
      if (docId) referenced.add(docId)
    }
    for (const docId of getRegisteredDocIds()) {
      if (!referenced.has(docId)) removeDocument(docId)
    }
  }, [files])

  const removeFailedFiles = useCallback((removeSource = false) => {
    // ✅ 先读取最新列表计算要删除的文件（不在 updater 内做副作用）
    const liveFiles = filesRef.current
    const toRemove = liveFiles.filter(fileObj =>
      fileObj.failedFields?.length ||
      fileObj.parseMethod?.includes('数据缺失') ||
      fileObj.parseMethod?.includes('缺失')
    )
    // ✅ 物理删除源文件（异步，不阻塞 UI）
    if (removeSource && toRemove.length > 0) {
      const paths = toRemove.map(f => f.path).filter(Boolean)
      const ipc = electronAPIRef.current?.ipcRenderer
      if (paths.length > 0 && ipc) {
        ipc.invoke('delete-files', paths).then(res => {
          if (res.failed?.length) {
            console.warn('[removeFailed] 部分文件删除失败:', res.failed)
          }
        }).catch(err => {
          console.error('[removeFailed] 删除源文件出错:', err)
        })
      }
    }
    // 如果正在预览的是被移除的文件，清理预览（auto-nav useEffect 会处理导航）
    const livePreview = previewFileRef.current
    if (livePreview && toRemove.some(f => f.key === livePreview.key)) {
      cleanupPreviewUrl()
    }
    setFiles(prev => prev.filter(fileObj =>
      !fileObj.failedFields?.length &&
      !fileObj.parseMethod?.includes('数据缺失') &&
      !fileObj.parseMethod?.includes('缺失')
    ))
  }, [cleanupPreviewUrl])

  const removeDuplicateFiles = useCallback((removeSource = false) => {
    // ✅ D1：重复检测以 document 为单位——先把页聚合成 document，再按 invoiceNumber 分组。
    //    删除重复 = 删除组内非首个 document 的全部页（不能按页删，否则多页发票被截断）。
    const liveFiles = filesRef.current
    const { duplicateGroups } = buildDocumentViewModel(liveFiles)
    const duplicateKeys = new Set()
    const pathsToDelete = []
    duplicateGroups.forEach((dupDocs) => {
      dupDocs.forEach((doc, idx) => {
        if (idx > 0) {
          for (const page of documentPages(doc)) {
            duplicateKeys.add(page.key)
            if (removeSource && page.path) pathsToDelete.push(page.path)
          }
        }
      })
    })
    // ✅ 物理删除源文件（异步，不阻塞 UI）
    if (pathsToDelete.length > 0) {
      const ipc = electronAPIRef.current?.ipcRenderer
      if (ipc) {
        ipc.invoke('delete-files', pathsToDelete).then(res => {
          if (res.failed?.length) {
            console.warn('[removeDup] 部分文件删除失败:', res.failed)
          }
        }).catch(err => {
          console.error('[removeDup] 删除源文件出错:', err)
        })
      }
    }
    // 如果正在预览的是被移除的文件，清理预览（auto-nav useEffect 会处理导航）
    const livePreview = previewFileRef.current
    if (livePreview && duplicateKeys.has(livePreview.key)) {
      cleanupPreviewUrl()
    }
    setFiles(prev => prev.filter(fileObj => !duplicateKeys.has(fileObj.key)))
  }, [cleanupPreviewUrl])

  const removePreviousYearFiles = useCallback((removeSource = false) => {
    // ✅ 先读取最新列表计算往年发票集合（不在 updater 内做副作用）
    const liveFiles = filesRef.current
    const prevYearInfo = getPreviousYearInfo(liveFiles)
    const prevYearKeys = new Set()
    const pathsToDelete = []
    prevYearInfo.forEach((info, key) => {
      if (info.isPreviousYear) {
        prevYearKeys.add(key)
        if (removeSource) {
          const f = liveFiles.find(x => x.key === key)
          if (f?.path) pathsToDelete.push(f.path)
        }
      }
    })
    // ✅ 物理删除源文件（异步，不阻塞 UI）
    if (pathsToDelete.length > 0) {
      const ipc = electronAPIRef.current?.ipcRenderer
      if (ipc) {
        ipc.invoke('delete-files', pathsToDelete).then(res => {
          if (res.failed?.length) {
            console.warn('[removePrevYear] 部分文件删除失败:', res.failed)
          }
        }).catch(err => {
          console.error('[removePrevYear] 删除源文件出错:', err)
        })
      }
    }
    // 如果正在预览的是被移除的文件，清理预览（auto-nav useEffect 会处理导航）
    const livePreview = previewFileRef.current
    if (livePreview && prevYearKeys.has(livePreview.key)) {
      cleanupPreviewUrl()
    }
    setFiles(prev => prev.filter(fileObj => {
      const info = prevYearInfo.get(fileObj.key)
      return !(info && info.isPreviousYear)
    }))
  }, [cleanupPreviewUrl])

  // ============================
  // mergeMode 同步到 FileContext（用于 printableCount 合并调整）
  // ============================
  useEffect(() => {
    setMergeMode(settings.mergeMode)
  }, [settings.mergeMode, setMergeMode])

  // ============================
  // 合并模式：箭头禁用状态
  // ============================
  // 文件位置索引（O(n) 构建一次，O(1) 查询）
  // 通过结构键守卫避免 status-only 更新触发重建（Phase 0.5）
  const fileIndexMap = useFileIndexMap(files)

  // ✅ 合并 isFirst/isLast 为单次 useMemo：用 fileIndexMap 做 O(1) 查找 + getMergeGroupStart 直接算组边界，
  // 避免原实现两次调用 getMergePair（每次 O(n) 遍历 files）。
  // 语义等价：getMergePair 的 pair[0] 即 files[groupStart]，故 fileIndexMap.get(key) 经 getMergeGroupStart 即为原 firstFileIdx。
  // Deps 已收窄：移除 files（过宽），改用 fileIndexMap.size 替代 files.length（Phase 0.5）
  const { isFirstMergeGroup, isLastMergeGroup } = useMemo(() => {
    if (!previewFile || !isMergeMode(settings.mergeMode)) {
      return { isFirstMergeGroup: false, isLastMergeGroup: false }
    }
    const groupSize = parseInt(settings.mergeMode?.replace('merge', '')) || 2
    const idx = fileIndexMap.get(previewFile.key) ?? -1
    if (idx === -1) return { isFirstMergeGroup: false, isLastMergeGroup: false }
    const groupStart = getMergeGroupStart(idx, groupSize)
    return {
      isFirstMergeGroup: groupStart - groupSize < 0,
      isLastMergeGroup: groupStart + groupSize >= fileIndexMap.size,
    }
  }, [previewFile?.key, settings.mergeMode, fileIndexMap])

  const currentIndex = previewFile ? fileIndexMap.get(previewFile.key) ?? -1 : -1

  const isPrevDisabled = isMergeMode(settings.mergeMode)
    ? isFirstMergeGroup
    : currentIndex <= 0

  const isNextDisabled = isMergeMode(settings.mergeMode)
    ? isLastMergeGroup
    : currentIndex >= fileIndexMap.size - 1

  // 合并模式下方向由 renderers 强制造纸，用户不可调（2/3 票强制竖向、4 票强制横向）
  const mergeActive = isMergeMode(settings.mergeMode)
  const displayOrientation = mergeActive
    ? (getForcedLandscape(settings.mergeMode, false) ? 'landscape' : 'portrait')
    : paperOrientation

  // ============================
  // 导出（useExport hook）
  // 内聚 ~90 行 SSE 流式导出 + 状态管理
  // ============================
  const {
    exporting, exportProgress, exportResult, exportAlert,
    closeExportAlert,
    handleExportExcel,
    handleExportPdf,
    pdfExportTask,
    cancelPdfExport,
    closePdfExportTask,
  } = useExport({ files, electronAPIRef, previewState: preview.state, settings })

  // 打开 Excel 字段确认弹窗：无已解析发票时复用 handleExportExcel 的无数据告警
  const openExcelFields = useCallback(() => {
    const parsed = files.filter((f) => f.status === 'parsed')
    if (parsed.length === 0) {
      handleExportExcel()
      return
    }
    setShowExcelFields(true)
  }, [files, handleExportExcel])

  // 打开压缩包导出确认弹窗：无已解析文件时复用 handlePack 的无数据告警
  const openPackConfirm = useCallback(() => {
    const parsed = files.filter((f) => f.status === 'parsed')
    if (parsed.length === 0) {
      handlePack()
      return
    }
    setShowPackConfirm(true)
  }, [files, handlePack])

  const { clearExportSession } = useExportSession()

  const handleSelectAll = useCallback(() => {
    const parsed = files.filter(f => f.status === 'parsed')
    if (parsed.length > 0) handlePreview(parsed[0])
  }, [files, handlePreview])

  // ============================
  // Alert 队列管理（抽为独立 hook）
  // ============================
  const {
    currentAlert,
    showAlert,
    dismissWithCleanup,
  } = useAlertQueue()

  // ============================
  // Alert 桥接：合并三个 hook 的 alert → 队列（去重由 showAlert 内部按 source 处理）
  // ============================
  useEffect(() => {
    const entries = [
      { alert: renamePackAlert, source: 'renamePack', onClose: closeRenamePackAlert },
      { alert: exportAlert,     source: 'export',     onClose: closeExportAlert },
      { alert: printAlert,      source: 'print',      onClose: closePrintAlert },
    ]
    for (const { alert, source, onClose } of entries) {
      if (alert?.visible) {
        showAlert(alert.message, alert.title || '提示', alert.type || 'warning', onClose, source)
      }
    }
  }, [renamePackAlert?.visible, exportAlert?.visible, printAlert?.visible])

  // ============================
  // 键盘快捷键
  // ============================
  const handleDeleteCurrent = useCallback(() => {
    if (previewFile) {
      removeFile(previewFile.key)
    }
  }, [previewFile, removeFile])

  const handleEscape = useCallback(() => {
    // 关闭队列中的 alert
    if (currentAlert) {
      dismissWithCleanup()
      return
    }
    if (renamePreviewVisible) {
      setRenamePreviewVisible(false)
      return
    }
    // ESC 不再退出预览
  }, [currentAlert, dismissWithCleanup, renamePreviewVisible, setRenamePreviewVisible])

  useKeyboardShortcuts({
    onPrevFile: handlePrevFile,
    onNextFile: handleNextFile,
    onPrint: onCtrlP,
    onDelete: handleDeleteCurrent,
    onEscape: handleEscape,
    onOpenCalculator: openCalculator,
  })

  // ============================
  // Electron 初始化
  // ============================
  useEffect(() => {
    const api = getElectronAPI()
    electronAPIRef.current = api
    const ipc = api?.ipcRenderer

    if (ipc) {
      ipc.invoke('load-print-settings').then((saved) => {
        if (saved) setSettings((prev) => ({ ...prev, ...saved }))
      })
      ipc.invoke('get-printers').then((list) => {
        if (Array.isArray(list) && list.length > 0) {
          setPrinters(list)
          setSettings((prev) => {
            if (!prev.printerName) return { ...prev, printerName: list[0] }
            return prev
          })
        }
      })

      const handleProgress = (_event, data) => {
        // 先取"上一次已提交"的进度快照用于判定 wasDone（更新 ref 镜像前）
        const prevProgress = progressMapRef.current
        const existed = prevProgress[data.key]
        const wasDone = existed && (existed.status === 'done' || existed.status === 'error')
        const isDone = data.status === 'done' || data.status === 'error'
        const transitionToDone = !wasDone && isDone

        // 更新 ref 镜像为最新（供下次事件判定 wasDone；事件处理器内变更 ref 不受 StrictMode 双调用影响）
        progressMapRef.current = { ...prevProgress, [data.key]: data }

        // ✅ 纯函数 updater：只计算并返回新状态，不修改 ref / 不调度副作用 / 不嵌套 setState
        // （React 18 StrictMode 会双调用 updater；原实现在 updater 内 ++ref / setTimeout / setFiles
        //  会导致计数器重复递增、收尾定时器被重复调度）
        setPrintProgress((prev) => ({ ...prev, [data.key]: data }))

        // ✅ 副作用全部移出 updater —— 每个 IPC 事件只执行一次
        // （事件处理器本身不会被 StrictMode 双调用，故此处计数/调度均唯一）
        if (transitionToDone) {
          completedCountRef.current++
        }

        if (printFilesRef.current.length > 0 && completedCountRef.current >= printFilesRef.current.length) {
          const keys = printFilesRef.current.map((f) => f.key)
          const allOriginalKeys = new Set()
          keys.forEach(k => k.split('+').forEach(part => allOriginalKeys.add(part)))

          clearTimeout(printTimeoutRef.current)
          printTimeoutRef.current = setTimeout(() => {
            setPrinting(false)
            progressMapRef.current = {}
            setPrintProgress({})
            setFiles((prev) => prev.map((f) => allOriginalKeys.has(f.key) ? { ...f, status: 'parsed' } : f))
          }, 1000)
        }
      }
      ipc.on('print-progress', handleProgress)

      const handleSettingsClosed = () => {
        setSettingsWindowOpen(false)
        ipc.invoke('load-print-settings').then((saved) => { if (saved) setSettings(saved) })
      }
      ipc.on('settings-window-closed', handleSettingsClosed)

      // ✅ 实时监听设置变化（尤其是 mergeMode），立即更新预览
      const handleSettingsChanged = (_event, newSettings) => {
        setSettings((prev) => ({ ...prev, ...newSettings }))
      }
      ipc.on('settings-changed', handleSettingsChanged)

      const handleContextMenuFiles = (_event, ctxFiles) => {
        if (!ctxFiles || ctxFiles.length === 0) return
        // 经 buildFileObj 统一构造，确保进入文件系统的 fileObj 携带 identity
        // （context-menu 仅有 {name, path}，无真实 File 对象 → file=null；docId 留空，
        //  待 4.2.1-c parse 阶段由 updateDocumentIdentity 回填）
        const initialFiles = ctxFiles.map((file) => buildFileObj(null, file.name, file.path))
        setFiles((prev) => {
          const existingPaths = new Set(prev.map((f) => f.path || f.printPath || f.name))
          return [...prev, ...initialFiles.filter((f) => !existingPaths.has(f.path || f.printPath || f.name))]
        })
        parseFiles(initialFiles)
      }
      ipc.on('context-menu-files', handleContextMenuFiles)

      return () => {
        ipc.removeListener('print-progress', handleProgress)
        ipc.removeListener('settings-window-closed', handleSettingsClosed)
        ipc.removeListener('settings-changed', handleSettingsChanged)
        ipc.removeListener('context-menu-files', handleContextMenuFiles)
        clearTimeout(printTimeoutRef.current)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // 空依赖数组是安全的：所有 handler 内部只使用 ref（progressMapRef、completedCountRef 等，引用稳定）
  // 和 setState 函数式更新（setSettings(prev=>...)、setFiles(prev=>...) 等，引用稳定），
  // 不存在过期闭包风险。IPC 监听器应仅在挂载时注册一次。
  }, [])

  // ============================
  // 设置窗口模式
  // ============================
  useEffect(() => {
    if (!isSettingsWindow) return
    const api = getElectronAPI()
    const ipc = api?.ipcRenderer
    if (!ipc) return
    ipc.invoke('load-print-settings').then((saved) => { if (saved) setSettings(saved) })
    ipc.invoke('get-printers').then((list) => {
      if (Array.isArray(list) && list.length > 0) setPrinters(list)
    })
  },       [isSettingsWindow, setSettings, setPrinters])

  // ============================
  // 自动预览：只在文件从空变非空时触发（导入场景）
  // 删除文件由 removeFile 自行处理预览逻辑
  // ============================
  const prevFilesLengthRef = useRef(0)
  useEffect(() => {
    // 文件数量增加（导入），且当前没有预览文件
    if (files.length > prevFilesLengthRef.current && !previewFile) {
      handlePreview(files[0])
    }
    prevFilesLengthRef.current = files.length
  }, [files.length, previewFile])

  if (isSettingsWindow) {
    return (
      <Suspense fallback={<div></div>}>
        <SettingsWindow settings={settings} saveSettings={saveSettings} printers={printers} electronAPI={getElectronAPI()} />
      </Suspense>
    )
  }

  if (isCalculatorWindow) {
    return (
      <Suspense fallback={<div></div>}>
        <CalculatorWindow />
      </Suspense>
    )
  }

  // ============================
  // Render
  // ============================
  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <Sidebar
        parsing={parsing}
        parseProgress={parseProgress}
        previewFile={previewFile}
        paperSize={settings.mergeMode || 'none'}
        fileRotations={fileRotations}
        // drag
        isNativeDragActive={isNativeDragActive}
        handleNativeDrop={handleNativeDrop}
        handleNativeDragOver={handleNativeDragOver}
        handleNativeDragLeave={handleNativeDragLeave}
        getRootProps={getRootProps}
        getInputProps={getInputProps}
        isDragActive={isDragActive}
        // actions
        handleOpenDialog={handleOpenDialog}
        handleOpenFolder={handleOpenFolder}
        handlePreview={handlePreview}
        handleHoverFile={preloadHD}
        removeFile={removeFile}
        clearFiles={clearFiles}
        removeFailedFiles={removeFailedFiles}
        removeDuplicateFiles={removeDuplicateFiles}
        removePreviousYearFiles={removePreviousYearFiles}
        handleRotate={handleRotate}
        // sort
        sortBy={sortBy}
        sortOrder={sortOrder}
        toggleSort={toggleSort}
      />

      <main className="main">
        {/* 1. Header：计算器、菜单、设置、窗口控制 */}
        <TopBar
          extraSpecial={settings.extraSpecial}
          paperSize={settings.paperSize}
          landscape={settings.landscape}
          previewFile={previewFile}
          previewPage={previewPage}
          numPages={numPages}
          prevPage={prevPage}
          nextPage={nextPage}
          openSettings={openSettings}
          onSettingsChange={updateSettings}
          onRotate={handleRotate}
          previewRotation={previewRotation}
          openCalculator={openCalculator}
        />

        {/* 2. Control：缩放工具栏 */}
        {previewFile && (
          <div className="control-bar">
            <div className="canvas-zoom-control">
              <button className="tb-btn" onClick={() => {
                const current = files.find(f => f.key === previewFile.key)
                setDetailFile(current || previewFile)
              }} title="查看/编辑发票字段">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <div className="cz-separator" />
              {/* D2-4.1：DocumentViewer 激活且 controller 就绪 → ZoomToolbar（状态源 useViewerState，
                  经 controller 桥接上抬）；否则 legacy 缩放控件（图片/OFD 路径）。
                  controller 空窗期（document 已注册但桥接未上报）回退 legacy，避免 null 崩溃。 */}
              {documentViewerActive && viewerController ? (
                <ZoomToolbar state={viewerController} actions={viewerController.actions} />
              ) : (
              <>
              <button className="tb-btn" onClick={zoomOut} title="缩小">
                <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
              </button>
              <div className="sort-dropdown-container" ref={zoomDropdownRef}>
                <button className="tb-zoom-trigger" onClick={() => setZoomMenuOpen(!zoomMenuOpen)}>
                  {zoomMode === 'adaptive' ? '自适应' : `${Math.round(zoomPercent)}%`}
                </button>
                {(zoomMenuOpen || zoomMenuClosing) && (
                  <div className={`sort-dropdown zoom-dropdown ${zoomMenuClosing ? 'closing' : ''}`}>
                    <div className="sort-dropdown-header">缩放比例</div>
                    <button
                      className={`sort-dropdown-item ${zoomMode === 'adaptive' ? 'active' : ''}`}
                      onClick={() => { setAdaptive(); handleCloseZoomMenu() }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ width: '16px', height: '16px' }}>
                        <rect x="2" y="2" width="20" height="20" rx="2"/>
                        <path d="M2 15l5-5 4 4 4-4 7 7"/>
                      </svg>
                      自适应
                      {zoomMode === 'adaptive' && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 'auto', width: '14px', height: '14px' }}>
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>
                    <div className="zoom-dropdown-divider"></div>
                    <div style={{ padding: '6px 12px', fontSize: '12px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
                      当前：{Math.round(zoomPercent)}%
                    </div>
                    {ZOOM_STEPS.map(s => (
                      <button
                        key={s}
                        className={`sort-dropdown-item ${zoomMode === 'manual' && zoomPercent === s ? 'active' : ''}`}
                        onClick={() => { setManualScale(s); handleCloseZoomMenu() }}
                      >
                        {s}%
                        {zoomMode === 'manual' && zoomPercent === s && (
                          <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 'auto', width: '14px', height: '14px' }}>
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button className="tb-btn" onClick={zoomIn} title="放大">
                <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
              </button>
              </>
              )}
            </div>

            <div className="canvas-orient-control">
              <div className="oco-segment">
                <button className={`oco-btn ${(!mergeActive && autoActive) ? 'active' : ''}`} onClick={() => handlePaperOrientationChange('auto')} title="自动方向" disabled={mergeActive}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10l2 2M5 19l2-2m10-10l2-2"/>
                  </svg>
                  自动
                </button>
                <button className={`oco-btn ${displayOrientation === 'landscape' ? 'active' : ''}`} onClick={() => handlePaperOrientationChange('landscape')} title="横向" disabled={mergeActive}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="7" width="18" height="10" rx="1.5"/>
                  </svg>
                  横向
                </button>
                <button className={`oco-btn ${displayOrientation === 'portrait' ? 'active' : ''}`} onClick={() => handlePaperOrientationChange('portrait')} title="纵向" disabled={mergeActive}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="6.5" y="3" width="11" height="18" rx="1.5"/>
                  </svg>
                  纵向
                </button>
              </div>
              <div className="oco-divider" />
              <button className="oco-rotate" onClick={() => handleRotate()} title={`旋转 (${previewRotation}°)`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 11-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
                  <path d="M21 3v5h-5"/>
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* 3. Canvas：预览内容区 */}
        <div
          className="canvas"
          onMouseMove={handleCanvasMouseMove}
          onMouseLeave={handleCanvasMouseLeave}
        >
          {(() => {
            // 空状态：无预览文件
            if (!previewFile) {
              return (
                <div className="canvas-center-overlay canvas-empty">
                  <img src={`${PUBLIC_BASE}icon/waiting.svg`} alt="等待预览" width="240" height="100" />
                  <p className="canvas-empty-title">左侧添加文件以预览</p>
                  <p className="canvas-empty-sub">支持 PDF、OFD、图片格式的发票文件</p>
                </div>
              )
            }

            // OFD 不支持预览
            if (previewFile._fileFormat === 'ofd' && !previewFile._previewImageUrl) {
              return <div className="canvas-center-overlay canvas-loading">OFD 文件不支持预览</div>
            }

            // 加载中：有预览文件但渲染尚未就绪
            // 新展示路径（DocumentViewer）自行管理加载态，跳过 legacy 遮罩
            const hasPreview = !!previewCanvas || !!previewUrl;
            if (!activeDocument && (!contentLayout?.ready || !hasPreview)) {
              if (previewCanvas && !contentLayout?.ready) {
                return (
                  <div className="canvas-center-overlay canvas-loading" style={{ gap: '10px' }}>
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ opacity: 0.5 }}>
                      <rect x="2" y="3" width="20" height="14" rx="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                      <line x1="2" y1="9" x2="22" y2="9" />
                      <line x1="3" y1="13" x2="5" y2="13" />
                      <line x1="19" y1="13" x2="21" y2="13" />
                    </svg>
                    <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-2)' }}>
                      预览区域过小
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--text-3)' }}>
                      请收起 DevTools（F12）或放大窗口
                    </span>
                  </div>
                )
              }
              return (
                <div className="canvas-center-overlay canvas-loading">
                  <svg className="canvas-loading-spinner" viewBox="0 0 36 36" fill="none">
                    <circle className="ring-track" cx="18" cy="18" r="15" strokeWidth="3" />
                    <circle cx="18" cy="18" r="15" stroke="currentColor" strokeWidth="3"
                      strokeDasharray="60 100" strokeLinecap="round" />
                  </svg>
                  <span>加载中...</span>
                </div>
              )
            }

            return null
          })()}

          {/* 滚动层：ref 绑定在这里 */}
          <div ref={previewContainerRef} className="canvas-scroll">
            {/* Display Area Refactor Step 10：双轨展示适配器。
                已注册 InvoiceDocument → DocumentViewer（新路径）；
                否则 → PreviewCanvas（legacy，保留一个版本周期）。 */}
            <DisplayAdapter
              file={previewFile}
              containerSize={containerSize}
              grayscale={settings.grayscale}
              onViewerController={setViewerController}
              previewCanvas={previewCanvas}
              previewUrl={previewUrl}
              previewRenderVersion={previewRenderVersion}
              paperLayout={paperLayout}
              contentLayout={contentLayout}
              previewRotation={previewRotation}
              previewLoading={previewLoading}
            />
          </div>

          {/* 翻页箭头（浮于 canvas 内两侧） */}
          {previewFile && files.length > 1 && (
            <>
              {showLeftArrow && (
                <button
                  className="canvas-arrow canvas-arrow-left"
                  onClick={handlePrevFile}
                  title="上一张"
                  disabled={isPrevDisabled}
                  aria-hidden={isPrevDisabled}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
              )}
              {showRightArrow && (
                <button
                  className="canvas-arrow canvas-arrow-right"
                  onClick={handleNextFile}
                  title="下一张"
                  disabled={isNextDisabled}
                  aria-hidden={isNextDisabled}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </button>
              )}
            </>
          )}
        </div>

        {/* 4. Status：状态指示器 */}
        <div className="status-bar">
          <StatusIndicator
            paperSize={settings.paperSize}
            landscape={settings.landscape}
            extraSpecial={settings.extraSpecial}
          />
        </div>

        {/* 5. Footer：总金额+操作按钮 */}
        <ActionBar
          handleRename={handleRename}
          handlePack={handlePack}
          onExportZip={openPackConfirm}
          handlePrint={handlePrint}
          packing={packing}
          packProgress={packProgress}
          printing={printing}
          removeFailedFiles={removeFailedFiles}
          onExportExcel={openExcelFields}
          onExportPdf={() => setShowPdfExport(true)}
          exporting={exporting}
        />
      </main>

      {/* 弹窗组件 - 单一 Suspense 边界包裹所有懒加载弹窗，减少 fallback 重复渲染 */}
      <Suspense fallback={<ModalFallback />}>
        <ImportProgressModal
          importing={importing}
          parsing={parsing}
          parseProgress={parseProgress}
        />
        <PrintProgressModal
          printing={printing}
          printFiles={printFiles}
          printProgress={printProgress}
          onClose={handlePrintClose}
        />
        {renamePreviewVisible && (
          <RenamePreviewModal
            visible
            files={renamePreviewFiles}
            executing={packing}
            result={renameResult}
            onConfirm={handleRenameConfirm}
            onCancel={handleRenameCancel}
            onCloseResult={handleRenameCloseResult}
          />
        )}
        <PackProgressModal
          visible={packing || packResult !== null}
          progress={packProgress}
          result={packResult}
          onCancel={() => { setPacking(false); setPackResult(null) }}
          onClose={() => { setPacking(false); setPackResult(null) }}
        />
        <ExportProgressModal
          visible={exporting || exportResult !== null}
          progress={exportProgress}
          result={exportResult}
          onCancel={clearExportSession}
          onClose={clearExportSession}
        />
        <AlertModal
          visible={!!currentAlert}
          title={currentAlert?.title || '提示'}
          message={currentAlert?.message || ''}
          type={currentAlert?.type || 'warning'}
          onClose={dismissWithCleanup}
        />
        <PrintConfirmModal
          visible={!!printConfirmModal}
          settings={settings}
          saveSettings={saveSettings}
          printers={printers}
          totalFiles={printableCount}
          mergeMode={isMergeMode(settings.mergeMode)}
          isOneNormalTwoSpecial={settings.extraSpecial || false}
          paperOrientation={paperOrientation}
          contentRotation={previewRotation}
          onConfirm={onPrintConfirm}
          onCancel={handlePrintCancel}
          onSettingsChange={updateSettings}
        />
        <PdfExportConfirmModal
          visible={showPdfExport}
          files={files.filter(f => f.status === 'parsed')}
          onConfirm={(config) => {
            setShowPdfExport(false)
            handleExportPdf(config)
          }}
          onCancel={() => setShowPdfExport(false)}
        />
        <ExcelExportFieldsModal
          visible={showExcelFields}
          files={files.filter(f => f.status === 'parsed')}
          initialColumns={excelExportSettings.columns}
          onPersist={excelExportSettings.persist}
          onConfirm={(cols) => {
            setShowExcelFields(false)
            handleExportExcel(cols)
          }}
          onCancel={() => setShowExcelFields(false)}
        />
        <PackConfirmModal
          visible={showPackConfirm}
          settings={settings}
          saveSettings={saveSettings}
          parsedFiles={files.filter(f => f.status === 'parsed')}
          onConfirm={() => {
            setShowPackConfirm(false)
            handlePack()
          }}
          onCancel={() => setShowPackConfirm(false)}
        />
        <TaskProgressModal
          visible={!!pdfExportTask}
          title="正在导出PDF"
          current={pdfExportTask?.current ?? 0}
          total={pdfExportTask?.total ?? 0}
          percent={pdfExportTask?.percent}
          currentFile={pdfExportTask?.currentFile ?? ''}
          stage={pdfExportTask?.stage ?? ''}
          status={pdfExportTask?.status}
          errors={pdfExportTask?.errors ?? []}
          onCancel={cancelPdfExport}
          onClose={closePdfExportTask}
        />
      </Suspense>

      {detailFile && (
        <InvoiceDetail
          fileObj={detailFile}
          onClose={() => setDetailFile(null)}
        />
      )}

    </div>
  )
}

export default App
