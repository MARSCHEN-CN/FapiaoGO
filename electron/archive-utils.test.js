'use strict'

/**
 * createZipArchive 回归测试（2026-08-17 修复）
 *
 * 背景：createZipArchive 的完成判定曾用 AND 双事件（archive.on('finalize') + output.on('close')），
 * 但 archiver 8.0.0 从不发射 'finalize' 事件（core.js 无 emit('finalize')，官方改为
 * finalize() 返回 Promise，由 zip-stream 'end' 驱动）→ Promise 永不 resolve →
 * 主进程 await 挂起 → 前端进度条永远卡在 67%。
 *
 * 本测试核心断言：**createZipArchive() 的 Promise 必须 settle（resolve 或 reject），绝不挂死**。
 * 每个用例通过 node:test 的 timeout 兜底：若 Promise 不 settle，测试直接超时失败。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

// ── electron mock ─────────────────────────────────────────────
// archive-utils.js → temp-manager.js 顶层 require('electron').app.getPath('temp')，
// 纯 Node 下 electron 包不提供 app，注入 mock 到 require.cache（与测试文件解析路径一致）。
const electronEntry = require.resolve('electron')
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: {
    app: { getPath: (name) => (name === 'temp' ? os.tmpdir() : '') },
  },
}

const { createZipArchive } = require('./archive-utils')

// ── 工具 ──────────────────────────────────────────────────────
let tmpRoot
function makeTmp() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archiver_reg_'))
  return tmpRoot
}

function cleanup() {
  if (tmpRoot) {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}

function writeFile(name, size) {
  const p = path.join(tmpRoot, name)
  fs.writeFileSync(p, Buffer.alloc(size, 1))
  return p
}

/** 解析 zip EOCD 中的中央目录条目总数（archiver forceZip64:false 时有效） */
function countZipEntries(filePath) {
  const buf = fs.readFileSync(filePath)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  assert.ok(eocd >= 0, `zip 缺少 EOCD 记录: ${filePath}`)
  return buf.readUInt16LE(eocd + 10)
}

// ── 用例 ──────────────────────────────────────────────────────

test('Case 1: 1 个文件 ZIP — 正常完成（Promise settle + 1 entry）', { timeout: 8000 }, async () => {
  const dir = makeTmp()
  try {
    const f1 = writeFile('a.pdf', 1024 * 1024)
    const out = path.join(dir, 'out1.zip')
    const info = await createZipArchive([{ originalPath: f1, targetName: 'a.pdf' }], out)
    assert.ok(fs.existsSync(out), 'zip 应已生成')
    assert.equal(countZipEntries(out), 1)
    assert.ok(Array.isArray(info.collisions))
  } finally { cleanup() }
})

test('Case 2: 2 个文件 ZIP — 不再卡 67%，正常 100%（核心回归）', { timeout: 8000 }, async () => {
  const dir = makeTmp()
  try {
    const f1 = writeFile('a.pdf', 1024 * 1024)
    const f2 = writeFile('b.pdf', 1024 * 1024)
    const out = path.join(dir, 'out2.zip')
    // 修复前此处永远挂起（archive 'finalize' 事件不存在）；timeout 8s 兜底失败
    const info = await createZipArchive([
      { originalPath: f1, targetName: 'a.pdf' },
      { originalPath: f2, targetName: 'b.pdf' },
    ], out)
    assert.ok(fs.existsSync(out), 'zip 应已生成')
    assert.equal(countZipEntries(out), 2)
    assert.ok(Array.isArray(info.collisions))
  } finally { cleanup() }
})

test('Case 3: 多文件（5 个）ZIP — 正常完成', { timeout: 8000 }, async () => {
  const dir = makeTmp()
  try {
    const files = Array.from({ length: 5 }, (_, i) => ({
      originalPath: writeFile(`f${i}.pdf`, 512 * 1024),
      targetName: `f${i}.pdf`,
    }))
    const out = path.join(dir, 'out5.zip')
    const info = await createZipArchive(files, out)
    assert.ok(fs.existsSync(out))
    assert.equal(countZipEntries(out), 5)
    assert.ok(Array.isArray(info.collisions))
  } finally { cleanup() }
})

test('Case 4: 输出文件已存在 — 覆盖写入，保持现有行为', { timeout: 8000 }, async () => {
  const dir = makeTmp()
  try {
    const f1 = writeFile('a.pdf', 1024 * 1024)
    const out = path.join(dir, 'out4.zip')
    fs.writeFileSync(out, 'PLACEHOLDER')  // 预置占位文件
    await createZipArchive([{ originalPath: f1, targetName: 'a.pdf' }], out)
    assert.equal(countZipEntries(out), 1, '占位文件应被新 zip 覆盖')
  } finally { cleanup() }
})

test('Case 5: 写入错误（输出目录不存在）— Promise 必须 reject，不挂死', { timeout: 8000 }, async () => {
  const dir = makeTmp()
  try {
    const f1 = writeFile('a.pdf', 1024)
    const out = path.join(dir, 'no_such_dir', 'out5.zip')
    await assert.rejects(
      createZipArchive([{ originalPath: f1, targetName: 'a.pdf' }], out),
      (err) => { assert.ok(err instanceof Error); return true },
    )
  } finally { cleanup() }
})

test('Case 6: 源文件不存在 — statSync 跳过，仍 settle（不挂死）', { timeout: 8000 }, async () => {
  const dir = makeTmp()
  try {
    const out = path.join(dir, 'out6.zip')
    const info = await createZipArchive([
      { originalPath: path.join(dir, 'missing.pdf'), targetName: 'missing.pdf' },
    ], out)
    assert.ok(fs.existsSync(out), '空 zip 也应生成')
    assert.equal(countZipEntries(out), 0)
    assert.ok(Array.isArray(info.collisions))
  } finally { cleanup() }
})

test('Case 7: 严格模式重名 — Promise reject（同步抛错被 async 包装）', { timeout: 8000 }, async () => {
  const dir = makeTmp()
  try {
    const f1 = writeFile('a.pdf', 1024)
    const f2 = writeFile('b.pdf', 1024)
    const out = path.join(dir, 'out7.zip')
    await assert.rejects(
      createZipArchive([
        { originalPath: f1, targetName: 'same.pdf' },
        { originalPath: f2, targetName: 'same.pdf' },
      ], out, { strictNames: true }),
      (err) => { assert.ok(err instanceof Error); return true },
    )
  } finally { cleanup() }
})
