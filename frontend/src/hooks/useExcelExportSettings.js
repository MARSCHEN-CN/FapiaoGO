import { useState, useCallback, useRef, useEffect } from 'react'

/**
 * Excel 导出字段选择持久化（Commit 4B）
 *
 * 镜像 useSettings 的 save/load 通道，但只管 Excel 字段确认页的勾选列
 * （string[] of keys），落盘到 Settings.json.excelExport.columns。
 *
 * 设计要点：
 *   - 300ms 防抖写入（与 useSettings.saveSettings 一致的手感）。
 *   - 挂载时从主进程加载已持久化的勾选；未持久化返回 null（调用方回落默认全选）。
 *   - 只存 key（string[]），不存 {label,width,virtual} —— 那些由前端 EXCEL_COLUMNS
 *     唯一真源解析，避免导出列定义与持久化耦合。
 */
export function useExcelExportSettings(electronAPIRef) {
  const [columns, setColumns] = useState(null) // 已持久化的 keys（Set）；null = 尚未加载 / 无持久化
  const [loaded, setLoaded] = useState(false)
  const saveTimerRef = useRef(null)

  const persist = useCallback((keys) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const ipc = electronAPIRef.current?.ipcRenderer
      if (ipc) ipc.invoke('save-excel-export-columns', Array.from(keys))
    }, 300)
  }, [electronAPIRef])

  // 挂载时加载已持久化勾选（避免每次打开弹窗闪烁默认全选）
  useEffect(() => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (ipc) {
      ipc.invoke('load-excel-export-columns')
        .then((saved) => {
          if (Array.isArray(saved)) setColumns(new Set(saved))
          setLoaded(true)
        })
        .catch(() => setLoaded(true))
    } else {
      setLoaded(true)
    }
  }, []) // 仅首次挂载加载一次

  // 卸载清理防抖 timer
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  return { columns, loaded, persist }
}
