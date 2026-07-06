import { useState, useMemo, useCallback, useRef, useEffect } from 'react'

// ============================
// 可用的重命名字段定义
// ============================
const FIELD_DEFS = [
  { key: 'type',        label: '发票类型',     preview: '普票' },
  { key: 'fphm',        label: '发票号码',     preview: '231420000000037815' },
  { key: 'kprq',        label: '开票日期',     preview: '2026年07月07日' },
  { key: 'gmfmc',       label: '购买方名称',   preview: '广州市阿爆XX科技有限公司' },
  { key: 'gmfsh',       label: '购买方税号',   preview: '91711X581MXXK0TB4XA' },
  { key: 'xsfmc',       label: '销售方名称',   preview: '广州市阿花XX科技有限公司' },
  { key: 'xsfsh',       label: '销售方税号',   preview: '82711X5T1M9XK0TD4XX' },
  { key: 'amountJe',    label: '发票金额',     preview: '49.50' },
  { key: 'amountSe',    label: '发票税额',     preview: '0.50' },
  { key: 'amountHj',    label: '价税合计',     preview: '50.00' },
  { key: 'amountHjDx',  label: '价税合计大写', preview: '伍拾圆整' },
  { key: 'note',        label: '备注',         preview: '订单号：SD15D54ADA126E' },
  { key: 'skr',         label: '收款人',       preview: '李大大' },
  { key: 'fhr',         label: '复核人',       preview: '陈小源' },
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

// ============================
// 工具
// ============================
function arrayMove(arr, fromIndex, toIndex) {
  const next = [...arr]
  next.splice(toIndex, 0, next.splice(fromIndex, 1)[0])
  return next
}

// 规范化 fields：支持旧版 string[] 和新版 { key, ... }[]
// 过滤掉不存在于 FIELD_DEFS 中的字段 key（兼容移除已删除字段的缓存）
function normalizeFields(raw) {
  if (!raw || raw.length === 0) return []
  return raw
    .map(f => typeof f === 'string' ? { key: f } : { ...f })
    .filter(f => getFieldDef(f.key) || f.key === 'cus')  // cus 是自定义类型，保留
}

// 根据 key 获取 field def
function getFieldDef(key) {
  return FIELD_DEFS.find(d => d.key === key)
}

export default function RenameSettings({ renameSettings, onSave, electronAPI, active = true }) {
  // ============================
  // 初始化主题 - 从 localStorage 读取并应用到当前 document
  // ============================
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme')
    const isDark = savedTheme === 'dark'
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
  }, [])
  
  // ============================
  // 状态
  // ============================
  const [fields, setFields] = useState(() =>
    normalizeFields(renameSettings?.fields || [])
  )
  const [separator, setSeparator] = useState(() =>
    renameSettings?.separator || '_'
  )
  const [targetFolder, setTargetFolder] = useState(() =>
    renameSettings?.targetFolder || ''
  )
  const [showIndex, setShowIndex] = useState(() =>
    renameSettings?.showIndex ?? false
  )
  const [showPrefix, setShowPrefix] = useState(() =>
    renameSettings?.showPrefix ?? false
  )
  const [keepOriginal, setKeepOriginal] = useState(() =>
    renameSettings?.keepOriginal ?? false
  )
  
  const contentRef = useRef(null)
  
  // 调整父窗口大小
  const resizeParentWindow = useCallback(() => {
    if (!electronAPI || !active) return
    
    // 延迟时间比 SettingsWindow 稍长，确保不会被覆盖
    setTimeout(() => {
      electronAPI.ipcRenderer.invoke('resize-settings-window', {
        width: 750,
        height: 1000
      }).catch(err => {
        console.warn('[RenameSettings] 调整窗口大小失败:', err)
      })
    }, 100)
  }, [electronAPI, active])
  
  // 当内容变化或激活状态变化时调整窗口大小
  useEffect(() => {
    resizeParentWindow()
  }, [fields, showIndex, showPrefix, separator, targetFolder, keepOriginal, resizeParentWindow, active])

  // 拖拽状态
  const [dragIndex, setDragIndex] = useState(null)
  const [dropIndex, setDropIndex] = useState(null)

  // ============================
  // 保存（用 ref 避免 stale closure）
  // ============================
  const stateRef = useRef({ fields, separator, targetFolder, showIndex, showPrefix, keepOriginal })
  stateRef.current = { fields, separator, targetFolder, showIndex, showPrefix, keepOriginal }

  const doSave = useCallback((updates = {}) => {
    const merged = { ...stateRef.current, ...updates }
    onSave({
      separator: merged.separator,
      fields: merged.fields,
      targetFolder: merged.targetFolder,
      showIndex: merged.showIndex,
      showPrefix: merged.showPrefix,
      keepOriginal: merged.keepOriginal,
    })
  }, [onSave])

  // ============================
  // 字段勾选切换
  // ============================
  const toggleField = useCallback((key) => {
    setFields((prev) => {
      const exists = prev.find(f => f.key === key)
      let next
      if (exists) {
        next = prev.filter(f => f.key !== key)
      } else {
        const newField = { key }
        // 开票日期默认日期格式
        if (key === 'kprq') newField.dateFormat = 'YYYY年MM月DD日'
        // 自定义内容默认空
        if (key === 'cus') newField.customText = ''
        next = [...prev, newField]
      }
      doSave({ fields: next })
      return next
    })
  }, [doSave])

  // ============================
  // 日期格式变更
  // ============================
  const handleDateFmtChange = useCallback((fmt) => {
    setFields((prev) => {
      const next = prev.map(f =>
        f.key === 'kprq' ? { ...f, dateFormat: fmt } : f
      )
      doSave({ fields: next })
      return next
    })
  }, [doSave])

  // ============================
  // 自定义内容输入
  // ============================
  const handleCustomInput = useCallback((text) => {
    setFields((prev) => {
      const next = prev.map(f =>
        f.key === 'cus' ? { ...f, customText: text } : f
      )
      doSave({ fields: next })
      return next
    })
  }, [doSave])

  // ============================
  // 分隔符变更
  // ============================
  const handleSeparatorChange = useCallback((value) => {
    setSeparator(value)
    doSave({ separator: value })
  }, [doSave])

  // ============================
  // 选项变更
  // ============================
  const handleShowIndexChange = useCallback((checked) => {
    setShowIndex(checked)
    doSave({ showIndex: checked })
  }, [doSave])

  const handleShowPrefixChange = useCallback((checked) => {
    setShowPrefix(checked)
    doSave({ showPrefix: checked })
  }, [doSave])

  const handleKeepOriginalChange = useCallback((checked) => {
    setKeepOriginal(checked)
    doSave({ keepOriginal: checked })
  }, [doSave])

  // ============================
  // 拖拽排序
  // ============================
  const handleDragStartItem = useCallback((e, idx) => {
    setDragIndex(idx)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', '')
    if (e.currentTarget) {
      requestAnimationFrame(() => {
        e.currentTarget.style.opacity = '0.4'
      })
    }
  }, [])

  const handleDragEndItem = useCallback((e) => {
    if (e.currentTarget) {
      e.currentTarget.style.opacity = '1'
    }
    if (dragIndex !== null && dropIndex !== null && dragIndex !== dropIndex) {
      setFields((prev) => {
        const next = arrayMove(prev, dragIndex, dropIndex)
        doSave({ fields: next })
        return next
      })
    }
    setDragIndex(null)
    setDropIndex(null)
  }, [dragIndex, dropIndex, doSave])

  const handleDragOverItem = useCallback((e, idx) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragIndex !== null && dragIndex !== idx) {
      setDropIndex(idx)
    }
  }, [dragIndex])

  const handleDragLeaveItem = useCallback(() => {
    setDropIndex(null)
  }, [])

  // ============================
  // 目标文件夹选择
  // ============================
  const selectFolder = useCallback(async () => {
    const ipc = electronAPI?.ipcRenderer
    if (!ipc) {
      try {
        const { ipcRenderer } = window.require('electron')
        const result = await ipcRenderer.invoke('select-folder')
        if (result?.success && result.folder) {
          setTargetFolder(result.folder)
          doSave({ targetFolder: result.folder })
        }
      } catch (e) {
        console.error('无法调用文件夹选择:', e)
      }
      return
    }
    const result = await ipc.invoke('select-folder')
    if (result?.success && result.folder) {
      setTargetFolder(result.folder)
      doSave({ targetFolder: result.folder })
    }
  }, [electronAPI, doSave])

  const clearFolder = useCallback(() => {
    setTargetFolder('')
    doSave({ targetFolder: '' })
  }, [doSave])

  // ============================
  // 命名预览
  // ============================
  const previewFileName = useMemo(() => {
    if (fields.length === 0) return '请勾选左侧项目'

    const parts = fields.map((f, i) => {
      const def = getFieldDef(f.key)
      let text = ''
      if (showIndex) text += (i + 1) + '.'
      if (showPrefix && def) text += def.label + ':'

      if (f.key === 'kprq') {
        const fmt = f.dateFormat || 'YYYY年MM月DD日'
        const sampleMap = {
          'YYYYMMDD': '20250501',
          'YYYY年MM月DD日': '2025年05月01日',
          'YYYY年MM月DD': '2025年05月01',
          'YYYY-MM-DD': '2025-05-01',
          'YYYY.MM.DD': '2025.05.01',
          'YYYY/MM/DD': '2025/05/01',
          'MM月DD日': '05月01日',
          'MM-DD': '05-01',
          'MMDD': '0501',
          'MM/DD': '05/01',
        }
        text += sampleMap[fmt] || fmt
      } else if (f.key === 'cus') {
        text += f.customText || '自定义内容'
      } else if (def) {
        text += def.preview
      } else {
        text += f.key
      }

      return text
    })

    const result = parts.join(separator)
    return result.length > 127
      ? result.substring(0, 127) + '…'
      : result
  }, [fields, separator, showIndex, showPrefix])

  // ============================
  // 当前已选中的 key 集合
  // ============================
  const selectedKeys = useMemo(() => new Set(fields.map(f => f.key)), [fields])

  // ============================
  // 当前 kprq 的日期格式
  // ============================
  const kprqField = useMemo(() => fields.find(f => f.key === 'kprq'), [fields])
  const kprqDateFormat = kprqField?.dateFormat || 'YYYY年MM月DD日'

  // ============================
  // RENDER
  // ============================
  return (
    <div ref={contentRef} style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 'clamp(12px, 1.25vw, 20px)',
      padding: 'clamp(2px, 0.25vw, 4px) 2px clamp(10px, 1vw, 16px) 2px',
    }}>
      {/* ========== 重命名规则标题 ========== */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(5px, 0.5vw, 8px)' }}>
          <div style={{
            width: '4px',
            height: '16px',
            background: 'var(--accent)',
            borderRadius: '2px',
            boxShadow: '0 0 8px rgba(59, 108, 245, 0.20)',
          }}></div>
          <span style={{
            fontSize: 'clamp(0.75rem, 0.7rem + 0.25vw, 0.85rem)',
            fontWeight: 600,
            color: 'var(--text)',
            letterSpacing: '0.02em',
          }}>
            重命名规则
          </span>
        </div>
      </div>

      {/* ========== 主内容区：两栏布局 ========== */}
      <div style={{
        display: 'flex',
        gap: 'clamp(10px, 1vw, 16px)',
        alignItems: 'flex-start',
      }}>
        {/* ========== 左栏：复选框字段列表 ========== */}
        <div style={{
          flex: '0 0 auto',
          width: 'clamp(120px, 15vw, 200px)',
          maxHeight: '550px',
          overflowY: 'auto',
          background: 'var(--surface)',
          borderRadius: 'var(--r-lg)',
          border: '1px solid var(--border-light)',
          boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.7)',
          padding: 'clamp(5px, 0.5vw, 8px) clamp(5px, 0.5vw, 8px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'clamp(0px, 0.05vw, 1px)',
        }}>
          {FIELD_DEFS.map((def, idx) => {
            const checked = selectedKeys.has(def.key)
            const isCus = def.key === 'cus'
            return (
              <label
                key={def.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'clamp(4px, 0.4vw, 6px)',
                  padding: 'clamp(3px, 0.3vw, 5px) clamp(5px, 0.5vw, 8px)',
                  borderRadius: 'var(--r-sm)',
                  cursor: 'pointer',
                  fontSize: 'clamp(0.75rem, 0.7rem + 0.25vw, 0.85rem)',
                  color: checked ? 'var(--accent)' : 'var(--text-2)',
                  fontWeight: checked ? 500 : 400,
                  background: checked ? 'var(--accent-soft)' : 'transparent',
                  paddingTop: isCus ? '16px' : '5px',
                  marginTop: isCus ? '8px' : '0',
                  transition: 'all 0.15s ease',
                  userSelect: 'none',
                }}
                onMouseEnter={(e) => {
                  if (!checked) e.currentTarget.style.background = 'rgba(59, 108, 245, 0.04)'
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

        {/* ========== 右栏：拖拽排序区 + 预览区 ========== */}
        <div style={{
          flex: '1 1 auto',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: 'clamp(6px, 0.65vw, 10px)',
          minWidth: 0,
        }}>
          {/* --- 拖拽排序区 --- */}
          <div style={{
            minHeight: fields.length > 0 ? 'auto' : '180px',
            display: 'flex',
            flexDirection: 'column',
            gap: 'clamp(4px, 0.4vw, 6px)',
            padding: 'clamp(8px, 0.75vw, 12px)',
            borderRadius: 'var(--r-lg)',
            border: '1px dashed var(--border)',
            background: 'var(--surface)',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.7)',
            position: 'relative',
            justifyContent: fields.length > 0 ? 'flex-start' : 'center',
            alignItems: fields.length > 0 ? 'stretch' : 'center',
          }}>
            {fields.length === 0 && (
              <div style={{
                fontSize: 'clamp(0.8rem, 0.75rem + 0.3vw, 0.9rem)',
                color: 'var(--text-4)',
                background: 'var(--bg)',
                padding: 'clamp(8px, 0.75vw, 12px) clamp(16px, 1.5vw, 24px)',
                borderRadius: 'var(--r-md)',
              }}>
                勾选左侧重命名项目
              </div>
            )}

            {fields.map((field, idx) => {
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
                    gap: 'clamp(4px, 0.4vw, 6px)',
                    padding: 'clamp(5px, 0.4vw, 7px) clamp(8px, 0.75vw, 12px)',
                    borderRadius: 'var(--r-sm)',
                    border: isDropTarget
                      ? '2px dashed var(--accent)'
                      : '1px solid rgba(59, 108, 245, 0.18)',
                    background: isDropTarget
                      ? 'rgba(59, 108, 245, 0.08)'
                      : 'rgba(59, 108, 245, 0.05)',
                    boxShadow: isDropTarget ? undefined : 'inset 0 1px 0 rgba(255,255,255,0.4)',
                    opacity: isDragging ? 0.4 : 1,
                    cursor: 'grab',
                    transition: 'all 0.15s ease',
                    userSelect: 'none',
                    position: 'relative',
                  }}
                  onMouseEnter={(e) => {
                    if (!isDropTarget && !isDragging) {
                      e.currentTarget.style.borderColor = 'rgba(59, 108, 245, 0.35)'
                      e.currentTarget.style.background = 'rgba(59, 108, 245, 0.08)'
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isDropTarget && !isDragging) {
                      e.currentTarget.style.borderColor = 'rgba(59, 108, 245, 0.18)'
                      e.currentTarget.style.background = 'rgba(59, 108, 245, 0.05)'
                    }
                  }}
                >
                  {/* 拖拽手柄 */}
                  <span style={{
                    fontSize: 'clamp(0.8rem, 0.75rem + 0.3vw, 0.9rem)',
                    color: 'var(--text-4)',
                    lineHeight: 1,
                    cursor: 'grab',
                  }}>
                    &#9776;
                  </span>

                  {/* 字段标签 */}
                  <span style={{
                    fontSize: 'clamp(0.75rem, 0.7rem + 0.25vw, 0.85rem)',
                    fontWeight: 500,
                    color: 'var(--accent)',
                  }}>
                    {def?.label || field.key}
                  </span>

                  {/* 开票日期：日期格式选择器 */}
                  {isKprq && (
                    <>
                      <span style={{
                        fontSize: 'clamp(0.7rem, 0.65rem + 0.2vw, 0.78rem)',
                        color: 'var(--text-4)',
                        marginLeft: 'clamp(2px, 0.25vw, 4px)',
                      }}>
                        {(() => {
                          const m = {
                            'YYYYMMDD': '20250501',
                            'YYYY年MM月DD日': '2025年05月01日',
                            'YYYY年MM月DD': '2025年05月01',
                            'YYYY-MM-DD': '2025-05-01',
                            'YYYY.MM.DD': '2025.05.01',
                            'YYYY/MM/DD': '2025/05/01',
                            'MM月DD日': '05月01日',
                            'MM-DD': '05-01',
                            'MMDD': '0501',
                            'MM/DD': '05/01',
                          }
                          return m[kprqDateFormat] || ''
                        })()}
                      </span>
                      <span style={{
                        fontSize: 'clamp(0.7rem, 0.65rem + 0.2vw, 0.78rem)',
                        color: 'var(--text-3)',
                        marginLeft: 'clamp(4px, 0.4vw, 6px)',
                      }}>
                        日期格式:
                      </span>
                      <select
                        value={kprqDateFormat}
                        onChange={(e) => handleDateFmtChange(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                        style={{
                          padding: 'clamp(2px, 0.2vw, 3px) clamp(2px, 0.25vw, 4px)',
                          fontSize: 'clamp(0.7rem, 0.65rem + 0.2vw, 0.78rem)',
                          borderRadius: 'var(--r-sm)',
                          border: '1px solid var(--border)',
                          background: 'var(--bg)',
                          color: 'var(--text-2)',
                          outline: 'none',
                          cursor: 'pointer',
                        }}
                        onFocus={(e) => e.target.style.borderColor = 'var(--accent)'}
                        onBlur={(e) => e.target.style.borderColor = 'var(--border)'}
                      >
                        {DATE_FORMAT_OPTIONS.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </>
                  )}

                  {/* 自定义内容：内联输入框 */}
                  {isCus && (
                    <input
                      type="text"
                      value={field.customText || ''}
                      placeholder="请输入自定义内容"
                      onChange={(e) => handleCustomInput(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      style={{
                        flex: 1,
                        minWidth: 'clamp(100px, 12vw, 160px)',
                        padding: 'clamp(2px, 0.2vw, 3px) clamp(5px, 0.5vw, 8px)',
                        fontSize: 'clamp(0.75rem, 0.7rem + 0.25vw, 0.85rem)',
                        borderRadius: 'var(--r-sm)',
                        border: '1px solid rgba(59, 108, 245, 0.3)',
                        background: 'var(--bg)',
                        color: 'var(--accent)',
                        outline: 'none',
                        transition: 'border-color 0.15s ease',
                      }}
                      onFocus={(e) => {
                        e.target.style.borderColor = 'var(--accent)'
                        e.target.style.boxShadow = '0 0 0 2px rgba(59, 108, 245, 0.1)'
                      }}
                      onBlur={(e) => {
                        e.target.style.borderColor = 'rgba(59, 108, 245, 0.3)'
                        e.target.style.boxShadow = 'none'
                      }}
                    />
                  )}

                  {/* 移除按钮 */}
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                      toggleField(field.key)
                    }}
                    title="移除"
                    style={{
                      cursor: 'pointer',
                      fontSize: 'clamp(0.9rem, 0.85rem + 0.35vw, 1rem)',
                      fontWeight: 'bold',
                      color: 'var(--text-4)',
                      marginLeft: 'auto',
                      lineHeight: 1,
                      transition: 'color 0.15s ease',
                    }}
                    onMouseEnter={(e) => e.target.style.color = 'var(--danger)'}
                    onMouseLeave={(e) => e.target.style.color = 'var(--text-4)'}
                  >
                    &times;
                  </span>
                </div>
              )
            })}

            {fields.length > 0 && (
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

          {/* --- 预览区 --- */}
          {fields.length > 0 && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'clamp(5px, 0.5vw, 8px)',
              background: 'var(--surface)',
              borderRadius: 'var(--r-lg)',
              border: '1px solid var(--border-light)',
              boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.7)',
              padding: 'clamp(8px, 0.75vw, 12px) clamp(10px, 1vw, 16px)',
            }}>
              {/* 预览选项 */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'clamp(10px, 1vw, 16px)',
                flexWrap: 'wrap',
              }}>
                <span style={{
                  fontSize: 'clamp(0.75rem, 0.7rem + 0.25vw, 0.85rem)',
                  fontWeight: 500,
                  color: 'var(--text)',
                }}>
                  文件名称预览：
                </span>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'clamp(8px, 0.75vw, 12px)',
                  flexWrap: 'wrap',
                }}>
                  <label style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'clamp(2px, 0.25vw, 4px)',
                    fontSize: 'clamp(0.7rem, 0.65rem + 0.2vw, 0.78rem)',
                    color: 'var(--text-3)',
                    cursor: 'pointer',
                  }}>
                    <input
                      type="checkbox"
                      checked={showIndex}
                      onChange={(e) => handleShowIndexChange(e.target.checked)}
                      style={{
                        width: '14px',
                        height: '14px',
                        accentColor: 'var(--accent)',
                      }}
                    />
                    显示序号
                  </label>
                  <label style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'clamp(2px, 0.25vw, 4px)',
                    fontSize: 'clamp(0.7rem, 0.65rem + 0.2vw, 0.78rem)',
                    color: 'var(--text-3)',
                    cursor: 'pointer',
                  }}>
                    <input
                      type="checkbox"
                      checked={showPrefix}
                      onChange={(e) => handleShowPrefixChange(e.target.checked)}
                      style={{
                        width: '14px',
                        height: '14px',
                        accentColor: 'var(--accent)',
                      }}
                    />
                    显示项目前缀
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(2px, 0.25vw, 4px)' }}>
                    <span style={{ fontSize: 'clamp(0.7rem, 0.65rem + 0.2vw, 0.78rem)', color: 'var(--text-3)' }}>分隔符号:</span>
                    <select
                      value={separator}
                      onChange={(e) => handleSeparatorChange(e.target.value)}
                      style={{
                        padding: 'clamp(2px, 0.2vw, 3px) clamp(4px, 0.4vw, 6px)',
                        fontSize: 'clamp(0.7rem, 0.65rem + 0.2vw, 0.78rem)',
                        borderRadius: 'var(--r-sm)',
                        border: '1px solid var(--border-light)',
                        background: 'var(--bg)',
                        color: 'var(--text-2)',
                        outline: 'none',
                        cursor: 'pointer',
                      }}
                      onFocus={(e) => e.target.style.borderColor = 'var(--accent)'}
                      onBlur={(e) => e.target.style.borderColor = 'var(--border-light)'}
                    >
                      {SEPARATOR_OPTIONS.map(ch => (
                        <option key={ch} value={ch}>
                          {ch === ' ' ? '空格' : ch === '' ? '无' : ch}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* 预览内容 */}
              <div style={{
                padding: 'clamp(6px, 0.65vw, 10px) clamp(8px, 0.75vw, 12px)',
                background: 'rgba(255,255,255,0.6)',
                borderRadius: 'var(--r-md)',
                border: '1px solid var(--border-light)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5)',
                fontSize: 'clamp(0.75rem, 0.7rem + 0.25vw, 0.85rem)',
                fontFamily: 'monospace',
                color: 'var(--accent)',
                wordBreak: 'break-all',
                minHeight: '36px',
                lineHeight: 1.6,
              }}>
                {previewFileName}
              </div>

              {/* 长度警告 */}
              {fields.length > 8 && (
                <div style={{
                  fontSize: 'clamp(0.7rem, 0.65rem + 0.2vw, 0.78rem)',
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
      {fields.length > 0 && (
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
        display: 'flex',
        flexDirection: 'column',
        gap: 'clamp(8px, 0.75vw, 12px)',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(5px, 0.5vw, 8px)' }}>
            <div style={{
              width: '4px',
              height: '16px',
              background: 'var(--accent)',
              borderRadius: '2px',
              boxShadow: '0 0 8px rgba(59, 108, 245, 0.20)',
            }}></div>
            <span style={{
              fontSize: 'clamp(0.75rem, 0.7rem + 0.25vw, 0.85rem)',
              fontWeight: 600,
              color: 'var(--text)',
              letterSpacing: '0.02em',
            }}>
              目标文件夹
            </span>
          </div>
          <span style={{
            fontSize: 'clamp(0.625rem, 0.6rem + 0.15vw, 0.7rem)',
            color: 'var(--text-4)',
            fontStyle: 'italic',
          }}>
            可选设置
          </span>
        </div>

        <div style={{
          background: 'var(--surface)',
          borderRadius: 'var(--r-lg)',
          border: '1px solid var(--border-light)',
          boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.7)',
          padding: 'clamp(10px, 1vw, 16px)',
        }}>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'clamp(8px, 0.75vw, 12px)',
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'clamp(8px, 0.75vw, 12px)',
            }}>
              <div style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 'clamp(2px, 0.25vw, 4px)',
                minWidth: 0,
              }}>
                <div style={{
                  padding: 'clamp(6px, 0.65vw, 10px) clamp(8px, 0.75vw, 12px)',
                  background: 'rgba(255,255,255,0.6)',
                  borderRadius: 'var(--r-md)',
                  border: '1px solid var(--border-light)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5)',
                  fontSize: 'clamp(0.7rem, 0.65rem + 0.2vw, 0.78rem)',
                  color: targetFolder ? 'var(--text)' : 'var(--text-4)',
                  fontStyle: targetFolder ? 'normal' : 'italic',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  minHeight: '40px',
                  display: 'flex',
                  alignItems: 'center',
                }}>
                  {targetFolder || '未设置 — 重命名时覆盖原始文件名'}
                </div>
                {targetFolder && (
                  <button
                    onClick={clearFolder}
                    style={{
                      alignSelf: 'flex-start',
                      fontSize: 'clamp(0.625rem, 0.6rem + 0.15vw, 0.7rem)',
                      color: 'var(--text-4)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 'clamp(1px, 0.1vw, 2px) 0',
                      textDecoration: 'underline',
                      textUnderlineOffset: '2px',
                      transition: 'color 0.2s ease',
                    }}
                    onMouseEnter={(e) => e.target.style.color = 'var(--text-3)'}
                    onMouseLeave={(e) => e.target.style.color = 'var(--text-4)'}
                  >
                    清除设置，恢复弹框选择
                  </button>
                )}
              </div>

              <button
                onClick={selectFolder}
                style={{
                  padding: 'clamp(6px, 0.65vw, 10px) clamp(12px, 1.25vw, 20px)',
                  fontSize: 'clamp(0.7rem, 0.65rem + 0.2vw, 0.78rem)',
                  fontWeight: 500,
                  borderRadius: 'var(--r-md)',
                  border: '1px solid var(--accent)',
                  background: 'var(--accent)',
                  color: 'white',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.2s ease',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'clamp(4px, 0.4vw, 6px)',
                  minWidth: 'clamp(100px, 12vw, 160px)',
                  justifyContent: 'center',
                  boxShadow: '0 1px 4px rgba(59, 108, 245, 0.20)',
                }}
                onMouseEnter={(e) => {
                  e.target.style.background = 'var(--accent-dark)';
                  e.target.style.transform = 'translateY(-1px)';
                  e.target.style.boxShadow = '0 2px 8px rgba(59, 108, 245, 0.3)';
                }}
                onMouseLeave={(e) => {
                  e.target.style.background = 'var(--accent)';
                  e.target.style.transform = 'translateY(0)';
                  e.target.style.boxShadow = 'none';
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 15v4c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-4"></path>
                  <polyline points="8 10 12 14 16 10"></polyline>
                  <line x1="12" y1="14" x2="12" y2="2"></line>
                </svg>
                选择文件夹
              </button>
            </div>

            <div style={{
              fontSize: 'clamp(0.625rem, 0.6rem + 0.15vw, 0.7rem)',
              color: 'var(--text-4)',
              lineHeight: 1.5,
              paddingTop: '16px',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'clamp(4px, 0.4vw, 6px)' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="16" x2="12" y2="12"></line>
                  <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
                <span>
                  设置后重命名将直接输出到此文件夹；不设置则在重命名时覆盖原始文件名。
                </span>
              </div>
            </div>

            {/* 保留原件 */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: '16px',
            }}>
              <label style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'clamp(5px, 0.5vw, 8px)',
                cursor: targetFolder ? 'pointer' : 'not-allowed',
                opacity: targetFolder ? 1 : 0.5,
              }}>
                <input
                  type="checkbox"
                  checked={keepOriginal}
                  disabled={!targetFolder}
                  onChange={(e) => handleKeepOriginalChange(e.target.checked)}
                  style={{
                    width: '14px',
                    height: '14px',
                    accentColor: 'var(--accent)',
                    cursor: targetFolder ? 'pointer' : 'not-allowed',
                  }}
                />
                <span style={{
                  fontSize: 'clamp(0.75rem, 0.7rem + 0.25vw, 0.85rem)',
                  color: targetFolder ? 'var(--text)' : 'var(--text-4)',
                }}>
                  保留原件
                </span>
              </label>
              <span style={{
                fontSize: 'clamp(0.625rem, 0.6rem + 0.15vw, 0.7rem)',
                color: 'var(--text-4)',
              }}>
                勾选则复制原件到目标文件夹；不勾选则剪切原件到目标文件夹
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
