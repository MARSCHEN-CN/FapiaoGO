import React, { useState, useEffect, useMemo, useRef } from 'react'
import { PUBLIC_BASE } from '../config'

/**
 * 导入进度弹窗
 *
 * 功能：
 * - 分阶段显示进度（拆分中 / 解析中 / 组装中 / 完成）
 * - 文件计数显示（如 30/40）
 * - 进度条严格单调递增：组件内维护displayPct，任何回退值都会被clamp
 * - 自带淡入/淡出动画，关闭时平滑过渡避免闪烁
 *
 * Props:
 * - visible: 是否显示
 * - title: 标题
 * - importStage: 'idle' | 'splitting' | 'parsing' | 'building' | 'completed'
 * - importStats: { originalCount, totalFiles, currentFile, splitDone, splitTotal, parseDone, parseTotal, buildDone, buildTotal }
 * - 兼容旧API: importing, parsing, parseProgress
 */
const ImportProgressModal = (props) => {
  const {
    visible: visibleProp,
    title = '正在导入文件',
    importStage,
    importStats,
    importing,
    parsing,
    parseProgress,
  } = props

  const shouldShow = visibleProp !== undefined ? visibleProp : Boolean(importing || parsing)

  // mounted: 是否在DOM中；isClosing: 是否正在播放淡出动画
  const [mounted, setMounted] = useState(shouldShow)
  const [isClosing, setIsClosing] = useState(false)
  const prevShowRef = useRef(shouldShow)

  // 单调递增进度：组件内维护，防止任何原因导致的百分比回退
  const [displayPct, setDisplayPct] = useState(0)

  useEffect(() => {
    if (shouldShow && !prevShowRef.current) {
      // 从隐藏变为显示：挂载，重置进度，不播放关闭动画
      setMounted(true)
      setIsClosing(false)
      setDisplayPct(0)
    } else if (!shouldShow && prevShowRef.current) {
      // 从显示变为隐藏：开始淡出动画
      setIsClosing(true)
    }
    prevShowRef.current = shouldShow
  }, [shouldShow])

  // 淡出动画结束后真正卸载
  const handleOverlayAnimEnd = (e) => {
    if (isClosing && e.target === e.currentTarget) {
      setMounted(false)
      setIsClosing(false)
    }
  }

  // 计算原始阶段文本、计数和百分比（不做单调保护）
  const rawProgress = useMemo(() => {
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

      // 非完成阶段上限99%，完成阶段100%
      const rawPct = importStage === 'completed' ? 100 : Math.min(99, Math.max(0, pctValue))
      return { stageText: stage, countText: count, rawPct }
    }

    if (parseProgress && parseProgress.total > 0) {
      return {
        stageText: '正在处理',
        countText: `${parseProgress.current}/${parseProgress.total}`,
        rawPct: Math.round((parseProgress.current / parseProgress.total) * 100),
      }
    }
    return { stageText: '准备中', countText: '', rawPct: 0 }
  }, [importStage, importStats, parseProgress])

  // 单调递增保护：新值只升不降
  useEffect(() => {
    const { rawPct } = rawProgress
    setDisplayPct((prev) => {
      // completed阶段直接100%
      if (importStage === 'completed') return 100
      // 正常情况只升不降
      return rawPct > prev ? rawPct : prev
    })
  }, [rawProgress, importStage])

  if (!mounted) return null

  const overlayClass = `modal-overlay ipm-overlay${isClosing ? ' ipm-closing' : ''}`
  const panelClass = `ipm-panel${isClosing ? ' ipm-panel-closing' : ''}`
  const { stageText, countText } = rawProgress
  const pct = displayPct

  return (
    <div className={overlayClass} onAnimationEnd={handleOverlayAnimEnd}>
      <div className={panelClass}>
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
                {!isClosing && importStage !== 'completed' && <span className="ipm-dots" />}
              </span>
            </div>
            <span className="ipm-pct">{pct}%</span>
          </div>
        </div>

        {/* 进度条 */}
        <div className="ipm-progress-wrap">
          <div className="ipm-bar-track">
            <div className={`ipm-bar-fill${importStage === 'completed' ? ' is-complete' : ''}`} style={{ width: `${pct}%` }}>
              <span className="ipm-bar-dot" />
            </div>
          </div>
          <div className="ipm-stage-row">
            <span className="ipm-stage-text">{stageText}</span>
            {countText && <span className="ipm-count-text">{countText}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

export default ImportProgressModal
