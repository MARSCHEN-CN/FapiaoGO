/**
 * TopBarMenu — 顶栏下拉菜单（懒加载）
 * 包含：菜单下拉、主题卡片、快捷键卡片、关于弹窗（via Portal 到 document.body）
 */
import { createPortal } from 'react-dom'
import { PUBLIC_BASE } from '../config'

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
              { label: '缩放预览', key: 'Ctrl + 滚轮' },
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
              <img src={`${PUBLIC_BASE}icon/app-icon.png`} alt="Logo" width="48" height="48" />
            </div>
            <h3 className="tb-about-title">发票管理助手</h3>
            <div className="tb-about-version-row">
              <p className="tb-about-version">版本 V1.0.0</p>
              <a
                className="tb-about-github"
                href="https://github.com/MARSCHEN-CN/FapiaoGO"
                target="_blank"
                rel="noopener noreferrer"
                title="查看 GitHub 仓库"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
                </svg>
              </a>
            </div>
            <p className="tb-about-desc">基于 Electron + React 构建</p>
            <p className="tb-about-copyright">Copyright © MarsChen 2026</p>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
