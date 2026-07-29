/**
 * ImportProgress — 文件导入进度条（侧栏底部）
 * 无感型：固定在 Sidebar 底部，导入完成后自动淡出消失
 * 支持分阶段显示：拆分中 / 解析中 / 组装中，显示单调递增总进度
 */
export default function ImportProgress({
  parsing,
  parseProgress,
  importStage,
  importStats,
  importLogs = []
}) {
  if (!parsing) return null

  // 优先使用增强版进度信息
  let stageText = '正在处理'
  let current = 0
  let total = 0
  let pct = 0
  let subText = ''

  if (importStage && importStats) {
    const {
      splitDone = 0, splitTotal = 0,
      parseDone = 0, parseTotal = 0,
      buildDone = 0, buildTotal = 0,
      totalFiles = 0, currentFile = 0
    } = importStats

    // 计算总进度（单调递增，百分比：0-100）
    // 拆分: 0-30%, 解析: 30-85%, 组装: 85-100%
    if (importStage === 'splitting') {
      stageText = '正在拆分'
      current = currentFile > 0 ? currentFile : splitDone
      total = totalFiles > 0 ? totalFiles : splitTotal
      pct = splitTotal > 0 ? Math.round((splitDone / splitTotal) * 30) : 0
      // 显示当前处理文件（从最后一条日志提取）
      const lastLog = importLogs[importLogs.length - 1]
      subText = lastLog?.message || ''
    } else if (importStage === 'parsing') {
      stageText = '正在解析'
      current = currentFile > 0 ? currentFile : parseDone
      total = totalFiles > 0 ? totalFiles : parseTotal
      const parsePct = parseTotal > 0 ? (parseDone / parseTotal) * 55 : 0
      pct = Math.round(30 + parsePct)
      const lastLog = importLogs[importLogs.length - 1]
      subText = lastLog?.message || ''
    } else if (importStage === 'building') {
      stageText = '正在组装'
      current = currentFile > 0 ? currentFile : buildDone
      total = totalFiles > 0 ? totalFiles : buildTotal
      pct = 95
      const lastLog = importLogs[importLogs.length - 1]
      subText = lastLog?.message || ''
    }
  } else if (parseProgress && parseProgress.total > 0) {
    // 兼容旧API
    current = parseProgress.current
    total = parseProgress.total
    pct = Math.round((current / total) * 100)
    stageText = '正在处理'
  }

  const displayCurrent = current > 0 ? current : 0
  const displayTotal = total > 0 ? total : 0
  const displayPct = Math.min(99, Math.max(0, pct)) // 不显示100%，避免误导

  return (
    <div className="import-progress">
      <div className="import-progress-text">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="import-spin-icon">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
        <span>{stageText} {displayCurrent}/{displayTotal}</span>
      </div>
      {subText && (
        <div className="import-progress-subtext" title={subText}>
          {subText}
        </div>
      )}
      <div className="import-progress-track">
        <div
          className="import-progress-fill"
          style={{ width: `${displayPct}%` }}
        />
      </div>
    </div>
  )
}
