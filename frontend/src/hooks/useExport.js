import { useState, useCallback, useRef } from 'react'
import { exportExcel, startPdfExport, cancelPdfExport } from '../services/ExportService'

/**
 * 导出 Excel/CSV + PDF hook
 *
 * 内聚导出相关 React state 和 UI 回调。
 * 执行逻辑（IPC/fetch/EventSource/SSE 消费）委托 ExportService。
 *
 * PDF 导出：handleExportPdf(config) 接收 PdfExportConfirmModal 的配置，
 * 通过 ExportService 启动任务 + 消费 SSE，更新 pdfExportTask 状态。
 *
 * Phase 5-2：IPC/fetch/EventSource/SSE 逻辑迁移至 ExportService。
 *   useExport.js: 390 → ~155 行。
 */
export function useExport({ files, electronAPIRef }) {
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState({ current: 0, total: 0, stage: '' })
  const [exportResult, setExportResult] = useState(null)
  const [exportAlert, setExportAlert] = useState(null)
  const closeExportAlert = useCallback(() => setExportAlert(null), [])

  // ── PDF 导出任务状态（与后端 ExportTask.to_dict() 对齐） ──
  const [pdfExportTask, setPdfExportTask] = useState(null)

  // EventSource close 函数（用于取消/关闭时清理）
  const pdfCloseRef = useRef(null)

  // ── Excel 导出 ──
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

    try {
      const result = await exportExcel({
        files: parsedFiles,
        ipc,
        taskId: Date.now(),
        onProgress: (p) => setExportProgress(p),
      })

      // 用户取消保存对话框 → 静默返回（保持原行为）
      if (result.status === 'cancelled') return

      setExportResult(result)
    } catch (err) {
      console.error('Excel 导出异常:', err)
      setExportResult({ success: false, error: err.message || '导出异常' })
    } finally {
      setExporting(false)
      setExportProgress({ current: 0, total: 0, stage: '' })
    }
  }, [files, electronAPIRef])

  // ── PDF 导出 ──

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

    try {
      const { taskId, close } = await startPdfExport(config, {
        onProgress: (msg) => {
          setPdfExportTask(prev => {
            if (!prev) return prev
            // 'pending'：任务已建立但尚未 start（GET 流可能在 start 前就连上）；按运行态展示
            if (msg.status === 'pending' || msg.status === 'running') {
              return {
                ...prev,
                taskId: msg.taskId ?? prev.taskId,
                status: 'running',
                current: msg.current ?? prev.current,
                total: msg.total ?? prev.total,
                percent: msg.percent ?? prev.percent,
                currentFile: msg.currentFile ?? prev.currentFile,
                stage: msg.stage || '正在导出',
              }
            }
            return prev
          })
        },
        onTerminal: (msg) => {
          setPdfExportTask(prev => {
            if (!prev) return prev
            const stageText = msg.status === 'completed' ? '导出完成'
              : msg.status === 'cancelled' ? '已取消' : '导出失败'
            return {
              ...prev,
              status: msg.status,
              current: msg.current ?? prev.current,
              total: msg.total ?? prev.total,
              percent: msg.percent ?? prev.percent,
              currentFile: msg.currentFile ?? prev.currentFile,
              successCount: msg.successCount ?? prev.successCount,
              failCount: msg.failCount ?? prev.failCount,
              errors: msg.errors ?? prev.errors,
              stage: stageText,
            }
          })
        },
        onError: () => {
          setPdfExportTask(prev => {
            if (!prev) return prev
            if (['completed', 'cancelled', 'failed'].includes(prev.status)) return prev
            return { ...prev, status: 'failed', stage: '连接中断', errors: [{ file: '', error: 'SSE 连接中断' }] }
          })
        },
      })

      // 保存 close 函数（供 cancel/closePdfExportTask 清理）
      pdfCloseRef.current = close

      // 更新 taskId（POST 返回的后端 UUID）
      if (taskId) {
        setPdfExportTask(prev => prev ? { ...prev, taskId } : null)
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

  // ── 取消导出 ──
  const handleCancelPdfExport = useCallback(async () => {
    setPdfExportTask(prev => {
      if (!prev?.taskId) return prev
      // 先乐观更新 UI
      return { ...prev, status: 'cancelled', stage: '正在取消...' }
    })

    // 关闭 EventSource
    if (pdfCloseRef.current) {
      pdfCloseRef.current()
      pdfCloseRef.current = null
    }

    // 发送取消请求到后端
    const taskId = pdfExportTask?.taskId
    if (taskId) {
      await cancelPdfExport(taskId)
    }
  }, [pdfExportTask])

  // ── 关闭任务面板 ──
  const closePdfExportTask = useCallback(() => {
    if (pdfCloseRef.current) {
      pdfCloseRef.current()
      pdfCloseRef.current = null
    }
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
    cancelPdfExport: handleCancelPdfExport,
    closePdfExportTask,
  }
}
