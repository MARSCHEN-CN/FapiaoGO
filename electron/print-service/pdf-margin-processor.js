/**
 * PDF Margin Processor — 安全边距处理
 *
 * 调用 Python 脚本（scripts/add-pdf-margins.py）给 PDF 添加安全白边。
 * 支持 PDF 文件和图片文件（JPG/PNG/BMP 等）。
 *
 * 如果 Python 或 pikepdf 不可用，优雅降级返回原路径。
 *
 * 返回格式：
 *   process() 返回字符串路径 —— 成功时是处理后的 PDF 路径，
 *   降级或出错时返回原输入路径。调用方通过 === 原路径 判断是否生效。
 */

const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const { TEMP_DIR } = require('../temp-manager')

// ============================
// 路径与常量
// ============================

const isProd = app.isPackaged

// 资源目录基座：优先用 Electron 注入的 process.resourcesPath；
// 兜底避免 process.resourcesPath 在某些启动上下文未注入时导致模块加载即崩溃。
// （实测：plain Node 下该属性为只读 getter，打包运行时由 Electron 注入为真实路径字符串。）
const RESOURCES_BASE = (process.resourcesPath && typeof process.resourcesPath === 'string')
  ? process.resourcesPath
  : (typeof __dirname === 'string' ? __dirname : process.cwd())

// dev: __dirname = electron/print-service/ → ../../scripts/add-pdf-margins.py
// prod: 打包后脚本在 resources/scripts/add-pdf-margins.py
const PYTHON_SCRIPT = isProd
  ? path.join(RESOURCES_BASE, 'scripts', 'add-pdf-margins.py')
  : path.join(__dirname, '..', '..', 'scripts', 'add-pdf-margins.py')

// 启动时校验脚本路径（仅 dev：prod 走独立 pdf_tool.exe，无需 resources/scripts/*.py）
if (!isProd && !fs.existsSync(PYTHON_SCRIPT)) {
  console.warn('[PDF_MARGIN] Python margin script not found at', PYTHON_SCRIPT, '— margin processing will be disabled')
}

const DEFAULT_TIMEOUT = 60_000  // 子进程超时（毫秒）
const ENV_CHECK_TTL = 30_000    // 环境检查缓存有效期

// ⚠️ DEBUG 开关：开启后边距处理后的 PDF 会复制一份到桌面，便于人工验证
// 打印文件名格式: margin_debug_<时间戳>_L<left>R<right>T<top>B<bottom>.pdf
// 契约 §8.1：默认必须为 false（不得默认往用户桌面写文件）
const DEBUG_SAVE_TO_DESKTOP = false
// 桌面目录（Windows）
function _getDesktopPath() {
  return process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, 'Desktop')
    : null
}

// ============================
// 核心函数
// ============================

/**
 * 判断是否需要处理边距
 * @param {object} settings - 打印设置对象
 * @returns {boolean}
 */
function hasMargins(settings) {
  if (!settings) return false
  const l = Number(settings.marginLeft) || 0
  const r = Number(settings.marginRight) || 0
  const t = Number(settings.marginTop) || 0
  const b = Number(settings.marginBottom) || 0
  return l > 0 || r > 0 || t > 0 || b > 0
}

/**
 * 提取边距对象（保证各方向有值）
 * @param {object} settings
 * @returns {{ left: number, right: number, top: number, bottom: number }}
 */
function extractMargins(settings) {
  return {
    left: Number(settings.marginLeft) || 0,
    right: Number(settings.marginRight) || 0,
    top: Number(settings.marginTop) || 0,
    bottom: Number(settings.marginBottom) || 0,
  }
}

/**
 * 将 execFile 包装为 Promise
 */
function execPromise(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) {
        reject(err)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

// ============================
// 环境检查（集成 Python 查找 + pikepdf 验证，统一缓存）
// ============================

/**
 * @typedef {{ ok: boolean, cmd: string|null, standalone?: boolean }} EnvCheckResult
 */

let _envCheckPromise = null
/** @type {EnvCheckResult|null} */
let _envCheckResult = null
let _envCheckTime = 0

/**
 * 检查 Python + pikepdf 是否可用，结果缓存 ENV_CHECK_TTL 毫秒。
 *
 * 返回 { ok, cmd }：
 *   - ok: 环境是否可用
 *   - cmd: 找到的 python 命令名（'python3'/'python'/'py'），不可用时为 null
 *
 * 使用 Promise 缓存解决并发竞态问题：
 * 如果多个调用同时到达，只会触发一次实际检查，其余等待同一个 Promise。
 */
async function checkPythonEnv() {
  const now = Date.now()
  if (_envCheckResult !== null && now - _envCheckTime < ENV_CHECK_TTL) {
    console.log('[PDF_MARGIN] checkPythonEnv cache hit:', _envCheckResult)
    return _envCheckResult
  }

  // 如果已有进行中的检查，复用其 Promise
  if (_envCheckPromise) {
    console.log('[PDF_MARGIN] checkPythonEnv awaiting in-flight check')
    return _envCheckPromise
  }

  _envCheckPromise = _doCheckPythonEnv()
  try {
    const result = await _envCheckPromise
    return result
  } finally {
    _envCheckPromise = null
  }
}

async function _doCheckPythonEnv() {
  // R4-P0-8-F PROBE: 运行时资源路径审计（诊断用，验证后删除）
  const _probeExe = path.join(RESOURCES_BASE, 'tools/pdf_tool/pdf_tool.exe')
  console.log('[PDF_MARGIN][PATH_AUDIT] __dirname=%s app.isPackaged=%s resourcesPath=%s RESOURCES_BASE=%s standaloneExe=%s exists=%s',
    __dirname, app && app.isPackaged, process.resourcesPath, RESOURCES_BASE, _probeExe, fs.existsSync(_probeExe))
  if (isProd) {
    // 生产环境：独立 pdf_tool.exe（R2-3 双 CLI：PNG→PDF 子命令 + 边距长旗标）。
    // 存在则 standalone 使用（process() 以 exe 为 argv[0]，--input/--output/... 旗标直通，
    // 不再插入 PYTHON_SCRIPT）；不存在则优雅降级 ok:false 让 process() 跳过边距。
    const standaloneExe = path.join(RESOURCES_BASE, 'tools/pdf_tool/pdf_tool.exe')
    if (fs.existsSync(standaloneExe)) {
      console.log('[PDF_MARGIN] Production mode: using standalone pdf_tool.exe:', standaloneExe)
      const result = { ok: true, cmd: standaloneExe, standalone: true }
      _envCheckResult = result
      _envCheckTime = Date.now()
      return result
    }
    console.warn('[PDF_MARGIN] Production mode: pdf_tool.exe 未找到，边距处理将跳过（原文件直通）')
    const result = { ok: false, cmd: null, standalone: false }
    _envCheckResult = result
    _envCheckTime = Date.now()
    return result
  }
  
  let pythonCmd = null
  pythonCmd = path.join(__dirname, '../../backend/venv/Scripts/python.exe')
  console.log('[PDF_MARGIN] Development mode: using venv Python:', pythonCmd)

  if (!fs.existsSync(pythonCmd)) {
    console.warn('[PDF_MARGIN] Python executable not found at:', pythonCmd)
    const result = { ok: false, cmd: null }
    _envCheckResult = result
    _envCheckTime = Date.now()
    return result
  }

  // 第二步：验证 pikepdf 可导入
  try {
    const { stdout, stderr } = await execPromise(
      pythonCmd,
      ['-c', 'import pikepdf; print("OK")'],
      { timeout: 10_000 }
    )
    const ok = stdout.trim() === 'OK'
    const result = { ok, cmd: pythonCmd }
    _envCheckResult = result
    _envCheckTime = Date.now()

    if (ok) {
      console.log('[PDF_MARGIN] checkPythonEnv: OK (pikepdf available via', pythonCmd + ')')
    } else {
      console.warn('[PDF_MARGIN] checkPythonEnv FAILED: stdout=%s, stderr=%s',
        stdout?.slice(0, 200) || '(empty)',
        stderr?.slice(0, 200) || '(empty)')
    }
    return result
  } catch (err) {
    console.warn('[PDF_MARGIN] checkPythonEnv ERROR: cmd=%s code=%s message=%s',
      pythonCmd, err.code || '?', err.message)
    if (err.stderr) {
      console.warn('[PDF_MARGIN] stderr:', err.stderr.slice(0, 500))
    }
    const result = { ok: false, cmd: pythonCmd }
    _envCheckResult = result
    _envCheckTime = Date.now()
    return result
  }
}

// ============================
// 目标纸解析（Phase 1-B Step 2 新增）
// ============================

/**
 * 从打印 settings 解析目标物理纸尺寸（mm）。
 *
 * 优先级：customPaper.widthMM/heightMM → PaperRegistry → A 系列内置表。
 * 解析失败返回 null（调用方应显式传 paperW_mm/paperH_mm，不应依赖默认纸型）。
 *
 * 注意（施工纪律）：这里只解析【纸张尺寸】，绝不把 orientation 传给几何——
 * 旧「orientation → A4 方向」推断已在 Python 侧废弃（rotation bug 同类风险）。
 *
 * @param {object} [settings] - 打印设置（含 paperSize / customPaper）
 * @returns {{width: number, height: number}|null} mm
 */
function resolvePaperMmFromSettings(settings) {
  if (!settings) return null

  // ① 自定义纸：最高优先级，显式 mm
  if (settings.customPaper && Number(settings.customPaper.widthMM) > 0 &&
      Number(settings.customPaper.heightMM) > 0) {
    return {
      width: Number(settings.customPaper.widthMM),
      height: Number(settings.customPaper.heightMM),
    }
  }

  const paperName = settings.paperSize || settings.paper || null

  // ② PaperRegistry（项目已有权威纸张表）
  try {
    const { PaperRegistryProvider } = require('../shared/PaperRegistryProvider')
    const dims = PaperRegistryProvider.getEffectivePaperMap()[paperName]
    if (dims && Number(dims.widthMM) > 0 && Number(dims.heightMM) > 0) {
      return { width: Number(dims.widthMM), height: Number(dims.heightMM) }
    }
  } catch (e) {
    // PaperRegistry 不可用时落到内置表（不会发生；防御性）
  }

  // ③ A 系列内置表（纸名大写不敏感）
  const A_SERIES_MM = {
    A4: [210, 297], A3: [297, 420], A5: [148, 210],
    LETTER: [215.9, 279.4], LEGAL: [215.9, 355.6], TABLOID: [279.4, 431.8],
  }
  const key = String(paperName || '').toUpperCase()
  if (A_SERIES_MM[key]) {
    return { width: A_SERIES_MM[key][0], height: A_SERIES_MM[key][1] }
  }

  return null
}

// ============================
// 边距处理
// ============================

/**
 * 对 PDF 文件应用安全边距
 *
 * @param {string} inputPath - 原始文件路径（PDF 或图片）
 * @param {object} margins - { left, right, top, bottom } 单位 mm
 * @param {boolean} [isImage] - 是否为图片文件。传 true 强制以图片方式处理
 *   （先转 PDF 再加边距）；不传或 undefined 则由 Python 脚本自动判断。
 * @param {string} [orientation] - ⚠️ 已废弃：不再参与几何（Python 侧忽略并告警）。
 *   保留参数位仅为兼容旧调用方。
 * @param {object} [opts] - Phase 1-B 新增：
 *   { paperW_mm, paperH_mm, contentRotation, timeout }
 *   - paperW_mm/paperH_mm: 目标物理纸尺寸（mm）。PDF 路径缺省时 Python 侧以
 *     源 MediaBox 兜底（不换纸）；图片路径必填。
 *   - contentRotation: G1c 新增。Truth.rotate（0/90/180/270）直通为 apply_pdf 的
 *     content_rotation（Policy A 内容旋转）。仅透传，本层不做任何几何/swap；
 *     几何 swap 由 Geometry Translator（geometry-translator.js §9.4 R6）唯一负责。
 *   - timeout: 子进程超时毫秒，默认 60000
 * @returns {Promise<{path: string, orientation: string|null}>}
 *   path: 处理后的 PDF 路径。降级或出错时返回原 inputPath。
 *   orientation: 兼容保留（恒 null；方向不再由边距处理决定）。
 *   调用方通过 `result.path !== inputPath` 判断是否实际处理了边距。
 */
async function process(inputPath, margins, isImage, orientation, opts, timeout = DEFAULT_TIMEOUT) {
  // ── 参数校验 ──
  if (!inputPath || !fs.existsSync(inputPath)) {
    console.warn('[PDF_MARGIN] Input file not found:', inputPath)
    return { path: inputPath, orientation: null }
  }

  // ── 检查 Python 环境（同时返回命令；prod standalone = pdf_tool.exe） ──
  // 提前到 PYTHON_SCRIPT 校验之前：prod standalone 不需要 resources/scripts/*.py。
  const env = await checkPythonEnv()
  if (!env.ok || !env.cmd) {
    console.warn('[PDF_MARGIN] Python/pdf_tool not available, using original file')
    return { path: inputPath, orientation: null }
  }
  if (!env.standalone && !fs.existsSync(PYTHON_SCRIPT)) {
    console.error('[PDF_MARGIN] Python script missing at', PYTHON_SCRIPT, '— cannot process margins')
    return { path: inputPath, orientation: null }
  }
  const pythonCmd = env.cmd

  const m = {
    left: Number(margins?.left) || 0,
    right: Number(margins?.right) || 0,
    top: Number(margins?.top) || 0,
    bottom: Number(margins?.bottom) || 0,
  }

  // 无边距 → 直接返回
  if (m.left === 0 && m.right === 0 && m.top === 0 && m.bottom === 0) {
    return { path: inputPath, orientation: null }
  }

  // ── Phase 1-B opts：目标纸尺寸（mm）+ 内容旋转 + 超时 ──
  const optsObj = (opts && typeof opts === 'object') ? opts : {}
  const paperW = Number(optsObj.paperW_mm) > 0 ? Number(optsObj.paperW_mm) : null
  const paperH = Number(optsObj.paperH_mm) > 0 ? Number(optsObj.paperH_mm) : null
  // G1c：Truth.rotate → apply_pdf content_rotation（直通，零几何）。CLI --content-rotation 已支持。
  const VALID_ROTATIONS = [0, 90, 180, 270]
  const rawRot = Number(optsObj.contentRotation)
  const contentRotation = VALID_ROTATIONS.includes(rawRot) ? rawRot : 0
  if (typeof optsObj.timeout === 'number' && optsObj.timeout > 0) {
    timeout = optsObj.timeout
  }

  // ── 创建临时输出路径（始终使用 .pdf 扩展名） ──
  const tmpDir = TEMP_DIR
  const timestamp = Date.now()
  const outputName = `pdf_margin_${timestamp}.pdf`
  const outputPath = path.join(tmpDir, outputName)

  return new Promise((resolve) => {
    const args = [
      // prod standalone：argv[0] 即 pdf_tool.exe，不再插入 PYTHON_SCRIPT（旗标契约不变）
      ...(env.standalone ? [] : [PYTHON_SCRIPT]),
      '--input', inputPath,
      '--output', outputPath,
      '--left', String(m.left),
      '--right', String(m.right),
      '--top', String(m.top),
      '--bottom', String(m.bottom),
    ]

    // 显式传递 isImage 标记
    if (isImage) {
      args.push('--is-image')
    }

    // 目标物理纸尺寸（mm）。PDF 缺省 → Python 以源 MediaBox 兜底；图片必填
    if (paperW !== null && paperH !== null) {
      args.push('--paper-width-mm', String(paperW))
      args.push('--paper-height-mm', String(paperH))
    }

    // G1c：Truth.rotate → apply_pdf content_rotation（直通；rotate=0 时 Python 侧默认值即 0，省略）
    if (contentRotation !== 0) {
      args.push('--content-rotation', String(contentRotation))
    }

    // ⚠️ 不再传 --orientation：旧「orientation→纸张方向」推断已在 Python 侧废弃，
    // 方向不得参与边距几何（rotation bug 同类风险，契约 §1.1 坐标适配层唯一化）。
    if (paperW === null || paperH === null) {
      console.warn('[PDF_MARGIN] WARN: 未提供目标纸尺寸 (paperW_mm/paperH_mm)。'
        + 'PDF 路径将以源 MediaBox 为兜底目标纸；图片路径将拒绝处理。'
        + 'Phase 1-C 将由调用方从 settings 解析后显式传入。')
    }

    const tag = isImage ? ' (image)' : ' (PDF)'
    console.log('[PDF_MARGIN] Processing:', inputPath,
      `L=${m.left} R=${m.right} T=${m.top} B=${m.bottom}${tag}`)
    console.log('[PDF_MARGIN] Spawning:', pythonCmd, args.join(' '))

    const startTime = Date.now()
    const child = execFile(pythonCmd, args, { timeout }, (err, stdout, stderr) => {
      const elapsed = Date.now() - startTime
      if (err) {
        if (err.killed) {
          console.error('[PDF_MARGIN] Process killed after %dms (timeout=%d): signal=%s',
            elapsed, timeout, err.signal || 'SIGTERM')
        } else {
          console.error('[PDF_MARGIN] Error (after %dms): code=%s message=%s', elapsed, err.code || '?', err.message)
        }
        if (stderr) console.error('[PDF_MARGIN] stderr:', stderr)
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch {}
        resolve({ path: inputPath, orientation: null })
        return
      }

      if (stderr && stderr.trim()) {
        console.warn('[PDF_MARGIN] stderr (%dms): %s', elapsed, stderr.trim().slice(0, 500))
      }

      try {
        const result = JSON.parse(stdout.trim())
        if (result.success && fs.existsSync(result.path)) {
          console.log('[PDF_MARGIN] Done in %dms: %s (orient=%s)',
            elapsed, result.path, result.orientation || '?')

          // ── DEBUG：复制处理后的 PDF 到桌面，方便人工验证边距是否生效 ──
          if (DEBUG_SAVE_TO_DESKTOP) {
            try {
              const desktopPath = _getDesktopPath()
              if (desktopPath && fs.existsSync(desktopPath)) {
                const debugName = `margin_debug_${timestamp}_L${m.left}R${m.right}T${m.top}B${m.bottom}.pdf`
                const debugPath = path.join(desktopPath, debugName)
                fs.copyFileSync(result.path, debugPath)
                console.log('[PDF_MARGIN] DEBUG: 已复制到桌面 →', debugPath)
              }
            } catch (debugErr) {
              console.warn('[PDF_MARGIN] DEBUG 保存失败:', debugErr.message)
            }
          }

          resolve({
            path: result.path,
            orientation: result.orientation || null,
          })
        } else {
          console.error('[PDF_MARGIN] Script failed after %dms: %s', elapsed, result.error || 'unknown')
          try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch {}
          resolve({ path: inputPath, orientation: null })
        }
      } catch (parseErr) {
        console.error('[PDF_MARGIN] Parse error after %dms: %s', elapsed, parseErr.message)
        console.error('[PDF_MARGIN] stdout was:', stdout?.slice(0, 500) || '(empty)')
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath) } catch {}
        resolve({ path: inputPath, orientation: null })
      }
    })
  })
}

module.exports = { process, hasMargins, extractMargins, checkPythonEnv, resolvePaperMmFromSettings }
