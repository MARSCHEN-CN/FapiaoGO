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
                  <svg viewBox="0 0 1024 1024" style={{ width: 17, height: 17 }}>
                    <path d="M968.704 135.168h-430.08v752.64h430.08c15.36 0 26.624-12.288 26.624-26.624V162.816c0-15.36-11.264-27.648-26.624-27.648z" fill="currentColor"/>
                    <path d="M727.04 270.336h188.416v80.896H727.04z m0 268.288h188.416v80.896H727.04z m0 134.144h188.416v80.896H727.04z m0-268.288h188.416v80.896H727.04zM538.624 270.336h134.144v80.896H538.624z m0 268.288h134.144v80.896H538.624z m0 134.144h134.144v80.896H538.624z m0-268.288h134.144v80.896H538.624z" fill="white"/>
                    <path d="M592.896 996.352L28.672 888.832V135.168L592.896 27.648z" fill="currentColor"/>
                    <path d="M379.904 696.32l-63.488-119.808c-2.048-4.096-5.12-12.288-7.168-24.576H307.2c-1.024 6.144-4.096 14.336-8.192 25.6L235.52 696.32h-99.328l117.76-184.32-107.52-184.32h101.376l53.248 110.592c4.096 9.216 8.192 19.456 11.264 30.72h1.024c2.048-7.168 6.144-17.408 11.264-31.744L381.952 327.68h92.16L364.544 509.952 478.208 696.32h-98.304z" fill="white"/>
                  </svg>
                  导出为Excel
                </button>
                <button
                  className="abm-dropdown-item"
                  onClick={() => { handlePack(); setExportDropdownOpen(false) }}
                >
                  <svg viewBox="0 0 1024 1024" style={{ width: 17, height: 17 }}>
                    <path d="M605.32079 142.690499h383.879586v726.336782H605.32079z" fill="white"/>
                    <path d="M1022.795861 153.888993A40.699906 40.699906 0 0 0 977.761054 108.372531c-124.146754-1.926623-248.654751 0-373.283161 0V0h-65.746002C359.074318 31.30762 179.537159 63.698965 0 95.488241v833.264346c177.490122 31.90969 355.100659 62.133584 532.349953 94.765757h72.248354v-118.607714h349.200376c19.988711-0.963311 42.024459 0.722484 59.002822-12.041392 13.486359-21.313264 9.994356-48.165569 11.198495-72.248354-1.685795-221.802446 0.842897-444.327375-1.204139-666.731891z m-34.197554 715.258702H604.718721V142.931326H988.598307z" fill="currentColor"/>
                    <path d="M763.063029 201.091251v13.365946L686.35936 289.715898h81.761054v14.449671h-111.021637v-13.245531L734.524929 215.540922h-72.248353v-14.449671zM807.375353 201.091251v103.074318h-22.035748V201.091251zM889.136406 201.091251c32.270931 0 48.165569 10.476011 48.16557 31.548448S921.407338 264.91063 888.775165 264.91063h-33.234243v39.616181h-21.915334V201.091251z m-33.595484 49.008467h31.909689a44.793979 44.793979 0 0 0 21.313265-3.97366 14.570085 14.570085 0 0 0 6.381938-13.486359 14.208843 14.208843 0 0 0-6.984008-13.125118 42.144873 42.144873 0 0 0-21.19285-3.973659h-31.428034z" fill="currentColor"/>
                    <path d="M375.330198 434.694262L240.827846 586.054563h139.439322v57.557855H149.915334v-54.547507L286.585136 433.490122H159.428034v-56.353716h215.902164z" fill="white"/>
                    <path d="M674.317968 662.276576h246.848542v147.747883H674.317968zM921.888993 361.241769H674.317968v248.052681h248.052681V361.241769z m-148.109125 24.082784h24.082785v24.082785h-24.082785z m48.165569 168.579492h-48.165569v-64.301035h48.165569z m0-120.413923h-24.082784v24.082785h24.082784v24.082784h-24.082784v-24.082784h-24.082785v-24.082785h24.082785v-24.082784h24.082784z" fill="currentColor"/>
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
                <svg viewBox="0 0 1024 1024">
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
                <svg viewBox="0 0 48 48" style={{ strokeWidth: 4 }}>
                  <path d="M37 32H11V44H37V32Z" strokeLinejoin="round" />
                  <path fillRule="evenodd" clipRule="evenodd" d="M4 20H44V38H37.0173V32H10.9805V38H4V20Z" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M38 4H10V20H38V4Z" strokeLinejoin="round" />
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