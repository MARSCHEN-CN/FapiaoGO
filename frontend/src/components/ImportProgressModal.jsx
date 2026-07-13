import React, { useMemo } from 'react'

const STEPS = [
  { key: 'read', label: '读取文件' },
  { key: 'extract', label: '提取字段' },
]

/**
 * 导入进度弹窗（方案2：横幅+wait.svg+步骤列表）
 *
 * 支持两种 props 方式：
 *  1. 新方式：visible, title, progress(0~100), text, currentStep(0/1/2), onCancel
 *  2. 兼容旧方式：importing, parsing, parseProgress({current,total})
 */
const ImportProgressModal = (props) => {
  const {
    // 新 API
    visible: visibleProp,
    title = '正在导入文件',
    progress,
    text = '',
    currentStep,
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

  // 推断当前步骤（基于进度百分比）
  const activeStep = useMemo(() => {
    if (currentStep !== undefined) return currentStep
    if (pct < 60) return 0
    return 1
  }, [currentStep, pct])

  if (!visible) return null

  return (
    <div className="modal-overlay ipm-overlay">
      <div className="ipm-panel">
        {/* 顶部横幅区 */}
        <div className="ipm-banner">
          <img src="/icon/wait.svg" alt="" className="ipm-banner-svg" />
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
          {text && <div className="ipm-bar-filename">{text}</div>}
        </div>

        {/* 步骤列表 */}
        <ul className="ipm-steps">
          {STEPS.map((step, i) => {
            const state = i < activeStep ? 'done' : i === activeStep ? 'active' : 'pending'
            return (
              <li key={step.key} className={`ipm-step ipm-step--${state}`}>
                <span className="ipm-step-icon">
                  {state === 'done' && (
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                  {state === 'active' && (
                    <span className="ipm-step-spinner" />
                  )}
                </span>
                <span className="ipm-step-label">{step.label}</span>
              </li>
            )
          })}
        </ul>

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
