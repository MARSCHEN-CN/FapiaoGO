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

// ⚠️ 契约变更（2026-09-03，f02c59d）：迁移由「逐项 skip 的幂等重试」改为「一次性迁移」。
// 第二次启动命中 legacyRoot/.migration_done → 整段短路返回，skipped 为空数组。
// 因此旧断言 `r2.skipped.includes('invoices.oplog')` 不再成立，改判 skippedByMarker。
test('一次性迁移：第二次启动命中 .migration_done 直接短路（不再逐项 skip）', () => {
  const m = fresh()
  const { base, legacy, data } = setup({ 'invoices.oplog': 'data-1' })
  const r1 = m.migrateLegacyBusinessData(legacy, data)
  assert.ok(r1.migrated.includes('invoices.oplog'))
  assert.strictEqual(r1.skippedByMarker, undefined)
  // 第二次：命中标记 → 整段跳过（skipped 为空，这是与旧"逐项 skip"契约的差异点）
  const r2 = m.migrateLegacyBusinessData(legacy, data)
  assert.strictEqual(r2.skippedByMarker, true)
  assert.strictEqual(r2.migrated.length, 0)
  assert.strictEqual(r2.skipped.length, 0)
  assert.strictEqual(r2.completed, true)
  // 短路发生在写日志之前 → 不重复追加 migration.log
  const log = fs.readFileSync(path.join(data, '.migration.log'), 'utf8')
  assert.strictEqual(log.match(/\[OK\] invoices.oplog/g).length, 1)
  fs.rmSync(base, { recursive: true, force: true })
})

test('标记落点 legacyRoot：删光 dataRoot 后重启不回拷（"数据复活"回归）', () => {
  const m = fresh()
  const { base, legacy, data } = setup({
    'invoices.oplog': 'oplog-20-entries',
    'invoice_import_history.json': '{"a":1}',
  })
  const r1 = m.migrateLegacyBusinessData(legacy, data)
  assert.ok(r1.migrated.includes('invoices.oplog'))
  // 标记必须落在 legacyRoot（用户删不到的地方），绝不能落在 dataRoot
  assert.strictEqual(fs.existsSync(path.join(legacy, '.migration_done')), true)
  assert.strictEqual(fs.existsSync(path.join(data, '.migration_done')), false)

  // 用户实测场景：删光 database/ 想重置
  fs.rmSync(data, { recursive: true, force: true })

  const r2 = m.migrateLegacyBusinessData(legacy, data)
  assert.strictEqual(r2.skippedByMarker, true)
  assert.strictEqual(r2.migrated.length, 0)
  // 关键：dataRoot 不被旧数据复活（闸门在 mkdir 之前短路 → 连目录都不应重建）
  assert.strictEqual(fs.existsSync(path.join(data, 'invoices.oplog')), false)
  assert.strictEqual(fs.existsSync(data), false)
  fs.rmSync(base, { recursive: true, force: true })
})

test('标记内容可诊断：含 ISO 时间戳与 migrated/skipped 计数', () => {
  const m = fresh()
  const { base, legacy, data } = setup({ 'invoices.oplog': 'x', 'Settings.json': '{}' })
  m.migrateLegacyBusinessData(legacy, data)
  const txt = fs.readFileSync(path.join(legacy, '.migration_done'), 'utf8')
  assert.match(txt, /migrated at \d{4}-\d{2}-\d{2}T/)
  assert.match(txt, /migrated: \d+ items, skipped: \d+/)
  fs.rmSync(base, { recursive: true, force: true })
})

// ⚠️ 冻结规则 #1「copy 不 move —— 迁移失败可重跑」 vs #4「一次性迁移」的冲突点：
// 标记必须**只在全成功时**写，否则部分失败项会被永久跳过（源数据还在 AppData，
// 能手工捞回，但不会再自动重试，且失败静默）。
test('部分失败不落标记：失败项下次启动可重试补迁（冻结规则 #1）', () => {
  const m = fresh()
  const { base, legacy, data } = setup({ 'invoices.oplog': 'ok', 'Settings.json': 'cfg' })
  const realFs = require('fs')
  const fsImpl = Object.create(realFs)
  fsImpl.copyFileSync = (s, d) => {
    if (s.includes('Settings.json')) { const e = new Error('EACCES: access denied'); e.code = 'EACCES'; throw e }
    return realFs.copyFileSync(s, d)
  }
  const r1 = m.migrateLegacyBusinessData(legacy, data, { fsImpl })
  assert.strictEqual(r1.completed, true)
  assert.ok(r1.failed.some(f => f.item === 'Settings.json'), 'Settings.json 应记为失败')
  // 关键：部分失败 → 不得落标记，否则该失败项今后再也不会被重试
  assert.strictEqual(fs.existsSync(path.join(legacy, '.migration_done')), false)

  // 第二次启动（故障已解除）→ 必须重试，把上次失败的 Settings.json 补迁
  const r2 = m.migrateLegacyBusinessData(legacy, data)
  assert.strictEqual(r2.skippedByMarker, undefined, '无标记 → 不得短路')
  assert.ok(r2.migrated.includes('Settings.json'), '上次失败项应被重试补迁')
  assert.strictEqual(r2.failed.length, 0)
  // 全成功 → 此时才落标记
  assert.strictEqual(fs.existsSync(path.join(legacy, '.migration_done')), true)

  // 补迁正确性：内容来自 legacy 源，且已有的 invoices.oplog 未被覆盖
  assert.strictEqual(fs.readFileSync(path.join(data, 'Settings.json'), 'utf8'), 'cfg')
  assert.strictEqual(fs.readFileSync(path.join(data, 'invoices.oplog'), 'utf8'), 'ok')
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
  assert.strictEqual(r2.completed, false)
  // no-op 不得写标记 —— 否则 dev 模式（legacy===data）会把迁移永久锁死
  assert.strictEqual(fs.existsSync(path.join(data, '.migration_done')), false)
  fs.rmSync(base, { recursive: true, force: true })
})
