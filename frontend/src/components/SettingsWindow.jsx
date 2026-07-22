import { useState, useEffect, useRef, useCallback } from 'react'
import RenameSettings from './RenameSettings'
import AutoSaveToast, { useAutoSaveToast } from './AutoSaveToast'
import SettingsTitlebar from './SettingsTitlebar'
import Toggle from './Toggle'
import '../settings-printer.css'
import { PAPER_REGISTRY, MARGIN_PRESETS } from '../config'

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

  const getWindowWidth = useCallback(() => {
    const screenWidth = window.screen.width
    if (screenWidth >= 3840) return 1100
    if (screenWidth >= 2560) return 850
    return Math.min(850, Math.max(750, Math.round(screenWidth * 0.45)))
  }, [])

  const getWindowHeight = useCallback(() => {
    const screenHeight = window.screen.height
    if (screenHeight >= 2160) return 1000
    if (screenHeight >= 1440) return 850
    return Math.min(850, Math.max(700, Math.round(screenHeight * 0.65)))
  }, [])

  const resizeWindow = useCallback(() => {
    if (!contentRef.current || !electronAPI) return

    const width = getWindowWidth()
    const innerContainer = contentRef.current.firstElementChild
    const contentHeight = innerContainer ? innerContainer.scrollHeight : contentRef.current.scrollHeight
    const titlebarHeight = 40
    const padding = 30
    const calculatedHeight = contentHeight + titlebarHeight + padding
    
    if (activeTab === 'printer') {
      electronAPI.ipcRenderer.invoke('resize-settings-window', {
        width,
        height: calculatedHeight
      }).catch(err => {
        console.warn('[SettingsWindow] 调整窗口大小失败:', err)
      })
    }
  }, [electronAPI, activeTab, getWindowWidth])

  // 当标签切换时调整窗口大小
  useEffect(() => {
    // 稍微延迟一下，等待内容渲染完成
    const timer = setTimeout(() => {
      resizeWindow()
    }, 150)

    return () => clearTimeout(timer)
  }, [activeTab, resizeWindow])

  const tabs = [
    {
      key: 'printer', label: '打印机',
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: '14px', height: '14px' }}><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>,
    },
    {
      key: 'rename', label: '重命名',
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: '14px', height: '14px' }}><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>,
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)', color: 'var(--text)' }}>
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
            minHeight: 'fit-content',
          }}>
            {/* 打印机标签内容 */}
            <div className="printer-settings" style={{
            display: activeTab === 'printer' ? 'flex' : 'none',
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
                      // ✅ 写边界：确保非 Custom 时 customPaper 真正被移除，
                      //    禁止产生 { paperSize:'A5', customPaper:{...} } 非法组合（L2/L3 收口）
                      const next = { ...settings, paperSize: newSize, paperkind: undefined }
                      if (newSize !== 'Custom') {
                        delete next.customPaper
                      }
                      saveSettingsWithToast(next)
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
              display: activeTab === 'rename' ? 'block' : 'none',
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

          </div>
        </div>
      </div>

      {/* 自动保存提示 */}
      <AutoSaveToast visible={toastVisible} onHidden={onToastHidden} />
    </div>
  )
}
