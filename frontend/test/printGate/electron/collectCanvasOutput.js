/**
 * A2-G1-CANVAS-1 canvas 轨采集器（DEV-only，Electron 渲染进程内执行）
 *
 * 职责（用户定稿，单变量纪律）：
 *   case → resolve file → makePrintItem → renderMultipleItemsToCanvas → canvas.toDataURL → artifact png/json
 *
 * 边界（红线）：
 *   ❌ 不 import usePrint / 不改 hook / 不改 renderer / 不改 PrintExecutionPlan / 不改 production IPC
 *   ✅ makePrintItem 固化 usePrint.js:180-278 的 PDF/OFD/Image 三分支加载逻辑（参数逐字镜像）
 *   ✅ renderMultipleItemsToCanvas 调用序列与 usePrint.js:288-298 逐字一致
 *
 * 运行方式（Electron dev，vite 渲染进程）：
 *   在 devtools console 或 dev-only harness 中：
 *   import { collectCanvasCases } from '/test/printGate/electron/collectCanvasOutput.js'
 *   await collectCanvasCases()
 *   产出 frontend/test/printGate/artifacts/<case>/canvas.json + canvas.png
 */

import { GATE_CASES } from '../gateCases.mjs'
import { GATE_DPI } from '../gateConfig.mjs'
import { findContentBBox, measureMarginsPx, marginsToMm } from '../measureMargins.mjs'
import { renderMultipleItemsToCanvas } from '../../../src/renderers.js'
import { buildPrintJobItem, fetchPrintRaster } from '../../../src/utils/printAdapter.js'

/** 渲染进程注入的 ipc（Electron window.api / preload 暴露）。若缺失，PDF/Image 分支会明确报错 */
const getIpc = () => {
  const ipc = window?.api?.ipc || window?.ipcRenderer
  if (!ipc) throw new Error('未找到 ipc（window.api.ipc / window.ipcRenderer），PDF/Image 分支需要 read-file')
  return ipc
}

/** b64 → Blob（OFD/Image previewImage 兜底） */
function b64toBlob(b64, mime = 'image/png') {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

/**
 * makePrintItem —— 固化 usePrint.js:180-278 三分支（参数逐字镜像）
 * @param {object} caseDef GATE_CASES 项
 * @returns {Promise<object>} item（含 key/fileFormat/_pdfData 或 _previewImageUrl）
 */
export async function makePrintItem(caseDef) {
  const f = {
    key: caseDef.id,
    name: caseDef.file.split('/').pop(),
    fileFormat: caseDef.format,
  }
  // 磁盘路径：vite 渲染进程无 fs，约定经 globalThis.__GATE_REPO_ROOT__ 注入仓库根（README 运行指引）
  const root = globalThis.__GATE_REPO_ROOT__
  if (typeof root !== 'string') throw new Error('需在采集前设置 globalThis.__GATE_REPO_ROOT__（仓库根绝对路径，如 E:/print706/）')
  f.printPath = root + caseDef.file

  // PDF 分支（usePrint.js:182-190）
  if (f.fileFormat === 'pdf' || (!f.fileFormat && !f.previewImage)) {
    const ipc = getIpc()
    const fileData = await ipc.invoke('read-file', f.printPath)
    if (!fileData?.success) throw new Error(`read-file 失败: ${f.printPath}`)
    f._pdfData = new Uint8Array(await fileData.data.arrayBuffer())
    return f
  }

  // OFD 分支（usePrint.js:191-238）：docId 走 buildPrintJobItem + fetchPrintRaster
  if (f.fileFormat === 'ofd') {
    const job = buildPrintJobItem(f)
    const pages = job.pages || []
    if (pages.length > 0) {
      // 逐页栅格（G1 第一轮只采第 0 页，与 source 轨对齐）
      const blob = await fetchPrintRaster(job.docId, 1)
      if (!blob) throw new Error('OFD fetchPrintRaster 返回空')
      f._previewImageUrl = URL.createObjectURL(blob)
      return f
    }
    // 无 doc：docId 缺失时用 previewImage 兜底（usePrint.js:240-258）
    if (f.docId) {
      const blob = await fetchPrintRaster(f.docId, 1)
      if (blob) { f._previewImageUrl = URL.createObjectURL(blob); return f }
    }
    if (f.previewImage) { f._previewImageUrl = URL.createObjectURL(b64toBlob(f.previewImage)); return f }
    throw new Error('OFD 无 docId 且无 previewImage，无法加载')
  }

  // Image 分支（usePrint.js:259-274）
  if (f.fileFormat === 'image') {
    const ipc = getIpc()
    const fileData = await ipc.invoke('read-file', f.printPath)
    if (fileData?.success) {
      f._previewImageUrl = URL.createObjectURL(new Blob([fileData.data]))
      return f
    }
    if (f.previewImage) { f._previewImageUrl = URL.createObjectURL(b64toBlob(f.previewImage)); return f }
    throw new Error('image 加载失败')
  }

  throw new Error(`未知 fileFormat: ${f.fileFormat}`)
}

/**
 * 采集单个 case 的 canvas 轨输出（生产同款调用序列）
 *
 * 返回 artifact 对象（含 canvas PNG bytes），**落盘由宿主完成**：
 *   - 无 __GATE_WRITE__ 时：artifact 完整返回给调用方，PNG bytes 在 artifact.png
 *   - 宿主（node 侧 helper / devtools 手动）负责写 frontend/test/printGate/artifacts/<case>/
 *
 * @param {object} caseDef
 * @returns {Promise<{ok:boolean, artifact:object, error?:string}>}
 */
export async function collectCanvasCase(caseDef) {
  try {
    const item = await makePrintItem(caseDef)
    const canvas = await renderMultipleItemsToCanvas(
      [item],
      caseDef.settings.paperSize || 'A4',
      GATE_DPI,
      caseDef.settings.landscape,
      { [item.key]: caseDef.rotation },
      1,             // slotCount = 1（usePrint.js:294）
      false,         // isPrint = false（usePrint.js:295，与预览一致）
      false,         // showSafeMargin（usePrint.js:296）
      { strategy: 'vertical', customPaper: caseDef.settings.customPaper },
    )
    if (!canvas) return { ok: false, error: 'renderMultipleItemsToCanvas 返回 null' }

    const cw = canvas.width, ch = canvas.height
    const img = canvas.getContext('2d').getImageData(0, 0, cw, ch)
    const bbox = findContentBBox(img.data, cw, ch)
    const paperPx = { w: cw, h: ch }
    const marginsPx = bbox ? measureMarginsPx(bbox, paperPx) : null
    const marginMm = marginsPx ? marginsToMm(marginsPx, GATE_DPI) : null

    const artifact = {
      anchor: caseDef.anchor,
      case: caseDef.id,
      purpose: caseDef.purpose,
      dpi: GATE_DPI,
      paper: caseDef.settings.paperSize || 'A4',
      paperActualPx: paperPx,
      rotation: caseDef.rotation,
      format: caseDef.format,
      source: 'renderMultipleItemsToCanvas(生产同款调用序列)',
      bbox: bbox ? { left: bbox.x, top: bbox.y, right: bbox.x + bbox.w, bottom: bbox.y + bbox.h } : null,
      marginMm,
    }

    // PNG bytes（供宿主落盘）
    const pngBytes = await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob null')), 'image/png'))
      .then(blob => blob.arrayBuffer())

    // 宿主写盘（可选）
    const writeFn = globalThis.__GATE_WRITE__
    if (typeof writeFn === 'function') {
      writeFn(`printGate/artifacts/${caseDef.id}`, 'canvas.json', JSON.stringify(artifact, null, 2))
      writeFn(`printGate/artifacts/${caseDef.id}`, 'canvas.png', new Uint8Array(pngBytes))
    }
    console.log(`[GATE-CANVAS] ${caseDef.id} OK  bbox=${JSON.stringify(artifact.bbox)} marginMm=${JSON.stringify(artifact.marginMm)}`)
    return { ok: true, artifact, pngBytes }
  } catch (e) {
    console.error(`[GATE-CANVAS] ${caseDef.id} FAIL:`, e.message)
    return { ok: false, error: e.message }
  }
}

/** 批量采集（默认 GATE_CASES 全部） */
export async function collectCanvasCases(cases = GATE_CASES) {
  const results = []
  for (const c of cases) {
    const r = await collectCanvasCase(c)
    results.push({ case: c.id, ok: r.ok, artifact: r.artifact, error: r.error, pngBytes: r.pngBytes })
  }
  return results
}

// 供 node 侧分析复用
export { GATE_CASES }
