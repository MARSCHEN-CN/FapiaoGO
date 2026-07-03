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
const os = require('os')

// ============================
// 路径与常量
// ============================

const PYTHON_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'add-pdf-margins.py')

// 启动时校验脚本路径
if (!fs.existsSync(PYTHON_SCRIPT)) {
  console.error('[PDF_MARGIN] CRITICAL: Python margin script not found at', PYTHON_SCRIPT)
}

const DEFAULT_TIMEOUT = 60_000  // 子进程超时（毫秒）
const ENV_CHECK_TTL = 30_000    // 环境检查缓存有效期

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
 * @typedef {{ ok: boolean, cmd: string|null }} EnvCheckResult
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
  // 第一步：找 Python（永久缓存，但 checkPythonEnv 本身有 TTL 兜底）
  const candidates = ['python3', 'python', 'py']
  let pythonCmd = null
  for (const cmd of candidates) {
    try {
      const { stdout } = await execPromise(cmd, ['-c', 'print("ok")'], { timeout: 5000 })
      if (stdout.trim() === 'ok') {
        pythonCmd = cmd
        console.log('[PDF_MARGIN] Using python command:', cmd)
        break
      }
    } catch {
      // 继续尝试下一个候选
    }
  }

  if (!pythonCmd) {
    console.warn('[PDF_MARGIN] No Python executable found in PATH')
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
// 边距处理
// ============================

/**
 * 对 PDF 文件应用安全边距
 *
 * @param {string} inputPath - 原始文件路径（PDF 或图片）
 * @param {object} margins - { left, right, top, bottom } 单位 mm
 * @param {boolean} [isImage] - 是否为图片文件。传 true 强制以图片方式处理
 *   （先转 PDF 再加边距）；不传或 undefined 则由 Python 脚本自动判断。
 * @param {string} [orientation] - 页面方向 'portrait' | 'landscape' | 'auto'
 *   不传则由 Python 脚本自动检测图片方向。
 * @param {number} [timeout] - 子进程超时毫秒，默认 60000
 * @returns {Promise<{path: string, orientation: string|null}>}
 *   path: 处理后的 PDF 路径。降级或出错时返回原 inputPath。
 *   orientation: 检测到的页面方向（仅图片路径返回），PDF 路径返回 null。
 *   调用方通过 `result.path !== inputPath` 判断是否实际处理了边距。
 */
async function process(inputPath, margins, isImage, orientation, timeout = DEFAULT_TIMEOUT) {
  // ── 参数校验 ──
  if (!inputPath || !fs.existsSync(inputPath)) {
    console.warn('[PDF_MARGIN] Input file not found:', inputPath)
    return { path: inputPath, orientation: null }
  }

  if (!fs.existsSync(PYTHON_SCRIPT)) {
    console.error('[PDF_MARGIN] Python script missing at', PYTHON_SCRIPT, '— cannot process margins')
    return { path: inputPath, orientation: null }
  }

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

  // ── 检查 Python 环境（同时返回 python 命令名） ──
  const env = await checkPythonEnv()
  if (!env.ok || !env.cmd) {
    console.warn('[PDF_MARGIN] Python/pikepdf not available, using original file')
    return { path: inputPath, orientation: null }
  }
  const pythonCmd = env.cmd

  // ── 创建临时输出路径（始终使用 .pdf 扩展名） ──
  const tmpDir = os.tmpdir()
  const timestamp = Date.now()
  const outputName = `pdf_margin_${timestamp}.pdf`
  const outputPath = path.join(tmpDir, outputName)

  return new Promise((resolve) => {
    const args = [
      PYTHON_SCRIPT,
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

    // 显式传递 orientation，Python 端 auto 为默认值
    if (orientation) {
      args.push('--orientation', orientation)
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

module.exports = { process, hasMargins, extractMargins, checkPythonEnv }
