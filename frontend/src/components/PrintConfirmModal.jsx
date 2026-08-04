import { memo, useCallback } from 'react'
import Toggle from './Toggle'
import PrintPreviewCanvas from './PrintPreviewCanvas'
import { PAPER_REGISTRY, MARGIN_PRESETS } from '../config'
import '../settings-printer.css'

/**
 * 打印确认弹窗（新版）
 *
 * 布局：3:2 比例（900×600）
 *   - 左侧：打印机设置区（完整迁移自 SettingsWindow 打印机页）
 *   - 右侧：打印布局预览（Phase 3.5 Preview Skeleton — PrintPreviewModel 驱动的
 *     纸张比例 / 槽位框 / 页导航；不渲染 PDF 像素，内容渲染待 Phase 4）
 *   - 底部：取消 / 确认打印
 */
const PrintConfirmModal = ({
  visible,
  settings,
  saveSettings,
  printers,
  totalFiles,
  mergeMode,
  isOneNormalTwoSpecial,
  paperOrientation,
  contentRotation,
  previewModel,
  onConfirm,
  onCancel,
}) => {
  if (!visible) return null

  // ── 设置更新辅助：合并后保存（防抖持久化由 useSettings 处理） ──
  const update = useCallback((patch) => {
    saveSettings(prev => ({ ...prev, ...patch }))
  }, [saveSettings])

  // 纸张选项（合并注册表）
  const mergedPaperOptions = PAPER_REGISTRY

  return (
    <div className="modal-overlay pcm-overlay">
      <div className="pcm-panel pcm-panel--new">
        {/* ── 头部 ── */}
        <div className="pcm-header">
          <div className="pcm-header-left">
            <svg className="pcm-icon" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 6 2 18 2 18 9" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" />
            </svg>
            <h3 className="pcm-title">打印确认</h3>
            <span className="pcm-count">{totalFiles} 页文件</span>
          </div>
          <button className="modal-close-btn" onClick={onCancel} aria-label="关闭">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="3" y1="3" x2="13" y2="13" /><line x1="13" y1="3" x2="3" y2="13" />
            </svg>
          </button>
        </div>

        {/* ── 主体：左设置 + 右预览 ── */}
        <div className="pcm-body pcm-body--split">
          {/* ── 左侧：设置区（可滚动） ── */}
          <div className="pcm-settings">
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

              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div className="printer-form-row" style={{ flex: 1 }}>
                  <label className="printer-form-label">打印机</label>
                  <select
                    className="printer-select"
                    value={settings.printerName || ''}
                    onChange={(e) => update({ printerName: e.target.value })}
                  >
                    {printers.length === 0 && <option value="">未检测到打印机</option>}
                    {printers.map((p) => (<option key={p} value={p}>{p}</option>))}
                  </select>
                </div>
                <div className="printer-checkbox-row" style={{ flexShrink: 0 }}>
                  <Toggle
                    checked={settings.grayscale || false}
                    onChange={(val) => update({ grayscale: val })}
                  />
                  <label className="printer-checkbox-label">灰度打印</label>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', marginTop: '4px' }}>
                <div className="printer-form-row" style={{ flex: '0 0 auto' }}>
                  <label className="printer-form-label">份数</label>
                  <input
                    type="number"
                    className="printer-input"
                    style={{ width: '70px' }}
                    min="1"
                    max="99"
                    value={settings.copies || 1}
                    onChange={(e) => update({ copies: parseInt(e.target.value) || 1 })}
                  />
                </div>

                <div className="printer-checkbox-row">
                  <Toggle
                    checked={(settings.copies || 1) >= 2 ? (settings.collate ?? true) : true}
                    disabled={(settings.copies || 1) < 2}
                    onChange={(val) => update({ collate: val })}
                  />
                  <label className={`printer-checkbox-label ${(settings.copies || 1) < 2 ? 'disabled' : ''}`}>逐份打印</label>
                </div>

                <div className="printer-checkbox-row">
                  <Toggle
                    checked={settings.extraSpecial || false}
                    onChange={(val) => update({ extraSpecial: val })}
                  />
                  <label className="printer-checkbox-label">一普二专</label>
                  <span style={{ fontSize: '11px', color: 'var(--text-4)', marginLeft: '4px' }}>普票一份，专票两份</span>
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
                  value={settings.paperSize || 'A4'}
                  onChange={(e) => {
                    const newSize = e.target.value
                    const next = { paperSize: newSize, paperkind: undefined }
                    if (newSize !== 'Custom') {
                      next.customPaper = undefined
                    }
                    update(next)
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
              </div>

              {/* 自定义尺寸输入 */}
              {settings.paperSize === 'Custom' && (
                <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                    <label className="printer-form-label" style={{ fontSize: '11px', marginBottom: '2px' }}>宽度 (mm)</label>
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
                        update({ customPaper: { ...settings.customPaper, widthMM: isNaN(w) ? undefined : w } })
                      }}
                    />
                  </div>
                  <span style={{ marginTop: '14px', color: '#6b7280' }}>×</span>
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                    <label className="printer-form-label" style={{ fontSize: '11px', marginBottom: '2px' }}>高度 (mm)</label>
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
                        update({ customPaper: { ...settings.customPaper, heightMM: isNaN(h) ? undefined : h } })
                      }}
                    />
                  </div>
                </div>
              )}

              {/* 合并发票设置 */}
              <div className="printer-form-row" style={{ marginTop: '10px' }}>
                <label className="printer-form-label">合并</label>
                <select
                  className="printer-merge-select"
                  value={settings.mergeMode || 'none'}
                  onChange={(e) => update({ mergeMode: e.target.value })}
                >
                  <option value="none">不合并</option>
                  <option value="merge2">两票一页（1页纸2张发票）</option>
                  <option value="merge3">三票一页（1页纸3张发票）</option>
                  <option value="merge4">四票一页（1页纸4张发票）</option>
                </select>
              </div>

              {/* 页边距设置 */}
              <div className="printer-margin-section" style={{ marginTop: '8px' }}>
                <div className="printer-margin-header" style={{ gap: '10px' }}>
                  <span className="printer-form-label" style={{ flexShrink: 0 }}>页边距</span>
                  <select
                    className="printer-select"
                    value={settings.marginPreset || 'default'}
                    onChange={(e) => {
                      const preset = e.target.value
                      if (preset !== 'custom' && MARGIN_PRESETS[preset]) {
                        const p = MARGIN_PRESETS[preset]
                        update({
                          marginPreset: preset,
                          marginLeft: p.left,
                          marginRight: p.right,
                          marginTop: p.top,
                          marginBottom: p.bottom,
                        })
                      } else {
                        update({ marginPreset: 'custom' })
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

                {/* 四方向输入网格 */}
                <div className="printer-margin-grid" style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '6px',
                  marginTop: '6px',
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
                      onChange={(e) => update({
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
                      onChange={(e) => update({
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
                      onChange={(e) => update({
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
                      onChange={(e) => update({
                        marginRight: Math.max(0, parseFloat(e.target.value) || 0),
                        marginPreset: 'custom',
                      })}
                    />
                    <span className="printer-margin-unit">mm</span>
                  </div>
                </div>

                <div className="printer-hint" style={{ marginTop: '4px' }}>
                  扩展 PDF 白边，防止打印内容被裁切。设置在打印前生效，不影响文件本身。
                </div>

                {/* 纸张方向选择（分段按钮） */}
                <div className="printer-form-row" style={{ marginTop: '10px' }}>
                  <label className="printer-form-label">方向</label>
                  <div className="printer-orient-toggle">
                    <button
                      type="button"
                      className={`printer-orient-btn ${!settings.landscape ? 'active' : ''}`}
                      onClick={() => update({ landscape: false })}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <rect x="3" y="1" width="10" height="14" rx="1.5"/>
                      </svg>
                      纵向
                    </button>
                    <button
                      type="button"
                      className={`printer-orient-btn ${settings.landscape ? 'active' : ''}`}
                      onClick={() => update({ landscape: true })}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <rect x="1" y="3" width="14" height="10" rx="1.5"/>
                      </svg>
                      横向
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ── 右侧：打印布局预览（Phase 3.5 数据驱动） ── */}
          <div className="pcm-preview">
            <div className="pcm-preview-header">
              <span className="pcm-preview-title">打印预览</span>
              <span className="pcm-preview-subtitle">打印布局（随设置实时更新）</span>
            </div>
            <div className="pcm-preview-body">
              <PrintPreviewCanvas preview={previewModel} />
            </div>
          </div>
        </div>

        {/* ── 底部 ── */}
        <div className="pcm-footer pcm-footer--new">
          <div className="pcm-footer-hint">
            确认后将 {totalFiles} 页发送到打印机
            {mergeMode && settings.mergeMode && settings.mergeMode !== 'none' && (
              <span className="pcm-badge pcm-badge-merge" style={{ marginLeft: '8px' }}>
                {settings.mergeMode === 'merge2' ? '两票一页' :
                 settings.mergeMode === 'merge3' ? '三票一页' :
                 settings.mergeMode === 'merge4' ? '四票一页' : settings.mergeMode}
              </span>
            )}
            {isOneNormalTwoSpecial && (
              <span className="pcm-badge pcm-badge-special" style={{ marginLeft: '6px' }}>一普二专</span>
            )}
          </div>
          <div className="pcm-footer-actions">
            <button className="pcm-btn pcm-btn-cancel" onClick={onCancel}>取消</button>
            <button className="pcm-btn pcm-btn-confirm" onClick={onConfirm}>确认打印</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default memo(PrintConfirmModal)
