import { useState, useEffect, useRef, useCallback } from 'react'
import RenameSettings from './RenameSettings'
import AutoSaveToast, { useAutoSaveToast } from './AutoSaveToast'
import SettingsTitlebar from './SettingsTitlebar'
import Toggle from './Toggle'
import '../settings-printer.css'
import { PAPER_REGISTRY, MARGIN_PRESETS } from '../config'

// 分隔符号选项（用于压缩包重命名）
const ARCHIVE_SEPARATOR_OPTIONS = ['_', '-', ',', '+', '#', '·', ' ', '']

// 日期格式选项（用于压缩包重命名）
const DATE_FORMAT_OPTIONS = [
  { value: 'none',           label: '无',             sample: '' },
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

export default function SettingsWindow({ settings, saveSettings, printers, electronAPI }) {
  const [activeTab, setActiveTab] = useState('printer')
  const contentRef = useRef(null)
  
  // 自动保存提示
  const { visible: toastVisible, trigger: triggerToast, onHidden: onToastHidden } = useAutoSaveToast()
  
  // 包装 saveSettings 函数，保存后触发提示
  const saveSettingsWithToast = useCallback((newSettings) => {
    saveSettings(newSettings)
    triggerToast()
  }, [saveSettings, triggerToast])

  // ── 纸张选项 ──
  // 当前仅使用硬编码注册表，后续可接入打印机能力查询（含 paperkind）
  const mergedPaperOptions = PAPER_REGISTRY

  // 初始化主题 - 从 localStorage 读取并应用到当前 document
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme')
    const isDark = savedTheme === 'dark'
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
  }, [])

  // 监听 localStorage 变化（如果主窗口修改了主题）
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === 'theme') {
        const isDark = e.newValue === 'dark'
        document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
      }
    }
    window.addEventListener('storage', handleStorageChange)
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [])

  // 打包设置状态（从 settings 中初始化，变更时自动保存）
  const packSettings = settings.packSettings || {}
  const [packTargetFolder, setPackTargetFolder] = useState(packSettings.packTargetFolder || '')
  const [packKeepOriginal, setPackKeepOriginal] = useState(packSettings.packKeepOriginal ?? false)
  const [packArchiveFormat, setPackArchiveFormat] = useState(packSettings.packArchiveFormat || 'ZIP')
  const [packRenameBeforeArchive, setPackRenameBeforeArchive] = useState(packSettings.packRenameBeforeArchive ?? false)
  const [packArchiveNamePrefix, setPackArchiveNamePrefix] = useState(packSettings.packArchiveNamePrefix ?? '发票')
  const [packArchiveNameDateFormat, setPackArchiveNameDateFormat] = useState(packSettings.packArchiveNameDateFormat || 'YYYY年MM月DD日')
  const [packArchiveNameSeparator, setPackArchiveNameSeparator] = useState(packSettings.packArchiveNameSeparator ?? '_')
  const [packNameFieldOrder, setPackNameFieldOrder] = useState(packSettings.packNameFieldOrder || ['prefix', 'date'])

  // 打包设置变更时自动保存到 settings
  const updatePackSettings = useCallback((key, val) => {
    const newPackSettings = {
      packTargetFolder: key === 'packTargetFolder' ? val : packTargetFolder,
      packKeepOriginal: key === 'packKeepOriginal' ? val : packKeepOriginal,
      packArchiveFormat: key === 'packArchiveFormat' ? val : packArchiveFormat,
      packRenameBeforeArchive: key === 'packRenameBeforeArchive' ? val : packRenameBeforeArchive,
      packArchiveNamePrefix: key === 'packArchiveNamePrefix' ? val : packArchiveNamePrefix,
      packArchiveNameDateFormat: key === 'packArchiveNameDateFormat' ? val : packArchiveNameDateFormat,
      packArchiveNameSeparator: key === 'packArchiveNameSeparator' ? val : packArchiveNameSeparator,
      packNameFieldOrder: key === 'packNameFieldOrder' ? val : packNameFieldOrder,
    }
    saveSettingsWithToast({ ...settings, packSettings: newPackSettings })
  }, [settings, saveSettingsWithToast, packTargetFolder, packKeepOriginal, packArchiveFormat, packRenameBeforeArchive, packArchiveNamePrefix, packArchiveNameDateFormat, packArchiveNameSeparator, packNameFieldOrder])

  // 打包设置字段变更的包装函数
  const handlePackTargetFolderChange = (val) => { setPackTargetFolder(val); updatePackSettings('packTargetFolder', val) }
  const handlePackKeepOriginalChange = (val) => { setPackKeepOriginal(val); updatePackSettings('packKeepOriginal', val) }
  const handlePackArchiveFormatChange = (val) => { setPackArchiveFormat(val); updatePackSettings('packArchiveFormat', val) }
  const handlePackRenameBeforeArchiveChange = (val) => { setPackRenameBeforeArchive(val); updatePackSettings('packRenameBeforeArchive', val) }
  const handlePackArchiveNamePrefixChange = (val) => { setPackArchiveNamePrefix(val); updatePackSettings('packArchiveNamePrefix', val) }
  const handlePackArchiveNameDateFormatChange = (val) => { setPackArchiveNameDateFormat(val); updatePackSettings('packArchiveNameDateFormat', val) }
  const handlePackArchiveNameSeparatorChange = (val) => { setPackArchiveNameSeparator(val); updatePackSettings('packArchiveNameSeparator', val) }
  const handlePackNameFieldOrderChange = (newOrder) => { setPackNameFieldOrder(newOrder); updatePackSettings('packNameFieldOrder', newOrder) }

  // 根据内容调整窗口大小
  const resizeWindow = useCallback(() => {
    if (!contentRef.current || !electronAPI) return

    // 打印机标签使用固定尺寸，打包标签使用750px宽度，重命名标签由 RenameSettings 组件自行处理
    if (activeTab === 'printer') {
      electronAPI.ipcRenderer.invoke('resize-settings-window', {
        width: 750,
        height: 750
      }).catch(err => {
        console.warn('[SettingsWindow] 调整窗口大小失败:', err)
      })
    } else if (activeTab === 'pack') {
      electronAPI.ipcRenderer.invoke('resize-settings-window', {
        width: 750,
        height: 650
      }).catch(err => {
        console.warn('[SettingsWindow] 调整窗口大小失败:', err)
      })
    }
  }, [electronAPI, activeTab])

  // 当标签切换时调整窗口大小
  useEffect(() => {
    // 稍微延迟一下，等待内容渲染完成
    const timer = setTimeout(() => {
      resizeWindow()
    }, 150)

    return () => clearTimeout(timer)
  }, [activeTab, resizeWindow])

  // 打包设置 - 选择文件夹
  const selectPackFolder = async () => {
    try {
      const result = await electronAPI.ipcRenderer.invoke('show-open-dialog', {
        properties: ['openDirectory'],
      })
      if (result && result.filePaths && result.filePaths.length > 0) {
        handlePackTargetFolderChange(result.filePaths[0])
      }
    } catch (err) {
      console.warn('[SettingsWindow] 选择文件夹失败:', err)
    }
  }

  // 打包设置 - 清除文件夹设置
  const clearPackFolder = () => {
    handlePackTargetFolderChange('')
    handlePackKeepOriginalChange(false)
  }

  const tabs = [
    {
      key: 'printer', label: '打印机',
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: '14px', height: '14px' }}><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>,
    },
    {
      key: 'rename', label: '重命名',
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: '14px', height: '14px' }}><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>,
    },
    {
      key: 'pack', label: '打包',
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: '14px', height: '14px' }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
      <SettingsTitlebar />
      <div className="settings-layout">
        {/* 左侧边栏导航 */}
        <nav className="settings-sidebar">
          {tabs.map(({ key, label, icon }) => (
            <button
              key={key}
              className={`settings-sidebar-item ${activeTab === key ? 'active' : ''}`}
              onClick={() => setActiveTab(key)}
            >
              <span className="settings-sidebar-icon">{icon}</span>
              <span className="settings-sidebar-label">{label}</span>
            </button>
          ))}
        </nav>

        {/* 右侧内容区 */}
        <div className="settings-content" ref={contentRef}>
          <div style={{
            position: 'relative',
            minHeight: '300px',
          }}>
            {/* 打印机标签内容 */}
            <div className="printer-settings" style={{
              position: activeTab === 'printer' ? 'relative' : 'absolute',
              opacity: activeTab === 'printer' ? 1 : 0,
              transform: activeTab === 'printer' ? 'translateX(0) translateY(0)' : 'translateX(8px) translateY(4px)',
              transition: 'opacity 0.25s ease, transform 0.25s ease',
              pointerEvents: activeTab === 'printer' ? 'auto' : 'none',
            }}>
              {/* 打印机选择卡片 */}
              <div className="printer-card">
                <div className="printer-card-header">
                  <div className="printer-card-header-icon">
                    <svg viewBox="0 0 1228 1024" style={{ width: 16, height: 16, fill: 'currentColor' }}>
                      <path d="M285.866667 85.333333H648.533333a149.333333 149.333333 0 0 1 149.333334 149.333334V341.333333a42.666667 42.666667 0 0 1-42.666667 42.666667h-469.333333a42.666667 42.666667 0 0 1-42.666667-42.666667V128a42.666667 42.666667 0 0 1 42.666667-42.666667z"/>
                      <path d="M243.2 640m42.666667 0l469.333333 0q42.666667 0 42.666667 42.666667l0 213.333333q0 42.666667-42.666667 42.666667l-469.333333 0q-42.666667 0-42.666667-42.666667l0-213.333333q0-42.666667 42.666667-42.666667Z"/>
                      <path d="M833.408 768v-170.666667H207.658667v170.666667H93.866667a42.666667 42.666667 0 0 1-42.666667-42.666667V298.666667a42.666667 42.666667 0 0 1 42.666667-42.666667h113.792v170.666667h625.749333V256H947.2a42.666667 42.666667 0 0 1 42.666667 42.666667v426.666666a42.666667 42.666667 0 0 1-42.666667 42.666667h-113.792z"/>
                      <path d="M123.733333 328.533333m-42.666666 0a42.666667 42.666667 0 1 0 85.333333 0 42.666667 42.666667 0 1 0-85.333333 0Z"/>
                    </svg>
                  </div>
                  <span className="printer-card-header-title">打印机设置</span>
                </div>

                <div className="printer-form-row">
                  <label className="printer-form-label">打印机</label>
                  <select
                    className="printer-select"
                    value={settings.printerName}
                    onChange={(e) => saveSettingsWithToast({ ...settings, printerName: e.target.value })}
                  >
                    {printers.length === 0 && <option value="">未检测到打印机</option>}
                    {printers.map((p) => (<option key={p} value={p}>{p}</option>))}
                  </select>
                </div>

                <div className="printer-checkbox-row">
                  <Toggle
                    checked={settings.grayscale}
                    onChange={(val) => saveSettingsWithToast({ ...settings, grayscale: val })}
                  />
                  <label className="printer-checkbox-label">灰度打印</label>
                </div>
              </div>

              {/* 打印份数卡片 */}
              <div className="printer-card">
                <div className="printer-card-header">
                  <div className="printer-card-header-icon">
                    <svg viewBox="0 0 1150 1024" style={{ width: 16, height: 16, fill: 'currentColor' }}>
                      <path d="M575.213163 570.785185a37.925926 37.925926 0 0 1-15.865679-3.476543l-537.28395-247.466667a37.925926 37.925926 0 0 1 0-68.898765l537.28395-247.466667a37.925926 37.925926 0 0 1 31.604939 0l537.28395 247.466667a37.925926 37.925926 0 0 1 0 68.898765l-537.28395 247.466667a37.925926 37.925926 0 0 1-15.73926 3.476543zM128.572176 285.392593L575.213163 491.077531l446.640988-205.684938L575.213163 79.707654zM1093.534151 705.548642l-518.320988 238.743704-518.320987-238.743704v83.500247l502.455308 231.474568a37.925926 37.925926 0 0 0 31.604939 0L1093.534151 789.048889z"/>
                      <path d="M1093.534151 478.688395l-518.320988 238.806914L56.892176 478.688395V562.567901l502.455308 231.411358a37.925926 37.925926 0 0 0 31.604939 0L1093.534151 562.567901z"/>
                    </svg>
                  </div>
                  <span className="printer-card-header-title">打印份数</span>
                </div>

                <div className="printer-form-row">
                  <label className="printer-form-label">份数</label>
                  <input
                    type="number"
                    className="printer-input"
                    min="1"
                    max="99"
                    value={settings.copies}
                    onChange={(e) => saveSettingsWithToast({ ...settings, copies: parseInt(e.target.value) || 1 })}
                  />
                </div>

                <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
                  <div className="printer-checkbox-row">
                    <Toggle
                      checked={settings.copies >= 2 ? settings.collate : true}
                      disabled={settings.copies < 2}
                      onChange={(val) => saveSettingsWithToast({ ...settings, collate: val })}
                    />
                    <label
                      className={`printer-checkbox-label ${settings.copies < 2 ? 'disabled' : ''}`}
                    >逐份打印</label>
                  </div>

                  <div className="printer-checkbox-row">
                    <Toggle
                      checked={settings.extraSpecial}
                      onChange={(val) => saveSettingsWithToast({ ...settings, extraSpecial: val })}
                    />
                    <label className="printer-checkbox-label">一普二专</label>
                    <span style={{ fontSize: '11px', color: 'var(--text-4)', marginLeft: '4px' }}>普票打印一份，专票打印两份</span>
                  </div>
                </div>
              </div>

              {/* 纸张设置卡片 */}
              <div className="printer-card">
                <div className="printer-card-header">
                  <div className="printer-card-header-icon">
                    <svg viewBox="0 0 1024 1024" style={{ width: 16, height: 16, fill: 'currentColor' }}>
                      <path d="M192 128a64 64 0 0 0-64 64v640a64 64 0 0 0 64 64h640a64 64 0 0 0 64-64v-640a64 64 0 0 0-64-64h-640m0-128h640a192 192 0 0 1 192 192v640a192 192 0 0 1-192 192h-640a192 192 0 0 1-192-192v-640a192 192 0 0 1 192-192z"/>
                      <path d="M224 467.2m64 0l0 0q64 0 64 64l0 192q0 64-64 64l0 0q-64 0-64-64l0-192q0-64 64-64Z"/>
                      <path d="M797.952 554.752m-64 0l0 0q-64 0-64-64l0-192q0-64 64-64l0 0q64 0 64 64l0 192q0 64-64 64Z"/>
                      <path d="M554.752 669.952m0 64l0 0q0 64-64 64l-192 0q-64 0-64-64l0 0q0-64 64-64l192 0q64 0 64 64Z"/>
                      <path d="M467.2 352m0-64l0 0q0-64 64-64l192 0q64 0 64 64l0 0q0 64-64 64l-192 0q-64 0-64-64Z"/>
                    </svg>
                  </div>
                  <span className="printer-card-header-title">纸张设置</span>
                </div>

                <div className="printer-form-row">
                  <label className="printer-form-label">纸张</label>
                  <select
                    className="printer-select"
                    value={settings.paperSize}
                    onChange={(e) => {
                      const newSize = e.target.value
                      const updates = { paperSize: newSize, paperkind: undefined }
                      if (newSize !== 'Custom') {
                        delete updates.customPaper
                      }
                      saveSettingsWithToast({ ...settings, ...updates })
                    }}
                  >
                    {mergedPaperOptions.map(p => {
                      const value = p.name || p.id
                      const label = p.label || p.name || value
                      const dims = p.widthMM && p.heightMM
                        ? `${p.widthMM}×${p.heightMM}mm`
                        : null
                      return (
                        <option key={value} value={value}>
                          {label}{dims ? ` (${dims})` : ''}
                        </option>
                      )
                    })}
                  </select>

                  {/* 自定义尺寸输入 */}
                  {settings.paperSize === 'Custom' && (
                    <div style={{ display: 'flex', gap: 'clamp(5px, 0.5vw, 8px)', marginTop: 'clamp(5px, 0.5vw, 8px)', alignItems: 'center' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                        <label className="printer-form-label" style={{ fontSize: 'clamp(0.625rem, 0.6rem + 0.15vw, 0.7rem)', marginBottom: '2px' }}>宽度 (mm)</label>
                        <input
                          type="number"
                          className="printer-input"
                          min={50}
                          max={1000}
                          step={0.5}
                          placeholder="50-1000"
                          value={settings.customPaper?.widthMM ?? ''}
                          onChange={(e) => {
                            const w = parseFloat(e.target.value)
                            saveSettingsWithToast({
                              ...settings,
                              customPaper: { ...settings.customPaper, widthMM: isNaN(w) ? undefined : w }
                            })
                          }}
                        />
                      </div>
                      <span style={{ marginTop: 'clamp(10px, 1vw, 16px)', color: '#6b7280' }}>×</span>
                      <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                        <label className="printer-form-label" style={{ fontSize: 'clamp(0.625rem, 0.6rem + 0.15vw, 0.7rem)', marginBottom: '2px' }}>高度 (mm)</label>
                        <input
                          type="number"
                          className="printer-input"
                          min={50}
                          max={1000}
                          step={0.5}
                          placeholder="50-1000"
                          value={settings.customPaper?.heightMM ?? ''}
                          onChange={(e) => {
                            const h = parseFloat(e.target.value)
                            saveSettingsWithToast({
                              ...settings,
                              customPaper: { ...settings.customPaper, heightMM: isNaN(h) ? undefined : h }
                            })
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* 合并发票设置 */}
                <div className="printer-form-row" style={{ marginTop: 'clamp(8px, 0.75vw, 12px)' }}>
                  <label className="printer-form-label">合并</label>
                  <select
                    className="printer-merge-select"
                    value={settings.mergeMode || 'none'}
                    onChange={(e) => saveSettingsWithToast({ ...settings, mergeMode: e.target.value })}
                  >
                    <option value="none">不合并</option>
                    <option value="merge2">两票一页（1页纸2张发票）</option>
                    <option value="merge3">三票一页（1页纸3张发票）</option>
                    <option value="merge4">四票一页（1页纸4张发票）</option>
                  </select>
                </div>

                {/* 页边距设置 */}
                <div className="printer-margin-section" style={{ marginTop: 'clamp(5px, 0.5vw, 8px)' }}>
                  <div className="printer-margin-header">
                    <span className="printer-form-label">页边距</span>
                    <span className="printer-help-icon"
                      title="扩展 PDF 白边，防止打印内容被打印机物理裁剪区域切掉。每个方向可独立设置，单位为毫米(mm)。">
                      ⓘ
                    </span>
                  </div>

                  {/* 预设下拉 */}
                  <div className="printer-form-row">
                    <div className="printer-form-control">
                      <select
                        className="printer-select"
                        value={settings.marginPreset || 'default'}
                        onChange={(e) => {
                          const preset = e.target.value
                          if (preset !== 'custom' && MARGIN_PRESETS[preset]) {
                            const p = MARGIN_PRESETS[preset]
                            saveSettingsWithToast({
                              ...settings,
                              marginPreset: preset,
                              marginLeft: p.left,
                              marginRight: p.right,
                              marginTop: p.top,
                              marginBottom: p.bottom,
                            })
                          } else {
                            saveSettingsWithToast({ ...settings, marginPreset: 'custom' })
                          }
                        }}
                      >
                        <option value="default">普通安全边距（3mm）</option>
                        <option value="binding">装订加宽（左8mm）</option>
                        <option value="label">标签/票据（上10mm）</option>
                        <option value="leftOffset">打印机左偏（左5mm）</option>
                        <option value="borderless">无边距（0mm）</option>
                        <option value="custom">自定义</option>
                      </select>
                    </div>
                  </div>

                  {/* 四方向输入网格 */}
                  <div className="printer-margin-grid"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: 'clamp(4px, 0.4vw, 6px)',
                      marginTop: 'clamp(4px, 0.4vw, 6px)',
                    }}>
                    <div className="printer-margin-input-group">
                      <label className="printer-margin-input-label">上</label>
                      <input
                        type="number"
                        className="printer-margin-input"
                        min="0"
                        max="50"
                        step="0.5"
                        value={settings.marginTop ?? 3}
                        onChange={(e) => saveSettingsWithToast({
                          ...settings,
                          marginTop: Math.max(0, parseFloat(e.target.value) || 0),
                          marginPreset: 'custom',
                        })}
                      />
                      <span className="printer-margin-unit">mm</span>
                    </div>
                    <div className="printer-margin-input-group">
                      <label className="printer-margin-input-label">下</label>
                      <input
                        type="number"
                        className="printer-margin-input"
                        min="0"
                        max="50"
                        step="0.5"
                        value={settings.marginBottom ?? 3}
                        onChange={(e) => saveSettingsWithToast({
                          ...settings,
                          marginBottom: Math.max(0, parseFloat(e.target.value) || 0),
                          marginPreset: 'custom',
                        })}
                      />
                      <span className="printer-margin-unit">mm</span>
                    </div>
                    <div className="printer-margin-input-group">
                      <label className="printer-margin-input-label">左</label>
                      <input
                        type="number"
                        className="printer-margin-input"
                        min="0"
                        max="50"
                        step="0.5"
                        value={settings.marginLeft ?? 3}
                        onChange={(e) => saveSettingsWithToast({
                          ...settings,
                          marginLeft: Math.max(0, parseFloat(e.target.value) || 0),
                          marginPreset: 'custom',
                        })}
                      />
                      <span className="printer-margin-unit">mm</span>
                    </div>
                    <div className="printer-margin-input-group">
                      <label className="printer-margin-input-label">右</label>
                      <input
                        type="number"
                        className="printer-margin-input"
                        min="0"
                        max="50"
                        step="0.5"
                        value={settings.marginRight ?? 3}
                        onChange={(e) => saveSettingsWithToast({
                          ...settings,
                          marginRight: Math.max(0, parseFloat(e.target.value) || 0),
                          marginPreset: 'custom',
                        })}
                      />
                      <span className="printer-margin-unit">mm</span>
                    </div>
                  </div>

                  <div className="printer-hint" style={{ marginTop: 'clamp(2px, 0.25vw, 4px)' }}>
                    扩展 PDF 白边，防止打印内容被裁切。设置在打印前生效，不影响文件本身。
                  </div>
                </div>

                <div className="printer-checkbox-row" style={{ marginTop: '4px' }}>
                  <Toggle
                    checked={settings.autoOrient ?? false}
                    onChange={(val) => saveSettingsWithToast({ ...settings, autoOrient: val })}
                  />
                  <label className="printer-checkbox-label">自动回正</label>
                  <span style={{ fontSize: '11px', color: 'var(--text-4)', marginLeft: '4px' }}>
                    自动检测文字方向并旋转（不稳定，解析慢）
                  </span>
                </div>
              </div>

            </div>
            {/* 重命名标签内容 */}
            <div style={{
              position: activeTab === 'rename' ? 'relative' : 'absolute',
              opacity: activeTab === 'rename' ? 1 : 0,
              transform: activeTab === 'rename' ? 'translateX(0) translateY(0)' : 'translateX(8px) translateY(4px)',
              transition: 'opacity 0.25s ease, transform 0.25s ease',
              pointerEvents: activeTab === 'rename' ? 'auto' : 'none',
              width: '100%',
            }}>
              <RenameSettings
                renameSettings={settings.renameSettings || {}}
                onSave={(renameSettings) => saveSettingsWithToast({ ...settings, renameSettings })}
                electronAPI={electronAPI}
                active={activeTab === 'rename'}
              />
            </div>

            {/* ========== 打包设置 ========== */}
            <div style={{
              position: activeTab === 'pack' ? 'relative' : 'absolute',
              opacity: activeTab === 'pack' ? 1 : 0,
              transform: activeTab === 'pack' ? 'translateX(0) translateY(0)' : 'translateX(8px) translateY(4px)',
              transition: 'opacity 0.25s ease, transform 0.25s ease',
              pointerEvents: activeTab === 'pack' ? 'auto' : 'none',
              width: '100%',
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>

                {/* 打包规则卡片 */}
                <div className="printer-card" style={{ padding: '16px' }}>
                  <div className="printer-card-header">
                    <div className="printer-card-header-icon">
                      <svg viewBox="0 0 1024 1024" style={{ width: 16, height: 16, fill: 'currentColor' }}>
                        <path d="M556.664757 243.934708l178.667216 0 0 535.9996L288.664957 779.934309 288.664957 243.934708l223.334531 0 0 44.753273-44.667316 0 0 44.665269 44.667316 0 0 44.667316-44.667316 0 0 44.621267 44.667316 0 0 44.623313-44.667316 0 0 44.665269 0 134.043902 89.333608 0L556.665781 511.932462l-44.665269 0 0-44.665269 44.665269 0 0-44.623313-44.665269 0 0-44.621267 44.665269 0 0-44.667316-44.665269 0L512.000512 288.687982l44.665269 0L556.665781 243.934708zM958.70846 243.934708l0 535.9996c0 98.711186-80.08599 178.709171-178.711218 178.709171L243.998665 958.64348c-98.711186 0-178.709171-79.997985-178.709171-178.709171L65.289494 243.934708c0-98.581226 79.997985-178.579211 178.709171-178.579211l535.998577 0C878.62247 65.355497 958.70846 145.353482 958.70846 243.934708zM869.286848 288.687982c0-74.067926-59.932997-134.042879-133.954875-134.042879L288.664957 154.645103c-74.021877 0-133.954875 59.974953-133.954875 134.042879l0 446.577988c0 74.023924 59.932997 134.086881 133.954875 134.086881l446.667016 0c74.021877 0 133.954875-60.062957 133.954875-134.086881L869.286848 288.687982z"/>
                      </svg>
                    </div>
                    <span className="printer-card-header-title">打包规则</span>
                  </div>

                  <div className="printer-checkbox-row">
                    <Toggle
                      checked={packRenameBeforeArchive}
                      onChange={handlePackRenameBeforeArchiveChange}
                    />
                    <label className="printer-checkbox-label">打包前先进行发票重命名</label>
                    <span style={{ fontSize: '11px', color: 'var(--text-4)', marginLeft: '4px' }}>按重命名规则重命名后再打包</span>
                  </div>

                  <div className="printer-form-row" style={{ marginTop: '4px' }}>
                    <label className="printer-form-label">压缩格式</label>
                    <div className="printer-form-control" style={{ display: 'flex', gap: '6px' }}>
                      {['ZIP', 'RAR', '7Z'].map((format) => (
                        <button
                          key={format}
                          onClick={() => handlePackArchiveFormatChange(format)}
                          style={{
                            flex: 1,
                            padding: '8px 10px',
                            fontSize: '12px',
                            fontWeight: 500,
                            borderRadius: 'var(--r-sm)',
                            border: 'none',
                            background: packArchiveFormat === format ? 'var(--accent-gradient)' : 'var(--surface)',
                            color: packArchiveFormat === format ? '#fff' : 'var(--text-3)',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                            transition: 'all 0.15s ease',
                            boxShadow: packArchiveFormat === format ? '0 2px 6px rgba(79,124,255,0.25)' : 'none',
                          }}
                          onMouseEnter={(e) => {
                            if (packArchiveFormat !== format) e.currentTarget.style.background = 'var(--surface-hover)'
                          }}
                          onMouseLeave={(e) => {
                            if (packArchiveFormat !== format) e.currentTarget.style.background = 'var(--surface)'
                          }}
                        >
                          {format}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '8px', borderTop: '1px solid var(--border-light)' }}>
                    <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>命名规则</div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '6px',
                        padding: '10px 12px',
                        background: 'var(--surface)',
                        borderRadius: 'var(--r-md)',
                        border: '1.5px dashed #d2d2d7',
                        minHeight: '50px',
                      }}
                      onDragOver={(e) => e.preventDefault()}
                    >
                      {packNameFieldOrder.map((fieldType, index) => (
                        <div key={fieldType} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <div
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData('text/plain', fieldType)
                              e.dataTransfer.effectAllowed = 'move'
                            }}
                            onDrop={(e) => {
                              e.preventDefault()
                              const draggedType = e.dataTransfer.getData('text/plain')
                              if (draggedType !== fieldType) {
                                const newOrder = [...packNameFieldOrder]
                                const draggedIndex = newOrder.indexOf(draggedType)
                                const targetIndex = newOrder.indexOf(fieldType)
                                newOrder.splice(draggedIndex, 1)
                                newOrder.splice(targetIndex, 0, draggedType)
                                handlePackNameFieldOrderChange(newOrder)
                              }
                            }}
                            onDragOver={(e) => e.preventDefault()}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px',
                              padding: '4px 10px',
                              background: 'var(--accent-gradient)',
                              borderRadius: '6px',
                              color: '#fff',
                              fontSize: '11px',
                              fontWeight: 500,
                              cursor: 'grab',
                              boxShadow: '0 2px 6px rgba(79,124,255,0.2)',
                            }}
                          >
                            <span style={{ opacity: 0.7, fontSize: '12px' }}>&#9776;</span>
                            {fieldType === 'prefix' ? (
                              <input
                                type="text"
                                value={packArchiveNamePrefix}
                                onChange={(e) => handlePackArchiveNamePrefixChange(e.target.value)}
                                placeholder="前缀"
                                style={{
                                  width: '80px',
                                  padding: '2px 6px',
                                  fontSize: '11px',
                                  borderRadius: '4px',
                                  border: 'none',
                                  background: 'rgba(255,255,255,0.25)',
                                  color: '#fff',
                                  outline: 'none',
                                  fontWeight: 500,
                                }}
                                onClick={(e) => e.stopPropagation()}
                              />
                            ) : (
                              <select
                                value={packArchiveNameDateFormat}
                                onChange={(e) => handlePackArchiveNameDateFormatChange(e.target.value)}
                                style={{
                                  padding: '2px 4px',
                                  fontSize: '11px',
                                  borderRadius: '4px',
                                  border: 'none',
                                  background: 'rgba(255,255,255,0.25)',
                                  color: '#fff',
                                  outline: 'none',
                                  cursor: 'pointer',
                                  fontWeight: 500,
                                }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                {DATE_FORMAT_OPTIONS.map(opt => (
                                  <option key={opt.value} value={opt.value} style={{ color: '#1d1d1f' }}>{opt.label}</option>
                                ))}
                              </select>
                            )}
                          </div>
                          {index < packNameFieldOrder.length - 1 && (() => {
                            const hasPrefix = packArchiveNamePrefix && packArchiveNamePrefix.trim() !== ''
                            const hasDate = packArchiveNameDateFormat !== 'none'
                            return hasPrefix && hasDate
                          })() && (
                            <select
                              value={packArchiveNameSeparator}
                              onChange={(e) => handlePackArchiveNameSeparatorChange(e.target.value)}
                              style={{
                                padding: '3px 6px',
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
                              {ARCHIVE_SEPARATOR_OPTIONS.map(ch => (
                                <option key={ch} value={ch}>
                                  {ch === ' ' ? '空格' : ch === '' ? '无' : ch}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      ))}
                    </div>

                    <div style={{
                      padding: '10px 12px',
                      background: 'var(--surface)',
                      borderRadius: 'var(--r-md)',
                      fontSize: '11px',
                      color: 'var(--accent)',
                      fontFamily: 'inherit',
                      fontWeight: 500,
                    }}>
                      {(() => {
                        const dateMap = {
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
                        const dateStr = packArchiveNameDateFormat === 'none' ? '' : (dateMap[packArchiveNameDateFormat] || '')
                        const prefix = packArchiveNamePrefix || ''
                        const parts = packNameFieldOrder.map(type =>
                          type === 'prefix' ? prefix : dateStr
                        ).filter(Boolean)
                        const sep = parts.length > 1 ? packArchiveNameSeparator : ''
                        return `${parts.join(sep)}.${packArchiveFormat.toLowerCase()}`
                      })()}
                    </div>
                  </div>

                  <div className="printer-checkbox-row">
                    <Toggle
                      checked={packKeepOriginal}
                      onChange={handlePackKeepOriginalChange}
                    />
                    <label className="printer-checkbox-label">保留原件</label>
                    <span style={{ fontSize: '11px', color: 'var(--text-4)', marginLeft: '4px' }}>不勾选则剪切原文件到压缩包</span>
                  </div>
                </div>

                {/* 目标文件夹卡片 */}
                <div className="printer-card" style={{ padding: '16px' }}>
                  <div className="printer-card-header">
                    <div className="printer-card-header-icon">
                      <svg viewBox="0 0 1024 1024" style={{ width: 16, height: 16, fill: 'currentColor' }}>
                        <path d="M919.68 949.12H103.68a96 96 0 0 1-96-96V167.04a96 96 0 0 1 96-96H384a95.36 95.36 0 0 1 72.96 33.92l56.32 64a33.28 33.28 0 0 0 24.32 10.88h378.88a96 96 0 0 1 96.64 96v576a96 96 0 0 1-93.44 97.28zM103.68 135.04a32 32 0 0 0-32 32v686.08a32 32 0 0 0 32 32h816a32.64 32.64 0 0 0 32-32v-576a32 32 0 0 0-32-32H540.8a99.2 99.2 0 0 1-74.24-33.28l-56.32-64a33.92 33.92 0 0 0-26.24-12.8z"/>
                        <path d="M945.28 374.4H78.08a32 32 0 1 1 0-64h867.2a32 32 0 0 1 0 64z"/>
                      </svg>
                    </div>
                    <span className="printer-card-header-title">目标文件夹</span>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <div style={{
                      flex: 1,
                      padding: '8px 12px',
                      background: 'var(--surface)',
                      borderRadius: 'var(--r-sm)',
                      fontSize: '11px',
                      color: packTargetFolder ? 'var(--text)' : 'var(--text-4)',
                      fontStyle: packTargetFolder ? 'normal' : 'italic',
                      fontWeight: 500,
                      minHeight: '32px',
                      display: 'flex',
                      alignItems: 'center',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {packTargetFolder || '未设置 — 打包时弹出选择文件夹对话框'}
                    </div>
                    <button
                      onClick={selectPackFolder}
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

                  {packTargetFolder && (
                    <button
                      onClick={clearPackFolder}
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

                  <div className="printer-hint">设置后打包将直接输出到此文件夹；不设置则弹出选择文件夹对话框。</div>
                </div>

              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 自动保存提示 */}
      <AutoSaveToast visible={toastVisible} onHidden={onToastHidden} />
    </div>
  )
}
