import { useState, useCallback, useRef, useEffect } from 'react'

export function useSettings(electronAPIRef) {
  const [settings, setSettings] = useState({
    printerName: '', copies: 1, paperSize: 'A4', grayscale: false,
    landscape: false, collate: true, extraSpecial: false, scaleFactor: 100,
    marginLeft: 3, marginRight: 3, marginTop: 3, marginBottom: 3,
    marginPreset: 'default',
  })
  const [settingsWindowOpen, setSettingsWindowOpen] = useState(false)
  const [printers, setPrinters] = useState([])
  const saveSettingsTimerRef = useRef(null)

  const saveSettings = useCallback((newSettings) => {
    // 支持函数式更新：saveSettings(prev => ({ ...prev, key: val }))
    const resolved = typeof newSettings === 'function' ? newSettings(settings) : newSettings
    setSettings(resolved)
    if (saveSettingsTimerRef.current) clearTimeout(saveSettingsTimerRef.current)
    saveSettingsTimerRef.current = setTimeout(() => {
      const ipc = electronAPIRef.current?.ipcRenderer
      if (ipc) ipc.invoke('save-print-settings', resolved)
    }, 300)
  }, [settings, electronAPIRef])

  const updateSettings = useCallback((partialSettings) => {
    const newSettings = { ...settings, ...partialSettings }
    saveSettings(newSettings)
  }, [settings, saveSettings])

  const openSettings = useCallback(() => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (ipc) {
      ipc.send('open-settings-window')
      setSettingsWindowOpen(true)
    }
  }, [electronAPIRef])

  // 组件卸载时清理防抖 timer
  useEffect(() => {
    return () => {
      if (saveSettingsTimerRef.current) {
        clearTimeout(saveSettingsTimerRef.current)
      }
    }
  }, [])

  // 挂载时从持久化存储加载设置（避免硬编码默认值闪烁）
  useEffect(() => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (ipc) {
      ipc.invoke('load-print-settings').then((saved) => {
        if (saved && Object.keys(saved).length > 0) {
          setSettings(saved)
        }
      })
    }
  }, []) // 仅在首次挂载时执行

  return {
    settings, setSettings, saveSettings, updateSettings,
    settingsWindowOpen, setSettingsWindowOpen,
    printers, setPrinters,
    openSettings,
  }
}
