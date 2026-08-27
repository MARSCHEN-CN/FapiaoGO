'use strict'
// DATA-PATH-2 DP-2A 单测：data-root.js 纯路径解析 + 可写探测（4 场景）
const test = require('node:test')
const assert = require('node:assert')
const Module = require('module')
const path = require('path')

const MOD = 'E:\\print706\\electron\\shared\\data-root.js'
// dev 下 PROJECT_ROOT = electron/shared 上两级 = 项目根 E:\print706
const EXPECTED_PROJECT_ROOT = path.resolve(__dirname, '..')

function loadWith(appCfg) {
  const orig = Module._load
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return { app: appCfg }
    return orig.apply(this, arguments)
  }
  delete require.cache[require.resolve(MOD)]
  const m = require(MOD)
  Module._load = orig
  return m
}

// ---------- 场景 1：Dev ----------
test('Dev: app.isPackaged=false → APP_ROOT=项目根, DATA_ROOT=项目根/database, USERDATA_ROOT=项目根/userdata', () => {
  const m = loadWith({ isPackaged: false })
  const prevExe = process.execPath
  try {
    process.execPath = 'C:\\node_modules\\electron\\dist\\electron.exe' // dev execPath 无意义，须走项目根
    assert.strictEqual(m.getAppRoot(), EXPECTED_PROJECT_ROOT)
    assert.strictEqual(m.getDataRoot(), path.join(EXPECTED_PROJECT_ROOT, 'database'))
    assert.strictEqual(m.getUserDataRoot(), path.join(EXPECTED_PROJECT_ROOT, 'userdata'))
  } finally { process.execPath = prevExe }
})

// ---------- 场景 2：ZIP / Portable ----------
test('Portable: isPackaged=true + execPath=解压目录 → DATA_ROOT=解压目录/database', () => {
  const m = loadWith({ isPackaged: true })
  const prevExe = process.execPath
  try {
    process.execPath = 'D:\\FapiaoGO\\FapiaoGO.exe'
    assert.strictEqual(m.getAppRoot(), 'D:\\FapiaoGO')
    assert.strictEqual(m.getDataRoot(), 'D:\\FapiaoGO\\database')
    assert.strictEqual(m.getUserDataRoot(), 'D:\\FapiaoGO\\userdata')
  } finally { process.execPath = prevExe }
})

// ---------- 场景 3：Installer（用户所选安装目录） ----------
test('Installer: isPackaged=true + execPath=安装目录 → DATA_ROOT=安装目录/database（不依赖 resourcesPath）', () => {
  const m = loadWith({ isPackaged: true })
  const prevExe = process.execPath
  const prevRes = process.resourcesPath
  try {
    process.execPath = 'C:\\Users\\it01\\AppData\\Local\\Programs\\FapiaoGO\\FapiaoGO.exe'
    process.resourcesPath = undefined // 与 R4-P0-8 教训一致：不假设 resourcesPath 存在
    assert.strictEqual(m.getAppRoot(), 'C:\\Users\\it01\\AppData\\Local\\Programs\\FapiaoGO')
    assert.strictEqual(m.getDataRoot(), 'C:\\Users\\it01\\AppData\\Local\\Programs\\FapiaoGO\\database')
    assert.strictEqual(m.getUserDataRoot(), 'C:\\Users\\it01\\AppData\\Local\\Programs\\FapiaoGO\\userdata')
  } finally { process.execPath = prevExe; process.resourcesPath = prevRes }
})

// ---------- 场景 4：Read-only（不可写 → 明确失败，不静默 fallback） ----------
test('Read-only: ensureWritable 失败 → { ok:false }，ensureDataRoots 返回失败 root（无 fallback）', () => {
  const m = loadWith({ isPackaged: true })
  const prevExe = process.execPath
  try {
    process.execPath = 'D:\\FapiaoGO\\FapiaoGO.exe'
    // 模拟只读：fsImpl 全部抛 EACCES
    const roFs = {
      mkdirSync: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e },
      writeFileSync: () => { throw new Error('EACCES') },
      unlinkSync: () => {},
    }
    const r = m.ensureWritable('D:\\FapiaoGO\\database', roFs)
    assert.strictEqual(r.ok, false)
    assert.ok(r.error)

    const roots = m.ensureDataRoots(roFs)
    assert.strictEqual(roots.ok, false)
    assert.strictEqual(roots.root, 'D:\\FapiaoGO\\database')
    assert.ok(roots.error)
  } finally { process.execPath = prevExe }
})

// ---------- 场景 5（补充）：正常可写 → ok:true 且目录被创建 ----------
test('可写目录: ensureDataRoots → { ok:true, dataRoot, userDataRoot }（temp 实测创建）', () => {
  const m = loadWith({ isPackaged: true })
  const prevExe = process.execPath
  const os = require('os')
  const base = path.join(os.tmpdir(), 'fg-data-root-test-' + Date.now())
  try {
    process.execPath = path.join(base, 'FapiaoGO.exe')
    const r = m.ensureDataRoots()
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.dataRoot, path.join(base, 'database'))
    assert.strictEqual(r.userDataRoot, path.join(base, 'userdata'))
    const fs = require('fs')
    assert.ok(fs.existsSync(path.join(base, 'database')))
    assert.ok(fs.existsSync(path.join(base, 'userdata')))
    // 清理
    fs.rmSync(base, { recursive: true, force: true })
  } finally { process.execPath = prevExe }
})
