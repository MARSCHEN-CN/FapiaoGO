import React from 'react'
import { PAPER_LABEL_MAP } from '../config'

/**
 * 预览区状态指示器
 * 显示：小绿点 + 就绪 + 特殊模式 + 纸张大小 + 方向
 */
export default React.memo(function StatusIndicator({ paperSize, landscape, extraSpecial }) {
  // 纸张显示名称来自单一注册表 (electron/shared/paper-registry.js)
  const getPaperLabel = (size) => {
    return PAPER_LABEL_MAP[size] || size || 'A4'
  }

  const parts = []

  // 小绿点 + 就绪
  parts.push(
    <span key="ready" className="status-indicator-item">
      <span className="status-dot"></span>
      就绪
    </span>
  )

  // 一普二专模式
  if (extraSpecial) {
    parts.push(
      <span key="special" className="status-indicator-item status-special">
        一普二专
      </span>
    )
  }

  // 纸张大小
  parts.push(
    <span key="paper" className="status-indicator-item">
      {getPaperLabel(paperSize)}
    </span>
  )

  // 方向
  parts.push(
    <span key="direction" className="status-indicator-item">
      {landscape ? '横向' : '竖向'}
    </span>
  )

  return <div className="status-indicator">{parts}</div>
})
