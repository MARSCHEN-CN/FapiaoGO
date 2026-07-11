'use strict';

/**
 * pdf-orientation.js — PDF 方向与 MediaBox 提取（单一真相源）
 *
 * 原先 detectPdfOrientation / extractMediaBox 在 main.js、print-backend.js、
 * OsLauncherBridge.js 三处近乎重复实现，且同一 PDF 在打印流程中常被读取检测
 * 方向 2-3 次。本模块将「读取前 8KB + 正则解析」抽为单一实现，并按绝对路径
 * 缓存原始 box 数据（与调用方选项无关，避免缓存一致性问题），供同步 / 异步
 * 调用方共享，消除重复磁盘读。
 */

const fs = require('fs');
const path = require('path');

const READ_LEN = 8192;
const MEDIA_BOX_RE = /\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/;
const CROP_BOX_RE = /\/CropBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/;

// 结果缓存：绝对路径 → 原始解析数据 { mediaBox, cropBox }
// 同一 PDF 多次检测方向时直接命中缓存，避免重复 8KB 磁盘读。
// 仅缓存原始 box，方向（是否回退 CropBox、默认 portrait/null）由调用方在命中后计算，
// 因此不同契约的调用方共享同一份缓存也不会串味。
const _cache = new Map();
const MAX_CACHE = 256;

function _absKey(filePath) {
  try {
    return path.resolve(filePath);
  } catch (_) {
    return String(filePath);
  }
}

function _parseRaw(buffer, bytesRead) {
  const raw = { mediaBox: null, cropBox: null };
  const content = buffer.toString('latin1', 0, bytesRead);

  const m = content.match(MEDIA_BOX_RE);
  if (m) {
    raw.mediaBox = {
      width: parseFloat(m[3]) - parseFloat(m[1]),
      height: parseFloat(m[4]) - parseFloat(m[2]),
    };
  }

  const c = content.match(CROP_BOX_RE);
  if (c) {
    raw.cropBox = {
      width: parseFloat(c[3]) - parseFloat(c[1]),
      height: parseFloat(c[4]) - parseFloat(c[2]),
    };
  }

  return raw;
}

function _evictIfFull() {
  if (_cache.size >= MAX_CACHE) {
    // Map 保持插入序，keys().next().value 即最旧条目（FIFO 淘汰，避免无界增长）
    _cache.delete(_cache.keys().next().value);
  }
}

function _readSync(filePath) {
  const key = _absKey(filePath);
  const hit = _cache.get(key);
  if (hit) return hit;

  let raw = { mediaBox: null, cropBox: null };
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(READ_LEN);
    const { bytesRead } = fs.readSync(fd, buffer, 0, READ_LEN, 0);
    raw = _parseRaw(buffer, bytesRead);
  } catch (_) {
    // 读取失败：保持 null，由调用方决定默认方向
  } finally {
    if (fd) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }

  _evictIfFull();
  _cache.set(key, raw);
  return raw;
}

async function _readAsync(filePath) {
  const key = _absKey(filePath);
  const hit = _cache.get(key);
  if (hit) return hit;

  let raw = { mediaBox: null, cropBox: null };
  let fd;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(READ_LEN);
    const { bytesRead } = await fd.read(buffer, 0, READ_LEN, 0);
    raw = _parseRaw(buffer, bytesRead);
  } catch (_) {
    // 同上
  } finally {
    if (fd) {
      try { await fd.close(); } catch (_) { /* ignore */ }
    }
  }

  _evictIfFull();
  _cache.set(key, raw);
  return raw;
}

function _orientOf(box) {
  if (!box) return null;
  return box.width > box.height ? 'landscape' : 'portrait';
}

// ── 同步 API（供同步调用方使用）──
function extractMediaBox(filePath) {
  const raw = _readSync(filePath);
  return raw.mediaBox || raw.cropBox;
}

function detectPdfOrientation(filePath, { fallbackToCropBox = true } = {}) {
  const raw = _readSync(filePath);
  const box = raw.mediaBox || (fallbackToCropBox ? raw.cropBox : null);
  return _orientOf(box);
}

// ── 异步 API（供非阻塞调用方使用，如 main.js 的诊断日志）──
async function extractMediaBoxAsync(filePath) {
  const raw = await _readAsync(filePath);
  return raw.mediaBox || raw.cropBox;
}

async function detectPdfOrientationAsync(filePath, { fallbackToCropBox = true } = {}) {
  const raw = await _readAsync(filePath);
  const box = raw.mediaBox || (fallbackToCropBox ? raw.cropBox : null);
  return _orientOf(box);
}

function clearOrientationCache() {
  _cache.clear();
}

module.exports = {
  extractMediaBox,
  detectPdfOrientation,
  extractMediaBoxAsync,
  detectPdfOrientationAsync,
  clearOrientationCache,
};
