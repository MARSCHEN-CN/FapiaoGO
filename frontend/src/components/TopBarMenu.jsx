/**
 * TopBarMenu — 顶栏下拉菜单（懒加载）
 * 包含：菜单下拉、主题卡片、快捷键卡片、关于弹窗（via Portal 到 document.body）
 */
import { createPortal } from 'react-dom'
import { PUBLIC_BASE, APP_VERSION } from '../config'

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
  updateModalOpen,
  updateLoading,
  updateInfo,
  setUpdateModalOpen,
  onCheckUpdate,
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

          {/* 检查更新 */}
          <button
            className="tb-menu-item"
            onClick={() => onCheckUpdate()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6"/>
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
              <path d="M3 22v-6h6"/>
              <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
            </svg>
            <span>检查更新</span>
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
              <p className="tb-about-version">版本 V{APP_VERSION}</p>
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

      {/* 检查更新弹窗 — 用 Portal 挂到 document.body */}
      {updateModalOpen && createPortal(
        <div className="tb-about-overlay" onClick={() => setUpdateModalOpen(false)}>
          <div className="tb-update-modal" onClick={e => e.stopPropagation()}>
            <button className="tb-about-close" onClick={() => setUpdateModalOpen(false)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>

            {updateLoading ? (
              <div className="tb-update-loading">
                <div className="tb-update-spinner" />
                <p className="tb-update-loading-text">正在检查更新...</p>
              </div>
            ) : updateInfo?.available ? (
              <>
                <div className="tb-update-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
                    <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
                    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
                    <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
                  </svg>
                </div>
                <h3 className="tb-update-title">有新的版本发布</h3>
                <p className="tb-update-version">请更新到新版本 {updateInfo.version}</p>
                {updateInfo.releaseNotes && (
                  <div className="tb-update-notes">
                    <div className="tb-update-notes-title">更新说明</div>
                    <div className="tb-update-notes-content">{updateInfo.releaseNotes}</div>
                  </div>
                )}
                <div className="tb-update-actions">
                  <button className="tb-update-btn tb-update-btn-primary" onClick={() => {
                    if (updateInfo.releaseUrl) {
                      window.open(updateInfo.releaseUrl, '_blank')
                    }
                    setUpdateModalOpen(false)
                  }}>
                    下载并重启更新
                  </button>
                  <button className="tb-update-btn tb-update-btn-secondary" onClick={() => setUpdateModalOpen(false)}>
                    稍后再说
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="tb-update-icon tb-update-icon-success">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                  </svg>
                </div>
                <h3 className="tb-update-title">已经是最新版本</h3>
                <p className="tb-update-version">当前版本 V{APP_VERSION}</p>
                <div className="tb-update-actions">
                  <button className="tb-update-btn tb-update-btn-primary" onClick={() => setUpdateModalOpen(false)}>
                    好的
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
