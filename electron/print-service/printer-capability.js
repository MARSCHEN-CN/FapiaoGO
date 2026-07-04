/**
 * printer-capability.js — 打印机能力查询服务
 *
 * 架构定位：
 *   Paper Registry（预设物理尺寸）
 *       │
 *       ▼
 *   PrinterCapabilityService（新增 — 查询真实打印机能力）
 *       │
 *       ▼
 *   Capability Cache（内存 + 磁盘）
 *       │
 *       ▼
 *   UI Layer（registry + capability overlay）
 *
 * 数据源：
 *   1. SumatraPDF -list-printers（primary — 与 print-settings 对齐）
 *   2. Windows DeviceCapabilities（supplement — 补全遗漏纸张）
 *
 * 设计原则：
 *   - paperkind 不是唯一真理，是"优先 hint"
 *   - sources 数组保留每张纸的来源追溯能力
 *   - 3 层 dedupe key：paperkind+尺寸 → 尺寸 → name
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { PaperRegistryProvider } = require('../shared/PaperRegistryProvider');

// ─── SumatraPDF 路径查找（复用 print-backend 逻辑） ──────────────

function getSumatraPath() {
  if (process.env.SUMATRA_PDF_PATH) {
    return process.env.SUMATRA_PDF_PATH;
  }

  const bundledPath = path.join(__dirname, '../../resources/sumatra/SumatraPDF.exe');
  try {
    if (fs.existsSync(bundledPath)) return bundledPath;
  } catch (e) { /* ignore */ }

  const candidates = [
    'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
    'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',
    path.join(process.env.LOCALAPPDATA || '', 'SumatraPDF', 'SumatraPDF.exe'),
    path.join(process.env.PROGRAMFILES || '', 'SumatraPDF', 'SumatraPDF.exe'),
  ];

  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (e) { /* ignore */ }
  }

  return 'sumatraPDF.exe';
}

// ─── 日志辅助 ──────────────────────────────────────────────────────

function log(...args) {
  console.log(`[PrinterCapability]`, ...args);
}

// ══════════════════════════════════════════════════════════════════
// Step 1: _querySumatra
// ══════════════════════════════════════════════════════════════════

/**
 * 一次性调用 SumatraPDF -list-printers，解析输出中所有打印机的纸张和纸盒信息。
 *
 * Sumatra -list-printers 输出格式:
 *   <PrinterName>:
 *     Paper sizes:
 *       <Name>: <w> x <h> mm (paperkind=<id>)
 *     Trays:
 *       <TrayName> (bin=<id>)
 *
 * 该函数一次拉取所有打印机数据，返回 Map<printerName, PaperKind[]>，
 * 调用方按需取对应打印机即可，避免重复调用 -list-printers。
 *
 * @returns {Promise<Map<string, PaperKind[]>>} 所有打印机 → 纸张列表
 */
async function _querySumatraAll() {
  const sumatraPath = getSumatraPath();
  const TIMEOUT_MS = 30000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let fullOutput = '';
    let errOutput = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // 超时后也能试一下已有的输出
      if (fullOutput.length > 0) {
        try {
          const all = _parseSumatraAllPrinters(fullOutput);
          if (all.size > 0) {
            log('Sumatra timeout fallback: parsed %d printers', all.size);
            resolve(all);
            return;
          }
        } catch (e) { /* fall through */ }
      }
      reject(new Error(`Sumatra -list-printers timed out after ${TIMEOUT_MS}ms, output=${fullOutput.length} bytes, err=${errOutput.length} bytes`));
    }, TIMEOUT_MS);

    // 用 exec 替代 spawn —— Windows 下 pipe 缓冲经常出问题
    const child = exec(`"${sumatraPath}" -list-printers`, {
      maxBuffer: 10 * 1024 * 1024,  // 10MB，足够容纳所有打印机信息
      windowsHide: true,
      timeout: TIMEOUT_MS,
    }, (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // 优先使用 stdout
      const output = (stdout || '') + (stderr || '');
      if (output.length > 0) {
        try {
          const all = _parseSumatraAllPrinters(output);
          if (all.size > 0) {
            log('Sumatra returned %d printers', all.size);
            resolve(all);
            return;
          }
        } catch (e) {
          log('Sumatra parse error:', e.message);
          reject(e);
          return;
        }
      }

      reject(new Error(err ? err.message : 'No printer data from Sumatra'));
    });

    // 同时流式收集输出（exec 回调可能只在进程退出时触发，超时 fallback 需要数据）
    child.stdout && child.stdout.on('data', (data) => { fullOutput += data.toString(); });
    child.stderr && child.stderr.on('data', (data) => { errOutput += data.toString(); });
  });
}

/**
 * 解析 Sumatra -list-printers 完整输出，提取所有打印机的纸张列表。
 *
 * @param {string} stdout - Sumatra -list-printers 的完整输出
 * @returns {Map<string, PaperKind[]>} 打印机名 → 纸张列表
 */
function _parseSumatraAllPrinters(stdout) {
  const result = new Map();
  const lines = stdout.split('\n');

  let currentPrinter = null;
  let inPaperSizes = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // 检测打印机段落开头: "Printer Name:" 或 "Printer Name (comment):"
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
      const match = line.match(/^(.+?)(?:\s+\([^)]*\))?:\s*$/);
      if (match) {
        currentPrinter = match[1].trim();
        result.set(currentPrinter, []);
        inPaperSizes = false;
      }
      continue;
    }

    if (!currentPrinter) continue;

    // 进入 Paper sizes 段落
    if (line.trim().startsWith('Paper sizes')) {
      inPaperSizes = true;
      continue;
    }

    // 进入 Trays 段落（结束 Paper sizes）
    if (line.trim().startsWith('Trays')) {
      inPaperSizes = false;
      continue;
    }

    // 解析纸张条目: "  A4: 210 x 297 mm (paperkind=9)"
    if (inPaperSizes) {
      const paperMatch = line.trim().match(
        /^(.+?):\s+([\d.]+)\s*x\s*([\d.]+)\s*mm(?:\s+\(paperkind=(\d+)\))?/
      );
      if (paperMatch) {
        const name = paperMatch[1].trim();
        const widthMM = parseFloat(paperMatch[2]);
        const heightMM = parseFloat(paperMatch[3]);
        const paperkind = paperMatch[4] ? parseInt(paperMatch[4], 10) : undefined;

        result.get(currentPrinter).push({
          name,
          paperkind,
          widthMM,
          heightMM,
          sources: ['sumatra'],
          raw: { sumatra: line.trim() },
        });
      }
    }
  }

  return result;
}

/**
 * 解析 Sumatra -list-printers 标准输出，提取指定打印机的纸张列表。
 *
 * @param {string} stdout - Sumatra -list-printers 的完整输出
 * @param {string} targetPrinter - 目标打印机名称
 * @returns {PaperKind[]}
 */
function _parseSumatraOutput(stdout, targetPrinter) {
  const papers = [];
  const lines = stdout.split('\n');

  let inTargetPrinter = false;
  let inPaperSizes = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // 检测打印机段落开头: "Printer Name:" 或 "Printer Name (comment):"
    if (!inTargetPrinter) {
      const match = line.match(/^(.+?)(?:\s+\([^)]*\))?:\s*$/);
      if (match) {
        const name = match[1].trim();
        inTargetPrinter = (name === targetPrinter);
        inPaperSizes = false;
      }
      continue;
    }

    // 离开当前打印机段落（遇到下一个顶格的行）
    if (inTargetPrinter && line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (!line.includes('Paper sizes') && !line.includes('Trays')) {
        break;
      }
    }

    // 进入 Paper sizes 段落
    if (line.trim().startsWith('Paper sizes')) {
      inPaperSizes = true;
      continue;
    }

    // 进入 Trays 段落（结束 Paper sizes）
    if (line.trim().startsWith('Trays')) {
      inPaperSizes = false;
      continue;
    }

    // 解析纸张条目: "  A4: 210 x 297 mm (paperkind=9)"
    if (inPaperSizes) {
      const paperMatch = line.trim().match(
        /^(.+?):\s+([\d.]+)\s*x\s*([\d.]+)\s*mm(?:\s+\(paperkind=(\d+)\))?/
      );
      if (paperMatch) {
        const name = paperMatch[1].trim();
        const widthMM = parseFloat(paperMatch[2]);
        const heightMM = parseFloat(paperMatch[3]);
        const paperkind = paperMatch[4] ? parseInt(paperMatch[4], 10) : undefined;

        papers.push({
          name,
          paperkind,
          widthMM,
          heightMM,
          sources: ['sumatra'],
          raw: { sumatra: line.trim() },
        });
      }
    }
  }

  return papers;
}

// ══════════════════════════════════════════════════════════════════
// 全局 Sumatra 查询缓存（一次 -list-printers 拿所有打印机）
// ══════════════════════════════════════════════════════════════════

let _sumatraAllPromise = null;  // Promise<Map<printerName, PaperKind[]>>，防止并发重复查询

/**
 * 获取所有打印机的纸张能力（一次性查询，全局缓存）。
 * 并发调用时复用同一个 Promise，避免重复 spawn Sumatra。
 *
 * @returns {Promise<Map<string, PaperKind[]>>}
 */
async function _getAllPrintersFromSumatra() {
  if (_sumatraAllPromise) {
    log('Reusing in-flight Sumatra -list-printers query');
    return _sumatraAllPromise;
  }

  _sumatraAllPromise = _querySumatraAll().finally(() => {
    // 查询完成后清除 promise 引用（失败也不缓存，下次重试）
    _sumatraAllPromise = null;
  });

  return _sumatraAllPromise;
}

/**
 * 查询 Windows 打印机支持的纸张。
 * Phase 1 轻量实现：通过内置预设 + 常见纸张补全。
 * 至少返回 A4/A5/A6/B5/Letter 基本集，保证能参与 merge。
 *
 * 后续可以升级为 DeviceCapabilities Win32 API 调用。
 *
 * @param {string} printerName - 打印机名称
 * @returns {Promise<PaperKind[]>} 纸张列表（查询失败时返回空数组，不注入假数据）
 */
async function _queryWindows(printerName) {
  // Phase 1：暂不接入 Windows 查询，返回空数组
  // 后续可接入 PowerShell Get-PrintCapability 或 Sumatra -list-printers 作为增强
  log('Windows query not yet implemented, returning empty for "%s"', printerName);
  return [];
}

// ══════════════════════════════════════════════════════════════════
// Step 2: _mergeCapabilities — 核心去重合并
// ══════════════════════════════════════════════════════════════════

/**
 * 去重 key 生成（3 层降级）
 *
 * 第 1 层（最稳）: paperkind + widthMM + heightMM
 * 第 2 层（fallback）: widthMM + heightMM
 * 第 3 层（兜底）: name
 */
function _dedupeKey(paper) {
  // 第 1 层：paperkind + 尺寸
  if (paper.paperkind != null && paper.widthMM != null && paper.heightMM != null) {
    return `k:${paper.paperkind}|${paper.widthMM}x${paper.heightMM}`;
  }
  // 第 2 层：尺寸
  if (paper.widthMM != null && paper.heightMM != null) {
    return `s:${paper.widthMM}x${paper.heightMM}`;
  }
  // 第 3 层：名称
  return `n:${paper.name}`;
}

/**
 * 合并来自 Sumatra 和 Windows 的纸张列表。
 *
 * 合并策略：
 *   1. 先用第 1 层 key 合并（paperkind+尺寸）
 *   2. 未匹配的继续用第 2 层 key（尺寸）
 *   3. 仍未匹配的用第 3 层 key（名称）
 *   4. 匹配到的条目合并 sources 数组，保留双方 raw
 *   5. 未匹配的各自追加
 *
 * @param {PaperKind[]} sumatraPapers
 * @param {PaperKind[]} windowsPapers
 * @returns {PaperKind[]} 合并后的去重列表
 */
function _mergeCapabilities(sumatraPapers, windowsPapers) {
  const merged = new Map(); // dedupeKey → PaperKind

  // 先插入 Sumatra 的条目
  for (const p of sumatraPapers) {
    const key = _dedupeKey(p);
    merged.set(key, { ...p, sources: [...p.sources], raw: { ...p.raw } });
  }

  // 再合并 Windows 的条目
  for (const wp of windowsPapers) {
    // 尝试 3 层 key 逐级匹配
    let matched = false;

    for (const keyFn of [
      (p) => _dedupeKey(p),                                           // 第 1 层
      (p) => (p.widthMM != null ? `s:${p.widthMM}x${p.heightMM}` : null), // 第 2 层
      (p) => `n:${p.name}`,                                           // 第 3 层
    ]) {
      const key = keyFn(wp);
      if (!key) continue;

      const existing = merged.get(key);
      if (existing) {
        // 合并不在 existing.sources 中的来源
        for (const src of wp.sources) {
          if (!existing.sources.includes(src)) {
            existing.sources.push(src);
          }
        }
        // 合并 raw
        Object.assign(existing.raw, wp.raw);
        // 如果 Windows 有 paperkind 而 Sumatra 没有，补上
        if (wp.paperkind != null && existing.paperkind == null) {
          existing.paperkind = wp.paperkind;
        }
        matched = true;
        break;
      }
    }

    if (!matched) {
      // 未匹配：作为独立条目追加
      const key = _dedupeKey(wp);
      merged.set(key, { ...wp, sources: [...wp.sources], raw: { ...wp.raw } });
    }
  }

  return Array.from(merged.values());
}

// ══════════════════════════════════════════════════════════════════
// Step 4: 缓存（memory → disk）
// ══════════════════════════════════════════════════════════════════

const MEMORY_CACHE_TTL_MS = 30 * 60 * 1000;  // 30 分钟
const DISK_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 天
const MAX_MEMORY_ENTRIES = 10;

// 内存缓存: printerName → { data, expiresAt }
const _memoryCache = new Map();
const _memoryAccessOrder = [];  // LRU 追踪

function _getCacheDir() {
  // 优先用 app.getPath('userData')，但这里可能没有 Electron 上下文
  // fallback 到项目目录下的 printer-cache 文件夹
  const userDataDir = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'marsprint')
    : path.join(__dirname, '../../printer-cache');
  const cacheDir = path.join(userDataDir, 'printer-cache');
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch (e) { /* ignore */ }
  return cacheDir;
}

function _getCacheFilePath(printerName) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(printerName).digest('hex');
  return path.join(_getCacheDir(), `${hash}.json`);
}

function _checkMemoryCache(printerName) {
  const entry = _memoryCache.get(printerName);
  if (!entry) return null;

  // 惰性过期
  if (Date.now() > entry.expiresAt) {
    _memoryCache.delete(printerName);
    const idx = _memoryAccessOrder.indexOf(printerName);
    if (idx > -1) _memoryAccessOrder.splice(idx, 1);
    return null;
  }

  // 更新 LRU 顺序
  const idx = _memoryAccessOrder.indexOf(printerName);
  if (idx > -1) {
    _memoryAccessOrder.splice(idx, 1);
    _memoryAccessOrder.push(printerName);
  }

  return entry.data;
}

function _setMemoryCache(printerName, data) {
  // LRU 淘汰
  if (_memoryCache.size >= MAX_MEMORY_ENTRIES && !_memoryCache.has(printerName)) {
    const oldest = _memoryAccessOrder.shift();
    if (oldest) _memoryCache.delete(oldest);
  }

  _memoryCache.set(printerName, {
    data,
    expiresAt: Date.now() + MEMORY_CACHE_TTL_MS,
  });

  // 更新 LRU 顺序
  const idx = _memoryAccessOrder.indexOf(printerName);
  if (idx > -1) _memoryAccessOrder.splice(idx, 1);
  _memoryAccessOrder.push(printerName);
}

async function _loadDiskCache(printerName) {
  const filePath = _getCacheFilePath(printerName);
  try {
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry = JSON.parse(raw);

    // 检查 TTL
    const age = Date.now() - new Date(entry.fetchedAt).getTime();
    if (age > DISK_CACHE_TTL_MS) {
      log('Disk cache expired for "%s" (age=%.1fd)', printerName, age / 86400000);
      fs.unlinkSync(filePath);
      return null;
    }

    log('Disk cache hit for "%s" (age=%.1fd)', printerName, age / 86400000);
    return entry.capabilities;
  } catch (e) {
    log('Disk cache read failed for "%s": %s', printerName, e.message);
    return null;
  }
}

async function _saveDiskCache(printerName, capabilities) {
  const filePath = _getCacheFilePath(printerName);
  const entry = {
    printerName,
    fetchedAt: new Date().toISOString(),
    capabilities,
  };

  // 原子写入：写临时文件 → rename
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
    log('Disk cache saved for "%s"', printerName);
  } catch (e) {
    log('Disk cache write failed for "%s": %s', printerName, e.message);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e2) { /* ignore */ }
  }
}

// ══════════════════════════════════════════════════════════════════
// PrinterCapabilityService
// ══════════════════════════════════════════════════════════════════

class PrinterCapabilityService {
  constructor() {
    this._initialized = false;
  }

  static getInstance() {
    if (!PrinterCapabilityService._instance) {
      PrinterCapabilityService._instance = new PrinterCapabilityService();
    }
    return PrinterCapabilityService._instance;
  }

  /**
   * 获取打印机的完整纸张能力列表。
   *
   * 查询链路：
   *   1. 内存缓存 → 命中直接返回
   *   2. 磁盘缓存 → 加载到内存后返回
   *   3. Sumatra CLI 查询
   *   4. Windows 轻量查询
   *   5. merge 去重
   *   6. 写缓存 → 返回
   *
   * @param {string} printerName - 打印机名称
   * @returns {Promise<object>} CapabilityResponse
   */
  async getCapabilities(printerName) {
    if (!printerName || typeof printerName !== 'string') {
      throw new Error('printerName is required');
    }

    // 1. 内存缓存
    const memCached = _checkMemoryCache(printerName);
    if (memCached) {
      log('Memory cache hit for "%s"', printerName);
      return memCached;
    }

    // 2. 磁盘缓存
    const diskCached = await _loadDiskCache(printerName);
    if (diskCached) {
      _setMemoryCache(printerName, diskCached);
      return diskCached;
    }

    // 3. 查询 Sumatra（一次拉取所有打印机，从结果中取本打印机）
    let sumatraPapers = [];
    try {
      const allPrinters = await _getAllPrintersFromSumatra();
      sumatraPapers = allPrinters.get(printerName) || [];
      log('Sumatra returned %d paper types for "%s" (from global query of %d printers)',
          sumatraPapers.length, printerName, allPrinters.size);
    } catch (e) {
      log('Sumatra query failed for "%s": %s', printerName, e.message);
    }

    // 4. 查询 Windows（轻量，永不抛异常）
    let windowsPapers = [];
    try {
      windowsPapers = await _queryWindows(printerName);
    } catch (e) {
      log('Windows query failed for "%s": %s', printerName, e.message);
    }

    // 5. 合并去重
    const papers = _mergeCapabilities(sumatraPapers, windowsPapers);

    // 确定实际使用的数据源
    const querySources = [];
    if (sumatraPapers.length > 0) querySources.push('sumatra');
    if (windowsPapers.length > 0) querySources.push('windows');

    const capabilities = {
      printerName,
      papers,
      querySources,
      fetchedAt: new Date().toISOString(),
    };

    // 6. 写缓存
    _setMemoryCache(printerName, capabilities);
    await _saveDiskCache(printerName, capabilities);

    log('Capabilities resolved for "%s": %d papers from [%s]',
        printerName, papers.length, querySources.join(','));

    return capabilities;
  }
}

// ══════════════════════════════════════════════════════════════════
// Step 2: Capability 自动映射
// ══════════════════════════════════════════════════════════════════

/**
 * 调试开关（环境变量 PRINT_DEBUG_CAPABILITY=true 开启）
 * 关闭时零影响。
 */
const _DEBUG = () => process.env.PRINT_DEBUG_CAPABILITY === 'true';

/**
 * 从缓存的 Capability 中为 settings 自动补齐 paperkind。
 *
 * 规则：
 *   - 仅当 settings 有 paper 但无 paperkind 时尝试补齐
 *   - 仅从缓存读取（不触发 Sumatra 查询）
 *   - 缓存不存在时不抛异常，静默跳过
 *
 * @param {object} settings - PrintSettings（会被修改）
 * @param {string} printerName - 打印机名称
 */
function enhanceWithCapability(settings, printerName) {
  if (!settings || !printerName || settings.paperkind != null) return;

  const paperName = settings.paper;
  if (!paperName || paperName === 'Custom') return;

  const startTime = _DEBUG() ? Date.now() : 0;

  // 仅检查内存缓存和磁盘缓存（不触发 Sumatra 查询）
  let capabilities = _checkMemoryCache(printerName);
  if (!capabilities) {
    // 同步读取磁盘缓存（不 await，因为打印链路不能阻塞）
    try {
      const filePath = _getCacheFilePath(printerName);
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const entry = JSON.parse(raw);
        if (entry.capabilities) {
          capabilities = entry.capabilities;
          // 加载到内存缓存
          _setMemoryCache(printerName, capabilities);
        }
      }
    } catch (e) {
      // 缓存不可用时不阻塞打印
    }
  }

  if (!capabilities || !capabilities.papers) return;

  // 第 1 层：名称精确匹配（最快路径）
  const paperLower = paperName.toLowerCase();
  let match = capabilities.papers.find(p =>
    p.name && p.name.toLowerCase() === paperLower && p.paperkind != null
  );

  // 第 2 层：尺寸匹配（名称不匹配时，按宽高找）
  if (!match) {
    const paperMap = PaperRegistryProvider.getEffectivePaperMap();
    const dims = paperMap[paperName];
    if (dims && dims.widthMM > 0 && dims.heightMM > 0) {
      const w = dims.widthMM, h = dims.heightMM;
      match = capabilities.papers.find(p =>
        p.paperkind != null &&
        p.widthMM != null && p.heightMM != null &&
        Math.abs(p.widthMM - w) < 1 && Math.abs(p.heightMM - h) < 1
      );
      if (match && _DEBUG()) {
        console.log(`[Capability-Debug] ${paperName} matched by size: ${w}x${h} → paperkind=${match.paperkind} (printer name: ${match.name})`);
      }
    }
  }

  if (match) {
    settings.paperkind = match.paperkind;
    if (_DEBUG()) {
      const elapsed = Date.now() - startTime;
      console.log(`[Capability-Debug] Printer: ${printerName}`);
      console.log(`[Capability-Debug] Paper: ${paperName} → paperkind=${match.paperkind}`);
      console.log(`[Capability-Debug] Elapsed: ${elapsed}ms`);
    }
  }
}

/**
 * 打印当前 settings 生成的完整 -print-settings 字符串（调试用）
 */
function _debugPrintSettings(settings, printerName) {
  if (!_DEBUG()) return;
  const { buildPrintSettings } = require('./print-settings');
  const result = buildPrintSettings(settings);
  console.log('[Capability-Debug] Generated print-settings:', result);
}

module.exports = {
  PrinterCapabilityService,
  _querySumatraAll, _queryWindows,
  _mergeCapabilities, _parseSumatraAllPrinters,
  enhanceWithCapability,
};
