import React, { useMemo } from 'react'
import { PUBLIC_BASE } from '../config'

/**
 * 导入进度弹窗
 *
 * 功能：
 * - 分阶段显示进度（拆分中 / 解析中 / 组装中）
 * - 文件计数显示（如 30/40 表示导入40个文件，解析到第30个）
 * - 进度条单调递增，避免回退误导用户
 *
 * Props:
 * - visible: 是否显示
 * - title: 标题
 * - onCancel: 取消回调
 * - importStage: 'idle' | 'splitting' | 'parsing' | 'building' | 'completed'
 * - importStats: { originalCount, totalFiles, currentFile, splitDone, splitTotal, parseDone, parseTotal, buildDone, buildTotal }
 * - 兼容旧API: importing, parsing, parseProgress
 */
const ImportProgressModal = (props) => {
  const {
    // 新 API
    visible: visibleProp,
    title = '正在导入文件',
    onCancel,
    importStage,
    importStats,
    // 旧 API（兼容）
    importing,
    parsing,
    parseProgress,
  } = props

  // 计算 visible
  const visible = visibleProp !== undefined ? visibleProp : Boolean(importing || parsing)

  // 计算阶段文本和计数
  const { stageText, countText, pct } = useMemo(() => {
    if (importStage && importStats) {
      const {
        splitDone, splitTotal,
        parseDone, parseTotal,
        buildDone, buildTotal,
        totalFiles, currentFile,
      } = importStats
      let pctValue = 0
      let stage = '准备中'
      let count = ''

      if (importStage === 'splitting') {
        stage = '正在拆分文件'
        const displayCurrent = currentFile > 0 ? currentFile : splitDone
        const displayTotal = totalFiles > 0 ? totalFiles : splitTotal
        count = `${displayCurrent}/${displayTotal}`
        pctValue = displayTotal > 0 ? Math.round((splitDone / splitTotal) * 30) : 0
      } else if (importStage === 'parsing') {
        stage = '正在解析发票'
        const displayCurrent = currentFile > 0 ? currentFile : parseDone
        const displayTotal = totalFiles > 0 ? totalFiles : parseTotal
        count = `${displayCurrent}/${displayTotal}`
        const parsePct = parseTotal > 0 ? (parseDone / parseTotal) * 55 : 0
        pctValue = Math.round(30 + parsePct)
      } else if (importStage === 'building') {
        stage = '正在组装文档'
        const displayCurrent = totalFiles > 0 ? totalFiles : buildDone
        const displayTotal = totalFiles > 0 ? totalFiles : buildTotal
        count = `${displayCurrent}/${displayTotal}`
        pctValue = 95
      } else if (importStage === 'completed') {
        stage = '导入完成'
        count = ''
        pctValue = 100
      }

      return { stageText: stage, countText: count, pct: Math.min(99, Math.max(0, pctValue)) }
    }

    // 兼容旧 API
    if (parseProgress && parseProgress.total > 0) {
      return {
        stageText: '正在处理',
        countText: `${parseProgress.current}/${parseProgress.total}`,
        pct: Math.round((parseProgress.current / parseProgress.total) * 100),
      }
    }
    return { stageText: '准备中', countText: '', pct: 0 }
  }, [importStage, importStats, parseProgress])

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
          <div className="ipm-stage-row">
            <span className="ipm-stage-text">{stageText}</span>
            {countText && <span className="ipm-count-text">{countText}</span>}
          </div>
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
