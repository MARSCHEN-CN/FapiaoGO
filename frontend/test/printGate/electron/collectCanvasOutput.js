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
import { normalizeReadFileData } from '../ipcPayloadAdapter.mjs'
import { renderMultipleItemsToCanvas, renderPDFPageRaw } from '../../../src/renderers.js'
import { buildPrintJobItem, fetchPrintRaster } from '../../../src/utils/printAdapter.js'
// A3-V1：生产路径采集（镜像 usePrint.js renderFileToPrintImage PDF 单文件分支 A3-3-2/3-3）
import { computePaperLayout } from '../../../src/previewState.js'
import { extendPaperLayoutContract } from '../../../src/print/paperLayoutContract.js'
import { applySourceOriginPlacement, transformPaperRotation } from '../../../src/print/placementAdapter.js'
import { drawRenderCommand } from '../../../src/layout/renderDraw.js'

/** 渲染进程注入的 ipc（真实契约 = window.electronAPI.ipcRenderer，见 electron/preload.js:51,92） */
function resolveGateIPC() {
  // 优先真实 preload 契约：contextBridge.exposeInMainWorld('electronAPI', ...)
  if (window.electronAPI?.ipcRenderer?.invoke) {
    return window.electronAPI.ipcRenderer
  }
  // 兜底：直接暴露的 ipcRenderer（部分测试环境）
  if (window.ipcRenderer?.invoke) {
    return window.ipcRenderer
  }
  // 兜底：window.api.ipc（历史假设，保留兼容）
  if (window.api?.ipc?.invoke) {
    return window.api.ipc
  }
  throw new Error(
    'Gate canvas collector requires Electron IPC bridge: ' +
    'window.electronAPI.ipcRenderer.invoke 不存在（preload.js 未暴露？）'
  )
}

/** b64 → Blob（OFD/Image previewImage 兜底） */
function b64toBlob(b64, mime = 'image/png') {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

/** previewImage base64 → Blob（Gate A 修复镜像）：嗅探真实 MIME，避免 WebP 内容被声明成 image/png 解码失败 → 白纸。 */
function detectImageMime(b64) {
  let raw = b64
  if (raw.startsWith('data:')) raw = raw.split(',')[1] || ''
  let bin
  try { bin = atob(raw.slice(0, 16)) } catch { return 'image/png' }
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return 'image/png'
}
function previewImageToBlob(b64) {
  return b64toBlob(b64, detectImageMime(b64))
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
    const ipc = resolveGateIPC()
    const fileData = await ipc.invoke('read-file', f.printPath)
    if (!fileData?.success) throw new Error(`read-file 失败: ${f.printPath}`)
    f._pdfData = normalizeReadFileData(fileData)
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
    if (f.previewImage) { f._previewImageUrl = URL.createObjectURL(previewImageToBlob(f.previewImage)); return f }
    throw new Error('OFD 无 docId 且无 previewImage，无法加载')
  }

  // Image 分支（usePrint.js:259-274）
  if (f.fileFormat === 'image') {
    const ipc = resolveGateIPC()
    const fileData = await ipc.invoke('read-file', f.printPath)
    if (fileData?.success) {
      f._previewImageUrl = URL.createObjectURL(new Blob([normalizeReadFileData(fileData)]))
      return f
    }
    if (f.previewImage) { f._previewImageUrl = URL.createObjectURL(previewImageToBlob(f.previewImage)); return f }
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

/**
 * 批量采集（支持 {names} 过滤——G1-CANVAS-1 只跑 PDF case，OFD 留 G1-B）
 * @param {object} [opts]
 * @param {string[]} [opts.names] 要采集的 case id 列表（如 ['A1-rot0','A1-rot90']）
 * @param {Array} [opts.cases] 自定义 case 数组（默认 GATE_CASES）
 */
export async function collectCanvasCases(opts = {}) {
  const all = opts.cases ?? GATE_CASES
  const names = opts.names ?? all.map(c => c.id)
  const cases = all.filter(c => names.includes(c.id))
  const results = []
  for (const c of cases) {
    const r = await collectCanvasCase(c)
    results.push({ case: c.id, ok: r.ok, artifact: r.artifact, error: r.error, pngBytes: r.pngBytes })
  }
  return results
}

/**
 * G1-CANVAS-3B：native PDF page render 采集器（单变量验证）
 *
 * 直接调 renderPDFPageRaw(paperKey=null)（renderers.js:558-566 native 分支）：
 *   - 画布 = PDF 原生页尺寸（dpi/72 缩放）
 *   - 无 slot-fit / 无居中 / 无 customPaper / 无外扩
 * 记录三个数据点（用户定稿 §3B）：bitmap size / content bbox / bbox offset vs source。
 *
 * @param {object} caseDef GATE_CASES 项
 * @returns {Promise<{ok:boolean, artifact:object, error?:string}>}
 */
export async function collectNativeCase(caseDef) {
  try {
    const item = await makePrintItem(caseDef)
    const result = await renderPDFPageRaw(item._pdfData, GATE_DPI, item.key, null, false)
    if (!result) return { ok: false, error: 'renderPDFPageRaw(native) 返回 null' }

    let w = result.width, h = result.height
    let canvas = result.canvas
    const rotate = caseDef.rotation || 0

    // A3-2 rotation gate：native 分支本身不旋转（renderers.js:558 无 rotate），
    // 旋转由 renderMultipleItemsToCanvas 的 rotations 参数层处理（createPlacement）。
    // 此处用 canvas 2D 旋转模拟「渲染后旋转」验证坐标系（验证性质，非生产路径）。
    if (rotate !== 0 && rotate % 90 === 0) {
      const tmp = document.createElement('canvas')
      if (rotate === 90 || rotate === 270) { tmp.width = h; tmp.height = w } else { tmp.width = w; tmp.height = h }
      const tctx = tmp.getContext('2d')
      tctx.fillStyle = '#ffffff'
      tctx.fillRect(0, 0, tmp.width, tmp.height)
      tctx.translate(tmp.width / 2, tmp.height / 2)
      tctx.rotate((rotate * Math.PI) / 180)
      tctx.drawImage(canvas, -w / 2, -h / 2)
      canvas = tmp
      w = tmp.width; h = tmp.height
    }

    const img = canvas.getContext('2d').getImageData(0, 0, w, h)
    const bbox = findContentBBox(img.data, w, h)

    const artifact = {
      anchor: caseDef.anchor,
      case: caseDef.id,
      purpose: 'A3-2 native render（paperKey=null）' + (rotate ? ` + rotation=${rotate}（A3-2-02 rotation gate）` : '（复现 G1-3B）'),
      dpi: GATE_DPI,
      paper: 'native（PDF 原生页尺寸）',
      paperActualPx: { w, h },
      rotation: rotate,
      format: caseDef.format,
      source: 'renderPDFPageRaw(paperKey=null) native 分支 + 采集器侧 canvas 旋转（验证性质）',
      bbox: bbox ? { left: bbox.x, top: bbox.y, right: bbox.x + bbox.w, bottom: bbox.y + bbox.h } : null,
      bboxPx: bbox ? { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h } : null,
      bboxOffsetVsSourcePx: bbox ? { dx: bbox.x - 169, dy: bbox.y - 189 } : null,
      marginMm: null,  // native 无纸面外扩，不适用边距比较
    }
    console.log(`[GATE-CANVAS-3B] ${caseDef.id} OK  bitmap=${w}x${h} bbox=${JSON.stringify(artifact.bboxPx)} offsetVsSource=${JSON.stringify(artifact.bboxOffsetVsSourcePx)}`)
    return { ok: true, artifact }
  } catch (e) {
    console.error(`[GATE-CANVAS-3B] ${caseDef.id} FAIL:`, e.message)
    return { ok: false, error: e.message }
  }
}

/**
 * A3-V1 collectProductionRotatedCase：生产路径 rot90 采集（A3-3 Verification Closure）
 *
 * 目标：验证「实现路径 ≠ 纯函数路径」——renderPDFPageRaw + applySourceOriginPlacement +
 * transformPaperRotation + 两段式 drawRenderCommand 实际产出的 bitmap 是否符合 C5 锚点
 * （画布 1890×2717 / bbox (201,169,1500×2423) / 边距 L17/T14.3/R16/B10.6 / ratio≥0.99）。
 * 防：transformPaperRotation 纯函数正确但 draw 顺序/translate/rotate/画布尺寸错误。
 *
 * 调用序列**逐字镜像 usePrint.js renderFileToPrintImage PDF 单文件分支**（A3-3-2 + A3-3-3 两段式）：
 *   computePaperLayout + extendPaperLayoutContract → renderPDFPageRaw(paperKey=null) native
 *   → applySourceOriginPlacement(rotation:0) → transformPaperRotation(rotation)
 *   → rot0 绘制扩展纸面画布 → rotateCanvasCommand 旋转绘制到新画布
 *
 * 边界（与 Gate 纪律一致）：只调用生产函数 + 生产调用序列，采集器只编排；不复制渲染语义。
 *
 * @param {object} caseDef GATE_CASES 项（settings 需含 paperSize/customPaper/margin；rotation 来自 caseDef.rotation）
 * @returns {Promise<{ok:boolean, artifact:object, error?:string}>}
 */
export async function collectProductionRotatedCase(caseDef) {
  try {
    const item = await makePrintItem(caseDef)
    const s = caseDef.settings || {}

    // ① paperLayout 构造（镜像 usePrint.js:298-309）
    const baseLayout0 = computePaperLayout({
      paperSize: s.paperSize,
      customPaper: s.customPaper,
      margins: {
        left: s.marginLeft ?? 3, right: s.marginRight ?? 3,
        top: s.marginTop ?? 3, bottom: s.marginBottom ?? 3,
      },
    })
    const paperLayout0 = extendPaperLayoutContract(baseLayout0, {
      sourceOriginXMM: s.marginLeft ?? 3,
      sourceOriginYMM: s.marginTop ?? 3,
    })

    // ② native 渲染（镜像 usePrint.js:310）
    const nativeRes = await renderPDFPageRaw(item._pdfData, GATE_DPI, item.key, null, false)
    if (!nativeRes) return { ok: false, error: 'renderPDFPageRaw(native) 返回 null' }

    // ③ rot0 placement + PaperTransform（镜像 usePrint.js:312-324）
    const rot0Cmd = applySourceOriginPlacement({ renderResource: nativeRes, paperLayout: paperLayout0, rotation: 0 })
    const pw = paperLayout0.paperRect?.w || nativeRes.width
    const ph = paperLayout0.paperRect?.h || nativeRes.height
    const rotInfo = transformPaperRotation(rot0Cmd, caseDef.rotation || 0, pw, ph)

    // ④ 两段式绘制（镜像 usePrint.js:317-345）：rot0 绘制扩展纸面 → 画布级旋转到新画布
    const finalCanvas = document.createElement('canvas')
    finalCanvas.width = rotInfo.canvasW
    finalCanvas.height = rotInfo.canvasH
    const fctx = finalCanvas.getContext('2d')
    fctx.fillStyle = '#ffffff'
    fctx.fillRect(0, 0, rotInfo.canvasW, rotInfo.canvasH)
    if (rotInfo.rotateCanvasCommand) {
      const tmpCanvas = document.createElement('canvas')
      tmpCanvas.width = pw
      tmpCanvas.height = ph
      const tctx = tmpCanvas.getContext('2d')
      tctx.fillStyle = '#ffffff'
      tctx.fillRect(0, 0, pw, ph)
      drawRenderCommand(tctx, rot0Cmd, nativeRes.canvas, nativeRes.width, nativeRes.height)
      drawRenderCommand(fctx, rotInfo.rotateCanvasCommand, tmpCanvas, pw, ph)
    } else {
      drawRenderCommand(fctx, rot0Cmd, nativeRes.canvas, nativeRes.width, nativeRes.height)
    }

    // ⑤ 测量（与 canvas 采集同链路）
    const w = finalCanvas.width, h = finalCanvas.height
    const img = finalCanvas.getContext('2d').getImageData(0, 0, w, h)
    const bbox = findContentBBox(img.data, w, h)
    const paperPx = { w, h }
    const marginsPx = bbox ? measureMarginsPx(bbox, paperPx) : null
    const marginMm = marginsPx ? marginsToMm(marginsPx, GATE_DPI) : null

    const artifact = {
      anchor: caseDef.anchor,
      case: caseDef.id,
      purpose: 'A3-V1 生产路径 rot' + (caseDef.rotation || 0) + '（renderPDFPageRaw + PlacementAdapter + PaperTransform 两段式）',
      dpi: GATE_DPI,
      paper: s.paperSize || 'Custom',
      paperActualPx: { w, h },
      rotation: caseDef.rotation || 0,
      format: caseDef.format,
      source: '生产调用序列镜像（usePrint.js renderFileToPrintImage PDF 单文件分支 A3-3-2/3-3）',
      bbox: bbox ? { left: bbox.x, top: bbox.y, right: bbox.x + bbox.w, bottom: bbox.y + bbox.h } : null,
      bboxPx: bbox ? { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h } : null,
      marginMm,
      // C5 锚点对照（rot90 预期）：bitmap 1890×2717 / bbox (201,169,1500×2423) / L17/T14.3/R16/B10.6
    }
    console.log(`[GATE-A3V1] ${caseDef.id} OK  bitmap=${w}x${h} bbox=${JSON.stringify(artifact.bboxPx)} marginMm=${JSON.stringify(marginMm)}`)
    return { ok: true, artifact }
  } catch (e) {
    console.error(`[GATE-A3V1] ${caseDef.id} FAIL:`, e.message)
    return { ok: false, error: e.message }
  }
}

/**
 * A3-RF RenderResource Probe — pdf.js 侧（Electron devtools 跑）。
 *
 * 镜像 collectProductionRotatedCase 的 native 渲染步，但只取 RenderResource 本身，
 * 不做 placement / rotation —— 纯粹对比 pdf.js 产出的 resource 与 fitz 侧（probe_render_resource_fitz.py）。
 *
 * 输出：nativeRes（pdf.js getViewport 渲染）尺寸 + content bbox（白底，亮度<250 即墨迹，与 fitz 对齐）。
 * 与 fitz 探针的 mediabox_px / cropbox_px 比对：
 *   - 若 nativeRes ≈ fitz cropbox_px 且 ≠ mediabox_px → 假设 R2 成立（pdf.js=CropBox, fitz=MediaBox）
 *   - 若 nativeRes ≈ fitz mediabox_px → 两引擎同 box，残差在 AA / glyph 层
 *
 * @param {object} caseDef GATE_CASES 项（rotation 无关，本探针只取 native）
 */
export async function collectRenderResourceProbe(caseDef) {
  try {
    const item = await makePrintItem(caseDef)
    const nativeRes = await renderPDFPageRaw(item._pdfData, GATE_DPI, item.key, null, false)
    if (!nativeRes) return { ok: false, error: 'renderPDFPageRaw(native) 返回 null' }

    const { canvas, width, height } = nativeRes
    const ctx = canvas.getContext('2d')
    const img = ctx.getImageData(0, 0, width, height).data

    // ⚠️ 修正（2026-08-04）：pdf.js 在 renderers.js:535-536 填白底（#ffffff），
    // alpha 通道恒为 1 → alpha>0 检测会命中整页（全白也算"内容"），content bbox 永远=整页。
    // 改用与 fitz 探针一致的亮度阈值（brightnessMax=250，任一通道<250 即墨迹），
    // 才能量到真实 inked content bbox，与 fitz content_bbox_px 可比。
    const brightnessMax = 250
    let minX = width, minY = height, maxX = -1, maxY = -1
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const r = img[i], g = img[i + 1], b = img[i + 2]
        if (r < brightnessMax || g < brightnessMax || b < brightnessMax) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    const bbox = maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null

    const artifact = {
      engine: 'pdfjs',
      case: caseDef.id,
      dpi: GATE_DPI,
      nativeW: width,
      nativeH: height,
      bbox_method: 'brightness<250 (white bg)',
      content_bbox_px: bbox,
    }
    console.log(`[GATE-A3RF] ${caseDef.id} OK native=${width}x${height} contentBBox=${JSON.stringify(bbox)}`)
    return { ok: true, artifact }
  } catch (e) {
    console.error(`[GATE-A3RF] ${caseDef.id} FAIL:`, e.message)
    return { ok: false, error: e.message }
  }
}

// 供 node 侧分析复用
export { GATE_CASES }
