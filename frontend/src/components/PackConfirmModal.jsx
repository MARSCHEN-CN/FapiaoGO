import { useState, useCallback } from 'react'
import Toggle from './Toggle'

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

/**
 * 「导出为压缩包」确认弹窗
 *
 * 职责：展示当前打包设置，允许用户在导出前调整，点「确认导出」触发打包。
 * 设置变更即时持久化（选项 A），与 ExcelExportFieldsModal 的 onPersist 模式一致。
 *
 * Props:
 *   visible:      boolean           是否渲染
 *   settings:     object            当前设置（含 packSettings）
 *   saveSettings: (settings) => void 持久化设置
 *   parsedFiles:  Array             已解析文件列表（用于计算确认按钮可见状态）
 *   onConfirm:    () => void        确认导出回调（调用方触发 handlePack）
 *   onCancel:     () => void        取消回调
 */
const PackConfirmModal = ({
  visible,
  settings,
  saveSettings,
  parsedFiles = [],
  onConfirm,
  onCancel,
}) => {
  // ── 打包设置状态（从 settings 初始化，变更时即时持久化） ──
  const packSettings = settings.packSettings || {}
  const [packTargetFolder, setPackTargetFolder] = useState(packSettings.packTargetFolder || '')
  const [packKeepOriginal, setPackKeepOriginal] = useState(packSettings.packKeepOriginal ?? false)
  const [packArchiveFormat, setPackArchiveFormat] = useState(packSettings.packArchiveFormat || 'ZIP')
  const [packRenameBeforeArchive, setPackRenameBeforeArchive] = useState(packSettings.packRenameBeforeArchive ?? false)
  const [packArchiveNamePrefix, setPackArchiveNamePrefix] = useState(packSettings.packArchiveNamePrefix ?? '发票')
  const [packArchiveNameDateFormat, setPackArchiveNameDateFormat] = useState(packSettings.packArchiveNameDateFormat || 'YYYY年MM月DD日')
  const [packArchiveNameSeparator, setPackArchiveNameSeparator] = useState(packSettings.packArchiveNameSeparator ?? '_')
  const [packNameFieldOrder, setPackNameFieldOrder] = useState(packSettings.packNameFieldOrder || ['prefix', 'date'])

  // 打包设置变更时即时持久化（选项 A，无 toast）
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
    saveSettings({ ...settings, packSettings: newPackSettings })
  }, [settings, saveSettings, packTargetFolder, packKeepOriginal, packArchiveFormat, packRenameBeforeArchive, packArchiveNamePrefix, packArchiveNameDateFormat, packArchiveNameSeparator, packNameFieldOrder])

  // 包装函数
  const handlePackTargetFolderChange = (val) => { setPackTargetFolder(val); updatePackSettings('packTargetFolder', val) }
  const handlePackKeepOriginalChange = (val) => { setPackKeepOriginal(val); updatePackSettings('packKeepOriginal', val) }
  const handlePackArchiveFormatChange = (val) => { setPackArchiveFormat(val); updatePackSettings('packArchiveFormat', val) }
  const handlePackRenameBeforeArchiveChange = (val) => { setPackRenameBeforeArchive(val); updatePackSettings('packRenameBeforeArchive', val) }
  const handlePackArchiveNamePrefixChange = (val) => { setPackArchiveNamePrefix(val); updatePackSettings('packArchiveNamePrefix', val) }
  const handlePackArchiveNameDateFormatChange = (val) => { setPackArchiveNameDateFormat(val); updatePackSettings('packArchiveNameDateFormat', val) }
  const handlePackArchiveNameSeparatorChange = (val) => { setPackArchiveNameSeparator(val); updatePackSettings('packArchiveNameSeparator', val) }
  const handlePackNameFieldOrderChange = (newOrder) => { setPackNameFieldOrder(newOrder); updatePackSettings('packNameFieldOrder', newOrder) }

  if (!visible) return null

  return (
    <div className="modal-overlay" style={{ zIndex: 100 }}>
      <div style={{
        width: '560px',
        maxWidth: '96vw',
        background: 'var(--canvas-float-bg)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderRadius: 'var(--r-xl)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}>
        {/* ── 标题 ── */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 24px',
          flexShrink: 0,
        }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--text)' }}>导出为压缩包</h3>
            <span style={{ fontSize: '12px', color: 'var(--text-3)' }}>确认打包设置</span>
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-3)' }}>已选择 {parsedFiles.length} 个文件</span>
        </div>

        {/* ── 主体 = 打包设置（从设置-打包页原样迁移） ── */}
        <div style={{
          padding: '0 24px',
          maxHeight: '600px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
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
              </div>

              <div className="printer-hint" style={{ marginTop: '6px' }}>设置后打包将直接输出到此文件夹；不设置则弹出选择文件夹对话框。</div>
            </div>

          </div>
        </div>

        {/* ── 底部 ── */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '10px',
          padding: '16px 24px',
          flexShrink: 0,
          borderTop: 'none',
        }}>
          <button type="button" className="pc-btn outline" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="pc-btn solid"
            onClick={() => {
              const currentPackSettings = {
                packTargetFolder,
                packKeepOriginal,
                packArchiveFormat,
                packRenameBeforeArchive,
                packArchiveNamePrefix,
                packArchiveNameDateFormat,
                packArchiveNameSeparator,
                packNameFieldOrder,
              }
              onConfirm(currentPackSettings)
            }}
          >
            确认导出
          </button>
        </div>
      </div>
    </div>
  )
}

export default PackConfirmModal
