/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  ARCHITECTURE PHASE: OS TRUST DELEGATION                        ║
 * ║                                                                  ║
 * ║  JS DOMAIN = Rendering only.                                     ║
 * ║  JavaScript never holds execution authority.                      ║
 * ║                                                                  ║
 * ║  ❌ No OS process execution                                      ║
 * ║  ❌ No binary path storage                                       ║
 * ║  ❌ No execution point protection                                ║
 * ║  ❌ No AST scanner / guard extension to execution layer          ║
 * ║                                                                  ║
 * ║  ✅ JS only emits PrintJob event                                ║
 * ║  ✅ OS signed launcher handles execution                         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * SINGLE RENDERING CONTRACT:
 * - LayoutSnapshot → renderLayoutToHTML() → HTML → PDF
 * - PrintService 只消费预生成的 PDF file path
 * - PrintService 不调用任何 OS process
 * - PrintService 发出 PrintJob 事件，由 OS launcher 消费
 */

const fs = require('fs');
const { EventEmitter } = require('events');

// CONTRACT: Single Rendering Pipeline compliant
// CONTRACT: OS Trust Delegation compliant

// ─── Print Service ────────────────────────────────────────────────

/**
 * PrintService — JS 渲染域的唯一打印出口
 *
 * 职责：
 * 1. 验证 PDF 文件存在且具有 .pdf 扩展名
 * 2. 构造 PrintJob（数据描述，不包含执行参数）
 * 3. 通过 'PrintJob' 事件将 PrintJob 移交 OS domain
 *
 * ❌ 禁止：
 * - execFile
 * - child_process
 * - binary path resolution
 * - SumatraPDF path
 * - SumatraPDF execution
 * - any OS process invocation
 * - this.sumatraPath
 * - getSumatraPath()
 */
class PrintService extends EventEmitter {
  /**
   * @param {import('./os-boundary-contract').PrintJobEmitter} [emitter] — PrintJobEmitter 实例（向后兼容）
   * @param {object} [config] — 配置
   * @param {'source'|'legacy'} [config.mode='source'] — 打印管道模式
   */
  constructor(emitter, config = {}) {
    super();
    /** @type {import('./os-boundary-contract').PrintJobEmitter} */
    this.emitter = emitter;
    /** @type {Map<string, Function>} */
    this._jobCallbacks = new Map();
    this.config = {
      mode: config.mode || 'source',
    };
    this._backend = null;
  }

  /**
   * 获取后端实例（延迟初始化）
   */
  _getBackend() {
    if (!this._backend) {
      const { createBackend } = require('./print-backend');
      this._backend = createBackend('sumatra');
    }
    return this._backend;
  }

  /**
   * 切换打印管道模式
   * @param {'source'|'legacy'} mode
   */
  setMode(mode) {
    if (mode !== 'source' && mode !== 'legacy') {
      console.warn('[PrintService] Unknown mode:', mode);
      return;
    }
    this.config.mode = mode;
    console.log('[PrintService] Mode switched to:', mode);
  }

  /**
   * 提交打印任务（根据当前模式路由）
   *
   * @param {object} payload - 打印任务
   * @param {string} payload.filePath - 文件路径
   * @param {object} [target] - PrintTarget（新管道使用）
   * @param {object} [settings] - PrintSettings（新管道使用）
   * @returns {Promise<object>}
   */
  async submit(payload, target, settings) {
    if (this.config.mode === 'source') {
      return this._sourcePrint(target, settings);
    }
    return this._legacySubmit(payload);
  }

  /**
   * 新管道：源文件直通 Sumatra
   * @private
   */
  async _sourcePrint(target, settings) {
    console.log('[PrintService] Source pipeline: printer=%s file=%s',
      target?.printer, target?.filePath);

    if (!target || !target.filePath) {
      return { success: false, exitCode: -1, message: 'PrintTarget.filePath is required' };
    }

    if (!target.printer) {
      return { success: false, exitCode: -1, message: 'Printer name is required' };
    }

    const backend = this._getBackend();
    const result = await backend.print(target, settings || {});

    // 退出码 → 前端可读消息
    const { interpretExitCode } = require('./print-backend');
    const message = interpretExitCode(result.exitCode);

    return {
      success: result.success,
      exitCode: result.exitCode,
      message,
    };
  }

  /**
   * 旧管道：维持原有逻辑
   * @private
   */
  async _legacySubmit(payload) {
    console.log('[PrintService] Legacy pipeline invoked');
    // ── GUARD: RAW_PATH_DETECTED — non-PDF paths are FORBIDDEN ──
    // Only Canvas → PNG → pdf-generator → PDF is valid.
    if (payload?.filePath && !payload.filePath.toLowerCase().endsWith('.pdf')) {
      const err = `[RAW_PATH_DETECTED] PrintService received non-PDF path: ${payload.filePath}. Only Canvas → PDF → PrintService is valid.`
      console.error(err)
      throw new Error(err)
    }

    // ── Step 1: 验证输入（JS domain validation only）──
    if (!payload.filePath) {
      return this._fail('filePath is required');
    }

    if (!payload.filePath.toLowerCase().endsWith('.pdf')) {
      return this._fail('filePath must be a .pdf file');
    }

    if (!fs.existsSync(payload.filePath)) {
      return this._fail(`PDF file not found: ${payload.filePath}`);
    }

    // ── PDF fingerprint validation (second line of defense) ──
    const { validatePdfStructure } = require('./pdf-generator')
    const pdfCheck = validatePdfStructure(payload.filePath)
    if (!pdfCheck.valid) {
      const errMsg = `[PDF_FINGERPRINT_FAIL] PDF validation failed: ${pdfCheck.issues.join('; ')}`
      console.error(errMsg)
      throw new Error(errMsg)
    }

    if (!payload.paperSize) {
      return this._fail('paperSize is required');
    }

    // ── Step 2: 构造 PrintJob ──
    /** @type {import('./os-boundary-contract').PrintJob} */
    const printJob = {
      pdfPath: payload.filePath,
      paperSize: payload.paperSize,
      orientation: payload.orientation,
      printerName: payload.printerName,
      customPaper: payload.customPaper,
      grayscale: payload.grayscale || false,
      copies: payload.copies || 1,
      createdAt: new Date().toISOString(),
    };

    // ── Step 3: 移交 OS domain ──
    try {
      this.emit('PrintJob', printJob);
      return {
        jobCreated: true,
        createdAt: printJob.createdAt,
      };
    } catch (err) {
      return this._fail(`OS domain error: ${err?.message || 'unknown'}`);
    }
  }

  /**
   * 提交直接打印任务。
   *
   * @param {Object} job - 直接打印任务对象
   * @param {string} job.id - 任务 ID
   * @param {string} job.type - 'direct'
   * @param {string} job.sourcePath - 源文件路径
   * @param {string} job.tempDir - 临时目录
   * @param {string} [job.printerName] - 打印机名称
   * @param {number} [job.copies] - 打印份数
   * @param {string} [job.paperSize] - 纸张尺寸
   * @param {string} [job.orientation] - 方向
   * @param {boolean} [job.grayscale] - 是否灰度
   * @param {number} [job.scaleFactor] - 缩放比例
   * @param {boolean} [job.collate] - 是否整理
   * @param {Object} [job.customPaper] - 自定义纸张
   * @returns {Promise<Object>}
   */
  async submitDirect(job) {
    console.log('[PrintService] submitDirect() called:', job.id);

    if (!job?.sourcePath) {
      return this._failDirect('sourcePath is required');
    }

    if (!fs.existsSync(job.sourcePath)) {
      return this._failDirect(`File not found: ${job.sourcePath}`);
    }

    const jobPromise = new Promise((resolve, reject) => {
      const completedEvent = `job-${job.id}-completed`;
      const failedEvent = `job-${job.id}-failed`;

      const onCompleted = () => {
        this._cleanupTempDir(job.tempDir);
        this.emitter.off(completedEvent, onCompleted);
        this.emitter.off(failedEvent, onFailed);
        resolve({ success: true, jobId: job.id });
      };

      const onFailed = (error) => {
        this._cleanupTempDir(job.tempDir);
        this.emitter.off(completedEvent, onCompleted);
        this.emitter.off(failedEvent, onFailed);
        reject({ success: false, error: error?.message || error || 'Unknown error' });
      };

      this.emitter.once(completedEvent, onCompleted);
      this.emitter.once(failedEvent, onFailed);

      // 同步发射 PrintJob；若监听器抛出异常，需在此 reject。
      // 注意：reject 是 executor 作用域内的参数，必须在 executor 内调用，
      // 不能外移到外层（外层作用域中 reject 未定义 → ReferenceError）。
      try {
        this.emit('PrintJob', job);
      } catch (err) {
        this.emitter.off(completedEvent, onCompleted);
        this.emitter.off(failedEvent, onFailed);
        reject({ success: false, error: err?.message || 'Unknown error' });
      }
    });

    return jobPromise;
  }

  /**
   * @param {string} tempDir
   * @private
   */
  _cleanupTempDir(tempDir) {
    if (!tempDir) return;
    setTimeout(async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await fs.promises.rm(tempDir, { recursive: true, force: true });
          console.log(`[PrintService] Cleaned up temp dir: ${tempDir}`);
          break;
        } catch (e) {
          if (i === 2) console.warn('[PrintService] Failed to cleanup temp dir:', e.message);
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }, 1000);
  }

  /**
   * @param {string} error
   * @returns {Object}
   * @private
   */
  _failDirect(error) {
    return {
      success: false,
      error,
    };
  }

  /**
   * @param {string} error
   * @returns {import('./os-boundary-contract').PrintResult}
   * @private
   */
  _fail(error) {
    return {
      jobCreated: false,
      createdAt: new Date().toISOString(),
      error,
    };
  }
}

module.exports = { PrintService };
module.exports.default = PrintService;
