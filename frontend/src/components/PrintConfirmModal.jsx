import { memo, useCallback, useMemo } from 'react'
import { PAPER_REGISTRY } from '../config'

/**
 * 构建打印机下拉选项列表
 */
function buildPrinterOptions(printers, currentPrinter) {
  const opts = []
  if (!currentPrinter) {
    opts.push(<option key="ph" value="" disabled>请选择打印机</option>)
  }
  if (printers && printers.length > 0) {
    for (let i = 0; i < printers.length; i++) {
      const name = printers[i]
      opts.push(<option key={name || `p-${i}`} value={name}>{name}</option>)
    }
  } else {
    opts.push(
      <option key={currentPrinter || '__default__'} value={currentPrinter || ''}>
        {currentPrinter || '默认打印机'}
      </option>
    )
  }
  return opts
}

/**
 * 构建配置汇总行的数组（统一为数组，所有元素带 key）
 */
function buildSummaryItems(
  settings, printers, totalFiles,
  mergeMode, isOneNormalTwoSpecial,
  handlePrinterChange, handleGrayscaleChange, handlePaperSizeChange
) {
  const colorValue = settings.grayscale ? 'grayscale' : 'color'
  const currentPaper = settings.paperSize || 'A4'

  const items = []

  // 打印机
  items.push(
    <div key="printer" className="pcm-item">
      <span className="pcm-item-label">打印机</span>
      <select className="pcm-select" value={settings.printerName || ''} onChange={handlePrinterChange}>
        {buildPrinterOptions(printers, settings.printerName)}
      </select>
    </div>
  )

  // 颜色模式
  items.push(
    <div key="color" className="pcm-item">
      <span className="pcm-item-label">颜色模式</span>
      <select className="pcm-select" value={colorValue} onChange={handleGrayscaleChange}>
        <option key="color" value="color">彩色打印</option>
        <option key="grayscale" value="grayscale">灰度打印</option>
      </select>
    </div>
  )

  // 纸张尺寸
  items.push(
    <div key="paper" className="pcm-item">
      <span className="pcm-item-label">纸张尺寸</span>
      <select className="pcm-select" value={currentPaper} onChange={handlePaperSizeChange}>
        {PAPER_REGISTRY.map(p => (
          <option key={p.id} value={p.id}>
            {p.label}{p.widthMM ? ` (${p.widthMM}×${p.heightMM}mm)` : ''}
          </option>
        ))}
      </select>
    </div>
  )

  // 纸张方向（硬编码为自动）
  items.push(
    <div key="orientation" className="pcm-item">
      <span className="pcm-item-label">纸张方向</span>
      <span className="pcm-item-value">自动</span>
    </div>
  )

  // 文件数量
  items.push(
    <div key="files" className="pcm-item">
      <span className="pcm-item-label">文件数量</span>
      <span className="pcm-item-value">{totalFiles} 个文件</span>
    </div>
  )

  // 打印份数
  items.push(
    <div key="copies" className="pcm-item">
      <span className="pcm-item-label">打印份数</span>
      <span className="pcm-item-value">{settings.copies || 1} 份</span>
    </div>
  )

  // 合并模式（条件性）
  if (mergeMode && settings.mergeMode && settings.mergeMode !== 'none') {
    items.push(
      <div key="merge" className="pcm-item">
        <span className="pcm-item-label">合并模式</span>
        <span className="pcm-item-value">
          <span className="pcm-badge pcm-badge-merge">
            {settings.mergeMode === 'merge2' ? '一页两票' :
             settings.mergeMode === 'merge3' ? '一页三票' :
             settings.mergeMode === 'merge4' ? '一页四票' :
             settings.mergeMode}
          </span>
        </span>
      </div>
    )
  }

  // 特殊模式（条件性）
  if (isOneNormalTwoSpecial) {
    items.push(
      <div key="special" className="pcm-item">
        <span className="pcm-item-label">特殊模式</span>
        <span className="pcm-item-value">
          <span className="pcm-badge pcm-badge-special">一普二专</span>
        </span>
      </div>
    )
  }

  return items
}

/**
 * 打印前确认弹窗
 */
const PrintConfirmModal = ({
  visible,
  settings,
  saveSettings,
  printers,
  totalFiles,
  mergeMode,
  isOneNormalTwoSpecial,
  onConfirm,
  onCancel,
}) => {
  if (!visible) return null

  const handlePrinterChange = useCallback((e) => {
    saveSettings(prev => ({ ...prev, printerName: e.target.value }))
  }, [saveSettings])

  const handleGrayscaleChange = useCallback((e) => {
    saveSettings(prev => ({ ...prev, grayscale: e.target.value === 'grayscale' }))
  }, [saveSettings])

  const handlePaperSizeChange = useCallback((e) => {
    saveSettings(prev => ({ ...prev, paperSize: e.target.value }))
  }, [saveSettings])

  // 只在相关 props/回调变更时才重建摘要列表，避免每次渲染都重建 JSX 数组
  const summaryItems = useMemo(() =>
    buildSummaryItems(
      settings, printers, totalFiles,
      mergeMode, isOneNormalTwoSpecial,
      handlePrinterChange, handleGrayscaleChange, handlePaperSizeChange
    ),
    [settings, printers, totalFiles, mergeMode, isOneNormalTwoSpecial,
     handlePrinterChange, handleGrayscaleChange, handlePaperSizeChange]
  )

  return (
    <div className="modal-overlay pcm-overlay">
      <div className="pcm-panel">
        <div key="header" className="pcm-header">
          <div className="pcm-header-left">
            <svg className="pcm-icon" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline key="line1" points="6 9 6 2 18 2 18 9" />
              <path key="path1" d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect key="rect1" x="6" y="14" width="12" height="8" />
            </svg>
            <h3 className="pcm-title">打印确认</h3>
          </div>
        </div>

        <div key="body" className="pcm-body">
          <div className="pcm-summary">
            {summaryItems}
          </div>
          <p className="pcm-hint">
            确认后，将 {totalFiles} 个文件发送到打印机
          </p>
        </div>

        <div key="footer" className="pcm-footer">
          <button key="cancel" className="pcm-btn pcm-btn-cancel" onClick={onCancel}>
            取消
          </button>
          <button key="confirm" className="pcm-btn pcm-btn-confirm" onClick={onConfirm}>
            确认打印
          </button>
        </div>
      </div>
    </div>
  )
}

export default memo(PrintConfirmModal)
