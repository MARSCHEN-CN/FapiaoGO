import React, { useMemo } from 'react'
import { PUBLIC_BASE } from '../config'

/**
 * 导入进度弹窗（方案2：横幅+wait.svg+进度条）
 *
 * 支持两种 props 方式：
 *  1. 新方式：visible, title, progress(0~100), text, onCancel
 *  2. 兼容旧方式：importing, parsing, parseProgress({current,total})
 */
const ImportProgressModal = (props) => {
  const {
    // 新 API
    visible: visibleProp,
    title = '正在导入文件',
    progress,
    text = '',
    onCancel,
    // 旧 API（兼容）
    importing,
    parsing,
    parseProgress,
  } = props

  // 计算 visible
  const visible = visibleProp !== undefined ? visibleProp : Boolean(importing || parsing)

  // 计算百分比
  const pct = useMemo(() => {
    if (progress !== undefined) return Math.max(0, Math.min(100, Math.round(progress)))
    if (parseProgress && parseProgress.total > 0) {
      return Math.round((parseProgress.current / parseProgress.total) * 100)
    }
    return 0
  }, [progress, parseProgress])

  // 统一文本：不暴露内部阶段
  const displayText = useMemo(() => {
    if (text) return text
    if (parseProgress && parseProgress.total > 0) {
      return `正在处理发票 ${parseProgress.current}/${parseProgress.total}`
    }
    return ''
  }, [text, parseProgress])

  if (!visible) return null

  return (
    <div className="modal-overlay ipm-overlay">
      <div className="ipm-panel">
        {/* 顶部横幅区 */}
        <div className="ipm-banner">
          <img src={`${PUBLIC_BASE}icon/wait.svg`} alt="" className="ipm-banner-svg" />
          <div className="ipm-banner-fade" />
          <div className="ipm-banner-bottom">
            <div className="ipm-title-row">
              <span className="ipm-title-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M2.5 19.5L21 12L2.5 4.5L2.5 10.5L15 12L2.5 13.5L2.5 19.5Z" />
                </svg>
              </span>
              <span className="ipm-title-text">
                {title}
                <span className="ipm-dots" />
              </span>
            </div>
            <span className="ipm-pct">{pct}%</span>
          </div>
        </div>

        {/* 进度条 */}
        <div className="ipm-progress-wrap">
          <div className="ipm-bar-track">
            <div className="ipm-bar-fill" style={{ width: `${pct}%` }}>
              <span className="ipm-bar-dot" />
            </div>
          </div>
          {displayText && <div className="ipm-bar-filename">{displayText}</div>}
        </div>

        {/* 底部操作 */}
        {onCancel && (
          <div className="ipm-footer">
            <button className="pc-btn outline ipm-cancel-btn" onClick={onCancel}>
              取消导入
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default ImportProgressModal
