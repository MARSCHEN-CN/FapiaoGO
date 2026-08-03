/**
 * A2-G1 采集器（DEV-only，冻结 §12/§11.5）
 *
 * 职责（用户定稿）：只做三件事
 *   1. 构造固定 Gate Case（见 gateCases.mjs）
 *   2. 调用现有能力（source=pdfMargin.process 生产同款 / canvas=renderMultipleItemsToCanvas）
 *   3. 输出 artifact（PNG + JSON，含 bbox + marginMm）
 *
 * 边界（用户红线）：
 *   ❌ 不改 usePrint / renderFileToPrintImage / 不加 IPC production handler / 不改 routing
 *   ✅ 不复制业务语义：不重新调 buildPrintExecutionPlan 构造另一套（case 只描述输入，双执行器由本脚本各调现有能力）
 *
 * 运行环境：
 *   - source 轨：纯 node 可跑（pdfMargin.process 是 CJS + Python 子进程）
 *   - canvas 轨：需要 DOM canvas → 必须 Electron 渲染进程（见 README）
 *
 * Artifact schema（用户定稿，冻结 §12）：
 *   { anchor, case, dpi, paper, rotation, bbox:{left,top,right,bottom}, marginMm:{left,top,right,bottom} }
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GATE_CASES } from './gateCases.mjs'
import { GATE_DPI, PAPER_SIZES_MM } from './gateConfig.mjs'
import { findContentBBox, measureMarginsPx, marginsToMm } from './measureMargins.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 仓库根（E:/print706）—— case.file 相对路径基准 */
const REPO_ROOT = path.resolve(__dirname, '../../..')

/** artifact 输出根（gitignored，见 .gitignore 或 README） */
export const ARTIFACT_ROOT = path.join(__dirname, 'artifacts')

/** venv python（source 轨光栅化 + pdfMargin 共用） */
const VENV_PYTHON = path.join(REPO_ROOT, 'backend', 'venv', 'Scripts', 'python.exe')

/**
 * 采集 source 轨输出（纯 node 可跑）
 *
 * 复用生产同款 pdfMargin.process（electron/print-service/pdf-margin-processor.js）
 * → 烘焙边距进 PDF → fitz 光栅化第 0 页 → findContentBBox → margins(mm)。
 *
 * @param {object} caseDef GATE_CASES 中的一项
 * @param {object} [opts]
 * @param {number} [opts.dpi=GATE_DPI]
 * @param {string} [opts.outDir=ARTIFACT_ROOT]
 * @returns {Promise<{ok:boolean, artifact:object, error?:string, bakedPdfPath?:string}>}
 */
export async function collectSourceCase(caseDef, opts = {}) {
  const dpi = opts.dpi ?? GATE_DPI
  const outDir = opts.outDir ?? ARTIFACT_ROOT
  const caseDir = path.join(outDir, caseDef.id)
  mkdirSync(caseDir, { recursive: true })

  const inputPath = path.join(REPO_ROOT, caseDef.file)
  if (!existsSync(inputPath)) {
    return { ok: false, error: `source 文件不存在: ${caseDef.file}` }
  }

  const margins = {
    left: Number(caseDef.settings.marginLeft) || 0,
    right: Number(caseDef.settings.marginRight) || 0,
    top: Number(caseDef.settings.marginTop) || 0,
    bottom: Number(caseDef.settings.marginBottom) || 0,
  }
  const hasMargins = (margins.left || margins.right || margins.top || margins.bottom) > 0

  // ── OFD：生产语义 = 不走 pdfMargin（electron/main.js:512 imgExts 不含 .ofd）──
  // fitz 不支持 OFD 光栅化 → 本采集器 node 侧无法产出 A2 source bbox；
  // 记录生产语义基线 + 明确标注待后端 Render Contract 补采。
  if (caseDef.format === 'ofd') {
    const artifactOfd = {
      anchor: caseDef.anchor,
      case: caseDef.id,
      purpose: caseDef.purpose,
      dpi,
      paper: caseDef.settings.paperSize || 'A4',
      paperActualPx: null,
      rotation: caseDef.rotation,
      format: caseDef.format,
      source: '生产语义基线（无 pdfMargin 处理）',
      marginApplied: false,
      bakedPdfPath: null,
      bbox: null,
      marginMm: null,
      notes: 'source 轨 OFD 无边距（main.js imgExts 不含 .ofd）；fitz 不支持 OFD，bbox 采集需后端 Render Contract（fetchPrintRaster），node 侧不可达',
    }
    writeFileSync(path.join(caseDir, 'source.json'), JSON.stringify(artifactOfd, null, 2))
    return { ok: true, artifact: artifactOfd, note: 'OFD source 仅语义基线，bbox 待后端补采' }
  }

  // ── PDF：复用生产同款边距语义：直接调 add-pdf-margins.py ──
  // 不 require electron/print-service/pdf-margin-processor.js（其依赖 temp-manager → electron app，
  // 纯 node 不可加载）。execFile 参数与 pdf-margin-processor.js L237-245 逐字一致，
  // 即与 electron/main.js:536 生产调用等价。output 放本采集器 caseDir（非 TEMP_DIR，便于 artifact 留存）。
  const isImage = caseDef.format !== 'pdf'
  const orient = caseDef.settings.landscape ? 'landscape' : 'portrait'
  const MARGIN_SCRIPT = path.join(REPO_ROOT, 'scripts', 'add-pdf-margins.py')
  const bakedPath = path.join(caseDir, `baked_${caseDef.id}.pdf`)
  const marginArgs = [
    MARGIN_SCRIPT, '--input', inputPath, '--output', bakedPath,
    '--left', String(margins.left), '--right', String(margins.right),
    '--top', String(margins.top), '--bottom', String(margins.bottom),
  ]
  if (isImage) marginArgs.push('--is-image')
  if (orient) marginArgs.push('--orientation', orient)
  if (hasMargins) {
    try {
      execFileSync(VENV_PYTHON, marginArgs, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    } catch (e) {
      return { ok: false, error: `add-pdf-margins.py 失败: ${e.message}` }
    }
  }

  // ── 光栅化（fitz → RGBA raw） ──
  const binPath = path.join(caseDir, 'source.raw.bin')
  let width = 0, height = 0
  try {
    const out = execFileSync(VENV_PYTHON, [
      path.join(__dirname, 'rasterize_pdf.py'), bakedPath, String(dpi), binPath,
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    const meta = JSON.parse(out.trim().split('\n').pop())
    if (!meta.ok) throw new Error(meta.error || 'rasterize failed')
    width = meta.width
    height = meta.height
  } catch (e) {
    return { ok: false, error: `光栅化失败: ${e.message}` }
  }

  const pixels = new Uint8ClampedArray(readFileSync(binPath))
  const bbox = findContentBBox(pixels, width, height)
  // 纸边 = 光栅化后的实际页面尺寸（真实发票页可为非 A4 专用纸，不能假设 A4）
  const paperPx = { w: width, h: height }
  const marginsPx = bbox ? measureMarginsPx(bbox, paperPx) : null
  const marginMm = marginsPx ? marginsToMm(marginsPx, dpi) : null

  const artifact = {
    anchor: caseDef.anchor,
    case: caseDef.id,
    purpose: caseDef.purpose,
    dpi,
    paper: caseDef.settings.paperSize || 'A4',
    paperActualPx: paperPx,
    rotation: caseDef.rotation,
    format: caseDef.format,
    source: 'add-pdf-margins.py(生产同款 execFile 参数) + fitz 光栅化',
    marginApplied: hasMargins,
    bakedPdfPath: hasMargins ? bakedPath : null,
    bbox: bbox ? { left: bbox.x, top: bbox.y, right: bbox.x + bbox.w, bottom: bbox.y + bbox.h } : null,
    marginMm,
    notes: caseDef.rotation !== 0
      ? `source 轨 rotation 由 Sumatra 原生处理（不在 PDF 内容中），node 采集的 bbox 不体现旋转；旋转方向验证需 canvas 轨（renderMultipleItemsToCanvas rotations 参数）`
      : undefined,
  }
  writeFileSync(path.join(caseDir, 'source.json'), JSON.stringify(artifact, null, 2))
  return { ok: true, artifact, bakedPdfPath: hasMargins ? bakedPath : null }
}

/**
 * 采集 canvas 轨输出（需 Electron 渲染进程，见 README）
 *
 * 复用生产同款 renderMultipleItemsToCanvas（usePrint.js:288-298 调用序列逐字一致：
 * paperSize/PREVIEW_DPI/landscape/rotations/slotCount=1/isPrint=false/showSafeMargin=false/layoutOptions）。
 * 与 source 轨共用 findContentBBox → margins 换算。
 *
 * @param {object} caseDef
 * @param {object} ctx { renderMultipleItemsToCanvas, makeItem } 由 Electron 环境注入（见 README）
 * @returns {Promise<{ok:boolean, artifact:object, error?:string}>}
 */
export async function collectCanvasCase(caseDef, ctx) {
  const { renderMultipleItemsToCanvas, makeItem } = ctx
  if (typeof renderMultipleItemsToCanvas !== 'function' || typeof makeItem !== 'function') {
    return { ok: false, error: 'canvas 轨需注入 renderMultipleItemsToCanvas + makeItem（Electron 环境，见 README）' }
  }
  const dpi = GATE_DPI
  const outDir = ARTIFACT_ROOT
  const caseDir = path.join(outDir, caseDef.id)
  mkdirSync(caseDir, { recursive: true })

  const item = await makeItem(caseDef)
  const canvas = await renderMultipleItemsToCanvas(
    [item],
    caseDef.settings.paperSize || 'A4',
    dpi,
    caseDef.settings.landscape,
    { [item.key]: caseDef.rotation },
    1,   // slotCount = 1（单文件，与 usePrint.js:294 一致）
    false,  // isPrint = false（与预览一致）
    false,  // showSafeMargin
    { strategy: 'vertical', customPaper: caseDef.settings.customPaper },
  )
  if (!canvas) return { ok: false, error: 'canvas 渲染返回 null' }

  const w = canvas.width, h = canvas.height
  const g = canvas.getContext('2d')
  const img = g.getImageData(0, 0, w, h)
  const bbox = findContentBBox(img.data, w, h)
  const paperPx = { w, h }
  const marginsPx = bbox ? measureMarginsPx(bbox, paperPx) : null
  const marginMm = marginsPx ? marginsToMm(marginsPx, dpi) : null

  const artifact = {
    anchor: caseDef.anchor,
    case: caseDef.id,
    dpi,
    paper: caseDef.settings.paperSize || 'A4',
    rotation: caseDef.rotation,
    format: caseDef.format,
    source: 'renderMultipleItemsToCanvas(生产同款调用序列)',
    bbox: bbox ? { left: bbox.x, top: bbox.y, right: bbox.x + bbox.w, bottom: bbox.y + bbox.h } : null,
    marginMm,
  }
  writeFileSync(path.join(caseDir, 'canvas.json'), JSON.stringify(artifact, null, 2))
  // PNG 导出（Electron canvas → blob → arrayBuffer → 写文件）
  try {
    const blob = await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob null')), 'image/png'))
    writeFileSync(path.join(caseDir, 'canvas.png'), Buffer.from(await blob.arrayBuffer()))
  } catch (e) {
    return { ok: true, artifact, error: `PNG 导出失败（不影响 JSON）: ${e.message}` }
  }
  return { ok: true, artifact }
}

/** 批量采集 source 轨（纯 node 可跑全部 case） */
export async function collectAllSource(cases = GATE_CASES, opts = {}) {
  const results = []
  for (const c of cases) {
    const r = await collectSourceCase(c, opts)
    results.push({ case: c.id, ok: r.ok, artifact: r.artifact, error: r.error })
  }
  return results
}

export { GATE_CASES }
