import { useMemo } from 'react'

/**
 * 通用任务进度弹窗（不感知具体业务类型）。
 *
 * 可复用：PDF 导出、Excel 导出、打印、批量重命名等。
 * Props 与后端 ExportTask.to_dict() 对齐。
 */
const TaskProgressModal = ({
  visible,
  title = '任务进度',
  current = 0,
  total = 0,
  percent,
  currentFile = '',
  stage = '',
  status,        // 'running' | 'completed' | 'cancelled'
  errors = [],   // [{ file, error }]
  onCancel,
  onClose,
}) => {
  const pct = percent !== undefined ? percent
    : total > 0 ? Math.round((current / total) * 100) : 0

  const isRunning = status === 'running' || (!status && visible)
  const isDone = status === 'completed'
  const isCancelled = status === 'cancelled'
  const isFinished = isDone || isCancelled
  const hasErrors = errors.length > 0

  if (!visible) return null

  return (
    <div className="modal-overlay tp-overlay">
      <div className="tp-panel">
        {/* ── 标题 ── */}
        <div className="tp-header">
          <div className="tp-header-left">
            <h3 className="tp-title">{title}</h3>
          </div>
        </div>

        <div className="tp-body">
          {isRunning ? (
            /* ── 运行中：进度环 + 进度条 + 文件信息 ── */
            <>
              <div className="tp-ring-row">
                <div className="tp-progress-ring-wrap">
                  <svg className="tp-ring" viewBox="0 0 72 72">
                    <circle className="tp-ring-track" cx="36" cy="36" r="30" />
                    <circle
                      className="tp-ring-fill"
                      cx="36" cy="36" r="30"
                      strokeDasharray={`${pct * 1.884} 188.4`}
                    />
                  </svg>
                  <div className="tp-ring-center">
                    <span className="tp-ring-pct">{pct}%</span>
                  </div>
                </div>
                <div className="tp-stage-info">
                  <span className="tp-stage-label">当前阶段</span>
                  <span className="tp-stage-value">{stage || '准备中...'}</span>
                </div>
              </div>
              <div className="tp-bar-track">
                <div className="tp-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="tp-progress-detail">
                <span className="tp-progress-file" title={currentFile}>{currentFile || ''}</span>
                <span className="tp-progress-count">{current}/{total}</span>
              </div>
            </>
          ) : (
            /* ── 完成/取消：结果展示 ── */
            <div className="tp-result-section">
              <div className={`tp-result-icon ${isCancelled ? 'cancelled' : (hasErrors ? 'error' : 'success')}`}>
                {isCancelled ? (
                  <svg viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                ) : hasErrors ? (
                  <svg viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24">
                    <polyline points="5,13 10,18 19,5" />
                    <circle cx="12" cy="12" r="10" />
                  </svg>
                )}
              </div>

              <div className="tp-result-stats">
                <div className="tp-result-stat">
                  <span className="tp-result-stat-val">
                    {isCancelled ? '-' : current - errors.length}
                  </span>
                  <span className="tp-result-stat-label">成功</span>
                </div>
                {hasErrors && (
                  <div className="tp-result-stat">
                    <span className="tp-result-stat-val error">{errors.length}</span>
                    <span className="tp-result-stat-label">失败</span>
                  </div>
                )}
              </div>

              {stage && <span className="tp-stage-value" style={{ textAlign: 'center' }}>{stage}</span>}

              {/* ── 错误列表 ── */}
              {hasErrors && (
                <div className="tp-errors">
                  {errors.map((err, i) => (
                    <div key={i} className="tp-error-item">
                      <span className="tp-error-file" title={err.file}>{err.file || '文件'}</span>
                      <span className="tp-error-msg">{err.error}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── 底部 ── */}
        <div className="tp-footer">
          {isFinished ? (
            <button className="pc-btn solid" onClick={onClose}>关闭</button>
          ) : (
            <button className="pc-btn outline" onClick={onCancel}>取消</button>
          )}
        </div>
      </div>
    </div>
  )
}

export default TaskProgressModal
