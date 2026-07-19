/**
 * PrintService — 打印能力层
 *
 * 负责打印执行，不负责 UI、队列或状态管理。
 *
 * 能力：
 *   1. printSingleSource(task) — 单文件源文件打印（Sumatra 直送）
 *   2. printMergedImages(tasks) — 合并渲染打印（Canvas → PNG → PDF）
 *
 * 不负责：
 *   ❌ React state / setState
 *   ❌ Queue management
 *   ❌ Progress tracking
 *   ❌ UI modals / notifications
 *
 * @module services/PrintService
 */

import { PRINT_SETTINGS_DEFAULTS } from '../config'
import { createSuccessfulResult, createFailedResult } from '../models/PrintResult'
import { getExtension } from '../utils'

/**
 * PrintTask mode constants.
 */
const PRINT_MODE = {
  SOURCE: 'source',
  MERGED: 'merged',
}

/**
 * 确定文件的实际可打印格式。
 * @param {{ fileFormat?: string, name: string }} file
 * @returns {string} 'pdf' | 'image' | 'ofd'
 */
export function detectPrintFormat(file) {
  let format = file.fileFormat || 'pdf'
  const ext = getExtension(file.name)
  if (!format || format === 'unknown') {
    if (ext === 'ofd') format = 'ofd'
    else if (['jpg', 'jpeg', 'png', 'bmp', 'tiff', 'tif', 'gif'].includes(ext)) format = 'image'
    else format = 'pdf'
  }
  return format
}

/**
 * 构建打印设置对象。
 *
 * @param {object} file - 文件对象（含 key, fileFormat, name, _pdfPageWidth, _pdfPageHeight 等）
 * @param {object} userSettings - 用户打印设置（从 settings / printSettings 合并）
 * @param {object} [fileRotations] - 每文件旋转角度 { [fileKey]: rotation }
 * @param {object} [detectDocumentOrientation] - 方向检测函数
 * @returns {object} 打印设置
 */
export function buildPrintSettings(file, userSettings, fileRotations, detectOrientationFn) {
  const fileRotation = fileRotations?.[file.key] || 0
  const hasReliableOrient = file._pdfPageWidth > 0 && file._pdfPageHeight > 0
  const contentOrientation = detectOrientationFn?.(file)

  return {
    rotation: fileRotation,
    paperkind: userSettings.paperkind,
    paper: userSettings.paperSize || userSettings.paper || PRINT_SETTINGS_DEFAULTS.paper,
    fit: userSettings.fit || PRINT_SETTINGS_DEFAULTS.fit,
    ...(hasReliableOrient ? { contentOrientation } : {}),
    duplex: userSettings.duplex ?? PRINT_SETTINGS_DEFAULTS.duplex,
    grayscale: userSettings.grayscale ?? PRINT_SETTINGS_DEFAULTS.grayscale,
    copies: userSettings.copies ?? PRINT_SETTINGS_DEFAULTS.copies,
    marginLeft: userSettings.marginLeft ?? 3,
    marginRight: userSettings.marginRight ?? 3,
    marginTop: userSettings.marginTop ?? 3,
    marginBottom: userSettings.marginBottom ?? 3,
    customPaper: userSettings.customPaper,
  }
}

/**
 * 获取打印机名称（支持多个传入源）。
 * @param {object} printSettings
 * @param {object} userSettings
 * @returns {string}
 */
export function resolvePrinterName(printSettings, userSettings) {
  return (printSettings?.printerName || printSettings?.printer || userSettings.printerName || '').trim()
}

/**
 * 获取文件的有效打印路径。
 * @param {object} file
 * @returns {string|null}
 */
export function resolvePrintPath(file) {
  return file.printPath || file.path || null
}

/**
 * 单文件源打印（Sumatra 直送）。
 *
 * @param {object} file - 文件对象
 * @param {object} ipc - Electron ipcRenderer
 * @param {object} userSettings - 用户设置（合并后的 settings + printSettings）
 * @param {object} [fileRotations] - 每文件旋转
 * @param {Function} [detectOrientationFn] - 方向检测函数
 * @returns {Promise<object>} PrintResult
 */
export async function printSingleSourceFile(file, ipc, userSettings, fileRotations, detectOrientationFn) {
  if (!file) return createFailedResult({ taskId: file?.key, error: '文件对象为空' })
  if (!ipc) return createFailedResult({ taskId: file.key, error: 'Electron IPC 不可用' })

  // 验证文件路径
  const filePath = resolvePrintPath(file)
  if (!filePath) return createFailedResult({ taskId: file.key, error: '文件路径不存在' })

  // 确定文件格式
  const fileFormat = detectPrintFormat(file)

  // 确定打印机
  const printerName = resolvePrinterName(userSettings, userSettings)
  if (!printerName) return createFailedResult({ taskId: file.key, error: '请选择打印机' })

  // 构建打印设置
  const ps = buildPrintSettings(file, userSettings, fileRotations, detectOrientationFn)

  try {
    const result = await ipc.invoke('print-source-file', {
      target: { printer: printerName, filePath, fileFormat },
      settings: ps,
      pipeline: { backend: 'sumatra' },
    })

    if (result?.success) {
      return createSuccessfulResult({ taskId: file.key, printer: printerName })
    }

    return createFailedResult({
      taskId: file.key,
      printer: printerName,
      error: result?.message || result?.error || '打印失败',
    })
  } catch (err) {
    return createFailedResult({ taskId: file.key, printer: printerName, error: err?.message || '打印异常' })
  }
}

/**
 * 合并打印：发送渲染后的 PNG 数据到主进程打印。
 *
 * @param {Uint8Array[]} images - 渲染后的 PNG 数据数组
 * @param {object} ipc - Electron ipcRenderer
 * @param {object} printOptions - 打印选项
 * @returns {Promise<object>} PrintResult
 */
export async function printMergedImages(images, ipc, printOptions) {
  if (!images || images.length === 0) {
    return createFailedResult({ taskId: 'merged', error: '没有可打印的渲染数据' })
  }
  if (!ipc) return createFailedResult({ taskId: 'merged', error: 'Electron IPC 不可用' })

  try {
    const result = await ipc.invoke('print-merged-images', {
      images,
      settings: printOptions || {},
    })

    if (result?.success) {
      return createSuccessfulResult({
        taskId: 'merged',
        pagesPrinted: images.length,
      })
    }

    return createFailedResult({
      taskId: 'merged',
      error: result?.error || '合并打印失败',
    })
  } catch (err) {
    return createFailedResult({
      taskId: 'merged',
      error: err?.message || '合并打印异常',
    })
  }
}

/**
 * 统一打印入口 — 根据 task.mode 路由到对应执行路径。
 *
 * @param {object} task - PrintTask 对象
 * @param {object} ipc - Electron ipcRenderer
 * @param {object} context - 上下文（含 userSettings, fileRotations, detectFn, images 等）
 * @returns {Promise<object>} PrintResult
 */
export async function print(task, ipc, context) {
  if (!task) return createFailedResult({ taskId: 'unknown', error: '打印任务为空' })
  if (!ipc) return createFailedResult({ taskId: task.id || 'unknown', error: 'Electron IPC 不可用' })

  const mode = task.mode || 'source'

  switch (mode) {
    case 'source': {
      const { userSettings, fileRotations, detectFn } = context || {}
      return printSingleSourceFile(task.file || task, ipc, userSettings || {}, fileRotations, detectFn)
    }

    case 'merged': {
      const { images, printOptions } = context || {}
      return printMergedImages(images || [], ipc, printOptions)
    }

    default:
      return createFailedResult({
        taskId: task.id || 'unknown',
        error: `不支持打印模式: ${mode}`,
      })
  }
}
