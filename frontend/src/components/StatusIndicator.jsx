import React from 'react'

export default React.memo(function StatusIndicator() {
  return (
    <div className="status-indicator">
      <span className="status-indicator-item">
        <span className="status-dot"></span>
        就绪
      </span>
    </div>
  )
})
