'use strict'
// DATA-PATH-2 DP-2E-2 单测：migrateLegacyBusinessData 迁移引擎
// 覆盖：copy / skip / 幂等（retry no-op）/ 单文件失败不中断 / 白名单（blob_storage 排除）
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const MOD = 'E:\\print706\\electron\\shared\\migrate-legacy-data.js'

function fresh() {
  delete require.cache[require.resolve(MOD)]
  return require(MOD)
}

function setup(legacyFiles = {}) {
  const base = path.join(os.tmpdir(), 'fg-dp2e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7))
  const legacy = path.join(base, 'legacy')
  const data = path.join(base, 'data')
  fs.mkdirSync(path.join(legacy, 'paper-registry'), { recursive: true })
  fs.mkdirSync(path.join(legacy, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(legacy, 'blob_storage'), { recursive: true }) // 不应迁移
  for (const [rel, content] of Object.entries(legacyFiles)) {
    const p = path.join(legacy, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  return { base, legacy, data }
}

test('copy：白名单文件/目录复制到目标，blob_storage 排除，源保留', () => {
  const m = fresh()
  const { base, legacy, data } = setup({
    'invoices.oplog': 'oplog-data',
    'Settings.json': '{"theme":"dark"}',
    'paper-registry/user-papers.json': '{"papers":[]}',
    'logs/app-2026-08-27.log': 'log-line',
    'blob_storage/b11db031/xxxx': 'chromium-blob', // 必须排除
  })
  const r = m.migrateLegacyBusinessData(legacy, data)
  assert.strictEqual(r.completed, true)
  assert.ok(r.migrated.includes('invoices.oplog'))
  assert.ok(r.migrated.includes('Settings.json'))
  assert.ok(r.migrated.includes('paper-registry/'))
  assert.ok(r.migrated.includes('logs/'))
  // blob_storage 不迁移
  assert.ok(!r.migrated.some(x => x.includes('blob_storage')))
  assert.strictEqual(fs.existsSync(path.join(data, 'blob_storage')), false)
  // 内容正确
  assert.strictEqual(fs.readFileSync(path.join(data, 'invoices.oplog'), 'utf8'), 'oplog-data')
  // 源保留（copy 非 move）
  assert.strictEqual(fs.readFileSync(path.join(legacy, 'invoices.oplog'), 'utf8'), 'oplog-data')
  // migration.log 已写
  const log = fs.readFileSync(path.join(data, '.migration.log'), 'utf8')
  assert.ok(log.includes('source:'))
  assert.ok(log.includes('[OK] invoices.oplog'))
  fs.rmSync(base, { recursive: true, force: true })
})

test('skip：目标已存在 → 不覆盖，新数据优先', () => {
  const m = fresh()
  const { base, legacy, data } = setup({ 'invoices.oplog': 'old-data' })
  fs.mkdirSync(data, { recursive: true })
  fs.writeFileSync(path.join(data, 'invoices.oplog'), 'NEW-DATA') // 新版已产生数据
  const r = m.migrateLegacyBusinessData(legacy, data)
  assert.ok(r.skipped.includes('invoices.oplog'))
  // 目标未被旧数据覆盖
  assert.strictEqual(fs.readFileSync(path.join(data, 'invoices.oplog'), 'utf8'), 'NEW-DATA')
  fs.rmSync(base, { recursive: true, force: true })
})

test('幂等：第二次启动全 skip（no-op 不重复追加）', () => {
  const m = fresh()
  const { base, legacy, data } = setup({ 'invoices.oplog': 'data-1' })
  const r1 = m.migrateLegacyBusinessData(legacy, data)
  assert.ok(r1.migrated.includes('invoices.oplog'))
  // 第二次
  const r2 = m.migrateLegacyBusinessData(legacy, data)
  assert.strictEqual(r2.migrated.length, 0)
  assert.ok(r2.skipped.includes('invoices.oplog'))
  // 不重复追加 migration.log（append 但 skip 行；内容检查）
  const log = fs.readFileSync(path.join(data, '.migration.log'), 'utf8')
  assert.strictEqual(log.match(/\[OK\] invoices.oplog/g).length, 1)
  fs.rmSync(base, { recursive: true, force: true })
})

test('失败容错：单文件失败不中断，其他照常迁移，completed=true', () => {
  const m = fresh()
  const { base, legacy, data } = setup({ 'invoices.oplog': 'ok', 'Settings.json': 'cfg' })
  // 注入 fsImpl：Settings.json 的 copyFileSync 抛错
  const realFs = require('fs')
  const fsImpl = Object.create(realFs)
  fsImpl.copyFileSync = (s, d) => {
    if (s.includes('Settings.json')) { const e = new Error('EACCES: access denied'); e.code = 'EACCES'; throw e }
    return realFs.copyFileSync(s, d)
  }
  const r = m.migrateLegacyBusinessData(legacy, data, { fsImpl })
  assert.strictEqual(r.completed, true)
  assert.ok(r.migrated.includes('invoices.oplog'))
  assert.ok(r.failed.some(f => f.item === 'Settings.json'))
  assert.ok(r.failed[0].error.includes('EACCES'))
  const log = fs.readFileSync(path.join(data, '.migration.log'), 'utf8')
  assert.ok(log.includes('migration completed with errors'))
  fs.rmSync(base, { recursive: true, force: true })
})

test('边界：旧根不存在 / 同路径 → no-op', () => {
  const m = fresh()
  const { base, legacy, data } = setup({ 'invoices.oplog': 'x' })
  // 旧根不存在
  const r1 = m.migrateLegacyBusinessData(path.join(base, 'nope'), data)
  assert.strictEqual(r1.migrated.length, 0)
  assert.strictEqual(r1.completed, false)
  // 同路径
  const r2 = m.migrateLegacyBusinessData(data, data)
  assert.strictEqual(r2.migrated.length, 0)
  fs.rmSync(base, { recursive: true, force: true })
})
