/**
 * print-backend.js — 打印后端抽象层
 *
 * 职责：
 * - CommandBuilder：构造 Sumatra 命令行
 * - SumatraBackend：执行 SumatraPDF 打印
 * - interpretExitCode：将 Sumatra 退出码转为可读消息
 *
 * 架构：
 *   SourcePrinter（已合并至此）
 *       │
 *       ▼
 *   CommandBuilder → buildSumatraCommand()
 *       │
 *       ▼
 *   spawn child_process
 *       │
 *       ▼
 *   interpretExitCode → PrintResult
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { resolvePrintTarget } = require('./print-target');
const { buildPrintSettings, getPaperOrientation } = require('./print-settings');
const { enhanceWithCapability } = require('./printer-capability');

// ─── SumatraPDF 路径查找 ──────────────────────────────────────────

/**
 * 获取 SumatraPDF 可执行文件路径
 * 优先使用配置路径，回退到环境变量和常见安装路径
 *
 * @returns {string} SumatraPDF.exe 路径
 */
function getSumatraPath() {
  // 优先从环境变量读取
  if (process.env.SUMATRA_PDF_PATH) {
    return process.env.SUMATRA_PDF_PATH;
  }

  // 项目捆绑的 SumatraPDF（与 OsLauncherBridge 一致）
  const bundledPath = path.join(__dirname, '../../resources/sumatra/SumatraPDF.exe');
  try {
    if (require('fs').existsSync(bundledPath)) {
      return bundledPath;
    }
  } catch (e) { /* ignore */ }

  // 常见安装路径
  const candidates = [
    'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
    'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',
    path.join(process.env.LOCALAPPDATA || '', 'SumatraPDF', 'SumatraPDF.exe'),
    path.join(process.env.PROGRAMFILES || '', 'SumatraPDF', 'SumatraPDF.exe'),
  ];

  for (const candidate of candidates) {
    try {
      if (require('fs').existsSync(candidate)) {
        return candidate;
      }
    } catch (e) {
      // 继续查找
    }
  }

  // 在 PATH 中查找
  return 'sumatraPDF.exe';
}

/**
 * 检测 PDF 的页面自然方向（从 /MediaBox 读取）
 * @param {string} pdfPath - PDF 文件路径
 * @returns {'portrait'|'landscape'|null} 方向（null = 无法检测）
 */
function detectPdfOrientation(pdfPath) {
  try {
    if (!pdfPath || !fs.existsSync(pdfPath)) return null;
    // 仅对 PDF 文件尝试检测
    if (!pdfPath.toLowerCase().endsWith('.pdf')) return null;

    const fd = fs.openSync(pdfPath, 'r');
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    fs.closeSync(fd);

    const content = buffer.toString('latin1', 0, bytesRead);

    // 匹配 /MediaBox [left bottom right top]（任意 left/bottom）
    const match = content.match(/\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/);
    if (match) {
      const w = parseFloat(match[3]) - parseFloat(match[1]);
      const h = parseFloat(match[4]) - parseFloat(match[2]);
      const orient = w > h ? 'landscape' : 'portrait';
      console.log('[detectPdfOrientation] %s: MediaBox=%s×%s, %s', path.basename(pdfPath), w, h, orient);
      return orient;
    }
    return null;
  } catch (e) {
    console.warn('[detectPdfOrientation] Failed for %s: %s', pdfPath, e.message);
    return null;
  }
}

// ─── CommandBuilder ───────────────────────────────────────────────

/**
 * 构造 SumatraPDF 命令行参数
 *
 * @param {object} target - PrintTarget
 * @param {string} target.printer - 打印机名称
 * @param {string} target.filePath - 文件路径
 * @param {object} settings - PrintSettings
 * @returns {{ exe: string, args: string[] }}
 */
function buildSumatraCommand(target, settings) {
  const exe = getSumatraPath();
  const resolved = resolvePrintTarget(target);

  // 归一化字段名：前端发来 paperSize，管线需要 paper
  const normalizedSettings = { ...settings };
  if (normalizedSettings.paperSize && !normalizedSettings.paper) {
    normalizedSettings.paper = normalizedSettings.paperSize;
  }

  // 内容方向：优先使用前端传入的 contentOrientation（导入时已检测），
  // 未传或格式不对时回退到后端 MediaBox 检测
  let contentOrient = normalizedSettings.contentOrientation;
  if (contentOrient !== 'portrait' && contentOrient !== 'landscape') {
    contentOrient = detectPdfOrientation(resolved.filePath);
    if (contentOrient) {
      normalizedSettings.contentOrientation = contentOrient;
    }
  }

  // 纸张方向由所选纸张的宽高比硬编码决定（如 A4 竖向、凭证纸 240×140 横向）
  if (contentOrient) {
    normalizedSettings.paperOrientation = getPaperOrientation(
      normalizedSettings.paper,
      normalizedSettings.customPaper
    );
    console.log('[CommandBuilder] orient: content=%s (src=%s), paper=%s (paper=%s), rotation=%d',
      contentOrient,
      settings.contentOrientation ? 'frontend' : 'mediaBox',
      normalizedSettings.paperOrientation,
      normalizedSettings.paper, normalizedSettings.rotation || 0);
  }

  // Step 2: Capability 自动映射 — 从缓存补齐 paperkind
  enhanceWithCapability(normalizedSettings, target.printer);

  const printSettingsStr = buildPrintSettings(normalizedSettings);

  const args = [
    '-print-to', target.printer,
    '-silent',
    '-print-settings', printSettingsStr,
    resolved.filePath,
  ];

  console.log('[CommandBuilder]', exe, args.join(' '));
  return { exe, args };
}

// ─── 退出码解析 ───────────────────────────────────────────────────

/**
 * SumatraPDF 退出码含义（官方文档）
 *
 * 0  = 成功
 * 2  = 文件打不开（不存在或不支持）
 * 3  = 文档禁止打印
 * 4  = 打印机不存在
 * 5  = 打印机驱动/设备失败
 * 6  = 打印被策略禁止
 */
function interpretExitCode(code) {
  const messages = {
    0: '打印成功',
    2: '文件不存在或不支持',
    3: '该文档不允许打印',
    4: '打印机不存在，请检查打印机名称',
    5: '打印机驱动错误',
    6: '打印已被系统策略禁止',
  };
  return messages[code] || `打印失败（错误码: ${code}）`;
}

// ─── PrintBackend 接口 ────────────────────────────────────────────

/**
 * @typedef {Object} PrintResult
 * @property {boolean} success
 * @property {number} exitCode
 * @property {string} [message]
 * @property {string} [stderr]
 */

class SumatraBackend {
  /**
   * 执行 SumatraPDF 打印
   *
   * @param {object} target - PrintTarget
   * @param {object} settings - PrintSettings
   * @returns {Promise<PrintResult>}
   */
  async print(target, settings) {
    const { exe, args } = buildSumatraCommand(target, settings);

    return new Promise((resolve) => {
      const child = spawn(exe, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (err) => {
        console.error('[SumatraBackend] spawn error:', err.message);
        resolve({
          success: false,
          exitCode: -1,
          message: `无法启动 SumatraPDF: ${err.message}`,
          stderr: err.message,
        });
      });

      child.on('close', (exitCode) => {
        const message = interpretExitCode(exitCode);
        console.log('[SumatraBackend] exitCode=%d, message=%s', exitCode, message);
        resolve({
          success: exitCode === 0,
          exitCode,
          message,
          stderr: stderr || undefined,
        });
      });
    });
  }
}

// ─── 旧管道回退 Backend ──────────────────────────────────────────

class LegacyBackend {
  /**
   * 走旧管道（Canvas→PNG→PDF→Sumatra）
   * 保持与当前 usePrint.js 中 executePrint(V2) 相同逻辑
   *
   * @param {object} target
   * @param {object} settings
   * @returns {Promise<PrintResult>}
   */
  async print(target, settings) {
    // 通过 IPC 让前端走旧逻辑
    // 实际实现保留在 usePrint.js 的 legacy 分支中
    console.log('[LegacyBackend] Delegating to legacy pipeline');
    return {
      success: false,
      exitCode: -1,
      message: 'Legacy pipeline - use frontend fallback',
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────

function createBackend(type) {
  switch (type) {
    case 'sumatra':
      return new SumatraBackend();
    case 'legacy':
      return new LegacyBackend();
    default:
      return new SumatraBackend();
  }
}

module.exports = {
  SumatraBackend,
  LegacyBackend,
  createBackend,
  buildSumatraCommand,
  interpretExitCode,
  getSumatraPath,
};
