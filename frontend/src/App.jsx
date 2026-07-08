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

import { PREVIEW_DPI, SUPPORTED_EXTENSIONS, ZOOM_STEPS } from './config'
import {
  getElectronAPI, getFilePath, getFileFormat, isMergeMode, getMergePair,
  detectDuplicateInvoices,
} from './utils'
import { generateFileKey } from './utils/fileHelpers'

import { useSettings } from './hooks/useSettings'
import { useSort } from './hooks/useSort'
import { usePreview } from './hooks/usePreview'
import { useFileOps } from './hooks/useFileOps'
import { usePrint } from './hooks/usePrint'
import { usePrintIntent } from './hooks/usePrintIntent'
import { useRenamePack } from './hooks/useRenamePack'
import { useExport } from './hooks/useExport'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useAlertQueue } from './hooks/useAlertQueue'

import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import PreviewCanvas from './components/PreviewCanvas'
import StatusIndicator from './components/StatusIndicator'
import ActionBar from './components/ActionBar'
import InvoiceDetail from './components/InvoiceDetail'

// PrintProgressModal, RenamePreviewModal, PackProgressModal, AlertModal 已懒加载

const ModalFallback = () => (
  <div className="modal-overlay" style={{ zIndex: 1000 }}>
    <div className="canvas-loading-spinner" />
  </div>
);

function App() {
  return (
    <FileProvider>
      <AppContent />
    </FileProvider>
  )
}

function AppContent() {
  const isSettingsWindow = window.location.hash === '#/settings'
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

  const {
    sortBy, sortOrder, toggleSort, sortByRef, sortOrderRef,
  } = useSort(setFiles)

  const preview = usePreview({ files, settings, electronAPIRef })
  // ✅ 从正确的分组中解构属性
  const {
    previewFile, mergePair, numPages, previewPage, previewCanvas,
    previewUrl,
    previewRenderVersion,
    previewRotation, fileRotations, showLeftArrow, showRightArrow,
    displayInfo,
  } = preview.state
  const {
    handlePreview, preloadHD, handleRotate, prevPage, nextPage,
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
    printProgressRef, printTimeoutRef, printFilesRef, completedCountRef,
    handlePrint, handlePrintClose, clearPrintState, setPrinting, setPrintProgress,
    alertModal: printAlert, closeAlert: closePrintAlert,
    printConfirmModal, handlePrintCancel,
    executePrint,  // Step 3.2: 唯一打印执行入口
  } = usePrint({ files, settings, fileRotations, setFiles, electronAPIRef, submitPrintIntent })

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

  const {
    packing, packProgress, packResult, setPackResult, setPacking,
    renamePreviewVisible, setRenamePreviewVisible,
    renamePreviewFiles, renameResult, setRenameResult,
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
  const removeFile = useCallback((key) => {
    // 先找到当前预览文件在列表中的位置
    const currentIndex = previewFile ? files.findIndex(f => f.key === previewFile.key) : -1
    const isPreviewing = previewFile && previewFile.key === key

    if (isPreviewing) {
      cleanupPreviewUrl()
    }

    // ✅ 删除文件时清理预览缓存（释放 Blob/Uint8Array 内存）
    clearFilePreviewCache(key)

    // 计算下一个要预览的文件（在 setFiles 之前计算，避免在 updater 中执行副作用）
    let nextPreviewFile = null
    if (isPreviewing) {
      if (currentIndex > 0) {
        nextPreviewFile = files[currentIndex - 1]
      } else if (files.length > 1) {
        nextPreviewFile = files.find(f => f.key !== key)
      }
    }

    setFiles((prev) => prev.filter((f) => f.key !== key))

    if (nextPreviewFile) {
      // ✅ 直接在 React 18 批处理中调用 handlePreview，移除 setTimeout hack
      // skipAutoNavRef 阻止 usePreview 的自动导航 useEffect 重复触发
      skipAutoNavRef.current = true
      handlePreview(nextPreviewFile)
    }
  }, [previewFile, files, cleanupPreviewUrl, handlePreview, skipAutoNavRef, clearFilePreviewCache])

  const clearFiles = useCallback(() => {
    setFiles([])
    cleanupPreviewUrl()
    setPreviewFile(null)
    clearPrintState()
    // ✅ 清空所有预览缓存
    clearAllPreviewCache()
  }, [cleanupPreviewUrl, clearPrintState, clearAllPreviewCache])

  const removeFailedFiles = useCallback(() => {
    setFiles(prev => {
      const filtered = prev.filter(fileObj =>
        !fileObj.failedFields?.length &&
        !fileObj.parseMethod?.includes('数据缺失') &&
        !fileObj.parseMethod?.includes('缺失')
      )
      // ✅ 移除 updater 内副作用 — usePreview 的 auto-nav useEffect 会在
      // previewFile 被移除时自动处理导航和清理
      return filtered
    })
  }, [])

  const removeDuplicateFiles = useCallback(() => {
    setFiles(prev => {
      const duplicates = detectDuplicateInvoices(prev)
      const duplicateKeys = new Set()
      duplicates.forEach((dupFiles) => {
        dupFiles.forEach((file, idx) => {
          if (idx > 0) {
            duplicateKeys.add(file.key)
          }
        })
      })
      // ✅ 移除 updater 内副作用 — usePreview 的 auto-nav useEffect 会自动处理
      return prev.filter(fileObj => !duplicateKeys.has(fileObj.key))
    })
  }, [])

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
  const fileIndexMap = useMemo(() => {
    const map = new Map()
    files.forEach((f, i) => map.set(f.key, i))
    return map
  }, [files])

  const isFirstMergeGroup = useMemo(() => {
    if (!previewFile || !isMergeMode(settings.mergeMode)) return false
    const groupSize = parseInt(settings.mergeMode?.replace('merge', '')) || 2
    const pair = getMergePair(files, previewFile.key, groupSize)
    if (!pair || pair.length === 0) return false
    const firstFileIdx = fileIndexMap.get(pair[0].key) ?? -1
    return firstFileIdx - groupSize < 0
  }, [previewFile, files, settings.mergeMode])

  const isLastMergeGroup = useMemo(() => {
    if (!previewFile || !isMergeMode(settings.mergeMode)) return false
    const groupSize = parseInt(settings.mergeMode?.replace('merge', '')) || 2
    const pair = getMergePair(files, previewFile.key, groupSize)
    if (!pair || pair.length === 0) return false
    const firstFileIdx = fileIndexMap.get(pair[0].key) ?? -1
    return firstFileIdx + groupSize >= files.length
  }, [previewFile, files, settings.mergeMode])

  const currentIndex = previewFile ? fileIndexMap.get(previewFile.key) ?? -1 : -1

  const isPrevDisabled = isMergeMode(settings.mergeMode)
    ? isFirstMergeGroup
    : currentIndex <= 0

  const isNextDisabled = isMergeMode(settings.mergeMode)
    ? isLastMergeGroup
    : currentIndex >= files.length - 1

  // ============================
  // 导出（useExport hook）
  // 内聚 ~90 行 SSE 流式导出 + 状态管理
  // ============================
  const {
    exporting, exportProgress, exportResult, exportAlert,
    closeExportAlert, setExporting, setExportResult, setExportProgress,
    handleExportExcel,
  } = useExport({ files, electronAPIRef })

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
        printProgressRef.current = { ...printProgressRef.current, [data.key]: data }
        setPrintProgress((prev) => {
          const existed = prev[data.key]
          const wasDone = existed && (existed.status === 'done' || existed.status === 'error')
          const isDone = data.status === 'done' || data.status === 'error'
          // ✅ 只有当文件从非完成状态变为完成状态时才递增计数，避免 O(n) 遍历
          if (!wasDone && isDone) {
            completedCountRef.current++
          }

          const newProgress = { ...prev, [data.key]: data }
          const totalFiles = printFilesRef.current.length

          if (totalFiles > 0 && completedCountRef.current >= totalFiles) {
            const keys = printFilesRef.current.map((f) => f.key)
            const allOriginalKeys = new Set()
            keys.forEach(k => { k.split('+').forEach(part => allOriginalKeys.add(part)) })

            clearTimeout(printTimeoutRef.current)
            setTimeout(() => {
              setPrinting(false); printProgressRef.current = {}; setPrintProgress({})
              setFiles((prev) => prev.map((f) => allOriginalKeys.has(f.key) ? { ...f, status: 'parsed' } : f))
            }, 1000)
          }
          return newProgress
        })
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
        const initialFiles = ctxFiles.map((file) => ({
          key: generateFileKey(file.name),
          name: file.name, path: file.path, printPath: file.path,
          status: 'parsing', invoiceType: '', invoiceNumber: '', amount: '',
          invoiceDate: '', newName: '', parseMethod: '',
          fileFormat: getFileFormat(file.name), previewImage: null,
        }))
        setFiles((prev) => {
          const existingPaths = new Set(prev.map((f) => f.path || f.printPath || f.name))
          return [...prev, ...initialFiles.filter((f) => !existingPaths.has(f.path || f.printPath || f.name))]
        })
        parseFiles(initialFiles)
      }
      ipc.on('context-menu-files', handleContextMenuFiles)

      const handleExcelProgress = (_event, data) => {
        setExportProgress(data)
      }
      ipc.on('excel-progress', handleExcelProgress)

      return () => {
        ipc.removeListener('print-progress', handleProgress)
        ipc.removeListener('settings-window-closed', handleSettingsClosed)
        ipc.removeListener('settings-changed', handleSettingsChanged)
        ipc.removeListener('context-menu-files', handleContextMenuFiles)
        ipc.removeListener('excel-progress', handleExcelProgress)
        clearTimeout(printTimeoutRef.current)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
        handleRotate={handleRotate}
        // sort
        sortBy={sortBy}
        sortOrder={sortOrder}
        toggleSort={toggleSort}
      />

      <main className="main">
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
        />

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
                  <img src="/icon/waiting.svg" alt="等待预览" width="240" height="100" />
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
            if (!displayInfo || !previewCanvas) {
              // 区分：预览 canvas 已就绪但容器太小 → 显示友好提示
              if (previewCanvas && !displayInfo) {
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

            // 预览已就绪 — 不渲染 overlay，由下方 scroll 层显示 canvas
            return null
          })()}

          {/* 滚动层：ref 绑定在这里，用于 ResizeObserver 和滚动控制 */}
          <div ref={previewContainerRef} className="canvas-scroll">
            <PreviewCanvas
              previewFile={previewFile}
              displayInfo={displayInfo}
              previewCanvas={previewCanvas}
              previewUrl={previewUrl}
              grayscale={settings.grayscale}
              previewRenderVersion={previewRenderVersion}
            />
          </div>

          {previewFile && (
            <div className="canvas-zoom-control">
              <button className="tb-btn" onClick={() => {
                const current = files.find(f => f.key === previewFile.key)
                setDetailFile(current || previewFile)
              }} title="查看/编辑发票字段">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <div className="cz-separator" />
              <button className="tb-btn" onClick={zoomOut} title="缩小">
                <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
              </button>
              <div className="sort-dropdown-container" ref={zoomDropdownRef}>
                <button className="tb-zoom-trigger" onClick={() => setZoomMenuOpen(!zoomMenuOpen)}>
                  {zoomMode === 'adaptive' ? '自适应' : `${zoomPercent}%`}
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
            </div>
          )}
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
          <StatusIndicator
            paperSize={settings.paperSize}
            landscape={settings.landscape}
            extraSpecial={settings.extraSpecial}
          />
        </div>

        <ActionBar
          handleRename={handleRename}
          handlePack={handlePack}
          handlePrint={handlePrint}
          packing={packing}
          packProgress={packProgress}
          printing={printing}
          removeFailedFiles={removeFailedFiles}
          handleExportExcel={handleExportExcel}
          exporting={exporting}
        />
      </main>

      {/* 弹窗组件 - 懒加载优化 */}
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
      </Suspense>

      <Suspense fallback={<ModalFallback />}>
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
      </Suspense>

      <Suspense fallback={<ModalFallback />}>
        <PackProgressModal
          visible={packing || packResult !== null}
          progress={packProgress}
          result={packResult}
          onCancel={() => { setPacking(false); setPackResult(null) }}
          onClose={() => { setPacking(false); setPackResult(null) }}
        />
      </Suspense>

      <Suspense fallback={<ModalFallback />}>
        <ExportProgressModal
          visible={exporting || exportResult !== null}
          progress={exportProgress}
          result={exportResult}
          onCancel={() => { setExporting(false); setExportResult(null); setExportProgress({ current: 0, total: 0, stage: '' }) }}
          onClose={() => { setExporting(false); setExportResult(null); setExportProgress({ current: 0, total: 0, stage: '' }) }}
        />
      </Suspense>

      <Suspense fallback={<ModalFallback />}>
        <AlertModal
          visible={!!currentAlert}
          title={currentAlert?.title || '提示'}
          message={currentAlert?.message || ''}
          type={currentAlert?.type || 'warning'}
          onClose={dismissWithCleanup}
        />
      </Suspense>

      <PrintConfirmModal
        visible={!!printConfirmModal}
        settings={settings}
        saveSettings={saveSettings}
        printers={printers}
        totalFiles={printableCount}
        mergeMode={isMergeMode(settings.mergeMode)}
        isOneNormalTwoSpecial={settings.extraSpecial || false}
        onConfirm={onPrintConfirm}
        onCancel={handlePrintCancel}
        onSettingsChange={updateSettings}
      />

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
