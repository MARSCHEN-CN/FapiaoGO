import { useCallback } from 'react'
import { getElectronAPI } from '../utils'

/**
 * 设置窗口标题栏
 * - 左侧：Logo + "FapiaoGO" 名称
 * - 右侧：窗口控制按钮（最小化、关闭）
 */
export default function SettingsTitlebar() {
  const electronAPI = getElectronAPI()

  const handleMinimize = useCallback(() => {
    electronAPI?.window?.minimize?.()
  }, [electronAPI])

  const handleClose = useCallback(() => {
    // 通用 window-close 已通过 BrowserWindow.fromWebContents 支持多窗口
    electronAPI?.window?.close?.()
  }, [electronAPI])

  return (
    <div className="settings-titlebar">
      {/* 左侧：Logo + 名称 */}
      <div className="settings-titlebar-left">
        <svg className="settings-titlebar-logo" viewBox="0 0 32 32" width="20" height="20">
          <rect x="2" y="6" width="28" height="20" rx="3" fill="currentColor" opacity="0.15"/>
          <rect x="5" y="10" width="22" height="12" rx="1.5" fill="currentColor" opacity="0.35"/>
          <line x1="8" y1="14" x2="18" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <line x1="8" y1="17" x2="15" y2="17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        <span className="settings-titlebar-name">FapiaoGO</span>
      </div>

      {/* 右侧：窗口控制 */}
      <div className="settings-titlebar-controls">
        <button className="settings-titlebar-btn" onClick={handleMinimize} title="最小化">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
        <button className="settings-titlebar-btn settings-titlebar-close" onClick={handleClose} title="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="6" y1="6" x2="18" y2="18"/>
            <line x1="6" y1="18" x2="18" y2="6"/>
          </svg>
        </button>
      </div>
    </div>
  )
}
