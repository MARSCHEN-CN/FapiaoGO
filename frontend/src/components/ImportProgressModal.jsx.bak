/**
 * ImportProgressModal — 导入进度弹窗
 * 导入完成后自动淡出消失
 */
import { useEffect, useState } from 'react'

export default function ImportProgressModal({ importing, parsing, parseProgress }) {
  const [visible, setVisible] = useState(false)

  // 立即响应 importing 状态
  useEffect(() => {
    if (importing) {
      setVisible(true)
    }
  }, [importing])

  // 导入结束后等动画完再卸载
  const handleTransitionEnd = () => {
    if (!importing) setVisible(false)
  }

  if (!visible) return null

  const { current, total } = parseProgress
  const pct = total > 0 ? Math.round((current / total) * 100) : 0
  const showBar = parsing && total > 0

  return (
    <div
      className={`import-modal-overlay ${!importing ? 'import-modal-out' : ''}`}
      onTransitionEnd={handleTransitionEnd}
    >
      <div className={`import-modal-box ${!importing ? 'import-modal-box-out' : ''}`}>
        {/* 旋转图标 */}
        <div className="import-modal-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
        </div>

        <p className="import-modal-title">
          {showBar ? `正在解析 ${current} / ${total} 个文件` : '正在处理文件…'}
        </p>

        {showBar && (
          <>
            <div className="import-modal-track">
              <div className="import-modal-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="import-modal-pct">{pct}%</span>
          </>
        )}
      </div>
    </div>
  )
}
