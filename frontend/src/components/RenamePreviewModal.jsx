import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import Toggle from './Toggle'

// ============================
// 可用的重命名字段定义（与 RenameSettings 保持一致）
// ============================
const FIELD_DEFS = [
  { key: 'type',        label: '发票类型',     preview: '普票' },
  { key: 'fphm',        label: '发票号码',     preview: '231420000000037815' },
  { key: 'kprq',        label: '开票日期',     preview: '2026年07月07日' },
  { key: 'gmfmc',       label: '购买方名称',   preview: '广州市阿爆XX科技有限公司' },
  { key: 'gmfsh',       label: '购买方税号',   preview: '91711X581MXXK0TB4XA' },
  { key: 'xsfmc',       label: '销售方名称',   preview: '广州市阿花XX科技有限公司' },
  { key: 'xsfsh',       label: '销售方税号',   preview: '82711X5T1M9XK0TD4XX' },
  { key: 'amountJe',    label: '税前金额',     preview: '49.50' },
  { key: 'amountSe',    label: '总税额',       preview: '0.50' },
  { key: 'amountHj',    label: '总金额',       preview: '50.00' },
  { key: 'amountHjDx',  label: '总金额大写',   preview: '伍拾圆整' },
  { key: 'note',        label: '备注',         preview: '订单号：SD15D54ADA126E' },
  { key: 'kpr',         label: '开票人',       preview: '钱掌柜' },
  { key: 'cus',         label: '自定义内容',   preview: '自定义内容' },
]

const SEPARATOR_OPTIONS = ['_', '-', ',', '+', '#', '·', ' ', '']

const DATE_FORMAT_OPTIONS = [
  { value: 'YYYYMMDD',       label: 'YYYYMMDD',       sample: '20250501' },
  { value: 'YYYY年MM月DD日', label: 'YYYY年MM月DD日', sample: '2025年05月01日' },
  { value: 'YYYY年MM月DD',   label: 'YYYY年MM月DD',   sample: '2025年05月01' },
  { value: 'YYYY-MM-DD',     label: 'YYYY-MM-DD',     sample: '2025-05-01' },
  { value: 'YYYY.MM.DD',     label: 'YYYY.MM.DD',     sample: '2025.05.01' },
  { value: 'YYYY/MM/DD',     label: 'YYYY/MM/DD',     sample: '2025/05/01' },
  { value: 'MM月DD日',       label: 'MM月DD日',       sample: '05月01日' },
  { value: 'MM-DD',          label: 'MM-DD',          sample: '05-01' },
  { value: 'MMDD',           label: 'MMDD',           sample: '0501' },
  { value: 'MM/DD',          label: 'MM/DD',          sample: '05/01' },
]

const DATE_SAMPLE_MAP = DATE_FORMAT_OPTIONS.reduce((m, o) => { m[o.value] = o.sample; return m }, {})

function arrayMove(arr, fromIndex, toIndex) {
  const next = [...arr]
  next.splice(toIndex, 0, next.splice(fromIndex, 1)[0])
  return next
}

function normalizeFields(raw) {
  if (!raw || raw.length === 0) return []
  return raw
    .map(f => typeof f === 'string' ? { key: f } : { ...f })
    .filter(f => FIELD_DEFS.find(d => d.key === f.key) || f.key === 'cus')
}

function getFieldDef(key) {
  return FIELD_DEFS.find(d => d.key === key)
}

/**
 * 智能重命名预览器
 * 支持三个阶段：预览选择 → 执行中 → 结果展示
 * 新增：规则设置面板（内嵌滑入，1:1复刻原RenameSettings样式）
 */
const RenamePreviewModal = ({
  visible,
  files,
  executing,
  reimportProgress,
  result,
  rulesWarning,
  renameSettings,
  onSaveRenameSettings,
  onApplySettings,
  electronAPI,
  onConfirm,
  onCancel,
  onCloseResult,
}) => {
  const [viewMode, setViewMode] = useState('list')
  const [selectedKeys, setSelectedKeys] = useState(new Set())
  const [searchText, setSearchText] = useState('')
  const [showRules, setShowRules] = useState(false)

  // 规则设置本地状态（迁移自 RenameSettings）
  const [rsFields, setRsFields] = useState(() => normalizeFields(renameSettings?.fields || []))
  const [rsSeparator, setRsSeparator] = useState(() => renameSettings?.separator || '_')
  const [rsTargetFolder, setRsTargetFolder] = useState(() => renameSettings?.targetFolder || '')
  const [rsShowIndex, setRsShowIndex] = useState(() => renameSettings?.showIndex ?? false)
  const [rsShowPrefix, setRsShowPrefix] = useState(() => renameSettings?.showPrefix ?? false)
  const [rsKeepOriginal, setRsKeepOriginal] = useState(() => renameSettings?.keepOriginal ?? false)

  const [dragIndex, setDragIndex] = useState(null)
  const [dropIndex, setDropIndex] = useState(null)

  const rsStateRef = useRef({ fields: rsFields, separator: rsSeparator, targetFolder: rsTargetFolder, showIndex: rsShowIndex, showPrefix: rsShowPrefix, keepOriginal: rsKeepOriginal })
  rsStateRef.current = { fields: rsFields, separator: rsSeparator, targetFolder: rsTargetFolder, showIndex: rsShowIndex, showPrefix: rsShowPrefix, keepOriginal: rsKeepOriginal }

  // 标记：是否为从props初始化阶段，避免初始化时触发多余保存
  const isInitialSyncRef = useRef(true)

  const doSaveRs = useCallback((updates = {}) => {
    if (!onSaveRenameSettings) return
    const merged = { ...rsStateRef.current, ...updates }
    onSaveRenameSettings({
      separator: merged.separator,
      fields: merged.fields,
      targetFolder: merged.targetFolder,
      showIndex: merged.showIndex,
      showPrefix: merged.showPrefix,
      keepOriginal: merged.keepOriginal,
    })
  }, [onSaveRenameSettings])

  // 使用useEffect监听设置变化，自动保存（避免在渲染期/setState updater中调用父组件setState）
  useEffect(() => {
    // 跳过初始化同步（props -> local state），只在用户操作后保存
    if (isInitialSyncRef.current) {
      isInitialSyncRef.current = false
      return
    }
    doSaveRs()
  }, [rsFields, rsSeparator, rsTargetFolder, rsShowIndex, rsShowPrefix, rsKeepOriginal, doSaveRs])

  useEffect(() => {
    isInitialSyncRef.current = true
    setRsFields(normalizeFields(renameSettings?.fields || []))
    setRsSeparator(renameSettings?.separator || '_')
    setRsTargetFolder(renameSettings?.targetFolder || '')
    setRsShowIndex(renameSettings?.showIndex ?? false)
    setRsShowPrefix(renameSettings?.showPrefix ?? false)
    setRsKeepOriginal(renameSettings?.keepOriginal ?? false)
  }, [renameSettings])

  useEffect(() => {
    if (visible && files.length > 0) {
      setSelectedKeys(new Set(files.map(f => f.key)))
    }
  }, [visible, files])

  useEffect(() => {
    if (visible) setShowRules(false)
  }, [visible])

  const filteredFiles = useMemo(() => {
    if (!searchText.trim()) return files
    const q = searchText.toLowerCase()
    return files.filter((f) => {
      if (f.originalName?.toLowerCase().includes(q)) return true
      if (f.newName?.toLowerCase().includes(q)) return true
      if (f.invoiceNumber?.toLowerCase().includes(q)) return true
      if (f.invoiceType?.toLowerCase().includes(q)) return true
      if (f.amount?.toLowerCase().includes(q)) return true
      if (f.invoiceDate?.toLowerCase().includes(q)) return true
      if (f.rawText?.toLowerCase().includes(q)) return true
      if (f.gmfmc?.toLowerCase().includes(q)) return true
      if (f.xsfmc?.toLowerCase().includes(q)) return true
      if (f.xmmc?.toLowerCase().includes(q)) return true
      if (f.note?.toLowerCase().includes(q)) return true
      return false
    })
  }, [files, searchText])

  const stats = useMemo(() => {
    const total = files.length
    const conflicts = files.filter((f) => f.conflict).length
    const selected = selectedKeys.size
    return { total, conflicts, selected }
  }, [files, selectedKeys])

  const toggleSelect = useCallback((key) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    if (selectedKeys.size === filteredFiles.length) {
      setSelectedKeys(new Set())
    } else {
      setSelectedKeys(new Set(filteredFiles.map((f) => f.key)))
    }
  }, [filteredFiles, selectedKeys])

  // ========== 规则设置操作（与原RenameSettings完全一致） ==========
  const rsSelectedKeys = useMemo(() => new Set(rsFields.map(f => f.key)), [rsFields])

  const toggleField = useCallback((key) => {
    setRsFields((prev) => {
      const exists = prev.find(f => f.key === key)
      let next
      if (exists) {
        next = prev.filter(f => f.key !== key)
      } else {
        const newField = { key }
        if (key === 'kprq') newField.dateFormat = 'YYYY年MM月DD日'
        if (key === 'cus') newField.customText = ''
        next = [...prev, newField]
      }
      return next
    })
  }, [])

  const handleDateFmtChange = useCallback((fmt) => {
    setRsFields((prev) => prev.map(f => f.key === 'kprq' ? { ...f, dateFormat: fmt } : f))
  }, [])

  const handleCustomInput = useCallback((text) => {
    setRsFields((prev) => prev.map(f => f.key === 'cus' ? { ...f, customText: text } : f))
  }, [])

  const handleSeparatorChange = useCallback((value) => {
    setRsSeparator(value)
  }, [])

  const handleShowIndexChange = useCallback((checked) => {
    setRsShowIndex(checked)
  }, [])

  const handleShowPrefixChange = useCallback((checked) => {
    setRsShowPrefix(checked)
  }, [])

  const handleKeepOriginalChange = useCallback((checked) => {
    setRsKeepOriginal(checked)
  }, [])

  const handleDragStartItem = useCallback((e, idx) => {
    setDragIndex(idx)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', '')
    // 保存元素引用，避免requestAnimationFrame中e.currentTarget已为null
    const el = e.currentTarget
    if (el) {
      requestAnimationFrame(() => { el.style.opacity = '0.4' })
    }
  }, [])

  const handleDragEndItem = useCallback((e) => {
    const el = e.currentTarget
    if (el) el.style.opacity = '1'
    if (dragIndex !== null && dropIndex !== null && dragIndex !== dropIndex) {
      setRsFields((prev) => arrayMove(prev, dragIndex, dropIndex))
    }
    setDragIndex(null)
    setDropIndex(null)
  }, [dragIndex, dropIndex])

  const handleDragOverItem = useCallback((e, idx) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragIndex !== null && dragIndex !== idx) setDropIndex(idx)
  }, [dragIndex])

  const handleDragLeaveItem = useCallback(() => setDropIndex(null), [])

  const selectFolder = useCallback(async () => {
    const ipc = electronAPI?.ipcRenderer
    if (!ipc) {
      try {
        const { ipcRenderer } = window.require('electron')
        const result = await ipcRenderer.invoke('select-folder')
        if (result?.success && result.folder) {
          setRsTargetFolder(result.folder)
        }
      } catch (e) {
        console.error('无法调用文件夹选择:', e)
      }
      return
    }
    const result = await ipc.invoke('select-folder')
    if (result?.success && result.folder) {
      setRsTargetFolder(result.folder)
    }
  }, [electronAPI])

  const clearFolder = useCallback(() => {
    setRsTargetFolder('')
  }, [])

  const previewFileName = useMemo(() => {
    if (rsFields.length === 0) return '请勾选左侧项目'
    const parts = rsFields.map((f, i) => {
      const def = getFieldDef(f.key)
      let text = ''
      if (rsShowIndex) text += (i + 1) + '.'
      if (rsShowPrefix && def) text += def.label + ':'
      if (f.key === 'kprq') {
        text += DATE_SAMPLE_MAP[f.dateFormat] || DATE_SAMPLE_MAP['YYYY年MM月DD日']
      } else if (f.key === 'cus') {
        text += f.customText || '自定义内容'
      } else if (def) {
        text += def.preview
      } else {
        text += f.key
      }
      return text
    })
    const result = parts.join(rsSeparator)
    return result.length > 127 ? result.substring(0, 127) + '…' : result
  }, [rsFields, rsSeparator, rsShowIndex, rsShowPrefix])

  const kprqField = useMemo(() => rsFields.find(f => f.key === 'kprq'), [rsFields])
  const kprqDateFormat = kprqField?.dateFormat || 'YYYY年MM月DD日'

  const resetRules = useCallback(() => {
    const defaultFields = [
      { key: 'type' },
      { key: 'fphm' },
      { key: 'kprq', dateFormat: 'YYYY年MM月DD日' },
    ]
    setRsFields(defaultFields)
    setRsSeparator('_')
    setRsTargetFolder('')
    setRsShowIndex(false)
    setRsShowPrefix(false)
    setRsKeepOriginal(false)
  }, [])

  const handleSaveAndBack = useCallback(() => {
    setShowRules(false)
    if (onApplySettings && rsFields.length > 0) {
      setTimeout(() => onApplySettings(), 0)
    }
  }, [onApplySettings, rsFields.length])

  // ========== 关闭按钮（统一使用原版样式，去掉内联marginLeft） ==========
  const renderCloseBtn = (onClick) => (
    <button className="modal-close-btn" onClick={onClick} aria-label="关闭">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
        <line x1="3" y1="3" x2="13" y2="13" /><line x1="13" y1="3" x2="3" y2="13" />
      </svg>
    </button>
  )

  if (!visible) return null

  // ====== 结果展示阶段 ======
  if (result) {
    return (
      <div className="modal-overlay rp-overlay">
        <div className="rp-panel rp-panel--result">
          <div className="rp-header">
            <div className="rp-header-left">
              <h3 className="rp-title">
                {result.success ? '重命名完成' : '重命名失败'}
              </h3>
            </div>
            <div className="rp-header-right">
              {renderCloseBtn(onCloseResult)}
            </div>
          </div>

          <div className="rp-result-section">
            {result.success ? (
              <>
                <div className="rp-result-icon success">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="5,13 10,18 19,5" />
                  </svg>
                </div>
                <div className="rp-result-stats">
                  <div className="rp-result-stat">
                    <span className="rp-result-val">{result.renamed}</span>
                    <span className="rp-result-label">成功</span>
                  </div>
                  <div className="rp-result-stat">
                    <span className={`rp-result-val ${result.failed > 0 ? 'error' : ''}`}>{result.failed}</span>
                    <span className="rp-result-label">失败</span>
                  </div>
                </div>
                {result.partialCount > 0 && (
                  <div className="rp-result-notice">
                    {result.partialCount} 个文件已复制到目标位置，但原文件被占用无法删除，请手动删除原文件
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="rp-result-icon error">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </div>
                <div className="rp-result-msg">{result.error || '未知错误'}</div>
              </>
            )}
          </div>

          <div className="rp-footer rp-footer--result">
            <button className="pc-btn solid" onClick={onCloseResult}>关闭</button>
          </div>
        </div>
      </div>
    )
  }

  // ====== 执行中阶段 ======
  if (executing) {
    return (
      <div className="modal-overlay rp-overlay">
        <div className="rp-panel rp-panel--executing">
          <div className="rp-header">
            <div className="rp-header-left">
              <h3 className="rp-title">
                {reimportProgress !== null ? '正在重新导入重命名完成的文件...' : '正在重命名...'}
              </h3>
            </div>
            <div className="rp-header-right">
              {renderCloseBtn(onCancel)}
            </div>
          </div>
          <div className="rp-executing">
            <div className="rp-spinner" />
            <span className="rp-executing-text">
              {reimportProgress !== null
                ? `正在重新导入 ${reimportProgress}%`
                : `正在处理 ${selectedKeys.size} 个文件`}
            </span>
            {reimportProgress !== null && (
              <div className="rp-progress">
                <div className="rp-progress-bar">
                  <div className="rp-progress-fill" style={{ width: `${reimportProgress}%` }} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ====== 预览选择阶段（含规则设置滑入面板） ======
  return (
    <div className="modal-overlay rp-overlay">
      <div className={`rp-panel ${showRules ? 'rp-panel--rules' : ''}`}>
        {/* 头部 */}
        <div className="rp-header">
          <div className="rp-header-left">
            {showRules ? (
              <>
                <button
                  className="rp-back-btn"
                  onClick={() => setShowRules(false)}
                  aria-label="返回预览"
                  title="返回预览"
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <polyline points="10,3 5,8 10,13" />
                  </svg>
                </button>
                <span className="rp-header-divider" />
                <div className="rp-header-titles">
                  <h3 className="rp-title">命名规则</h3>
                  <span className="rp-subtitle">配置文件名的字段组合与格式</span>
                </div>
              </>
            ) : (
              <>
                <h3 className="rp-title">重命名预览</h3>
                <span className="rp-count">{files.length} 个发票</span>
                {stats.conflicts > 0 && (
                  <span className="rp-conflict-badge">{stats.conflicts} 个冲突</span>
                )}
              </>
            )}
          </div>
          <div className="rp-header-right">
            {showRules ? (
              <>
                <button className="rp-reset-btn" onClick={resetRules} title="恢复默认规则">
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M2 4v4h4" />
                    <path d="M2 8a6 6 0 1 1 1.5 4" />
                  </svg>
                  恢复默认
                </button>
                {renderCloseBtn(onCancel)}
              </>
            ) : (
              <>
                <div className="rp-search">
                  <svg className="rp-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="6.5" cy="6.5" r="4.5" />
                    <line x1="10.5" y1="10.5" x2="14" y2="14" />
                  </svg>
                  <input
                    className="rp-search-input"
                    type="text"
                    placeholder="搜索文件..."
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                  />
                </div>
                <div className="rp-view-toggle">
                  <button
                    className={`rp-view-btn ${viewMode === 'list' ? 'active' : ''}`}
                    onClick={() => setViewMode('list')}
                    title="列表视图"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <line x1="1" y1="3" x2="15" y2="3" /><line x1="1" y1="8" x2="15" y2="8" /><line x1="1" y1="13" x2="15" y2="13" />
                    </svg>
                  </button>
                  <button
                    className={`rp-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
                    onClick={() => setViewMode('grid')}
                    title="网格视图"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="1" y="1" width="6" height="6" rx="1" /><rect x="9" y="1" width="6" height="6" rx="1" />
                      <rect x="1" y="9" width="6" height="6" rx="1" /><rect x="9" y="9" width="6" height="6" rx="1" />
                    </svg>
                  </button>
                </div>
                <button
                  className={`rp-rules-entry ${showRules ? 'active' : ''}`}
                  onClick={() => setShowRules(true)}
                  title="规则设置"
                >
                  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <line x1="3" y1="4" x2="13" y2="4" />
                    <line x1="5" y1="8" x2="13" y2="8" />
                    <line x1="3" y1="12" x2="13" y2="12" />
                    <circle cx="4" cy="8" r="1.2" fill="currentColor" />
                  </svg>
                </button>
                {renderCloseBtn(onCancel)}
              </>
            )}
          </div>
        </div>

        {/* ========== 预览视图区域 ========== */}
        <div
          className="rp-preview-pane"
          style={{
            display: showRules ? 'none' : 'flex',
            flexDirection: 'column',
            flex: 1,
            minHeight: 0,
          }}
        >
          <div className="rp-toolbar">
            <label className="rp-select-all">
              <input
                type="checkbox"
                checked={filteredFiles.length > 0 && filteredFiles.every(f => selectedKeys.has(f.key))}
                onChange={selectAll}
              />
              <span>{selectedKeys.size > 0 ? `已选 ${selectedKeys.size} 项` : '全选'}</span>
            </label>
            <div className="rp-toolbar-right">
              <span className="rp-current-rules" onClick={() => setShowRules(true)} title="点击编辑规则">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <line x1="3" y1="4" x2="13" y2="4" />
                  <line x1="5" y1="8" x2="13" y2="8" />
                  <line x1="3" y1="12" x2="13" y2="12" />
                  <circle cx="4" cy="8" r="1.2" fill="currentColor" />
                </svg>
                当前规则：{rsFields.length > 0
                  ? (rsFields.map(f => getFieldDef(f.key)?.label || f.key).join(rsSeparator === ' ' ? ' ' : rsSeparator === '' ? '' : rsSeparator))
                  : '未配置'}
              </span>
            </div>
          </div>

          {rulesWarning && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '10px 14px',
              margin: '6px 14px 0',
              background: 'linear-gradient(135deg, #fff7ed 0%, #ffedd5 100%)',
              border: '1px solid #fed7aa',
              borderRadius: '10px',
              fontSize: '13px',
              color: '#c2410c',
              fontWeight: 500,
            }}>
              <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="#ea580c" strokeWidth="1.5" style={{ flexShrink: 0 }}>
                <path d="M8 1L15 14H1L8 1Z" />
                <line x1="8" y1="6" x2="8" y2="9.5" />
                <circle cx="8" cy="11.5" r="0.6" fill="#ea580c" />
              </svg>
              <span style={{ flex: 1 }}>{rulesWarning}</span>
              <button
                onClick={() => setShowRules(true)}
                style={{
                  padding: '5px 14px',
                  fontSize: '12px',
                  fontWeight: 600,
                  borderRadius: '6px',
                  border: 'none',
                  background: '#ea580c',
                  color: '#fff',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                去设置
              </button>
            </div>
          )}

          {viewMode === 'list' ? (
            <div className="rp-list rs-scroll">
              {filteredFiles.map((file) => (
                <div
                  key={file.key}
                  className={`rp-item ${selectedKeys.has(file.key) ? 'selected' : ''} ${file.conflict ? 'conflict' : ''}`}
                  onClick={() => toggleSelect(file.key)}
                >
                  <input type="checkbox" checked={selectedKeys.has(file.key)} onChange={() => {}} />
                  <span className="rp-item-badge">{file.fileFormat?.toUpperCase() || '?'}</span>
                  <div className="rp-item-arrow">
                    <span className="rp-item-original" title={file.originalName}>{file.originalName}</span>
                    <span className={`rp-item-new ${file.conflict ? 'conflict' : ''}`} title={file.newName}>{file.newName}</span>
                  </div>
                  {file.conflict && <span className="rp-item-conflict-tag">冲突</span>}
                </div>
              ))}
            </div>
          ) : (
            <div className="rp-grid rs-scroll">
              {filteredFiles.map((file) => (
                <div
                  key={file.key}
                  className={`rp-grid-item ${selectedKeys.has(file.key) ? 'selected' : ''} ${file.conflict ? 'conflict' : ''}`}
                  onClick={() => toggleSelect(file.key)}
                >
                  <input type="checkbox" checked={selectedKeys.has(file.key)} onChange={() => {}} />
                  <span className="rp-grid-badge">{file.fileFormat?.toUpperCase() || '?'}</span>
                  <span className="rp-grid-original" title={file.originalName}>{file.originalName}</span>
                  <span className={`rp-grid-new ${file.conflict ? 'conflict' : ''}`} title={file.newName}>{file.newName}</span>
                  {file.conflict && <span className="rp-grid-conflict-tag">冲突</span>}
                </div>
              ))}
            </div>
          )}

          <div className="rp-footer">
            <div className="rp-footer-info">
              {stats.conflicts > 0 ? (
                <span className="rp-footer-warning">
                  {stats.conflicts} 个文件名冲突，将自动添加序号
                </span>
              ) : (
                <span className="rp-footer-hint" onClick={() => setShowRules(true)}>
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="8" cy="8" r="6" />
                    <line x1="8" y1="7" x2="8" y2="11" />
                    <circle cx="8" cy="4.5" r="0.8" fill="currentColor" />
                  </svg>
                  点击右上角设置图标可调整命名规则
                </span>
              )}
            </div>
            <div className="rp-footer-actions">
              <button
                className="pc-btn outline"
                onClick={onCancel}
              >取消</button>
              <button
                className="pc-btn outline rp-btn-rules"
                onClick={() => setShowRules(true)}
                title="规则设置"
              >
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <line x1="3" y1="4" x2="13" y2="4" />
                  <line x1="5" y1="8" x2="13" y2="8" />
                  <line x1="3" y1="12" x2="13" y2="12" />
                  <circle cx="4" cy="8" r="1.2" fill="currentColor" />
                </svg>
                规则设置
              </button>
              <button className="pc-btn solid" onClick={() => onConfirm(Array.from(selectedKeys))}>
                确认重命名 {selectedKeys.size > 0 ? `(${selectedKeys.size})` : ''}
              </button>
            </div>
          </div>
        </div>

        {/* ========== 规则设置面板（滑入，1:1复刻原RenameSettings内联样式） ========== */}
        <div
          className="rp-rules-pane"
          style={{
            display: showRules ? 'flex' : 'none',
            flexDirection: 'column',
            position: 'absolute',
            inset: 0,
            background: 'var(--bg, #f5f6f8)',
            zIndex: 5,
          }}
        >
          {/* 滚动容器：关键修复，使内容可滚动到底 */}
          <div className="rs-scroll" style={{
            flex: 1,
            overflowY: 'auto',
            padding: '14px 20px 16px',
          }}>
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}>
              {/* ========== 主内容区：两栏布局（与原RenameSettings完全一致） ========== */}
              <div style={{
                display: 'flex',
                gap: '10px',
                alignItems: 'flex-start',
              }}>
                {/* 左栏：复选框字段列表 */}
                <div style={{
                  flex: '0 0 auto',
                  width: 'clamp(120px, 15vw, 200px)',
                  maxHeight: '550px',
                  overflowY: 'auto',
                  background: 'var(--white)',
                  borderRadius: 'var(--r-lg)',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.02), 0 1px 3px rgba(0,0,0,0.04)',
                  padding: '8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                }}>
                  {FIELD_DEFS.map((def) => {
                    const checked = rsSelectedKeys.has(def.key)
                    const isCus = def.key === 'cus'
                    return (
                      <label
                        key={def.key}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          padding: isCus ? '10px 8px 5px' : '5px 8px',
                          marginTop: isCus ? '8px' : '0',
                          borderTop: isCus ? '1px solid var(--border-light)' : 'none',
                          borderRadius: 'var(--r-sm)',
                          cursor: 'pointer',
                          fontSize: '12px',
                          color: checked ? 'var(--accent)' : 'var(--text-2)',
                          fontWeight: checked ? 500 : 400,
                          background: checked ? 'var(--accent-soft)' : 'transparent',
                          transition: 'all 0.15s ease',
                          userSelect: 'none',
                        }}
                        onMouseEnter={(e) => {
                          if (!checked) e.currentTarget.style.background = 'rgba(79, 124, 255, 0.05)'
                        }}
                        onMouseLeave={(e) => {
                          if (!checked) e.currentTarget.style.background = 'transparent'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleField(def.key)}
                          style={{
                            width: '14px',
                            height: '14px',
                            accentColor: 'var(--accent)',
                            cursor: 'pointer',
                            flexShrink: 0,
                          }}
                        />
                        {def.label}
                      </label>
                    )
                  })}
                </div>

                {/* 右栏：拖拽排序区 + 预览区 */}
                <div style={{
                  flex: '1 1 auto',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: 'clamp(6px, 0.65vw, 10px)',
                  minWidth: 0,
                }}>
                  {/* 拖拽排序区 */}
                  <div style={{
                    minHeight: rsFields.length > 0 ? 'auto' : '180px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    padding: '14px',
                    borderRadius: 'var(--r-lg)',
                    border: '1.5px dashed #d2d2d7',
                    background: 'var(--white)',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.02), 0 1px 3px rgba(0,0,0,0.04)',
                    position: 'relative',
                    justifyContent: rsFields.length > 0 ? 'flex-start' : 'center',
                    alignItems: rsFields.length > 0 ? 'stretch' : 'center',
                  }}>
                    {rsFields.length === 0 && (
                      <div style={{
                        fontSize: '13px',
                        color: 'var(--text-4)',
                        background: 'var(--surface)',
                        padding: '10px 20px',
                        borderRadius: 'var(--r-md)',
                        fontWeight: 500,
                      }}>
                        勾选左侧重命名项目
                      </div>
                    )}

                    {rsFields.map((field, idx) => {
                      const def = getFieldDef(field.key)
                      const isDragging = dragIndex === idx
                      const isDropTarget = dropIndex === idx
                      const isKprq = field.key === 'kprq'
                      const isCus = field.key === 'cus'

                      return (
                        <div
                          key={field.key}
                          draggable
                          onDragStart={(e) => handleDragStartItem(e, idx)}
                          onDragEnd={handleDragEndItem}
                          onDragOver={(e) => handleDragOverItem(e, idx)}
                          onDragLeave={handleDragLeaveItem}
                          onDrop={(e) => e.preventDefault()}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            padding: '5px 10px',
                            borderRadius: '6px',
                            border: isDropTarget
                              ? '2px dashed var(--accent)'
                              : 'none',
                            background: isDropTarget
                              ? 'rgba(79, 124, 255, 0.08)'
                              : 'var(--accent-gradient)',
                            color: isDropTarget ? 'var(--accent)' : '#fff',
                            boxShadow: isDropTarget ? 'none' : '0 2px 6px rgba(79,124,255,0.2)',
                            opacity: isDragging ? 0.4 : 1,
                            cursor: 'grab',
                            transition: 'all 0.15s ease',
                            userSelect: 'none',
                            position: 'relative',
                            fontSize: '11px',
                            fontWeight: 500,
                          }}
                        >
                          <span style={{
                            fontSize: '12px',
                            color: 'rgba(255,255,255,0.7)',
                            lineHeight: 1,
                            cursor: 'grab',
                          }}>
                            &#9776;
                          </span>

                          <span style={{
                            fontSize: '11px',
                            fontWeight: 500,
                            color: isDropTarget ? 'var(--accent)' : '#fff',
                          }}>
                            {def?.label || field.key}
                          </span>

                          {isKprq && (
                            <>
                              <span style={{
                                fontSize: '10px',
                                color: 'rgba(255,255,255,0.7)',
                                marginLeft: '2px',
                              }}>
                                {DATE_SAMPLE_MAP[kprqDateFormat] || ''}
                              </span>
                              <select
                                value={kprqDateFormat}
                                onChange={(e) => handleDateFmtChange(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                onPointerDown={(e) => e.stopPropagation()}
                                style={{
                                  padding: '2px 4px',
                                  fontSize: '10px',
                                  borderRadius: '4px',
                                  border: 'none',
                                  background: 'rgba(255,255,255,0.25)',
                                  color: '#fff',
                                  outline: 'none',
                                  cursor: 'pointer',
                                  fontWeight: 500,
                                }}
                              >
                                {DATE_FORMAT_OPTIONS.map(opt => (
                                  <option key={opt.value} value={opt.value} style={{ color: '#1d1d1f' }}>{opt.label}</option>
                                ))}
                              </select>
                            </>
                          )}

                          {isCus && (
                            <input
                              type="text"
                              value={field.customText || ''}
                              placeholder="自定义"
                              onChange={(e) => handleCustomInput(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onPointerDown={(e) => e.stopPropagation()}
                              style={{
                                flex: 1,
                                minWidth: '80px',
                                padding: '2px 6px',
                                fontSize: '10px',
                                borderRadius: '4px',
                                border: 'none',
                                background: 'rgba(255,255,255,0.25)',
                                color: '#fff',
                                outline: 'none',
                                fontWeight: 500,
                              }}
                            />
                          )}

                          <span
                            onClick={(e) => {
                              e.stopPropagation()
                              e.preventDefault()
                              toggleField(field.key)
                            }}
                            title="移除"
                            style={{
                              cursor: 'pointer',
                              fontSize: '12px',
                              fontWeight: 'bold',
                              color: 'rgba(255,255,255,0.7)',
                              marginLeft: 'auto',
                              lineHeight: 1,
                              transition: 'color 0.15s ease',
                            }}
                            onMouseEnter={(e) => e.target.style.color = '#fff'}
                            onMouseLeave={(e) => e.target.style.color = 'rgba(255,255,255,0.7)'}
                          >
                            &times;
                          </span>
                        </div>
                      )
                    })}

                    {rsFields.length > 0 && (
                      <div style={{
                        position: 'absolute',
                        bottom: '4px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        fontSize: 'clamp(0.625rem, 0.6rem + 0.15vw, 0.7rem)',
                        color: 'var(--text-4)',
                        background: 'var(--bg)',
                        padding: 'clamp(1px, 0.15vw, 2px) clamp(8px, 0.75vw, 12px)',
                        borderRadius: '20px',
                      }}>
                        可拖动以上项目进行排序
                      </div>
                    )}
                  </div>

                  {/* 预览区 */}
                  {rsFields.length > 0 && (
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px',
                      background: 'var(--white)',
                      borderRadius: 'var(--r-lg)',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.02), 0 1px 3px rgba(0,0,0,0.04)',
                      padding: '16px',
                    }}>
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '16px',
                        flexWrap: 'wrap',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Toggle checked={rsShowIndex} onChange={handleShowIndexChange} />
                          <span style={{ fontSize: '12px', color: 'var(--text)', fontWeight: 500 }}>显示序号</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Toggle checked={rsShowPrefix} onChange={handleShowPrefixChange} />
                          <span style={{ fontSize: '12px', color: 'var(--text)', fontWeight: 500 }}>显示前缀</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-3)', fontWeight: 500 }}>分隔符:</span>
                          <select
                            value={rsSeparator}
                            onChange={(e) => handleSeparatorChange(e.target.value)}
                            style={{
                              padding: '4px 8px',
                              fontSize: '11px',
                              borderRadius: 'var(--r-sm)',
                              border: 'none',
                              background: 'var(--surface)',
                              color: 'var(--text-3)',
                              outline: 'none',
                              cursor: 'pointer',
                              fontWeight: 500,
                            }}
                          >
                            {SEPARATOR_OPTIONS.map(ch => (
                              <option key={ch} value={ch}>
                                {ch === ' ' ? '空格' : ch === '' ? '无' : ch}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div style={{
                        padding: '10px 12px',
                        background: 'var(--surface)',
                        borderRadius: 'var(--r-md)',
                        fontSize: '11px',
                        color: 'var(--accent)',
                        wordBreak: 'break-all',
                        minHeight: '36px',
                        lineHeight: 1.6,
                        fontWeight: 500,
                      }}>
                        {previewFileName}
                      </div>

                      {rsFields.length > 8 && (
                        <div style={{
                          fontSize: '11px',
                          color: 'var(--danger)',
                        }}>
                          提示：中文文件名长度不能超过127个字，超出部分可能会被截断！
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* 提示文字 */}
              {rsFields.length > 0 && (
                <div style={{
                  fontSize: 'clamp(0.625rem, 0.6rem + 0.15vw, 0.7rem)',
                  color: 'var(--text-4)',
                  lineHeight: 1.5,
                  padding: '0 clamp(2px, 0.25vw, 4px)',
                }}>
                  可拖动拖拽手柄 <span style={{ fontFamily: 'monospace' }}>&#9776;</span> 调整字段排序，或点击 &times; 移除字段。
                </div>
              )}

              {/* ========== 目标文件夹 ========== */}
              <div style={{
                background: 'var(--white)',
                borderRadius: 'var(--r-lg)',
                boxShadow: '0 1px 2px rgba(0,0,0,0.02), 0 1px 3px rgba(0,0,0,0.04)',
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{
                    width: '28px', height: '28px',
                    borderRadius: 'var(--r-sm)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--accent-gradient)',
                    fontSize: '13px', flexShrink: 0,
                    boxShadow: '0 2px 6px rgba(79,124,255,0.2)',
                    color: '#fff',
                  }}>
                    <svg viewBox="0 0 1024 1024" style={{ width: 16, height: 16, fill: 'currentColor' }}>
                      <path d="M919.68 949.12H103.68a96 96 0 0 1-96-96V167.04a96 96 0 0 1 96-96H384a95.36 95.36 0 0 1 72.96 33.92l56.32 64a33.28 33.28 0 0 0 24.32 10.88h378.88a96 96 0 0 1 96.64 96v576a96 96 0 0 1-93.44 97.28zM103.68 135.04a32 32 0 0 0 -32 32v686.08a32 32 0 0 0 32 32h816a32.64 32.64 0 0 0 32 -32v-576a32 32 0 0 0 -32 -32H540.8a99.2 99.2 0 0 1-74.24-33.28l-56.32-64a33.92 33.92 0 0 0 -26.24 -12.8z"/>
                      <path d="M945.28 374.4H78.08a32 32 0 1 1 0-64h867.2a32 32 0 0 1 0 64z"/>
                    </svg>
                  </div>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>目标文件夹</span>
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <div style={{
                    flex: 1,
                    padding: '8px 12px',
                    background: 'var(--surface)',
                    borderRadius: 'var(--r-sm)',
                    fontSize: '11px',
                    color: rsTargetFolder ? 'var(--text)' : 'var(--text-4)',
                    fontStyle: rsTargetFolder ? 'normal' : 'italic',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    minHeight: '32px',
                    display: 'flex',
                    alignItems: 'center',
                    fontWeight: 500,
                  }}>
                    {rsTargetFolder || '未设置 — 重命名时覆盖原始文件名'}
                  </div>
                  <button
                    onClick={selectFolder}
                    style={{
                      padding: '7px 16px',
                      fontSize: '12px',
                      fontWeight: 500,
                      borderRadius: 'var(--r-sm)',
                      border: 'none',
                      background: 'var(--accent-gradient)',
                      color: '#fff',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      whiteSpace: 'nowrap',
                      transition: 'all 0.15s ease',
                      boxShadow: '0 2px 6px rgba(79,124,255,0.25)',
                      minHeight: '32px',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-0.5px)'
                      e.currentTarget.style.boxShadow = '0 3px 8px rgba(79,124,255,0.3)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translateY(0)'
                      e.currentTarget.style.boxShadow = '0 2px 6px rgba(79,124,255,0.25)'
                    }}
                  >
                    选择文件夹
                  </button>
                </div>

                {rsTargetFolder && (
                  <button
                    onClick={clearFolder}
                    style={{
                      alignSelf: 'flex-start',
                      fontSize: '11px',
                      color: 'var(--text-4)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '2px 0',
                      textDecoration: 'underline',
                      textUnderlineOffset: '2px',
                      fontFamily: 'inherit',
                      transition: 'color 0.15s ease',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-2)'}
                    onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-4)'}
                  >
                    清除设置，恢复弹框选择
                  </button>
                )}

                <div className="printer-hint" style={{ fontSize: '11px', color: 'var(--text-4)', lineHeight: 1.5 }}>
                  设置后重命名将直接输出到此文件夹；不设置则在重命名时覆盖原始文件名。
                </div>

                {/* 保留原件 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingTop: '4px', borderTop: '1px solid var(--border-light)' }}>
                  <Toggle
                    checked={rsKeepOriginal}
                    disabled={!rsTargetFolder}
                    onChange={handleKeepOriginalChange}
                  />
                  <span style={{ fontSize: '12px', color: rsTargetFolder ? 'var(--text)' : 'var(--text-4)', fontWeight: 500, opacity: rsTargetFolder ? 1 : 0.5 }}>保留原件</span>
                  <span style={{ fontSize: '11px', color: 'var(--text-4)', marginLeft: '4px' }}>不勾选则剪切原文件到目标文件夹</span>
                </div>
              </div>
            </div>
          </div>

          {/* 底部操作栏（固定，不随内容滚动） */}
          <div className="rp-footer rs-footer" style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--border-light)',
            background: 'var(--white)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}>
            <div className="rp-footer-info">
              <span className="rs-back-link"
                onClick={() => setShowRules(false)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                  fontSize: '12px', color: 'var(--text-3)', cursor: 'pointer', padding: '4px 0',
                }}
                onMouseEnter={(e) => e.currentTarget.style.color = 'var(--accent)'}
                onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-3)'}
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <polyline points="10,3 5,8 10,13" />
                </svg>
                返回预览
              </span>
            </div>
            <div className="rp-footer-actions" style={{ display: 'flex', gap: '8px' }}>
              <button className="pc-btn outline" onClick={onCancel}>取消</button>
              <button
                className="pc-btn solid rs-save-btn"
                onClick={handleSaveAndBack}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3,8 7,12 13,5" />
                </svg>
                保存并返回预览
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default React.memo(RenamePreviewModal)
