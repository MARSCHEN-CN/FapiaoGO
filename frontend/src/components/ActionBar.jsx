import React, { useState, useRef, useEffect } from 'react'
import { useFileContext } from '../contexts/FileContext'

/**
 * 现代化操作按钮区域
 * 包含三个核心功能：重命名、打包导出、打印/导出
 * 支持执行中状态、进度可视化、禁用状态
 */
export default React.memo(function ActionBar({
  handleRename,
  handlePack,
  handlePrint,
  packing,
  packProgress,
  printing,
  removeFailedFiles,
  handleExportExcel,
  exporting,
}) {
  const { files, chineseAmount, totalAmountInt, totalAmountDecimal, printableCount, hasFailedFiles, failedFilesCount } = useFileContext()
  const filesCount = files.length
  // 导出下拉菜单状态
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false)
  const exportDropdownRef = useRef(null)

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (exportDropdownRef.current && !exportDropdownRef.current.contains(e.target)) {
        setExportDropdownOpen(false)
      }
    }
    if (exportDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [exportDropdownOpen])

  // 计算进度百分比
  const renameProgress = packing && packProgress.total > 0
    ? Math.round((packProgress.current / packProgress.total) * 100)
    : 0

  return (
    <div className="actionbar">
      {/* 左侧：金额信息 */}
      {filesCount > 0 && !hasFailedFiles && (
        <div className="abm-left">
          <div className="abm-amount-card">
            <div className="abm-amount-label">总金额</div>
            <div className="abm-amount-value">
              <span className="abm-amount-int">{totalAmountInt}</span>
              <span className="abm-amount-decimal">.{totalAmountDecimal}</span>
            </div>
            <div className="abm-amount-cn">大写：{chineseAmount}</div>
          </div>
        </div>
      )}

      {/* 右侧：操作按钮组 */}
      <div className="abm-right">
        {/* 导出按钮（点击上方弹出下拉菜单） */}
        {filesCount > 0 && (
          <div className="abm-btn-wrapper" ref={exportDropdownRef}>
            <button
              className={`abm-btn abm-btn-export ${exporting ? 'executing' : ''} ${exportDropdownOpen ? 'open' : ''}`}
              onClick={() => setExportDropdownOpen(prev => !prev)}
              disabled={exporting || packing}
              aria-label={exporting ? '导出中...' : '导出'}
            >
              <div className="abm-btn-icon">
                {exporting ? (
                  <svg className="abm-spinner" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" fill="none" strokeWidth="2" stroke="currentColor" strokeDasharray="31.4 31.4" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 1024 1024" fill="none">
                    <path d="M452.923077 315.076923v315.076923h118.153846V315.076923h65.831385L512 190.168615 387.091692 315.076923z" fill="currentColor" opacity="0.5"/>
                    <path d="M157.538462 866.461538h708.923076V512h78.769231v433.230769H78.769231V512h78.769231v354.461538z m492.307692-472.615384v315.076923H374.153846V393.846154h-177.230769L512 78.769231l315.076923 315.076923h-177.230769z m-196.923077-78.769231v315.076923h118.153846V315.076923h65.831385L512 190.168615 387.091692 315.076923H452.923077z m-78.769231 433.230769h275.692308v78.769231H374.153846v-78.769231z" fill="currentColor"/>
                  </svg>
                )}
              </div>
              <span className="abm-btn-text">{exporting ? '导出中...' : '导出'}</span>
            </button>

            {exportDropdownOpen && (
              <div className="abm-dropdown">
                <button
                  className="abm-dropdown-item"
                  onClick={() => { handleExportExcel(); setExportDropdownOpen(false) }}
                >
                  <svg viewBox="0 0 48 48" fill="none">
                    <path d="M10 6H30L38 14V40C38 41.1046 37.1046 42 36 42H10C8.89543 42 8 41.1046 8 40V8C8 6.89543 8.89543 6 10 6Z" stroke="currentColor" strokeWidth="4" strokeLinejoin="round"/>
                    <path d="M28 6V14H38" stroke="currentColor" strokeWidth="4" strokeLinejoin="round"/>
                    <path d="M18 24L24 30L30 24" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M24 30V18" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/>
                  </svg>
                  导出为Excel
                </button>
                <button
                  className="abm-dropdown-item"
                  onClick={() => { handlePack(); setExportDropdownOpen(false) }}
                >
                  <svg viewBox="0 0 48 48" fill="none">
                    <path d="M4 10C4 8.89543 4.89543 8 6 8H18L24 14H42C43.1046 14 44 14.8954 44 16V38C44 39.1046 43.1046 40 42 40H6C4.89543 40 4 39.1046 4 38V10Z" stroke="currentColor" strokeWidth="4" strokeLinejoin="round"/>
                    <path d="M30 26H18" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/>
                    <path d="M28 22L32 26L28 30" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  导出为压缩包
                </button>
              </div>
            )}
          </div>
        )}

        {/* 重命名按钮 */}
        {filesCount > 0 && (
          <div className="abm-btn-wrapper">
            <button
              className={`abm-btn abm-btn-rename ${packing ? 'executing' : ''}`}
              onClick={handleRename}
              disabled={packing}
              aria-label={packing ? `重命名中 ${packProgress.current}/${packProgress.total}` : '重命名'}
            >
              <div className="abm-btn-icon">
                {packing ? (
                  <svg className="abm-spinner" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" fill="none" strokeWidth="2" stroke="currentColor" strokeDasharray="31.4 31.4" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 1024 1024" width="16" height="16">
                    <path d="M163.84 619.52l-57.6 219.52a38.4 38.4 0 0 0 8.96 35.84 37.76 37.76 0 0 0 25.6 10.24h14.72L355.84 832h6.4l551.68-576a92.8 92.8 0 0 0 24.32-74.24 112.64 112.64 0 0 0-32-78.08l-52.48-50.56a106.24 106.24 0 0 0-74.88-32.64 88.96 88.96 0 0 0-64 26.24l-550.4 571.52z m694.4-424.32l-54.4 56.32-88.96-93.44 53.12-56.96a25.6 25.6 0 0 1 34.56 0l53.12 53.76a30.72 30.72 0 0 1 8.32 20.48 22.4 22.4 0 0 1-5.76 16zM261.76 628.48l394.88-411.52 89.6 94.08-394.88 410.88z m-73.6 167.68l28.8-109.44L293.76 768z m693.12-376.32M938.88 1001.6h-832a35.2 35.2 0 0 1-35.2-35.2 34.56 34.56 0 0 1 35.2-35.2h832a35.2 35.2 0 0 1 35.2 35.2 35.2 35.2 0 0 1-35.2 35.2z" fill="currentColor"/>
                  </svg>
                )}
              </div>
              <div className="abm-btn-content">
                <span className="abm-btn-text">
                  {packing ? `重命名中` : '重命名'}
                </span>
                {packing && (
                  <span className="abm-btn-progress">
                    {packProgress.current}/{packProgress.total}
                  </span>
                )}
              </div>
              {packing && (
                <div className="abm-progress-bar">
                  <div className="abm-progress-fill" style={{ width: `${renameProgress}%` }} />
                </div>
              )}
            </button>
          </div>
        )}

        {/* 打印/导出按钮（主操作） */}
        <div className="abm-btn-wrapper">
          <button
            className={`abm-btn abm-btn-print ${printing ? 'executing' : ''}`}
            onClick={handlePrint}
            disabled={printing || printableCount === 0}
            aria-label={printing ? '打印中...' : `打印/导出 (${printableCount}个可打印)`}
          >
            <div className="abm-btn-icon">
              {printing ? (
                <svg className="abm-spinner" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" fill="none" strokeWidth="2" stroke="currentColor" strokeDasharray="31.4 31.4" />
                </svg>
              ) : (
                <svg viewBox="0 0 1025 1024" width="16" height="16" fill="currentColor">
                  <path d="M736.1 82v521h-446V82h446m20-80h-486c-33.1 0-60 26.9-60 60v561c0 33.1 26.9 60 60 60h486c33.1 0 60-26.9 60-60V62c0-33.1-26.8-60-60-60z"/>
                  <path d="M825.1 551c17.8 0 35 2.9 51 8.6 14.8 5.3 27.8 12.7 38.9 22 11.3 9.5 30.2 29.7 30.2 58.2V943h-864V639.8c0-28.5 18.9-48.7 30.2-58.2 11-9.3 24.1-16.7 38.9-22 16-5.7 33.1-8.6 51-8.6h9.5v51.5c0 44.2 35.8 80 80 80h446c44.2 0 80-35.8 80-80V551h8.3m0-80h-88.5v131.5h-446V471h-89.5c-110.5 0-200 75.6-200 168.8v332.6c0 28 26.9 50.6 60 50.6h904c33.1 0 60-22.7 60-50.6V639.8c0-93.2-89.5-168.8-200-168.8z"/>
                  <path d="M668.1 534h-310c-22.1 0-40-17.9-40-40s17.9-40 40-40h310c22.1 0 40 17.9 40 40s-17.9 40-40 40z m0-145h-310c-22.1 0-40-17.9-40-40s17.9-40 40-40h310c22.1 0 40 17.9 40 40s-17.9 40-40 40z m0-149h-310c-22.1 0-40-17.9-40-40s17.9-40 40-40h310c22.1 0 40 17.9 40 40s-17.9 40-40 40zM595.1 924h-164c-22.1 0-40-17.9-40-40s17.9-40 40-40h164c22.1 0 40 17.9 40 40s-17.9 40-40 40z"/>
                </svg>
              )}
            </div>
            <div className="abm-btn-content">
              <span className="abm-btn-text">
                {printing ? '打印中...' : '打印'}
              </span>
            </div>
            
            {/* 徽章（仅显示数量） */}
            {printableCount > 0 && !printing && (
              <div className="abm-badge">
                {printableCount}
              </div>
            )}
          </button>
        </div>
      </div>
    </div>
  )
})