import React, { useMemo, useState, useCallback, useEffect } from 'react'

/**
 * 智能重命名预览器
 * 支持三个阶段：预览选择 → 执行中 → 结果展示
 */
const RenamePreviewModal = ({
  visible,
  files,           // [{ key, originalName, newName, conflict, fileFormat }]
  executing,       // boolean: 是否正在执行重命名
  reimportProgress, // null | 0-100: 重导入进度
  result,          // null | { success, renamed, failed, partialCount, error }
  onConfirm,
  onCancel,
  onCloseResult,
}) => {
  const [viewMode, setViewMode] = useState('list')   // list | grid
  const [selectedKeys, setSelectedKeys] = useState(new Set())
  const [searchText, setSearchText] = useState('')

  // 初始默认全选
  useEffect(() => {
    if (visible && files.length > 0) {
      setSelectedKeys(new Set(files.map(f => f.key)))
    }
  }, [visible, files])

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

  if (!visible) return null

  // ====== 结果展示阶段 ======
  if (result) {
    return (
      <div className="modal-overlay rp-overlay">
        <div className="rp-panel">
          <div className="rp-header">
            <div className="rp-header-left">
              <h3 className="rp-title">
                {result.success ? '重命名完成' : '重命名失败'}
              </h3>
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
        <div className="rp-panel">
          <div className="rp-header">
            <div className="rp-header-left">
              <h3 className="rp-title">
                {reimportProgress !== null ? '正在重新导入重命名完成的文件...' : '正在重命名...'}
              </h3>
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

  // ====== 预览选择阶段 ======
  return (
    <div className="modal-overlay rp-overlay">
      <div className="rp-panel">
        {/* 头部 */}
        <div className="rp-header">
          <div className="rp-header-left">
            <h3 className="rp-title">重命名预览</h3>
            <span className="rp-count">{files.length} 个文件</span>
            {stats.conflicts > 0 && (
              <span className="rp-conflict-badge">{stats.conflicts} 个冲突</span>
            )}
          </div>
          <div className="rp-header-right">
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
          </div>
        </div>

        {/* 工具栏 */}
        <div className="rp-toolbar">
          <label className="rp-select-all">
            <input
              type="checkbox"
              checked={filteredFiles.length > 0 && filteredFiles.every(f => selectedKeys.has(f.key))}
              onChange={selectAll}
            />
            <span>{selectedKeys.size > 0 ? `已选 ${selectedKeys.size} 项` : '全选'}</span>
          </label>
        </div>

        {/* 列表 / 网格视图 */}
        {viewMode === 'list' ? (
          <div className="rp-list">
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
          <div className="rp-grid">
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

        {/* 底部操作 */}
        <div className="rp-footer">
          <div className="rp-footer-info">
            {stats.conflicts > 0 && (
              <span className="rp-footer-warning">
                {stats.conflicts} 个文件名冲突，将自动添加序号
              </span>
            )}
          </div>
          <div className="rp-footer-actions">
            <button 
  className="pc-btn outline" 
  onClick={onCancel}
  style={{ 
    background: '#ffffff', 
    color: '#666666', 
    border: '1px solid #e0e0e0', 
    borderRadius: '8px', 
    padding: '8px 20px', 
    fontWeight: '500',
    cursor: 'pointer'
  }}
>取消</button>
            <button className="pc-btn solid" onClick={() => onConfirm(Array.from(selectedKeys))}>
              确认重命名 {selectedKeys.size > 0 ? `(${selectedKeys.size})` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default React.memo(RenamePreviewModal)