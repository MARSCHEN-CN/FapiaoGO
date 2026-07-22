/**
 * ZoomToolbar — DocumentViewer 缩放工具栏（D2-4）
 *
 * 职责（单一）：显示当前缩放状态 + 上报点击/选择事件。
 *   不拥有缩放状态：mode/scale/zoomPercent 全部由 useViewerState 驱动，经 props 传入；
 *   本组件只读 state、只调 actions。唯一的本地 state 是下拉菜单开合（瞬态 UI，非缩放域状态）。
 *
 * 适用范围：仅 DocumentViewer 路径（PDF 已注册）。legacy 路径（图片/OFD）继续用
 *   App.jsx control-bar 的 preview.zoom 工具栏，与本组件无关。
 *
 * 显示语义（D2-4 冻结，决策 A）：
 *   fit 模式  → 「自适应」（不显示 fitScale×100，避免随窗口变化误导用户）。
 *   manual 模式 → fit 相对百分比 `${zoomPercent}%`（= round(scale/fitScale×100)）。
 *
 * 复用 App.jsx 旧缩放工具栏的 CSS 类（tb-btn / tb-zoom-trigger / sort-dropdown /
 *   zoom-dropdown 等，见 topbar.css），保证视觉与 legacy 一致。
 *
 * @module components/ZoomToolbar
 */

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { ZOOM_STEPS } from '../config'

/**
 * @param {Object} props
 * @param {import('../hooks/useViewerState').ViewerState} props.state - useViewerState 状态（读 mode/zoomPercent）
 * @param {import('../hooks/useViewerState').ViewerActions} props.actions - useViewerState actions
 *   （调 zoomIn/zoomOut/setScalePreset/setFitMode）
 */
export function ZoomToolbar({ state, actions }) {
  const { mode, zoomPercent } = state

  // 下拉菜单开合（瞬态 UI 状态，非缩放域；关闭沿用 legacy 150ms 淡出动画）
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuClosing, setMenuClosing] = useState(false)
  const dropdownRef = useRef(null)
  const closeTimeoutRef = useRef(null)

  const handleClose = useCallback(() => {
    if (closeTimeoutRef.current) return
    setMenuClosing(true)
    closeTimeoutRef.current = setTimeout(() => {
      closeTimeoutRef.current = null
      setMenuClosing(false)
      setMenuOpen(false)
    }, 150)
  }, [])

  // 点击菜单外关闭
  useEffect(() => {
    if (!menuOpen) return undefined
    const onDocClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) handleClose()
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen, handleClose])

  // 卸载清理关闭动画 timeout
  useEffect(() => () => {
    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current)
  }, [])

  const label = mode === 'fit' ? '自适应' : `${zoomPercent}%`

  return (
    <div className="canvas-zoom-control viewer-zoom-toolbar">
      <button className="tb-btn" onClick={actions.zoomOut} title="缩小">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      </button>

      <div className="sort-dropdown-container" ref={dropdownRef}>
        <button className="tb-zoom-trigger" onClick={() => setMenuOpen(!menuOpen)}>
          {label}
        </button>
        {(menuOpen || menuClosing) && (
          <div className={`sort-dropdown zoom-dropdown ${menuClosing ? 'closing' : ''}`}>
            <div className="sort-dropdown-header">缩放比例</div>
            <button
              className={`sort-dropdown-item ${mode === 'fit' ? 'active' : ''}`}
              onClick={() => { actions.setFitMode(); handleClose() }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ width: '16px', height: '16px' }}>
                <rect x="2" y="2" width="20" height="20" rx="2"/>
                <path d="M2 15l5-5 4 4 4-4 7 7"/>
              </svg>
              自适应
              {mode === 'fit' && (
                <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 'auto', width: '14px', height: '14px' }}>
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )}
            </button>
            <div className="zoom-dropdown-divider"></div>
            <div style={{ padding: '6px 12px', fontSize: '12px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
              当前：{label}
            </div>
            {ZOOM_STEPS.map((s) => (
              <button
                key={s}
                className={`sort-dropdown-item ${mode === 'manual' && zoomPercent === s ? 'active' : ''}`}
                onClick={() => { actions.setScalePreset(s); handleClose() }}
              >
                {s}%
                {mode === 'manual' && zoomPercent === s && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 'auto', width: '14px', height: '14px' }}>
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <button className="tb-btn" onClick={actions.zoomIn} title="放大">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      </button>
    </div>
  )
}
