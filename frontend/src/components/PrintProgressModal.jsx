import React, { useMemo } from 'react'

/**
 * 实时打印控制中心
 * 将原有的简单进度弹窗升级为具备进度总览、文件列表、控制按钮和统计信息的完整容器
 */
const PrintProgressModal = ({ printing, printFiles, printProgress, onClose }) => {
  if (!printing) return null

  const progressList = useMemo(() => {
    return printFiles.map((file) => {
      const p = printProgress[file.key]
      return {
        key: file.key,
        name: file.name || file.path?.split(/[\\/]/).pop() || '',
        status: p?.status || 'waiting',  // waiting | printing | done | error
        page: p?.page,
        total: p?.total,
        percent: p?.percent,
        error: p?.error || '',
      }
    })
  }, [printFiles, printProgress])

  const stats = useMemo(() => {
    const done = progressList.filter((f) => f.status === 'done').length
    const error = progressList.filter((f) => f.status === 'error').length
    const printing = progressList.filter((f) => f.status === 'printing').length
    const waiting = progressList.filter((f) => f.status === 'waiting').length
    const total = progressList.length
    const completed = done + error
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0
    const allDone = completed === total
    const hasError = error > 0
    return { done, error, printing, waiting, total, completed, pct, allDone, hasError }
  }, [progressList])

  return (
    <div className="modal-overlay pc-overlay">
      <div className="pc-panel">
        {/* 头部 */}
        <div className="pc-header">
          <div className="pc-header-left">
            <div className={`pc-status-dot ${stats.allDone ? (stats.hasError ? 'error' : 'done') : 'active'}`} />
            <h3 className="pc-title">
              {(() => {
                if (stats.allDone) return stats.hasError ? '打印完成（含错误）' : '打印完成'
                const hasV2 = printFiles.some(f => f.key?.endsWith('_v2'))
                if (!hasV2) return '正在打印'
                const v2Printing = progressList.some(f => f.key?.endsWith('_v2') && f.status === 'printing')
                const v2Done = progressList.filter(f => f.key?.endsWith('_v2')).every(f => f.status === 'done' || f.status === 'error')
                if (v2Printing || v2Done) return '正在打印（第二轮）'
                return '正在打印（第一轮）'
              })()}
            </h3>
          </div>
          {!stats.allDone && <span className="pc-header-sub">{stats.completed}/{stats.total} 已完成</span>}
        </div>

        {/* 进度总览 */}
        <div className="pc-overview">
          <div className="pc-progress-ring-wrap">
            <svg className="pc-ring" viewBox="0 0 72 72">
              <circle className="pc-ring-track" cx="36" cy="36" r="30" />
              <circle
                className={`pc-ring-fill ${stats.allDone ? (stats.hasError ? 'error' : 'done') : ''}`}
                cx="36" cy="36" r="30"
                strokeDasharray={`${stats.pct * 1.884} 188.4`}
              />
            </svg>
            <div className="pc-ring-center">
              <span className="pc-ring-pct">{stats.pct}%</span>
            </div>
          </div>
          <div className="pc-stats-grid">
            <div className="pc-stat">
              <span className="pc-stat-val">{stats.done}</span>
              <span className="pc-stat-label">成功</span>
            </div>
            <div className="pc-stat">
              <span className={`pc-stat-val ${stats.error > 0 ? 'error' : ''}`}>{stats.error}</span>
              <span className="pc-stat-label">失败</span>
            </div>
            <div className="pc-stat">
              <span className="pc-stat-val">{stats.printing}</span>
              <span className="pc-stat-label">进行中</span>
            </div>
            <div className="pc-stat">
              <span className="pc-stat-val">{stats.waiting}</span>
              <span className="pc-stat-label">等待中</span>
            </div>
          </div>
        </div>

        {/* 进度条 */}
        <div className="pc-bar-section">
          <div className="pc-bar-track">
            <div
              className={`pc-bar-fill ${stats.allDone ? (stats.hasError ? 'error' : 'done') : ''}`}
              style={{ width: `${stats.pct}%` }}
            />
          </div>
        </div>

        {/* 文件列表 */}
        <div className="pc-file-list">
          {progressList.map((item) => (
            <div key={item.key} className={`pc-file-item ${item.status}`}>
              <span className={`pc-file-dot ${item.status}`} />
              <span className={`pc-file-name ${item.status}`} title={item.name}>{item.name}</span>
            <span className="pc-file-info">
              {item.status === 'done' && '完成'}
              {item.status === 'error' && (item.error || '失败')}
              {item.status === 'printing' && (
                (item.page !== undefined && item.total !== undefined && item.total > 0)
                  ? `${item.page}/${item.total}`
                  : (item.percent !== undefined ? `${item.percent}%` : '打印中...')
              )}
              {item.status === 'waiting' && '等待'}
            </span>
            </div>
          ))}
        </div>

        {/* 底部操作 */}
        <div className="pc-footer">
          {stats.allDone && (
            <div className="pc-footer-text">
              {stats.hasError
                ? `${stats.error} 个文件打印失败，请检查后重试`
                : '所有文件已成功发送至打印机'}
            </div>
          )}
          <button
            className={`pc-btn ${stats.allDone ? 'solid' : 'outline'}`}
            onClick={onClose}
          >
            {stats.allDone ? '关闭' : '取消打印'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default PrintProgressModal