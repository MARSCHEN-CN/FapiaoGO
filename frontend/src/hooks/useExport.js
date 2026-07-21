import { useState, useCallback, useRef, useSyncExternalStore } from 'react'
import { exportExcel, startPdfExport, startRenderExport, cancelPdfExport } from '../services/ExportService'
import { EXPORT_RENDER_ENABLED } from '../layout/exportConstants.js'
import { buildExportSnapshot } from '../layout/exportSnapshotBuilder.js'
import { isRenderExportEligible } from '../layout/exportCapabilities.js'
import { createExportTask, EXPORT_TYPE, EXPORT_MODE } from '../models/ExportTask'
import { createSuccessfulExport, createFailedExport, createCancelledExport } from '../models/ExportResult'
import { isTerminalStatus } from '../models/ExportSession'
import {
  createExportSession, startExport, updateProgress, completeExport,
  failExport, cancelExport, clearActiveSession, getActiveSession, subscribe,
} from '../stores/ExportSessionStore'

/**
 * 导出 Excel/CSV + PDF hook（Phase 5-3 → 5-4-3）。
 * 业务状态（exporting/exportProgress/exportResult/pdfExportTask）全部由
 * ExportSessionStore 持有，通过 useSyncExternalStore 派生。本 hook 只保留
 * React 层 ephemeral 状态（exportAlert 警告弹窗）。
 * 历史兼容 setter 已在 5-4-3 移除，Modal 清理改由 App.jsx 的
 * useExportSession().clearExportSession() 完成。
 */

/** session → PdfExportTaskModal props 形状（仅 PDF session）。 */
function sessionToPdfTaskView(session) {
  if (!session || session.task.type !== EXPORT_TYPE.PDF) return null
  return {
    visible: true,
    taskId: session.details.backendTaskId,
    status: session.status === 'created' ? 'starting' : session.status,
    current: session.details.current,
    total: session.details.total,
    percent: session.progress,
    currentFile: session.details.currentFile,
    stage: session.stage,
    successCount: session.details.successCount,
    failCount: session.details.failCount,
    errors: session.details.errors,
  }
}

export function useExport({ files, electronAPIRef, previewState, settings }) {
  const [exportAlert, setExportAlert] = useState(null)
  const closeExportAlert = useCallback(() => setExportAlert(null), [])
  const pdfCloseRef = useRef(null)

  // ── 订阅 store，派生业务视图 ──
  const activeSession = useSyncExternalStore(subscribe, getActiveSession)

  const exporting = activeSession?.task.type === EXPORT_TYPE.EXCEL
    && !isTerminalStatus(activeSession.status)

  const exportProgress = activeSession
    ? { current: activeSession.details.current, total: activeSession.details.total, stage: activeSession.stage }
    : { current: 0, total: 0, stage: '' }

  const exportResult = activeSession?.task.type === EXPORT_TYPE.EXCEL ? activeSession.result : null
  const pdfExportTask = sessionToPdfTaskView(activeSession)

  // ── Excel 导出 ──
  // columns: 可选，来自字段确认弹窗的 {key,label,width,virtual}[]；
  //          不传（旧路径 / 无数据告警复用）则后端走默认全列。
  const handleExportExcel = useCallback(async (columns) => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return

    const parsedFiles = files.filter(f => f.status === 'parsed')
    if (parsedFiles.length === 0) {
      setExportAlert({ visible: true, title: '提示', message: '没有可导出的发票数据', type: 'warning' })
      return
    }

    const task = createExportTask({
      type: EXPORT_TYPE.EXCEL,
      files: parsedFiles.map(f => ({ name: f.name, path: f.path })),
    })
    const session = createExportSession(task)
    startExport(session.id, '准备中')

    try {
      const result = await exportExcel({
        files: parsedFiles, ipc, taskId: task.id, columns,
        onProgress: (p) => {
          updateProgress(session.id, {
            current: p.current, total: p.total, stage: p.stage,
            progress: p.total ? Math.round((p.current / p.total) * 100) : 0,
          })
        },
      })
      if (result.status === 'cancelled') { cancelExport(session.id, result); return }
      if (result.success) completeExport(session.id, result)
      else failExport(session.id, result)
    } catch (err) {
      console.error('Excel 导出异常:', err)
      failExport(session.id, createFailedExport({ taskId: task.id, error: err.message || '导出异常' }))
    }
  }, [files, electronAPIRef])

  // ── PDF 导出 ──
  /** @param {object} config - { mode, outputType, folderPath, fileName, files } */
  const handleExportPdf = useCallback(async (config) => {
    const task = createExportTask({
      type: EXPORT_TYPE.PDF,
      mode: config.mode === 'merge' ? EXPORT_MODE.MERGE : EXPORT_MODE.SINGLE,
      files: config.files.map(f => ({ name: f.name, path: f.path })),
      outputPath: config.mode === 'merge' ? (config.fileName || 'invoice_export.pdf') : '',
    })
    const session = createExportSession(task)
    startExport(session.id, '准备中')
    updateProgress(session.id, { total: config.files.length })

    const handlers = {
      onProgress: (msg) => {
        updateProgress(session.id, {
          backendTaskId: msg.taskId ?? undefined,
          current: msg.current, total: msg.total, currentFile: msg.currentFile,
          successCount: msg.successCount, failCount: msg.failCount,
          progress: msg.percent, stage: msg.stage || '正在导出',
        })
      },
      onTerminal: (msg) => {
        const btid = msg.taskId ?? null
        const meta = { backendTaskId: btid, total: msg.total, successCount: msg.successCount, failCount: msg.failCount, fileErrors: msg.errors }
        if (msg.status === 'completed') {
          completeExport(session.id, createSuccessfulExport({ taskId: task.id, metadata: meta }))
        } else if (msg.status === 'cancelled') {
          cancelExport(session.id, createCancelledExport({ taskId: task.id, metadata: meta }))
        } else {
          failExport(session.id, createFailedExport({ taskId: task.id, error: msg.stage || '导出失败', metadata: meta }))
        }
      },
      onError: () => {
        failExport(session.id, createFailedExport({ taskId: task.id, error: 'SSE 连接中断' }))
      },
    }

    try {
      let backendTaskId = null
      let close = () => {}

      // 有效导出文件集（render 与 legacy 分支共用）：
      // config.files 优先（ActionBar 指定子集），否则取已解析文件。
      // 合成兜底对象补 fileFormat 默认 'pdf'，避免未命中时能力判断误判为不支持。
      const byPath = new Map(files.map(f => [f.path, f]))
      const exportFiles = (config.files && config.files.length)
        ? config.files.map(cf => byPath.get(cf.path) || { key: cf.path, path: cf.path, name: cf.name, status: 'parsed', fileFormat: cf.fileFormat || 'pdf' })
        : files.filter(f => f.status === 'parsed')

      if (isRenderExportEligible({ enabled: EXPORT_RENDER_ENABLED, previewState, settings, files: exportFiles })) {
        // 新管线（D2-2-c1）：几何由 Preview 状态经薄桥组装，ExportService 保持几何无关。
        // 仅当 flag 开启、Preview 几何状态可用、且所有文件格式受 render 管线支持时启用；
        // 否则（含 OFD 等不被支持的类型）回落 legacy /api/export-pdf。
        const commands = buildExportSnapshot({
          files: exportFiles,
          documentState: previewState.documentState,
          fileRotations: previewState.fileRotations,
          previewPage: previewState.previewPage,
          settings,
        })
        const res = await startRenderExport(commands, handlers)
        backendTaskId = res.taskId
        close = res.close
      } else {
        const res = await startPdfExport(config, handlers)
        backendTaskId = res.taskId
        close = res.close
      }

      pdfCloseRef.current = close
      if (backendTaskId) updateProgress(session.id, { backendTaskId })
    } catch (err) {
      console.error('PDF 导出异常:', err)
      failExport(session.id, createFailedExport({ taskId: task.id, error: err.message || '导出异常' }))
    }
  }, [files, electronAPIRef, previewState, settings])

  // ── 取消导出 ──
  const handleCancelPdfExport = useCallback(async () => {
    const s = getActiveSession()
    if (!s) return
    if (pdfCloseRef.current) { pdfCloseRef.current(); pdfCloseRef.current = null }
    if (s.details.backendTaskId) await cancelPdfExport(s.details.backendTaskId)
    cancelExport(s.id, createCancelledExport({ taskId: s.task.id, metadata: { backendTaskId: s.details.backendTaskId } }))
  }, [])

  // ── 关闭任务面板 ──
  const closePdfExportTask = useCallback(() => {
    if (pdfCloseRef.current) { pdfCloseRef.current(); pdfCloseRef.current = null }
    clearActiveSession()
  }, [])

  return {
    exporting, exportProgress, exportResult, exportAlert, closeExportAlert,
    handleExportExcel, handleExportPdf,
    pdfExportTask, cancelPdfExport: handleCancelPdfExport, closePdfExportTask,
  }
}
