import { useState, useCallback } from 'react'

/**
 * PDF 导出确认弹窗
 *
 * 职责：展示配置选项 → 输出 config（不触发导出）
 * 状态机约束：
 *   single → 允许 source / folder
 *   merge  → 允许 source / folder（与 single 一致）
 *   mode 切换时不改变 outputType
 */
const PdfExportConfirmModal = ({
  visible,
  files = [],
  onConfirm,
  onCancel,
}) => {
  const [exportConfig, setExportConfig] = useState({
    mode: 'single',
    outputType: 'source',
    folderPath: '',
    fileName: 'invoice_export.pdf',
  })

  const changeMode = useCallback((nextMode) => {
    setExportConfig(prev => ({ ...prev, mode: nextMode }))
  }, [])

  const changeOutputType = useCallback((nextType) => {
    setExportConfig(prev => ({ ...prev, outputType: nextType }))
  }, [])

  const changeFolderPath = useCallback((e) => {
    setExportConfig(prev => ({ ...prev, folderPath: e.target.value }))
  }, [])

  const changeFileName = useCallback((e) => {
    setExportConfig(prev => ({ ...prev, fileName: e.target.value }))
  }, [])

  // ── 文件夹选择 ──
  const handleSelectFolder = useCallback(async () => {
    try {
      const ep = window.electronAPI
      if (!ep || !ep.ipcRenderer) {
        console.log('[PDF Export] electronAPI unavailable, fallback to manual input')
        return
      }
      const result = await ep.ipcRenderer.invoke('select-export-folder')
      if (result && !result.canceled && result.folderPath) {
        setExportConfig(prev => ({ ...prev, folderPath: result.folderPath }))
      }
      // 取消选择 → 不关闭 Modal，保持已有输入
    } catch (e) {
      console.log('[PDF Export] select folder error:', e)
    }
  }, [])

  const handleConfirm = useCallback(() => {
    console.log('[PDF Export] Config:', exportConfig)
    onConfirm({
      ...exportConfig,
      files,
    })
  }, [exportConfig, files, onConfirm])

  if (!visible) return null

  return (
    <div className="modal-overlay pe-overlay">
      <div className="pe-panel">
        {/* ── 标题 ── */}
        <div className="pe-header">
          <div className="pe-header-left">
            <h3 className="pe-title">导出PDF</h3>
          </div>
        </div>

        {/* ── 主体 ── */}
        <div className="pe-body">
          {/* 文件数量 */}
          <div className="pe-summary">
            已选择 {files.length} 个文件
          </div>

          {/* ── 输出模式 ── */}
          <div className="pe-section">
            <span className="pe-section-label">输出模式</span>
            <div className="pe-select-row">
              <select
                className="pe-select"
                value={exportConfig.mode}
                onChange={(e) => changeMode(e.target.value)}
              >
                <option value="single">分别单独导出</option>
                <option value="merge">合并为一个文件</option>
              </select>
            </div>
          </div>

          {/* ── 输出位置（单文件和合并都用） ── */}
          <div className="pe-section">
            <span className="pe-section-label">输出位置</span>
            <div className="pe-select-row">
              <select
                className="pe-select"
                value={exportConfig.outputType}
                onChange={(e) => changeOutputType(e.target.value)}
              >
                <option value="source">与文件同源</option>
                <option value="folder">指定文件夹</option>
              </select>
            </div>

            {/* 指定文件夹时展开路径输入 */}
            {exportConfig.outputType === 'folder' && (
              <div className="pe-folder-row" style={{ marginTop: 6 }}>
                <input
                  className="pe-path-input"
                  type="text"
                  placeholder="选择或输入导出路径..."
                  value={exportConfig.folderPath}
                  onChange={changeFolderPath}
                />
                <button
                  className="pe-folder-btn"
                  onClick={handleSelectFolder}
                  title="选择文件夹"
                  type="button"
                >
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 4.5A1.5 1.5 0 013.5 3h3.84a1.5 1.5 0 011.06.44l1.1 1.1a1.5 1.5 0 001.06.44H16.5A1.5 1.5 0 0118 6.48V16a2 2 0 01-2 2H4a2 2 0 01-2-2V4.5z" />
                  </svg>
                </button>
              </div>
            )}
          </div>

          {/* ── 文件名输入（仅 merge 模式） ── */}
          {exportConfig.mode === 'merge' && (
            <div className="pe-section">
              <span className="pe-section-label">文件名</span>
              <input
                className="pe-file-name-input"
                type="text"
                value={exportConfig.fileName}
                onChange={changeFileName}
                placeholder="invoice_export.pdf"
              />
            </div>
          )}
        </div>

        {/* ── 底部 ── */}
        <div className="pe-footer">
          <button className="pc-btn outline" onClick={onCancel}>
            取消
          </button>
          <button className="pc-btn solid" onClick={handleConfirm}>
            确认导出
          </button>
        </div>
      </div>
    </div>
  )
}

export default PdfExportConfirmModal
