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
import { BACKEND_URL } from '../config'
import { createSuccessfulResult, createFailedResult } from '../models/PrintResult'
import { getExtension } from '../utils'
import { requestedPaperOrientation } from '../print/paperSpec.js'
import { resolveFileRotation } from '../print/resolveSourceIdentity.js'

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
 * @param {object} [fileRotations] - 每文件旋转角度 { [fileKey]: rotation }（deprecated，迁移后用 placement）
 * @param {object} [detectDocumentOrientation] - 方向检测函数
 * @param {object} [placement] - RotationResolver 布局结果 { scale, offset, renderTransform, ... }（Commit 3-B 新增）
 * @param {object} [executionPaper] - Plan 物理纸几何（C-2 Step 4-1 新增）
 * @param {Array<{pageIndex:number, placement:object}>} [pagePlacements] - 多页 placement（R-4.6-A v2 IPC 契约新增）：
 *   聚合源（多页 PDF）按页携带独立 placement，pageIndex 显式声明（不依赖数组位置）；
 *   单页 / 非聚合源为 null，走 placement（单）兼容路径。
 * @returns {object} 打印设置
 */
export function buildPrintSettings(file, userSettings, fileRotations, detectOrientationFn, placement, executionPaper, pagePlacements) {
  // R-2：聚合源（key='__source_...'）在 fileRotations 中查不到 → fallback 到
  // _sourceOriginalKey（representative 原始 key），保持与 Plan 层同一 resolver。
  const fileRotation = resolveFileRotation(file, fileRotations)
  const hasReliableOrient = file._pdfPageWidth > 0 && file._pdfPageHeight > 0
  const contentOrientation = detectOrientationFn?.(file)

  return {
    // Commit 3-B-2-A: rotation 改名 sourceRotation，清晰区别于 contentRotation/fitRotation
    //   sourceRotation = 用户原始旋转意图（仅用于 Sumatra source file 路径的旧执行器）
    //   placement = RotationResolver 布局结果（新模型，Canvas 路径已使用）
    //   ⚠️ 保留 rotation 为 deprecated alias（兼容 electron 旧版本）
    rotation: fileRotation,
    sourceRotation: fileRotation,
    paperkind: userSettings.paperkind,
    paper: userSettings.paperSize || userSettings.paper || PRINT_SETTINGS_DEFAULTS.paper,
    fit: userSettings.fit || PRINT_SETTINGS_DEFAULTS.fit,
    // RG-3：纸向权移交——用户横打请求（landscape）必须显式传给 electron normalize
    // （旧路径靠 contentOrientation 间接决定 baseFlag，RG-3 后两通道分离，请求方向必须直传）。
    landscape: !!userSettings.landscape,
    // G2（C-2-G）：绝对请求方向，与 resolvePaperSpec 共用 requestedPaperOrientation 单一来源。
    // 修复「横纸型 + 纵向」因 landscape 布尔无法表达而被 normalize 回退成 natural(landscape) 的断点。
    // normalize(print-settings.js:202-203,226) 已原生消费/透传此字段；纯补传，零 electron 改动。
    paperOrientation: requestedPaperOrientation(userSettings),
    ...(hasReliableOrient ? { contentOrientation } : {}),
    duplex: userSettings.duplex ?? PRINT_SETTINGS_DEFAULTS.duplex,
    grayscale: userSettings.grayscale ?? PRINT_SETTINGS_DEFAULTS.grayscale,
    copies: userSettings.copies ?? PRINT_SETTINGS_DEFAULTS.copies,
    marginLeft: userSettings.marginLeft ?? 3,
    marginRight: userSettings.marginRight ?? 3,
    marginTop: userSettings.marginTop ?? 3,
    marginBottom: userSettings.marginBottom ?? 3,
    customPaper: userSettings.customPaper,
    // Commit 3-B: 布局结果透传（Preview 与 Print 共享同一个 RotationResolver 输出）
    placement: placement || null,
    // C-2 Step 4-1：Plan truth 独立透传（execution* 前缀 = Execution Plan geometry，
    // 与用户 PrintSettings 生命周期分离——不混入 userSettings；electron 消费属 Step 4-2）。
    //   executionPaper = plan.paper（needSwap 后物理纸几何：size/orientation/widthMM/heightMM）
    executionPaper: executionPaper || null,
    // R-4.6-A（v2 IPC 契约）：多页 placement —— [{pageIndex, placement}]，页序显式携带；
    // 单 placement 保留兼容（placement 字段仍为 representative / 单页 placement）。
    // R-4.6-B 起 placement-bake 消费 pagePlacements 逐页烤入；A 阶段仅透传 + 结构校验。
    pagePlacements: pagePlacements || null,
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
 * @param {object} [placement] - RotationResolver 布局结果（Commit 3-B 新增）
 * @param {object} [executionPaper] - Plan 物理纸几何（C-2 Step 4-1 新增）
 * @param {Array<{pageIndex:number, placement:object}>} [pagePlacements] - 多页 placement（R-4.6-A 新增，v2 契约）
 * @returns {Promise<object>} PrintResult
 */
export async function printSingleSourceFile(file, ipc, userSettings, fileRotations, detectOrientationFn, placement, executionPaper, pagePlacements) {
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

  // 构建打印设置（Commit 3-B: placement 透传；C-2 Step 4-1: executionPaper 独立透传；
  // R-4.6-A: pagePlacements 多页 placement v2 透传）
  const ps = buildPrintSettings(file, userSettings, fileRotations, detectOrientationFn, placement, executionPaper, pagePlacements)

  try {
    const result = await ipc.invoke('print-source-file', {
      target: { printer: printerName, filePath, fileFormat, docId: file?.docId || file?.documentId || '' },
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
 * 图片 → PDF → 打印管线。
 *
 * 仅用于 raster 图片（JPG/PNG/BMP/TIFF 等）。
 * 流程：
 *   1. 从后端 /print_pdf/{doc_id} 获取带旋转的 A4 PDF
 *   2. 通过 save-print-pdf IPC 保存到临时目录
 *   3. 通过 print-source-file 将临时 PDF 直送 SumatraPDF
 *   4. 打印完成后删除临时文件
 *
 * @param {object} file - 文件对象（需含 docId）
 * @param {object} ipc - Electron ipcRenderer
 * @param {object} userSettings - 用户设置
 * @param {number} contentRotation - 由 PrintAutoRotationPolicy 决定的内容旋转角度 (0/90/180/270)
 * @returns {Promise<object>} PrintResult
 */
export async function printImageAsPdf(file, ipc, userSettings, contentRotation) {
  if (!file) return createFailedResult({ taskId: file?.key, error: '文件对象为空' })
  if (!ipc) return createFailedResult({ taskId: file.key, error: 'Electron IPC 不可用' })

  const docId = file?.docId || file?.documentId
  if (!docId) return createFailedResult({ taskId: file.key, error: '缺少 docId，无法生成打印 PDF' })

  // 确定打印机
  const printerName = resolvePrinterName(userSettings, userSettings)
  if (!printerName) return createFailedResult({ taskId: file.key, error: '请选择打印机' })

  const rotation = Number(contentRotation) || 0
  const paperOrient = requestedPaperOrientation(userSettings)

  // ── Step 1: 从后端获取带旋转的 A4 PDF ──
  let tempPdfPath = null
  try {
    const url = `${BACKEND_URL}/print_pdf/${encodeURIComponent(docId)}?content_rotation=${rotation}&paper_orientation=${paperOrient}`

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/pdf' },
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      let errMsg = `后端 PDF 生成失败 (HTTP ${response.status})`
      try {
        const errJson = JSON.parse(errText)
        if (errJson?.error) errMsg = errJson.error
      } catch {}
      return createFailedResult({ taskId: file.key, error: errMsg })
    }

    const pdfBuffer = await response.arrayBuffer()
    if (!pdfBuffer || pdfBuffer.byteLength === 0) {
      return createFailedResult({ taskId: file.key, error: '后端返回的 PDF 为空' })
    }

    // ── Step 2: 保存临时 PDF ──
    const safeName = `${file?.key || 'image'}_print_${Date.now()}.pdf`
    const saveResult = await ipc.invoke('save-print-pdf', {
      buffer: Array.from(new Uint8Array(pdfBuffer)),
      filename: safeName,
    })

    if (!saveResult?.success) {
      return createFailedResult({ taskId: file.key, error: saveResult?.error || '保存临时 PDF 失败' })
    }

    tempPdfPath = saveResult.path

    // ── Step 3: 构建打印设置 + 调用 SumatraPDF ──
    const ps = buildPrintSettings(file, userSettings)
    // R-4.7 Fix-Y：临时 PDF 已由 /print_pdf 完成旋转烘焙（backend effective_rotation 烤进像素 +
    // 页方向按渲染后尺寸定）= 「baked」产物 → 显式声明 baked execution semantics：
    //   commandOrientation 预设为请求纸向 → main.js:697 guard（!commandOrientation）天然跳过
    //   injectExecutionTruth → commandRotate=0，execution truth 不再二次介入。
    // 与 PDF placement-bake 语义统一：bake stage 之后 Sumatra 纯执行（no extra rotation）。
    // ⚠️ 禁止改为「携带 contentOrientation 交给 Truth 推导」——Truth 为未烘焙源设计（Fix-X 已否决）。
    ps.commandOrientation = paperOrient
    ps.commandRotate = 0

    const result = await ipc.invoke('print-source-file', {
      target: { printer: printerName, filePath: tempPdfPath, fileFormat: 'pdf', docId: docId },
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
  } finally {
    // ── Step 4: 清理临时文件 ──
    if (tempPdfPath) {
      try {
        await ipc.invoke('delete-print-pdf', { filePath: tempPdfPath })
      } catch {
        // 清理失败不影响打印结果
      }
    }
  }
}

