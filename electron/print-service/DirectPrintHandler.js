/**
 * DirectPrintHandler — 直接打印处理器
 * 
 * 职责：
 * 1. 安全校验输入文件（路径、扩展名白名单、文件存在性）
 * 2. 创建临时目录和文件副本（只读保护）
 * 3. 构造直接打印任务对象
 * 4. 调用 PrintService.submitDirect() 提交任务
 * 5. 清理临时文件
 */

const fs = require('fs');
const path = require('path');
const { TEMP_DIR } = require('../temp-manager');

// 直接打印支持的文件扩展名
const DIRECT_PRINT_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif'];

/**
 * 验证文件是否可以直接打印
 * @param {string} filePath 
 * @returns {boolean}
 */
function isValidDirectPrintFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const ext = path.extname(filePath).toLowerCase();
  return DIRECT_PRINT_EXTENSIONS.includes(ext);
}

/**
 * 生成唯一 ID
 * @returns {string}
 */
function generateJobId() {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 异步判断路径是否存在（Node 无 fs.promises.exists，用 access 容错）
 */
async function pathExists(p) {
  try {
    await fs.promises.access(p)
    return true
  } catch {
    return false
  }
}

let printService = null;

function setPrintService(service) {
  printService = service;
}

/**
 * 处理直接打印请求
 * @param {string} filePath - 源文件路径
 * @param {Object} settings - 打印设置
 * @returns {Promise<Object>}
 */
async function handle(filePath, settings) {
  console.log('[DirectPrintHandler] handle() called with:', filePath);

  if (!filePath) {
    return { success: false, error: 'filePath is required' };
  }

  if (!isValidDirectPrintFile(filePath)) {
    return { success: false, error: `Unsupported file type. Supported: ${DIRECT_PRINT_EXTENSIONS.join(', ')}` };
  }

  if (!(await pathExists(filePath))) {
    return { success: false, error: `File not found: ${filePath}` };
  }

  if (!printService) {
    return { success: false, error: 'PrintService not initialized' };
  }

  const jobId = generateJobId();
  // 统一到 temp-manager 受管根目录（TEMP_DIR），纳入其孤儿/定时/启动清理，
  // 避免崩溃时 os.tmpdir() 下的临时目录永久泄漏。调用方仍由各路径自己的清理逻辑负责。
  const tempDir = path.join(TEMP_DIR, `print_direct_${jobId}`);

  try {
    await fs.promises.mkdir(tempDir, { recursive: true })
    console.log(`[DirectPrintHandler] Created temp dir: ${tempDir}`)
  } catch (err) {
    return { success: false, error: `Failed to create temp dir: ${err.message}` }
  }

  const ext = path.extname(filePath)
  const destPath = path.join(tempDir, `original${ext}`)

  // ========== [DEBUG] 链路追踪 ==========
  console.log(`[DEBUG-DPH] settings.landscape: ${settings?.landscape}`)
  console.log(`[DEBUG-DPH] Source PDF: ${filePath}`)
  console.log(`[DEBUG-DPH] Dest PDF: ${destPath}`);

  try {
    await fs.promises.copyFile(filePath, destPath);
    console.log(`[DirectPrintHandler] Copied file to: ${destPath}`);
    await fs.promises.chmod(destPath, 0o444);
  } catch (err) {
    try { await fs.promises.rm(tempDir, { recursive: true, force: true }); } catch (e) {}
    return { success: false, error: `Failed to copy file: ${err.message}` };
  }

  const printJob = {
    id: jobId,
    type: 'direct',
    sourcePath: destPath,
    tempDir,
    printerName: settings?.printerName || '',
    copies: settings?.copies || 1,
    paperSize: settings?.paperSize || 'A4',
    paperkind: settings?.paperkind != null ? settings.paperkind : undefined,
    orientation: settings?.landscape ? 'landscape' : 'portrait',
    grayscale: settings?.grayscale || false,
    scaleFactor: settings?.scaleFactor || 100,
    collate: settings?.collate || true,
    customPaper: settings?.customPaper || null,
  };

  // ========== [DEBUG] 链路追踪 ==========
  console.log(`[DEBUG-DPH] job.orientation: ${printJob.orientation}`)
  console.log(`[DEBUG-DPH] job.paperSize: ${printJob.paperSize}`)
  console.log(`[DEBUG-DPH] job.paperkind: ${printJob.paperkind}`)

  try {
    const result = await printService.submitDirect(printJob);
    if (result.success) {
      return { success: true, jobId };
    } else {
      try { await fs.promises.rm(tempDir, { recursive: true, force: true }); } catch (e) {}
      return { success: false, error: result.error };
    }
  } catch (err) {
    try { await fs.promises.rm(tempDir, { recursive: true, force: true }); } catch (e) {}
    return { success: false, error: err.message };
  }
}

module.exports = {
  DirectPrintHandler: {
    handle,
  },
  isValidDirectPrintFile,
  setPrintService,
};
