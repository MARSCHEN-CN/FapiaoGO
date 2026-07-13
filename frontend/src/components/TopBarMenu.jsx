/**
 * TopBarMenu — 顶栏下拉菜单（懒加载）
 * 包含：菜单下拉、主题卡片、快捷键卡片、关于弹窗（via Portal 到 document.body）
 */
import { createPortal } from 'react-dom'

export default function TopBarMenu({
  showDropdown,
  showThemeSubmenu,
  showShortcutCard,
  aboutModalOpen,
  isDarkMode,
  toggleTheme,
  toggleDropdown,
  setShowDropdown,
  setShowThemeSubmenu,
  setShowShortcutCard,
  setAboutModalOpen,
  clearThemeCloseTimer,
  scheduleThemeClose,
}) {
  return (
    <>
      {/* 菜单下拉卡片 */}
      {showDropdown === 'menu' && (
        <div className="tb-dropdown menu-dropdown">
          {/* 主题 */}
          <button
            className="tb-menu-item"
            onMouseEnter={() => { clearThemeCloseTimer(); setShowThemeSubmenu(true) }}
            onMouseLeave={() => scheduleThemeClose()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5"/>
              <line x1="12" y1="1" x2="12" y2="3"/>
              <line x1="12" y1="21" x2="12" y2="23"/>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
              <line x1="1" y1="12" x2="3" y2="12"/>
              <line x1="21" y1="12" x2="23" y2="12"/>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
            <span>主题</span>
          </button>

          {/* 快捷键 */}
          <button
            className="tb-menu-item"
            onMouseEnter={() => setShowShortcutCard(true)}
            onMouseLeave={() => setShowShortcutCard(false)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2"/>
              <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M6 16h.01"/>
            </svg>
            <span>快捷键</span>
          </button>

          {/* 关于 */}
          <button
            className="tb-menu-item"
            onClick={() => { setShowDropdown(null); setAboutModalOpen(true); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="16" x2="12" y2="12"/>
              <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
            <span>关于</span>
          </button>
        </div>
      )}

      {/* 主题悬停卡片 */}
      {showThemeSubmenu && (
        <div
          className="tb-shortcut-popover"
          onMouseEnter={() => { clearThemeCloseTimer(); setShowThemeSubmenu(true) }}
          onMouseLeave={() => scheduleThemeClose()}
        >
          <div className="tb-shortcuts-grid">
            <button
              className={`tb-submenu-item ${!isDarkMode ? 'active' : ''}`}
              onClick={() => { toggleTheme(); setShowThemeSubmenu(false); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="5"/>
                <line x1="12" y1="1" x2="12" y2="3"/>
                <line x1="12" y1="21" x2="12" y2="23"/>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                <line x1="1" y1="12" x2="3" y2="12"/>
                <line x1="21" y1="12" x2="23" y2="12"/>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
              <span>浅色模式</span>
              {!isDarkMode && <span className="tb-dropdown-check">&#10003;</span>}
            </button>
            <button
              className={`tb-submenu-item ${isDarkMode ? 'active' : ''}`}
              onClick={() => { toggleTheme(); setShowThemeSubmenu(false); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
              <span>深色模式</span>
              {isDarkMode && <span className="tb-dropdown-check">&#10003;</span>}
            </button>
          </div>
        </div>
      )}

      {/* 快捷键悬停卡片 */}
      {showShortcutCard && (
        <div
          className="tb-shortcut-popover"
          onMouseEnter={() => setShowShortcutCard(true)}
          onMouseLeave={() => setShowShortcutCard(false)}
        >
          <div className="tb-shortcuts-grid">
            {[
              { label: '打印', key: 'Ctrl+P' },
              { label: '计算器', key: 'F2' },
              { label: '删除', key: 'Delete' },
              { label: '上一个', key: '\u2190' },
              { label: '下一个', key: '\u2192' },
              { label: '取消', key: 'Esc' },
            ].map(({ label, key }) => (
              <div className="tb-shortcut-item" key={label}>
                <span className="tb-shortcut-label">{label}</span>
                <span className="tb-shortcut-key">{key}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 关于弹窗 — 用 Portal 挂到 document.body，脱离布局树，避免 position: fixed 受祖先包含块影响 */}
      {aboutModalOpen && createPortal(
        <div className="tb-about-overlay" onClick={() => setAboutModalOpen(false)}>
          <div className="tb-about-modal" onClick={e => e.stopPropagation()}>
            <button className="tb-about-close" onClick={() => setAboutModalOpen(false)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <div className="tb-about-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="40" height="40">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
            </div>
            <h3 className="tb-about-title">发票管理助手</h3>
            <p className="tb-about-version">版本 1.0.0</p>
            <p className="tb-about-desc">基于 Electron + React 构建</p>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
