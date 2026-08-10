/**
 * placement-bake-processor.js — PlacementBakeAdapter 生产消费层（C-2 Step 4-2b-1）
 *
 * 职责：把 IPC 边界收到的 Plan placement 几何（settings.placement + settings.executionPaper）
 * 转成 PlacementBakeSpec，调 scripts/placement_bake.py 烤出临时 PDF，交给 Sumatra 执行。
 *
 * ════════════════════════════════════════════════════════════════════
 * ⚠️ 冻结边界（用户裁决，2026-08-10）：
 *   1. 本模块是 4-2a（DEV bake 验证）→ 4-2b（生产 executor consumption）的接线层：
 *      - 4-2a 已证明「Placement → PDF bake」几何可行（A3-03 Gate PASS）
 *      - 本模块证明「生产 print-source-file 真的调用了 bake」——4-2a 没有证明这点
 *   2. 4-2b-1 只做 bake 接线，【不切 noscale】：Sumatra 仍 fit（bake 产物 MediaBox==paper
 *      时 fit 是 1:1 no-op）。fit→noscale 属 4-2b-2，D2 触碰点，单独裁决。
 *   3. Placement 是最终 geometry truth；renderTransform 只是 Preview 的渲染表示，
 *      不能反向作为 Print PDF geometry 权威来源（本模块只消费 placement 精确几何）。
 *   4. 优雅降级：Python/pikepdf 不可用、非 PDF 源、纸型不一致、bake 失败
 *      → 返回原路径（旧 Sumatra 行为兜底），绝不让 bake 成为打印硬依赖。
 * ════════════════════════════════════════════════════════════════════
 *
 * 数据契约（与 Step 4-1 handoff 对齐）：
 *   settings.placement      = RotationResolver.resolveContentPlacement 输出（px@dpi）
 *                             { scale, offset, placedRect, layoutRotation, canvasSize, ... }
 *   settings.executionPaper = plan.paper（needSwap 后物理纸几何）
 *                             { size, orientation, widthMM, heightMM, customPaper, paperkind }
 *
 * 单位：placement 坐标域 px@300（frontend PREVIEW_DPI），bake 侧按 dpi 换算 pt。
 */

const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')

// placement_bake.py（4-2a 冻结脚本，复用 margin_contract 的 PDF 机械组装）
const BAKE_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'placement_bake.py')

// placement 坐标域 DPI——与 frontend config.js PREVIEW_DPI=300 契约对齐。
// ⚠️ 耦合点：若前端 PREVIEW_DPI 变更，此处必须同步（placement 无自带 dpi 字段）。
const BAKE_DPI = 300

const DEFAULT_TIMEOUT = 60_000  // 子进程超时（毫秒），与 pdf-margin-processor 对齐

// 纸张尺寸容差（mm）——canBakeSafely 判定 Sumatra 纸 == executionPaper 的阈值
const PAPER_TOLERANCE_MM = 0.1

// ============================
// Python 环境
// ============================

/**
 * 解析 backend venv python（dev / prod 路径与 pdf-margin-processor 一致）。
 * @returns {string|null}
 */
function getPythonCmd() {
  const isDev = !process.resourcesPath || process.resourcesPath.includes('app.asar') === false
  const pythonCmd = isDev
    ? path.join(__dirname, '../../backend/venv/Scripts/python.exe')
    : path.join(process.resourcesPath, 'backend/venv/Scripts/python.exe')
  return fs.existsSync(pythonCmd) ? pythonCmd : null
}

// ============================
// 决策纯函数（可被 Gate 直接 require）
// ============================

/**
 * 判定是否走 placement bake 生产接线。
 *
 * 条件（全部满足才 bake，任一缺失降级原路径）：
 *   1. settings.placement 字段完整（scale/offset/placedRect/layoutRotation/canvasSize）
 *   2. settings.executionPaper 提供物理纸宽高（widthMM/heightMM > 0）
 *   3. 源文件是 PDF（placement_bake 依赖 pikepdf Form XObject；OFD/图片降级）
 *   4. Sumatra 派生纸 == executionPaper 尺寸（canBakeSafely，防纸命令与 MediaBox 错位）
 *
 * @param {object} settings - IPC 收到的 settings（含 placement / executionPaper）
 * @param {string} [filePath] - 源文件路径（.pdf 判定）
 * @returns {boolean}
 */
function hasPlacement(settings, filePath) {
  if (!settings || !settings.placement || !settings.executionPaper) return false
  if (!filePath || !String(filePath).toLowerCase().endsWith('.pdf')) return false

  const p = settings.placement
  const ok = p && typeof p.scale === 'number' && Number.isFinite(p.scale)
    && p.offset && typeof p.offset.x === 'number' && typeof p.offset.y === 'number'
    && p.placedRect && typeof p.placedRect.x === 'number' && typeof p.placedRect.y === 'number'
    && typeof p.placedRect.w === 'number' && typeof p.placedRect.h === 'number'
    && Number.isFinite(Number(p.layoutRotation))
    && p.canvasSize && typeof p.canvasSize.width === 'number' && typeof p.canvasSize.height === 'number'
  if (!ok) return false

  const paper = settings.executionPaper
  if (!paper || !(Number(paper.widthMM) > 0) || !(Number(paper.heightMM) > 0)) return false

  return canBakeSafely(settings)
}

/**
 * 安全一致性守卫：Sumatra 打印纸（normalize 派生，needSwap 后）必须 == executionPaper
 * （Plan truth 物理纸）。否则 bake 产物 MediaBox 与 Sumatra paper 命令错位，fit 会二次变换。
 *
 * 背景：RG-3 后 normalize 的 needSwap 与 frontend resolvePaperSpec 同构，source 轨
 * （mergeMode='none'）下两者同源；但 printSettings 覆盖 / paperOrientation 显式字段
 * 可能导致偏差——此处显式验证，防未来接线回归。
 *
 * @param {object} settings
 * @returns {boolean}
 */
function canBakeSafely(settings) {
  try {
    const { normalize } = require('./print-settings')
    const spec = normalize(settings)
    const paper = settings.executionPaper
    const sw = spec.paper.widthMM, sh = spec.paper.heightMM
    const ew = Number(paper.widthMM), eh = Number(paper.heightMM)
    if (!(sw > 0) || !(sh > 0)) return false
    return Math.abs(sw - ew) <= PAPER_TOLERANCE_MM && Math.abs(sh - eh) <= PAPER_TOLERANCE_MM
  } catch (e) {
    // normalize 抛 MissingPrintSpecPaperError（缺纸）等 → 不 bake（降级）
    return false
  }
}

/**
 * 构造 PlacementBakeSpec（Plan truth → 冻结输入契约）。
 *
 * 只做字段搬运 + 单位命名转换（executionPaper.widthMM → paper.widthMm），
 * 不重新推导任何几何（Plan 是唯一 geometry authority）。
 *
 * @param {string} inputPath - 源 PDF 路径
 * @param {object} settings - settings.placement + settings.executionPaper
 * @param {string} outputPath - bake 产物路径
 * @returns {object} PlacementBakeSpec
 */
function buildBakeSpec(inputPath, settings, outputPath) {
  const paper = settings.executionPaper
  const p = settings.placement
  return {
    source_pdf: inputPath,
    output_pdf: outputPath,
    paper: {
      widthMm: Number(paper.widthMM),
      heightMm: Number(paper.heightMM),
    },
    placement: {
      scale: p.scale,
      offset: { x: p.offset.x, y: p.offset.y },
      placedRect: { x: p.placedRect.x, y: p.placedRect.y, w: p.placedRect.w, h: p.placedRect.h },
      layoutRotation: Number(p.layoutRotation),
      canvasSize: { width: p.canvasSize.width, height: p.canvasSize.height },
    },
    dpi: BAKE_DPI,
  }
}

// ============================
// 执行
// ============================

/**
 * 生产 bake 执行：placement_bake.py → 临时 PDF。
 *
 * 降级策略（绝不硬失败）：脚本缺失 / Python 缺失 / spawn 失败 / bake 失败
 * → 返回 { path: inputPath }（调用方通过 !== inputPath 判断是否生效）。
 *
 * @param {string} inputPath - 源 PDF 路径
 * @param {object} settings - 含 placement / executionPaper
 * @param {object} [opts] - { outputDir, timeout }
 * @returns {Promise<{path: string, info?: object}>}
 */
async function process(inputPath, settings, opts = {}) {
  const outputDir = opts.outputDir
  const timeout = opts.timeout || DEFAULT_TIMEOUT

  if (!inputPath || !fs.existsSync(inputPath)) {
    console.warn('[PLACEMENT_BAKE] Input file not found:', inputPath)
    return { path: inputPath }
  }
  if (!fs.existsSync(BAKE_SCRIPT)) {
    console.error('[PLACEMENT_BAKE] Python script missing at', BAKE_SCRIPT, '— degrade to original file')
    return { path: inputPath }
  }
  const pythonCmd = getPythonCmd()
  if (!pythonCmd) {
    console.warn('[PLACEMENT_BAKE] venv python not found — degrade to original file')
    return { path: inputPath }
  }

  // 输出路径：outputDir（main.js 传 TEMP_DIR；Gate 传自身目录）
  const dir = outputDir || require('os').tmpdir()
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { /* ignore */ }
  const outputPath = path.join(dir, `placement_bake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`)

  // spec 落盘（placement_bake.py --placement-file 语义 = 完整 PlacementBakeSpec）
  const spec = buildBakeSpec(inputPath, settings, outputPath)
  const specFile = path.join(dir, `placement_bake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)
  fs.writeFileSync(specFile, JSON.stringify(spec))

  return new Promise((resolve) => {
    // ⚠️ CLI 契约：placement_bake.py 的 argparse 将 --source/--output/--paper-*-mm 设为
    // required（即使 --placement-file 已含完整 spec）。调用方须补全显式参数
    // （placement-file 模式语义 = 显式参数覆盖 spec 字段，同值无副作用）。
    const args = [
      BAKE_SCRIPT,
      '--source', inputPath,
      '--output', outputPath,
      '--paper-width-mm', String(spec.paper.widthMm),
      '--paper-height-mm', String(spec.paper.heightMm),
      '--placement-file', specFile,
      '--dpi', String(spec.dpi),
    ]
    console.log('[PLACEMENT_BAKE] Spawning:', pythonCmd, args.join(' '))
    const startTime = Date.now()
    execFile(pythonCmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const elapsed = Date.now() - startTime
      // spec 文件用完即删
      try { if (fs.existsSync(specFile)) fs.unlinkSync(specFile) } catch (e) { /* ignore */ }

      if (err) {
        console.error('[PLACEMENT_BAKE] Error (after %dms): code=%s message=%s', elapsed, err.code || '?', err.message)
        if (stderr) console.error('[PLACEMENT_BAKE] stderr:', String(stderr).slice(0, 500))
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch (e) { /* ignore */ }
        resolve({ path: inputPath })
        return
      }

      try {
        const parsed = JSON.parse(stdout)
        if (parsed.success) {
          console.log('[PLACEMENT_BAKE] OK (%dms): %s MediaBox=%j /Rotate=%s phi=%s',
            elapsed, outputPath, parsed.info?.mediaBox, parsed.info?.rotate, parsed.info?.phi)
          resolve({ path: outputPath, info: parsed.info })
        } else {
          console.error('[PLACEMENT_BAKE] bake failed: %s', parsed.error || '(no error message)')
          try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch (e) { /* ignore */ }
          resolve({ path: inputPath })
        }
      } catch (parseErr) {
        console.error('[PLACEMENT_BAKE] Cannot parse bake stdout (%dms): %s', elapsed, String(stdout).slice(0, 300))
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch (e) { /* ignore */ }
        resolve({ path: inputPath })
      }
    })
  })
}

module.exports = { hasPlacement, canBakeSafely, buildBakeSpec, process, getPythonCmd, BAKE_DPI }
