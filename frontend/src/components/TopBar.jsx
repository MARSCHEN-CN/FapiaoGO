import { useState, useRef, useEffect, useCallback, lazy, Suspense, memo } from 'react'
import { getElectronAPI } from '../utils'

const TopBarMenu = lazy(() => import('./TopBarMenu'))

const isElectron = typeof window !== 'undefined' && window.process?.type

export default memo(function TopBar({
  extraSpecial,
  paperSize,
  landscape,
  previewFile,
  previewPage,
  numPages,
  prevPage,
  nextPage,
  openSettings,
  onRotate,
  previewRotation = 0,
  onSettingsChange,
  openCalculator,
}) {
  const [isMaximized, setIsMaximized] = useState(false)
  const [isDarkMode, setIsDarkMode] = useState(() => {
    // 从 localStorage 加载主题设置
    const savedTheme = localStorage.getItem('theme')
    if (savedTheme) {
      return savedTheme === 'dark'
    }
    // 默认跟随系统
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches || false
  })
  const [showDropdown, setShowDropdown] = useState(null) // 'menu' | null
  const [showThemeSubmenu, setShowThemeSubmenu] = useState(false)
  const [showShortcutCard, setShowShortcutCard] = useState(false)
  const [aboutModalOpen, setAboutModalOpen] = useState(false)
  const dropdownRef = useRef(null)
  const electronAPI = getElectronAPI()

  // 主题子菜单延迟关闭定时器
  const themeCloseTimerRef = useRef(null)
  // resize 事件节流定时器
  const resizeTimerRef = useRef(null)
  const clearThemeCloseTimer = useCallback(() => {
    if (themeCloseTimerRef.current) {
      clearTimeout(themeCloseTimerRef.current)
      themeCloseTimerRef.current = null
    }
  }, [])
  const scheduleThemeClose = useCallback(() => {
    clearThemeCloseTimer()
    themeCloseTimerRef.current = setTimeout(() => {
      setShowThemeSubmenu(false)
    }, 150) // 150ms 延迟，足够鼠标从按钮移到卡片
  }, [clearThemeCloseTimer])

  // 初始化主题 - 使用 useEffect 确保在挂载时执行
  useEffect(() => {
    // 根据 isDarkMode 设置 data-theme 属性
    if (isDarkMode) {
      document.documentElement.setAttribute('data-theme', 'dark')
    } else {
      document.documentElement.setAttribute('data-theme', 'light')
    }
  }, [isDarkMode]) // 添加 isDarkMode 依赖，初始挂载时会执行

  // 检查窗口最大化状态
  useEffect(() => {
    const checkMaximized = async () => {
      if (electronAPI?.window?.isMaximized) {
        const maximized = await electronAPI.window.isMaximized()
        setIsMaximized(maximized)
      }
    }
    checkMaximized()

    // 监听窗口大小变化（节流，避免频繁 IPC 调用）
    const handleResize = () => {
      if (resizeTimerRef.current) return
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null
        checkMaximized()
      }, 100)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = null
      }
    }
  }, [electronAPI])

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(null)
        setShowThemeSubmenu(false)
        setShowShortcutCard(false)
      }
    }
    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showDropdown])

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (themeCloseTimerRef.current) {
        clearTimeout(themeCloseTimerRef.current)
      }
    }
  }, [])

  const handleMinimize = () => {
    electronAPI?.window?.minimize?.()
  }

  const handleMaximize = () => {
    electronAPI?.window?.maximize?.()
    setTimeout(() => {
      electronAPI?.window?.isMaximized?.().then(setIsMaximized)
    }, 100)
  }

  const handleClose = () => {
    electronAPI?.window?.close?.()
  }

  const toggleTheme = () => {
    const newMode = !isDarkMode
    setIsDarkMode(newMode)
    const theme = newMode ? 'dark' : 'light'
    // 保存主题设置到 localStorage
    localStorage.setItem('theme', theme)
    // 应用主题
    document.documentElement.setAttribute('data-theme', theme)
    // 通知主进程，广播给其他窗口（计算器、设置等）
    electronAPI?.ipcRenderer?.send?.('theme-changed', theme)
    setShowDropdown(null)
  }

  const toggleDropdown = (type) => {
    setShowDropdown(showDropdown === type ? null : type)
  }

  return (
    <div className="topbar">
      <div className="tb-left" style={{ WebkitAppRegion: 'drag', display: 'flex', alignItems: 'center', gap: '8px' }}>
        {/* 左侧留空，拖拽区域 */}
      </div>

      <div className="tb-right">
        <button
          className="tb-icon-btn"
          title="计算器"
          onClick={openCalculator}
        >
          <svg viewBox="0 0 1024 1024" style={{ fill: 'currentColor', stroke: 'none', width: 16, height: 16 }}>
            <path d="M383.98 512.13h-63.92v63.92h63.92v-63.92z"/>
            <path d="M97.93 98.23V928.3H928V98.23H97.93zM864 255.95h-63.82v-93.73H864v93.73z m-191.85 0v-93.73h63.98v93.73h-63.98z m-64.05-93.72v93.73H161.93v-93.73H608.1zM161.93 864.29V320H864v544.3H161.93z"/>
            <path d="M256.05 448.21h192.04v63.92H256.05zM576.38 448.64h192.04v63.92H576.38zM576.38 678.52h192.04v63.92H576.38zM391.87 619.98l-45.3 45.3-45.29-45.3-45.2 45.2 45.3 45.3-45.3 45.29 45.2 45.2 45.29-45.3 45.3 45.3 45.2-45.2-45.3-45.29 45.3-45.3zM320.06 384.1h63.92v63.92h-63.92zM649.83 623.89h45.14v45.14h-45.14zM649.83 751.92h45.14v45.14h-45.14z"/>
          </svg>
        </button>

        {/* 菜单按钮（三横条图标） */}
        <div className="tb-icon-group" ref={dropdownRef}>
          <button
            className="tb-icon-btn"
            onClick={() => toggleDropdown('menu')}
            title="菜单"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="6" x2="21" y2="6"/>
              <line x1="3" y1="12" x2="21" y2="12"/>
              <line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>

          {/* 菜单下拉 & 弹窗（懒加载） */}
          <Suspense fallback={null}>
            <TopBarMenu
              showDropdown={showDropdown}
              showThemeSubmenu={showThemeSubmenu}
              showShortcutCard={showShortcutCard}
              aboutModalOpen={aboutModalOpen}
              isDarkMode={isDarkMode}
              toggleTheme={toggleTheme}
              toggleDropdown={toggleDropdown}
              setShowDropdown={setShowDropdown}
              setShowThemeSubmenu={setShowThemeSubmenu}
              setShowShortcutCard={setShowShortcutCard}
              setAboutModalOpen={setAboutModalOpen}
              clearThemeCloseTimer={clearThemeCloseTimer}
              scheduleThemeClose={scheduleThemeClose}
            />
          </Suspense>
        </div>

        <button
          className="tb-btn"
          onClick={openSettings}
          onMouseEnter={() => import('./SettingsWindow')}
          title="设置"
        >
          <svg viewBox="0 0 24 24">
            <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>

        {/* 窗口控制按钮 */}
        <div className="tb-window-controls">
          <button className="tb-btn tb-win-btn" onClick={handleMinimize} title="最小化">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
          <button className="tb-btn tb-win-btn" onClick={handleMaximize} title={isMaximized ? '还原' : '最大化'}>
            {isMaximized ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="4" y="6" width="14" height="14" rx="1"/>
                <path d="M8 6V4a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1h-2"/>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="4" y="4" width="16" height="16" rx="1"/>
              </svg>
            )}
          </button>
          <button className="tb-btn tb-win-btn tb-win-close" onClick={handleClose} title="关闭">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="6" x2="18" y2="18"/>
              <line x1="6" y1="18" x2="18" y2="6"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
})
