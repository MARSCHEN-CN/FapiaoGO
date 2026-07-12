/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  OsLauncherBridge — JS ↔ SumatraPDF Print Bridge                ║
 * ║                                                                  ║
 * ║  Bridge layer between PrintService (JS domain) and               ║
 * ║  SumatraPDF.exe (OS execution domain).                           ║
 * ║                                                                  ║
 * ║  Contract:                                                        ║
 * ║  - Receives PrintJob from PrintService                           ║
 * ║  - Constructs SumatraPDF command line                            ║
 * ║  - Calls execFile(SumatraPDF, args)                              ║
 * ║  - Captures stdout, stderr, exit code                           ║
 * ║  - Returns OsPrintResult                                         ║
 * ║                                                                  ║
 * ║  Paper strategy:                                                  ║
 * ║  - Standard sizes (A4/A3/Letter): use -print-settings "paper=X"  ║
 * ║  - Custom/Voucher: PDF already has correct MediaBox from          ║
 * ║    pngToPdf(), use -print-settings "noscale" to preserve it      ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const { app } = require('electron');
const { execFile, execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { detectPdfOrientation: _detectPdfOrientation } = require('../shared/pdf-orientation');
const { EventEmitter } = require('events');
const { resolveOrientationCommands, getPaperOrientation } = require('./print-settings');

// detectPdfOrientation 委托到共享模块（带结果缓存，避免重复磁盘读）；
// 保持原契约：MediaBox||CropBox，未知时默认 portrait
function detectPdfOrientation(pdfPath) {
  return _detectPdfOrientation(pdfPath) ?? 'portrait';
}

// ─── SumatraPDF Path ──────────────────────────────────────────────

function getSumatraPath() {
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, 'sumatra', 'SumatraPDF.exe');
  }
  return path.join(__dirname, '../../resources/sumatra/SumatraPDF.exe');
}

// ─── 8.3 Short Path → Long Path ──────────────────────────────────

// 8.3 短路径 → 长路径 转换结果缓存。
// 8.3 路径基数极小（通常仅系统/用户目录，如 C:\PROGRA~1、C:\Users\MARS_C~1），
// 缓存几乎不会无界增长，但能避免同一文件重复打印时重复启动 PowerShell。
const _longPathCache = new Map();

// 打印任务串行队列上限（仅约束“等待中”的任务；在途任务已出队，不计入）。
// 防止打印风暴/异常调用方导致队列无界增长进而拖垮主进程。桌面场景极少触碰，可调。
const MAX_PRINT_QUEUE = 50;

/**
 * Convert Windows 8.3 short path to long path.
 * SumatraPDF cannot parse paths like C:\Users\MARS_C~1\...
 * fs.realpathSync does NOT resolve 8.3 names on Windows (see L43 comment),
 * so PowerShell [System.IO.Path]::GetFullPath() remains the reliable engine.
 *
 * Performance fix (2026-07-11):
 *  - Only invoke PowerShell when the path actually contains a `~` (the 8.3
 *    signature, e.g. PROGRA~1). The vast majority of paths are normal long
 *    paths and return immediately — eliminating the per-print 200-500ms
 *    synchronous main-thread block caused by spawning PowerShell.
 *  - Conversion results are cached per source path, so re-printing the same
 *    file never re-spawns a process.
 */
async function toLongPath(shortPath) {
  if (!shortPath) return shortPath;
  if (!shortPath.includes('~')) {
    return shortPath;
  }
  const cached = _longPathCache.get(shortPath);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const escaped = shortPath.replace(/\\/g, '\\\\');
    const result = await new Promise((resolve, reject) => {
      execFile('powershell', [
        '-NoProfile',
        '-Command',
        `[System.IO.Path]::GetFullPath('${escaped}')`
      ], { encoding: 'utf8', timeout: 3000, windowsHide: true }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim() || shortPath);
      });
    });
    _longPathCache.set(shortPath, result);
    return result;
  } catch (e) {
    _longPathCache.set(shortPath, shortPath);
    return shortPath;
  }
}

// ─── Printer Detection ────────────────────────────────────────────

// Printer names to skip (virtual/export printers incompatible with SumatraPDF)
const PRINTER_SKIP_PATTERNS = [
  /导出/i, /export/i, /wps\s*pdf/i,
  /fax/i, /xps/i, /onenote/i,
  /send\s*to/i, /microsoft\s*xps/i,
];


// ─── Default Printer Cache ─────────────────────────────────────
// The system default printer changes rarely, so cache the detection result
// to avoid spawning PowerShell / querying Chromium on every print job.
const _defaultPrinterCache = { value: undefined, expiresAt: 0 };
const DEFAULT_PRINTER_CACHE_TTL_MS = 300000; // 5 minutes

/**
 * Detect system default printer (async, non-blocking).
 * Prefers Electron's webContents.getPrintersAsync() — no PowerShell spawn.
 * Falls back to PowerShell via execFile when webContents is unavailable.
 * If no default is set, returns the first reliable (non-virtual) printer.
 * Skips virtual/export printers incompatible with SumatraPDF.
 * Success results are cached (TTL); transient failures are NOT cached so the
 * next call retries immediately instead of degrading for the full TTL.
 * @param {import('electron').WebContents|null} [webContents]
 * @returns {Promise<string|null>}
 */
async function detectDefaultPrinter(webContents) {
  const now = Date.now();
  if (_defaultPrinterCache.value !== undefined && now < _defaultPrinterCache.expiresAt) {
    return _defaultPrinterCache.value;
  }

  let result = null;
  try {
    if (webContents && typeof webContents.getPrintersAsync === 'function') {
      // ✅ Preferred: Electron-native, no external process spawned
      const printers = await webContents.getPrintersAsync();
      let fallback = null;
      for (const p of printers) {
        if (p.isDefault) { result = p.name; break; }
        const shouldSkip = PRINTER_SKIP_PATTERNS.some(re => re.test(p.name));
        if (!shouldSkip && !fallback) fallback = p.name;
      }
      result = result || fallback || null;
    } else {
      // Fallback: PowerShell, executed asynchronously (does not block main thread)
      result = await detectDefaultPrinterViaPowershell();
    }
  } catch (e) {
    console.warn('[OsLauncherBridge] detectDefaultPrinter failed:', e.message);
    result = null;
  }

  // Only cache successful detections; let transient failures retry next time.
  if (result !== null) {
    _defaultPrinterCache.value = result;
    _defaultPrinterCache.expiresAt = now + DEFAULT_PRINTER_CACHE_TTL_MS;
  }
  return result;
}

/**
 * Pre-detect default printer at app startup (non-blocking, fire-and-forget).
 * Moves the 500ms-2s PowerShell delay from first print to startup time.
 * @param {import('electron').WebContents|null} [webContents]
 */
function preDetectDefaultPrinter(webContents) {
  detectDefaultPrinter(webContents).catch((e) => {
    console.warn('[OsLauncherBridge] Pre-detection failed:', e.message);
  });
}

/**
 * Fallback default-printer detection via PowerShell, executed asynchronously
 * with execFile so it never blocks the Electron main thread.
 * @returns {Promise<string|null>}
 */
function detectDefaultPrinterViaPowershell() {
  return new Promise((resolve) => {
    const args = [
      '-NoProfile',
      '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
        'Get-Printer | Select-Object Name,Default | ConvertTo-Csv -NoTypeInformation',
    ];
    execFile('powershell', args, { encoding: 'utf8', timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        console.warn('[OsLauncherBridge] PowerShell default-printer detection failed:', err.message);
        return resolve(null);
      }
      const lines = stdout.trim().split(/\r?\n/).slice(1); // skip CSV header
      let fallback = null;
      for (const line of lines) {
        const match = line.match(/"([^"]+)"/);
        if (!match) continue;
        const name = match[1];
        if (line.includes('"True"')) return resolve(name); // system default
        const shouldSkip = PRINTER_SKIP_PATTERNS.some(p => p.test(name));
        if (!shouldSkip && !fallback) fallback = name;
      }
      resolve(fallback);
    });
  });
}

// ─── Layer 1: PrintSpec — 纯数据层 ──────────────────────────

/**
 * @typedef {Object} PrintSpec
 * @property {'A4'|'A5'|'A3'|'Letter'|'Legal'|string} paper - paper size identifier
 *   Standard sizes: 'A4','A5','A3','letter','legal','tabloid','statement','A2','A6'
 *   Custom dimensions: '140mm x 210mm' (SumatraPDF paper=Wmm x Hmm 格式)
 * @property {'portrait'|'landscape'} orientation
 * @property {'noscale'|'fit'|'shrink'} scale
 * @property {boolean} [grayscale] - Whether to print in grayscale
 * @property {boolean} [center] - Horizontally center page on paper (useful when page < paper)
 */

// ─── Layer 2: Print Decision Agent ──────────────────────────

/**
 * Map paper sizes SumatraPDF understands.
 * For unknown/custom sizes, paper key is passed through for CLI to handle.
 */
const SUMATRA_PAPER_SIZES = Object.freeze({
  A2: 'A2',
  A3: 'A3',
  A4: 'A4',
  A5: 'A5',
  A6: 'A6',
  Letter: 'letter',
  Legal: 'legal',
  Tabloid: 'tabloid',
  Statement: 'statement',
});

/**
 * Make a print decision — pure structured JSON output.
 * ❌ NO string concatenation.
 * ❌ NO comma DSL.
 * ✅ Only returns structured PrintSpec.
 *
 * @param {import('./os-boundary-contract').PrintJob} job
 * @returns {PrintSpec}
 */
function decidePrintSpec(job) {
  let paperName;

  if (job.paperSize === 'Custom' && job.customPaper) {
    // SumatraPDF 支持自定义尺寸: paper=76mm x 130mm
    const w = job.customPaper.widthMM
    const h = job.customPaper.heightMM
    if (typeof w === 'number' && typeof h === 'number' && !isNaN(w) && !isNaN(h)) {
      paperName = `${w}mm x ${h}mm`
      console.log(`[decidePrintSpec] Custom paper → "${paperName}"`)
    } else {
      paperName = job.paperSize  // fallback: 'Custom' — will be dropped by toSumatraArgs
    }
  } else {
    paperName = SUMATRA_PAPER_SIZES[job.paperSize] || job.paperSize
  }

  // 纸张方向由所选纸张的宽高比硬编码决定（如 A4 竖向、凭证纸 240×140 横向）
  const orientation = getPaperOrientation(job.paperSize, job.customPaper);

  return {
    paper: paperName,
    paperkind: job.paperkind != null ? job.paperkind : undefined,
    orientation,
    scale: 'fit',
    grayscale: job.grayscale || false,
    center: true,
  };
}

// ─── GUARD: 禁止 comma DSL ────────────────────────────────

function validateSpec(spec) {
  if (typeof spec === 'string') {
    throw new Error('[SPEC_GUARD] INVALID_SPEC: string DSL forbidden, use structured PrintSpec object');
  }
  if (!spec.paper || !spec.scale) {
    throw new Error(`[SPEC_GUARD] INVALID_SPEC: missing fields ${JSON.stringify(spec)}`);
  }
}

// ─── Layer 3: CLI Serializer — 唯一允许拼字符串的地方 ──────

/**
 * Convert PrintSpec to a single SumatraPDF -print-settings argument.
 *
 * ⚠️ This is the ONLY function in the system allowed to
 *    construct CLI strings. All others must pass PrintSpec objects.
 *
 * SumatraPDF expects: -print-settings "paper=A5,noscale,disable-auto-rotation"
 *
 * @param {PrintSpec} spec
 * @param {Object} job - PrintJob object (contains pdfPath/sourcePath for orientation detection)
 * @returns {string[]} CLI arguments
 */
function toSumatraArgs(spec, job) {
  validateSpec(spec);

  // GUARD: 禁止单个字段中出现 comma（防止 DSL 泄露）
  for (const [key, value] of Object.entries(spec)) {
    if (typeof value === 'string' && value.includes(',')) {
      throw new Error(`[SPEC_GUARD] Comma in spec.${key}: "${value}"`);
    }
  }

  // Build single combined -print-settings string
  const parts = [];

  // paperkind 优先于 paper name（Sumatra 两者都认，paperkind 更精准）
  const paperkind = spec.paperkind != null ? spec.paperkind : undefined;
  if (paperkind != null) {
    parts.push(`paperkind=${paperkind}`);
    // paper name 作为 fallback 同时输出
    if (spec.paper && SUMATRA_PAPER_SIZES[spec.paper]) {
      parts.push(`paper=${spec.paper.toLowerCase()}`);
    }
  } else if (spec.paper && (SUMATRA_PAPER_SIZES[spec.paper] || /\d+mm\s*x\s*\d+mm/.test(spec.paper))) {
    parts.push(`paper=${spec.paper}`);
  }

  const filePath = job?.pdfPath || job?.sourcePath;

  if (filePath) {
    const pdfOrientation = detectPdfOrientation(filePath);

    if (pdfOrientation) {
      const orientResult = resolveOrientationCommands(
        pdfOrientation,
        spec.orientation || 'portrait',
        0
      );
      parts.push(orientResult.baseFlag);
      if (orientResult.rotate !== 0) {
        parts.push(`rotate=${orientResult.rotate}`);
      }
    } else {
      parts.push('disable-auto-rotation');
    }
  } else {
    parts.push('disable-auto-rotation');
  }

  parts.push(spec.scale);
  if (spec.center) {
    parts.push('center');
  }
  if (spec.grayscale) {
    parts.push('monochrome');
  }

  return ['-print-settings', parts.join(',')];
}

// ─── OsLauncherBridge ───────────────────────────────────────────

/**
 * OsLauncherBridge — JS ↔ SumatraPDF execution bridge.
 *
 * Implements PrintJobEmitter interface.
 * Receives PrintJob from PrintService via event, executes SumatraPDF.
 */
class OsLauncherBridge extends EventEmitter {
  constructor(printService) {
    super();
    /** @type {string} */
    this.sumatraPath = getSumatraPath();
    /** @type {BrowserWindow|null} */
    this.mainWindow = null;
    /** @type {PrintService|null} */
    this.printService = printService;

    // 打印任务串行队列
    this.taskQueue = [];
    this.isProcessing = false;

    if (!fs.existsSync(this.sumatraPath)) {
      throw new Error(`[OsLauncherBridge] SumatraPDF not found at: ${this.sumatraPath}`);
    }

    if (this.printService) {
      this.printService.on('PrintJob', (job) => {
        this.executeJob(job);
      });
    }
  }

  /**
   * Set the main window reference for sending events to renderer.
   * @param {BrowserWindow} window
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * Send event to renderer process.
   * @param {string} channel
   * @param {Object} data
   */
  _sendToRenderer(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send(channel, data);
      } catch (err) {
        console.error(`[OsLauncherBridge] Failed to send to renderer: ${err.message}`);
      }
    }
  }

  /**
   * 打印任务入口（串行队列）
   * @param {import('./os-boundary-contract').PrintJob} job - PrintJob from PrintService
   * @returns {Promise<import('./os-boundary-contract').OsPrintResult>}
   */
  executeJob(job) {
    return new Promise((resolve, reject) => {
      if (this.taskQueue.length >= MAX_PRINT_QUEUE) {
        const err = new Error(
          `[OsLauncherBridge] 打印队列已满（上限 ${MAX_PRINT_QUEUE}），请稍后重试`
        );
        console.warn(err.message);
        reject(err);
        return;
      }
      this.taskQueue.push({ job, resolve, reject });
      this._processQueue();
    });
  }

  /**
   * 串行处理队列中的任务
   * 每次只取一个任务执行，完成后自动取下一个
   */
  async _processQueue() {
    if (this.isProcessing || this.taskQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const task = this.taskQueue.shift();
    console.log(`[OsLauncherBridge] Queue: processing job ${task.job.id}, remaining=${this.taskQueue.length}`);

    try {
      const result = await this._executeJobInternal(task.job);
      task.resolve(result);
    } catch (error) {
      task.reject(error);
    } finally {
      this.isProcessing = false;
      this._processQueue();
    }
  }

  /**
   * 内部执行方法（原 executeJob 逻辑，内容不变）
   *
   * @param {import('./os-boundary-contract').PrintJob} job - PrintJob from PrintService
   * @returns {Promise<import('./os-boundary-contract').OsPrintResult>}
   */
  async _executeJobInternal(job) {
    // Layer 1 + 2: decide print spec (pure object, no strings)
    const spec = decidePrintSpec(job);

    // Layer 3: serialize to CLI args
    const settingsArgs = toSumatraArgs(spec, job);

    // ── Build SumatraPDF arguments ──
    // Order: file → print-to → print-settings → silent
    // Convert 8.3 short path to long path — SumatraPDF cannot parse short paths
    // Support both pdfPath (rendered print) and sourcePath (direct print)
    const filePath = job.pdfPath || job.sourcePath;
    const pdfPath = await toLongPath(filePath);
    console.log(`[OsLauncherBridge] PDF path resolved: ${pdfPath}`);
    const args = [pdfPath]; // file first

    if (job.printerName && job.printerName.trim()) {
      args.push('-print-to', job.printerName.trim());
    } else {
      // Detect system default printer; fall back to first available.
      // Pass webContents for the async, non-blocking Electron-native path;
      // falls back to async PowerShell only if the window is unavailable.
      const wc = (this.mainWindow && !this.mainWindow.isDestroyed())
        ? this.mainWindow.webContents
        : null;
      const detected = await detectDefaultPrinter(wc);
      if (detected) {
        console.log(`[OsLauncherBridge] Resolved printer: ${detected}`);
        args.push('-print-to', detected);
      } else {
        // Last resort: let SumatraPDF try its own default
        args.push('-print-to-default');
      }
    }

    args.push(...settingsArgs);
    args.push('-silent');
    // 注意：-exit-when-done 仅适用于 -print-dialog / -stress-test
    // -print-to / -print-to-default 完成后 SumatraPDF 会自动退出，无需此标志

    if (job.copies && job.copies > 1) {
      args.push('-print-copies', job.copies.toString());
    }

    console.log('[OsLauncherBridge] Executing:');
    console.log(`  Binary: ${this.sumatraPath}`);
    console.log(`  Args:   ${args.join(' ')}`);
    console.log(`  PDF:    ${pdfPath} (orig: ${job.pdfPath})`);
    console.log(`  Paper:  ${job.paperSize} / ${job.orientation}`);
    console.log(`  Printer: ${job.printerName || '(default)'}`);
    console.log(`  Copies: ${job.copies || 1}`);
    console.log(`  CWD:    ${path.dirname(this.sumatraPath)}`);

    // ── Execute ──
    return new Promise((resolve) => {
      const child = spawn(
        this.sumatraPath,
        args,
        {
          timeout: 120000,
          env: process.env,
          windowsHide: false,
          cwd: path.dirname(this.sumatraPath),
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 120000);

      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);

        console.log('[OsLauncherBridge] Result:');
        console.log(`  exitCode: ${exitCode}`);
        console.log(`  signal: ${signal}`);
        if (stdout) console.log(`  stdout:   ${stdout.trim().slice(0, 800)}`);
        if (stderr) console.log(`  stderr:   ${stderr.trim().slice(0, 500)}`);
        if (timedOut) console.log(`  timeout:  true`);

        if (exitCode === 0 && !timedOut) {
          this._sendToRenderer('print-job-completed', { jobId: job.id });
          this.emit(`job-${job.id}-completed`);
          resolve({
            jobId: null,
            status: 'submitted',
          });
        } else {
          const errMsg = timedOut
            ? 'SumatraPDF timed out (120s)'
            : stderr.trim() || `exit code ${exitCode}`;
          console.error(`[OsLauncherBridge] FAILED: ${errMsg}`);
          this._sendToRenderer('print-job-failed', { jobId: job.id, message: errMsg });
          this.emit(`job-${job.id}-failed`, new Error(errMsg));
          resolve({
            jobId: null,
            status: 'failed',
            error: errMsg,
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        console.error(`[OsLauncherBridge] spawn error: ${err.message}`);
        this._sendToRenderer('print-job-failed', { jobId: job.id, message: err.message });
        this.emit(`job-${job.id}-failed`, err);
        resolve({
          jobId: null,
          status: 'failed',
          error: err.message,
        });
      });

      // Log child process info
      if (child.pid) {
        console.log(`[OsLauncherBridge] Process started, PID: ${child.pid}`);
      }
    });
  }

  /**
   * Make a print decision — pure structured JSON output.
   *
   * @param {Object} job
   * @returns {PrintSpec}
   */
  _decidePrintSpec(job) {
    let paperName;

    if (job.paperSize === 'Custom' && job.customPaper) {
      const w = job.customPaper.widthMM;
      const h = job.customPaper.heightMM;
      if (typeof w === 'number' && typeof h === 'number' && !isNaN(w) && !isNaN(h)) {
        paperName = `${w}mm x ${h}mm`;
        console.log(`[decidePrintSpec] Custom paper → "${paperName}"`);
      } else {
        paperName = job.paperSize;
      }
    } else {
      paperName = SUMATRA_PAPER_SIZES[job.paperSize] || job.paperSize;
    }

    const orientation = job.orientation === 'landscape' ? 'landscape' : 'portrait';
    return {
      paper: paperName,
      paperkind: job.paperkind != null ? job.paperkind : undefined,
      orientation,
      scale: 'fit',
      grayscale: job.grayscale || false,
    };
  }

  /**
   * Verify SumatraPDF binary exists.
   * @returns {boolean}
   */
  verifyBinary() {
    return fs.existsSync(this.sumatraPath);
  }

  /**
   * Get the full path to SumatraPDF.
   * @returns {string}
   */
  getBinaryPath() {
    return this.sumatraPath;
  }
}

module.exports = { OsLauncherBridge, decidePrintSpec, toSumatraArgs, getSumatraPath, toLongPath, preDetectDefaultPrinter };
module.exports.default = OsLauncherBridge;
