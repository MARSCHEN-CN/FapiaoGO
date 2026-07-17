import React, { useMemo, useRef, useCallback, useEffect, useState } from 'react'
import { isMergeMode, getDuplicateGroupInfo, getElectronAPI } from '../utils'
import { useFileContext } from '../contexts/FileContext'
import { PUBLIC_BASE } from '../config'
import FileList from './FileList'

function isFailed(fileObj, fieldKey) {
  return fileObj.failedFields?.includes(fieldKey)
}



const ICONS = {
  addFile: <svg viewBox="0 0 48 48" fill="none"><path d="M5 8C5 6.89543 5.89543 6 7 6H19L24 12H41C42.1046 12 43 12.8954 43 14V40C43 41.1046 42.1046 42 41 42H7C5.89543 42 5 41.1046 5 40V8Z" stroke="currentColor" strokeWidth="4" strokeLinejoin="round"/><path d="M18 27H30" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/><path d="M24 21L24 33" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/></svg>,
  addFolder: <svg viewBox="0 0 48 48" fill="none"><path d="M4 9V41L9 21H39.5V15C39.5 13.8954 38.6046 13 37.5 13H24L19 7H6C4.89543 7 4 7.89543 4 9Z" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><path d="M40 41L44 21H8.8125L4 41H40Z" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  dropdownArrow: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>,
  sort: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="16" y2="12"/><line x1="4" y1="18" x2="12" y2="18"/></svg>,
  trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  clear: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  file: <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/></svg>,
  failed: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>,
  check: <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15l-4-4 1.41-1.41L11 14.17l6.59-6.59L19 8l-8 8z"/></svg>,
}

const SORT_OPTIONS = [
  {
    field: 'fileName', label: '文件名',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
  },
  {
    field: 'invoiceType', label: '发票类型',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
  },
  {
    field: 'amount', label: '发票金额',
    icon: <span style={{ fontSize: '16px', fontWeight: '600' }}>￥</span>,
  },
  {
    field: 'invoiceDate', label: '开票日期',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  },
]

export default React.memo(function Sidebar({
  parsing,
  parseProgress,
  previewFile,
  paperSize,
  fileRotations,
  // drag
  isNativeDragActive, handleNativeDrop,
  handleNativeDragOver, handleNativeDragLeave,
  getRootProps, getInputProps, isDragActive,
  // actions
  handleOpenDialog, handleOpenFolder, handlePreview, handleHoverFile, removeFile, clearFiles,
  removeFailedFiles, removeDuplicateFiles, handleRotate,
  // sort
  sortBy, sortOrder, toggleSort,
}) {
  const [removeSourceFile, setRemoveSourceFile] = useState(false)
  const { files, searchQuery, setSearchQuery, filteredFiles, isSearching, totalAmount, hasFailedFiles, failedFilesCount } = useFileContext()
  const mergeActive = isMergeMode(paperSize)

  // ── 排序下拉（纯 UI 状态，不上升到 App 级） ──
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [sortMenuClosing, setSortMenuClosing] = useState(false)
  const sortDropdownRef = useRef(null)

  const handleCloseSortMenu = useCallback(() => {
    if (sortMenuClosing || !sortMenuOpen) return
    setSortMenuClosing(true)
    setTimeout(() => {
      setSortMenuClosing(false)
      setSortMenuOpen(false)
    }, 150)
  }, [sortMenuClosing, sortMenuOpen])

  useEffect(() => {
    if (!sortMenuOpen) return
    const handleClickOutside = (e) => {
      if (sortDropdownRef.current && !sortDropdownRef.current.contains(e.target)) {
        handleCloseSortMenu()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [sortMenuOpen, handleCloseSortMenu])

  // 检测重复发票（getDuplicateGroupInfo 内部已调用 detectDuplicateInvoices）
  const duplicateInfo = useMemo(() => getDuplicateGroupInfo(files), [files])

  // 从 duplicateInfo 直接提取组数，避免重复遍历
  const duplicateGroupCount = useMemo(() => {
    if (duplicateInfo.size === 0) return 0
    const groups = new Set()
    duplicateInfo.forEach(info => groups.add(info.groupIndex))
    return groups.size
  }, [duplicateInfo])

  // ── 统计区动画：仅值变化时触发 countPop ──
  const countDisplay = hasFailedFiles ? failedFilesCount : (duplicateInfo.size > 0 ? duplicateGroupCount : files.length)
  const statsMode = hasFailedFiles ? 'failed' : (duplicateInfo.size > 0 ? 'duplicate' : 'normal')
  const prevStatsRef = useRef({ count: 0, amount: 0, mode: 'normal' })
  const [poppingStats, setPoppingStats] = useState({ count: false, amount: false })
  useEffect(() => {
    const prev = prevStatsRef.current
    const newPops = { count: false, amount: false }
    if (prev.count !== countDisplay || prev.mode !== statsMode) newPops.count = true
    if (prev.amount !== totalAmount) newPops.amount = true
    prevStatsRef.current = { count: countDisplay, amount: totalAmount, mode: statsMode }
    if (newPops.count || newPops.amount) {
      setPoppingStats(newPops)
      const timer = setTimeout(() => setPoppingStats({ count: false, amount: false }), 420)
      return () => clearTimeout(timer)
    }
  }, [countDisplay, totalAmount, statsMode])

  // 添加按钮分裂下拉
  const [addDropdownOpen, setAddDropdownOpen] = useState(false)
  const addDropdownRef = useRef(null)

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (addDropdownRef.current && !addDropdownRef.current.contains(e.target)) {
        setAddDropdownOpen(false)
      }
    }
    if (addDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [addDropdownOpen])

  // 窗口控制 API
  const electronAPI = getElectronAPI()

  // 双击顶部区域最大化/还原窗口
  const handleHeaderDoubleClick = useCallback((e) => {
    if (e.target.closest('.sb-actions')) return
    if (electronAPI?.window?.maximize) {
      electronAPI.window.maximize()
    }
  }, [electronAPI])

  // 自定义窗口拖动（避免 -webkit-app-region 阻止点击事件）
  const isDraggingRef = useRef(false)

  const handleHeaderMouseDown = useCallback((e) => {
    // 只响应左键
    if (e.button !== 0) return
    // 不干扰交互元素
    if (e.target.closest('button, a, input, select, textarea, [role="button"]')) return
    if (e.target.closest('.sort-dropdown, .sort-dropdown-item, .sb-dropdown, .sb-dropdown-item')) return
    // sb-actions 区域不支持拖动
    if (e.target.closest('.sb-actions')) return

    isDraggingRef.current = true

    // 发送 IPC 通知主进程开始拖动（传入鼠标屏幕坐标）
    if (electronAPI?.ipcRenderer) {
      electronAPI.ipcRenderer.send('window-drag-start', {
        screenX: e.screenX,
        screenY: e.screenY,
      })
    }

    e.preventDefault()
  }, [electronAPI])

  const handleHeaderMouseMove = useCallback((e) => {
    if (!isDraggingRef.current) return
    if (!electronAPI?.ipcRenderer) return

    // 发送鼠标屏幕坐标，主进程计算窗口新位置
    electronAPI.ipcRenderer.send('window-drag-move', {
      screenX: e.screenX,
      screenY: e.screenY,
    })
  }, [electronAPI])

  const handleHeaderMouseUp = useCallback(() => {
    if (!isDraggingRef.current) return
    isDraggingRef.current = false

    if (electronAPI?.ipcRenderer) {
      electronAPI.ipcRenderer.send('window-drag-end')
    }
  }, [electronAPI])

  // 绑定 document 级别的 mousemove/mouseup，确保拖出区域后仍能跟踪
  useEffect(() => {
    document.addEventListener('mousemove', handleHeaderMouseMove)
    document.addEventListener('mouseup', handleHeaderMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleHeaderMouseMove)
      document.removeEventListener('mouseup', handleHeaderMouseUp)
    }
  }, [handleHeaderMouseMove, handleHeaderMouseUp])

  return (
    <aside className="sidebar">
      {/* ---- 头部 ---- */}
      <div className="sb-header" onMouseDown={handleHeaderMouseDown} onDoubleClick={handleHeaderDoubleClick}>
        <div className="sb-brand">
          <div className="sb-brand-logo">
            <img src={`${PUBLIC_BASE}icon/app-icon.png`} alt="Logo" />
          </div>
          <div className="sb-brand-info">
            <div className="sb-brand-text">POPIC</div>
            <div className="sb-brand-sub">发票管理助手</div>
          </div>
          <span className="sb-brand-badge">MARS</span>
        </div>

        <div className="sb-actions">
          <div className="sb-btn-split" ref={addDropdownRef}>
            <button className="sb-btn sb-btn-primary sb-btn-split-main" onClick={handleOpenDialog}>
              {ICONS.addFile}
              添加文件
            </button>
            <button
              className={`sb-btn sb-btn-split-arrow ${addDropdownOpen ? 'open' : ''}`}
              onClick={() => setAddDropdownOpen(!addDropdownOpen)}
              aria-label="更多添加选项"
            >
              {ICONS.dropdownArrow}
            </button>
            {addDropdownOpen && (
              <div className="sb-dropdown">
                <button
                  className="sb-dropdown-item"
                  onClick={() => { handleOpenFolder(); setAddDropdownOpen(false) }}
                >
                  {ICONS.addFolder}
                  添加文件夹
                </button>
              </div>
            )}
          </div>

          <div className="sort-dropdown-container" ref={sortDropdownRef}>
            <button className="sb-btn sb-btn-ghost" onClick={() => setSortMenuOpen(!sortMenuOpen)} title="排序">
              {ICONS.sort}
            </button>
            {(sortMenuOpen || sortMenuClosing) && (
              <div className={`sort-dropdown ${sortMenuClosing ? 'closing' : ''}`}>
                <div className="sort-dropdown-header">排序方式</div>
                {SORT_OPTIONS.map(({ field, label, icon }) => (
                  <button
                    key={field}
                    className={`sort-dropdown-item ${sortBy === field ? 'active' : ''}`}
                    onClick={() => { toggleSort(field); if (sortBy !== field) handleCloseSortMenu() }}
                  >
                    {icon}
                    {label}
                    {sortBy === field && (
                      <svg className="sort-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                        style={{ marginLeft: 'auto', width: '14px', height: '14px', transition: 'transform 0.2s ease', transform: sortOrder === 'desc' ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                        <polyline points="6 9 12 15 18 9"/>
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button className="sb-btn sb-btn-ghost" onClick={clearFiles} title="清空">
            {ICONS.trash}
          </button>
        </div>
      </div>

      {/* ---- 拖放区域：无文件时显示，向下铺满 ---- */}
      {files.length === 0 && !parsing && (
        <div
          {...getRootProps()}
          className={`dropzone-area ${isNativeDragActive ? 'drag-active' : ''}`}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleOpenDialog() }}
          onDrop={handleNativeDrop}
          onDragOver={handleNativeDragOver}
          onDragLeave={handleNativeDragLeave}
        >
          <input {...getInputProps()} />
          <div className="dropzone-icon">
            <img src={`${PUBLIC_BASE}icon/files.svg`} alt="打开文件夹" width="98" height="98" />
          </div>
          {isNativeDragActive ? (
            <p className="dropzone-text-active">释放文件以添加</p>
          ) : (
            <>
              <p className="dropzone-text">拖拽文件/文件夹到此处</p>
              <p className="dropzone-formats">支持 PDF / OFD / 图片格式</p>
              <button className="dropzone-btn" onClick={(e) => { e.stopPropagation(); handleOpenDialog() }}>
                <span className="dropzone-btn-icon">{ICONS.addFolder}</span>
                选择文件
              </button>
            </>
          )}
        </div>
      )}

      {/* ---- 文件列表：有文件时显示 ---- */}
      {files.length > 0 && (
        <div className="sb-files"
          onDrop={handleNativeDrop}
          onDragOver={handleNativeDragOver}
          onDragLeave={handleNativeDragLeave}
        >
          <div className="sb-section">
              <div className="sb-section-title">
                <div className="sb-search-bar">
                  <span className="sb-search-icon">{ICONS.search}</span>
                  <input
                    type="text"
                    className="sb-search-input"
                    placeholder="搜索文件名、发票内容..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button
                      className="sb-search-clear"
                      onClick={() => setSearchQuery('')}
                      title="清除搜索"
                    >
                      {ICONS.clear}
                    </button>
                  )}
                </div>
              </div>

              {isSearching && filteredFiles.length === 0 ? (
                <div className="sb-search-empty">
                  <div className="sb-search-empty-icon">
                    <img src={`${PUBLIC_BASE}icon/nosearch.svg`} alt="" />
                  </div>
                  <div className="sb-search-empty-text">未找到匹配文件</div>
                  <button
                    className="sb-search-empty-clear"
                    onClick={() => setSearchQuery('')}
                  >
                    清除搜索
                  </button>
                </div>
              ) : (
                <FileList
                  files={isSearching ? filteredFiles : files}
                  previewFile={previewFile}
                  paperSize={paperSize}
                  duplicateInfo={duplicateInfo}
                  fileRotations={fileRotations}
                  onPreview={handlePreview}
                  onHoverFile={handleHoverFile}
                  onRemove={removeFile}
                  onRotate={handleRotate}
                />
              )}
          </div>
        </div>
      )}

      {/* ---- 统计 ---- */}
      {files.length > 0 && (
        <div className="sb-stats">
          <div className="sb-stat">
            <div className={`sb-stat-icon ${hasFailedFiles ? 'red' : (duplicateGroupCount > 0 ? 'orange' : 'blue')}`}>
              {hasFailedFiles ? ICONS.failed : (duplicateGroupCount > 0 ? ICONS.trash : ICONS.file)}
            </div>
            <span className={`sb-stat-val${poppingStats.count ? ' pop' : ''} ${hasFailedFiles ? 'error' : (duplicateGroupCount > 0 ? 'orange' : '')}`}>
              {hasFailedFiles ? failedFilesCount : (duplicateGroupCount > 0 ? duplicateGroupCount : files.length)}
            </span>
            <span className="sb-stat-label">{hasFailedFiles ? '解析失败' : (duplicateGroupCount > 0 ? '重复组' : '文件数')}</span>
          </div>
          {hasFailedFiles ? (
            <div className="sb-stat sb-stat-remove-failed">
              <button 
                className="sb-stat-failed-btn"
                onClick={(e) => { e.stopPropagation(); removeFailedFiles() }}
                title="移除失败文件"
              >
                {ICONS.trash}
              </button>
              <span className="sb-stat-failed-label">移除失败</span>
            </div>
          ) : duplicateGroupCount > 0 ? (
            <div className="sb-stat sb-stat-remove-duplicate">
              <button 
                className="sb-stat-duplicate-btn"
                onClick={(e) => { e.stopPropagation(); removeDuplicateFiles(removeSourceFile) }}
                title="一键去重"
              >
                {ICONS.trash}
              </button>
              <span className="sb-stat-duplicate-label">去重</span>
              <div className="sb-stat-duplicate-switch">
                <label className="toggle-switch sb-stat-mini-switch">
                  <input type="checkbox" checked={removeSourceFile} onChange={(e) => setRemoveSourceFile(e.target.checked)} />
                  <span className="toggle-track"></span>
                  <span className="toggle-thumb"></span>
                </label>
                <span className="sb-stat-duplicate-switch-label">删源</span>
              </div>
            </div>
          ) : (
            <div className="sb-stat">
              <div className="sb-stat-icon green">
                {ICONS.check}
              </div>
              <span className={`sb-stat-val${poppingStats.amount ? ' pop' : ''} brand`}>¥{totalAmount.toFixed(2)}</span>
              <span className="sb-stat-label">总金额</span>
            </div>
          )}
        </div>
      )}
    </aside>
  )
})
