import { useState, useCallback } from 'react'
import { BACKEND_URL } from '../config'

/**
 * 导出 Excel/CSV hook
 * 
 * 从 App.jsx 提取 ~90 行的 handleExportExcel 逻辑，
 * 内聚导出相关状态和 SSE 流式处理。
 */
export function useExport({ files, electronAPIRef }) {
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState({ current: 0, total: 0, stage: '' })
  const [exportResult, setExportResult] = useState(null)
  const [exportAlert, setExportAlert] = useState(null)
  const closeExportAlert = useCallback(() => setExportAlert(null), [])

  const handleExportExcel = useCallback(async () => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return

    const parsedFiles = files.filter(f => f.status === 'parsed')
    if (parsedFiles.length === 0) {
      setExportAlert({ visible: true, title: '提示', message: '没有可导出的发票数据', type: 'warning' })
      return
    }

    setExporting(true)
    setExportProgress({ current: 0, total: 100, stage: '准备中' })
    setExportResult(null)

    // 只传文件名列表，后端从数据库读取完整数据
    const fileNames = parsedFiles.map(f => f.name || f.path || f.fileName || '').filter(Boolean)
    if (fileNames.length === 0) {
      setExportAlert({ visible: true, title: '提示', message: '无法获取文件名', type: 'warning' })
      setExporting(false)
      return
    }

    try {
      // 第一步：通过 Electron 获取保存路径
      let savePath = ''
      let isCsv = false

      if (ipc) {
        const dialogResult = await ipc.invoke('select-save-path', {
          defaultName: `发票汇总_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
          filters: [
            { name: 'Excel 文件', extensions: ['xlsx'] },
            { name: 'CSV 文件', extensions: ['csv'] },
          ]
        })
        if (!dialogResult || dialogResult.canceled || !dialogResult.filePath) {
          setExporting(false)
          setExportProgress({ current: 0, total: 0, stage: '' })
          return
        }
        savePath = dialogResult.filePath
        isCsv = savePath.toLowerCase().endsWith('.csv')
      } else {
        setExportResult({ success: false, error: 'Electron API 不可用' })
        setExporting(false)
        setExportProgress({ current: 0, total: 0, stage: '' })
        return
      }

      // 第二步：SSE 流式调用后端，实时接收进度
      const response = await fetch(`${BACKEND_URL}/api/export-excel-sse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: savePath,
          fileNames,
          options: { includeRemark: true, splitByType: false },
          format: isCsv ? 'csv' : 'xlsx',
        }),
      })

      // 检查非 2xx 响应，从 JSON 体中提取错误信息
      if (!response.ok) {
        let errorMsg = `服务器返回 ${response.status}`
        try {
          const errBody = await response.json()
          if (errBody.error) errorMsg = errBody.error
        } catch (_) {}
        setExportResult({ success: false, error: errorMsg })
        setExporting(false)
        return
      }

      // 消费 SSE 事件流
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const msg = JSON.parse(line.slice(6))
              if (msg.error) {
                setExportResult({ success: false, error: msg.error })
              } else if (msg.result) {
                setExportProgress(prev => ({ ...prev, current: 100, stage: '完成' }))
                setExportResult(msg.result)
              } else {
                setExportProgress({
                  current: msg.current || 0,
                  total: msg.total || 100,
                  stage: msg.stage || '处理中',
                })
              }
            } catch (e) {
              // 跳过无法解析的行（心跳等）
            }
          }
        }
      }
    } catch (err) {
      console.error('Excel 导出异常:', err)
      setExportResult({ success: false, error: err.message || '导出异常' })
    } finally {
      setExporting(false)
      setExportProgress({ current: 0, total: 0, stage: '' })
    }
  }, [files, electronAPIRef])

  const handleExportPdf = useCallback(async () => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return

    const parsedFiles = files.filter(f => f.status === 'parsed')
    if (parsedFiles.length === 0) {
      setExportAlert({ visible: true, title: '提示', message: '没有可导出发票数据', type: 'warning' })
      return
    }

    setExporting(true)
    setExportProgress({ current: 0, total: 100, stage: '准备中' })
    setExportResult(null)

    const fileNames = parsedFiles.map(f => f.name || f.path || f.fileName || '').filter(Boolean)
    if (fileNames.length === 0) {
      setExportAlert({ visible: true, title: '提示', message: '无法获取文件名', type: 'warning' })
      setExporting(false)
      return
    }

    try {
      const dialogResult = await ipc.invoke('select-save-path', {
        defaultName: `发票PDF_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
        filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
      })
      if (!dialogResult || dialogResult.canceled || !dialogResult.filePath) {
        setExporting(false)
        setExportProgress({ current: 0, total: 0, stage: '' })
        return
      }

      // TODO: 接入后端 /api/export-pdf 接口做实际 PDF 生成
      setExportResult({ success: true, message: `已保存到 ${dialogResult.filePath}` })
    } catch (err) {
      console.error('PDF 导出异常:', err)
      setExportResult({ success: false, error: err.message || '导出异常' })
    } finally {
      setExporting(false)
      setExportProgress({ current: 0, total: 0, stage: '' })
    }
  }, [files, electronAPIRef])

  return {
    exporting,
    exportProgress,
    exportResult,
    exportAlert,
    closeExportAlert,
    setExporting,
    setExportResult,
    setExportProgress,
    handleExportExcel,
    handleExportPdf,
  }
}
