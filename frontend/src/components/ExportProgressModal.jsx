import React, { useMemo } from 'react'

const ExportProgressModal = ({
  visible,
  progress,       // { current, total, stage, currentFile }
  result,         // null | { success, path, metadata: { successCount, failCount } } | { success: false, error }
  onCancel,
  onClose,
}) => {
  const stats = useMemo(() => {
    if (!progress) return { pct: 0, current: 0, total: 0, stage: '' }
    const { current = 0, total = 0, stage = '' } = progress
    const pct = total > 0 ? Math.round((current / total) * 100) : 0
    return { pct, current, total, stage }
  }, [progress])

  if (!visible) return null

  const isDone = result !== null
  const successCount = isDone && result.success ? (result.metadata?.successCount ?? stats.total) : 0
  const failCount = isDone && result.success ? (result.metadata?.failCount ?? 0) : 0

  return (
    <div className="modal-overlay ex-overlay">
      <div className="ex-panel">
        {/* 头部 */}
        <div className="pk-header">
          <div className="pk-header-left">
            <h3 className="pk-title">
              {isDone
                ? (result.success ? '导出完成' : '导出失败')
                : '正在导出 Excel'}
            </h3>
          </div>
        </div>

        {/* 进度区域 */}
        {!isDone ? (
          <div className="pk-progress-section">
            <div className="pk-ring-row">
              <div className="pk-progress-ring-wrap">
                <svg className="pk-ring" viewBox="0 0 72 72">
                  <circle className="pk-ring-track" cx="36" cy="36" r="30" />
                  <circle
                    className="pk-ring-fill"
                    cx="36" cy="36" r="30"
                    strokeDasharray={`${stats.pct * 1.884} 188.4`}
                  />
                </svg>
                <div className="pk-ring-center">
                  <span className="pk-ring-pct">{stats.pct}%</span>
                </div>
              </div>
              <div className="pk-stage-info">
                <span className="pk-stage-label">当前阶段</span>
                <span className="pk-stage-value">{stats.stage || '准备中'}</span>
              </div>
            </div>
            <div className="pk-bar-track">
              <div className="pk-bar-fill" style={{ width: `${stats.pct}%` }} />
            </div>
            <div className="pk-progress-detail">
              <span className="pk-progress-file">{progress?.currentFile || ''}</span>
              <span className="pk-progress-count">{stats.current}/{stats.total}</span>
            </div>
          </div>
        ) : (
          /* 完成状态（与打包/重命名完成页统一模板） */
          <div className="pk-result-section">
            {result.success ? (
              <>
                <div className="pk-result-icon success">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="5,13 10,18 19,5" />
                  </svg>
                </div>
                <div className="pk-result-stats">
                  <div className="pk-result-stat">
                    <span className="pk-result-val">{successCount}</span>
                    <span className="pk-result-label">成功</span>
                  </div>
                  <div className="pk-result-stat">
                    <span className={`pk-result-val ${failCount > 0 ? 'error' : ''}`}>{failCount}</span>
                    <span className="pk-result-label">失败</span>
                  </div>
                </div>
                {result.path && (
                  <div className="pk-result-path">
                    <span className="pk-result-path-label">输出路径</span>
                    <span className="pk-result-path-value" title={result.path}>{result.path}</span>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="pk-result-icon error">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </div>
                <div className="pk-result-msg">{result.error}</div>
              </>
            )}
          </div>
        )}

        {/* 底部操作 */}
        <div className="pk-footer">
          {isDone ? (
            <button className="pc-btn solid" onClick={onClose}>关闭</button>
          ) : (
            <button className="pc-btn outline" onClick={onCancel}>取消导出</button>
          )}
        </div>
      </div>
    </div>
  )
}

export default ExportProgressModal
