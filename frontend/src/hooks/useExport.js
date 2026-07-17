import { useState, useCallback } from 'react'
import { BACKEND_URL } from '../config'

/**
 * 导出 Excel/CSV + PDF hook
 * 
 * 内聚导出相关状态和 SSE 流式处理。
 * PDF 导出：handleExportPdf(config) 接收 PdfExportConfirmModal 的配置，
 * 消费 SSE 更新 pdfExportTask 状态，不直接控制弹窗。
 */
export function useExport({ files, electronAPIRef }) {
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState({ current: 0, total: 0, stage: '' })
  const [exportResult, setExportResult] = useState(null)
  const [exportAlert, setExportAlert] = useState(null)
  const closeExportAlert = useCallback(() => setExportAlert(null), [])

  // ── PDF 导出任务状态（与后端 ExportTask.to_dict() 对齐） ──
  const [pdfExportTask, setPdfExportTask] = useState(null)

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

  // ── PDF 导出 ──

  /** 生成 yymmdd 格式日期字符串 */
  const _dateSuffix = () => {
    const d = new Date()
    return String(d.getFullYear()).slice(2) +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0')
  }

  /**
   * 为文件生成输出路径。
   * single 模式：每个文件独立路径（用源文件目录 + basename_export_YYMMDD.pdf）。
   * merge 模式：单一路径（输出目录 + config.fileName）。
   */
  const _resolveOutputPath = (file, config) => {
    // 确定输出目录
    let outputDir = ''
    if (config.outputType === 'source' && file.path) {
      outputDir = file.path.split(/[\\/]/).slice(0, -1).join('/')
    } else if (config.outputType === 'folder' && config.folderPath) {
      outputDir = config.folderPath
    }

    if (!outputDir) {
      outputDir = '.'
    }

    if (config.mode === 'merge') {
      // 合并模式：输出目录 + 用户指定的文件名
      const fname = config.fileName || 'invoice_export.pdf'
      return `${outputDir}/${fname}`
    }

    // 单独导出：源文件目录 + basename_export_YYMMDD.pdf
    const name = file.name || file.path?.split(/[\\/]/).pop() || 'export'
    const baseName = name.replace(/\.[^.]+$/, '')
    const suffix = _dateSuffix()
    return `${outputDir}/${baseName}_export_${suffix}.pdf`
  }

  /**
   * 发起 PDF 导出任务。
   * @param {object} config - 来自 PdfExportConfirmModal.onConfirm
   *   { mode, outputType, folderPath, fileName, files: [{path, name}] }
   */
  const handleExportPdf = useCallback(async (config) => {
    // 初始化任务状态
    setPdfExportTask({
      visible: true,
      taskId: null,
      status: 'starting',
      current: 0,
      total: config.files.length,
      percent: 0,
      currentFile: '',
      stage: '准备中',
      successCount: 0,
      failCount: 0,
      errors: [],
    })

    // ── 构建 POST body ──
    let body

    if (config.mode === 'merge') {
      // 合并模式：源文件列表 + 顶层 outputPath
      const firstFile = config.files[0]
      const mergeOutput = _resolveOutputPath(firstFile, config)
      const filesPayload = config.files.map(f => ({
        name: f.name || f.path?.split(/[\\/]/).pop() || '',
        path: f.path || '',
      }))
      body = {
        mode: 'merge',
        files: filesPayload,
        outputPath: mergeOutput,
      }
    } else {
      // 单独导出：每个文件独立输出路径
      const filesPayload = config.files.map(f => ({
        name: f.name || f.path?.split(/[\\/]/).pop() || '',
        path: f.path || '',
        outputPath: _resolveOutputPath(f, config),
      }))
      body = {
        mode: 'single',
        files: filesPayload,
      }
    }

    try {
      const response = await fetch(`${BACKEND_URL}/api/export-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        let errorMsg = `服务器返回 ${response.status}`
        try {
          const errBody = await response.json()
          if (errBody.error) errorMsg = errBody.error
        } catch (_) {}
        setPdfExportTask(prev => prev ? {
          ...prev,
          status: 'completed',
          stage: errorMsg,
          failCount: prev.total || 0,
          errors: [{ file: '', error: errorMsg }],
        } : null)
        return
      }

      // ── 消费 SSE ──
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
              handleSseMessage(msg)
            } catch (e) {
              // 跳过无法解析的行
            }
          }
        }
      }
    } catch (err) {
      console.error('PDF 导出异常:', err)
      setPdfExportTask(prev => prev ? {
        ...prev,
        status: 'completed',
        stage: err.message || '导出异常',
        errors: [{ file: '', error: err.message || '导出异常' }],
      } : null)
    }
  }, [])

  // ── SSE 消息处理 ──
  const handleSseMessage = useCallback((msg) => {
    setPdfExportTask(prev => {
      if (!prev) return prev

      if (msg.status === 'started') {
        return { ...prev, taskId: msg.taskId, status: 'running', stage: '正在导出' }
      }

      if (msg.status === 'running') {
        return {
          ...prev,
          current: msg.current ?? prev.current,
          total: msg.total ?? prev.total,
          percent: msg.percent ?? prev.percent,
          currentFile: msg.currentFile ?? prev.currentFile,
          stage: msg.stage ?? prev.stage,
        }
      }

      if (msg.status === 'completed' || msg.status === 'cancelled') {
        return {
          ...prev,
          status: msg.status,
          successCount: msg.successCount ?? prev.successCount,
          failCount: msg.failCount ?? prev.failCount,
          errors: msg.errors ?? prev.errors,
          stage: msg.status === 'completed' ? '导出完成' : '已取消',
        }
      }

      return prev
    })
  }, [])

  // ── 取消导出 ──
  const cancelPdfExport = useCallback(async () => {
    setPdfExportTask(prev => {
      if (!prev?.taskId) return prev
      // 先乐观更新 UI
      return { ...prev, status: 'cancelled', stage: '正在取消...' }
    })

    // 发送取消请求
    try {
      await fetch(`${BACKEND_URL}/api/export-pdf/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: pdfExportTask?.taskId }),
      })
    } catch (err) {
      console.error('取消导出失败:', err)
    }
  }, [pdfExportTask])

  // ── 关闭任务面板 ──
  const closePdfExportTask = useCallback(() => {
    setPdfExportTask(null)
  }, [])

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
    // PDF 导出
    pdfExportTask,
    cancelPdfExport,
    closePdfExportTask,
  }
}
