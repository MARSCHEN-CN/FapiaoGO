/**
 * ImportProgress — 文件导入进度条
 * 无感型：固定在 Sidebar 底部，导入完成后自动淡出消失
 */
export default function ImportProgress({ parsing, parseProgress }) {
  if (!parsing) return null

  const { current, total } = parseProgress
  const pct = total > 0 ? Math.round((current / total) * 100) : 0

  return (
    <div className="import-progress">
      <div className="import-progress-text">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="import-spin-icon">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
        <span>正在处理发票 {current}/{total}</span>
      </div>
      <div className="import-progress-track">
        <div
          className="import-progress-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
