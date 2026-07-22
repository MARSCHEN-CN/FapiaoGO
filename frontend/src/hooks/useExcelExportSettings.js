import { useState, useCallback, useRef, useEffect } from 'react'

/**
 * Excel 导出字段选择持久化（Commit 4B + 5 修复）
 *
 * 镜像 useSettings 的 save/load 通道，但只管 Excel 字段确认页的勾选列
 * （string[] of keys），落盘到 Settings.json.excelExport.columns。
 *
 * 三态约定（Commit 5 修复关键）：
 *   - undefined : 仍在加载（未知）—— Modal 等待，不回落默认、不提前锁定
 *   - null      : 已加载但无持久化 —— Modal 回落 23/23 全选
 *   - Set       : 已保存勾选 —— Modal 应用之
 * 用 undefined 与 null 区分「未加载完」与「无配置」，避免把加载中误判为「无配置」。
 *
 * 设计要点：
 *   - 300ms 防抖写入（与 useSettings.saveSettings 一致的手感）。
 *   - 挂载时从主进程加载一次已持久化的勾选。
 *   - persist 时**乐观回写 columns**：让同一会话内重开弹窗直接读到最新勾选，
 *     无需再往返 IPC（否则重开会因 hook 未更新而回落默认，复现「不恢复」bug）。
 *   - 只存 key（string[]），不存 {label,width,virtual} —— 那些由前端 EXCEL_COLUMNS
 *     唯一真源解析，避免导出列定义与持久化耦合。
 */
export function useExcelExportSettings(electronAPIRef) {
  // undefined = 加载中（未知）；null = 无持久化；Set = 已保存勾选
  const [columns, setColumns] = useState(undefined)
  const saveTimerRef = useRef(null)

  const persist = useCallback((keys) => {
    const next = keys instanceof Set ? new Set(keys) : new Set(keys)
    // 乐观更新：同会话内重开弹窗直接读到最新勾选
    setColumns(next)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const ipc = electronAPIRef.current?.ipcRenderer
      if (ipc) ipc.invoke('save-excel-export-columns', Array.from(next))
    }, 300)
  }, [electronAPIRef])

  // 挂载时加载已持久化勾选（仅一次）
  useEffect(() => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (ipc) {
      ipc.invoke('load-excel-export-columns')
        .then((saved) => {
          setColumns(Array.isArray(saved) ? new Set(saved) : null)
        })
        .catch(() => setColumns(null))
    } else {
      setColumns(null)
    }
  }, []) // 仅首次挂载加载一次

  // 卸载清理防抖 timer
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  return { columns, persist }
}
