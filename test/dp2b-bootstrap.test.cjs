'use strict'
// DATA-PATH-2 DP-2B 验证：main.js Early Bootstrap 顺序 + userData 重定向运行时行为
const test = require('node:test')
const assert = require('node:assert')
const Module = require('module')
const path = require('path')
const fs = require('fs')

const MAIN = 'E:\\print706\\electron\\main.js'
const DATA_ROOT_MOD = 'E:\\print706\\electron\\shared\\data-root.js'
const EXPECTED_PROJECT_ROOT = path.resolve(__dirname, '..') // E:\print706

// ---------- 1. 静态顺序断言：setPath('userData') 必须早于一切 getPath('userData') ----------
test('main.js: app.setPath(userData) 早于所有 getPath(userData) 与 ConfigService require', () => {
  const src = fs.readFileSync(MAIN, 'utf8')
  const lines = src.split('\n')

  const setPathLine = lines.findIndex(l => l.includes("app.setPath('userData'")) + 1
  assert.ok(setPathLine > 0, 'main.js 必须包含 app.setPath(userData)')

  // 模块加载期 getPath('userData') 调用点（main.js 自身 + ConfigService 顶层）
  // 过滤注释行（// 或 * 开头）——注释里的字符串不算调用
  const isComment = l => {
    const t = l.trim()
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
  }
  const getPathLines = []
  lines.forEach((l, i) => {
    if (isComment(l)) return
    if (l.includes("getPath('userData')") || l.includes('getPath("userData")')) getPathLines.push(i + 1)
  })
  // ConfigService.js:14 顶层 CONFIG_DIR
  const cfgSrc = fs.readFileSync('E:\\print706\\electron\\services\\ConfigService.js', 'utf8')
  const cfgLines = cfgSrc.split('\n')
  cfgLines.forEach((l, i) => {
    if (isComment(l)) return
    if (l.includes("getPath('userData')")) getPathLines.push(10000 + i + 1) // 用大偏移标注外部文件
  })

  console.log(`  [顺序] setPath('userData') @ main.js:${setPathLine}`)
  for (const gl of getPathLines) console.log(`  [顺序] getPath('userData') @ ${gl >= 10000 ? 'ConfigService.js:' + (gl - 10000) : 'main.js:' + gl}`)

  for (const gl of getPathLines) {
    assert.ok(setPathLine < gl, `setPath(${setPathLine}) 必须早于 getPath(${gl})`)
  }
  // setPath 必须在 ConfigService require 之前（main.js:35 附近）
  const cfgRequireLine = lines.findIndex(l => l.includes("require('./services/ConfigService')")) + 1
  assert.ok(cfgRequireLine > 0)
  assert.ok(setPathLine < cfgRequireLine, `setPath(${setPathLine}) 必须早于 ConfigService require(${cfgRequireLine})`)
  console.log(`  [顺序] ConfigService require @ main.js:${cfgRequireLine} → setPath 更早 ✓`)
})

// ---------- 运行时模拟：stub electron 记录 setPath/getPath 调用序列 ----------
function runBootstrap(appCfg, execPath) {
  const calls = [] // ['setPath', name, value] / ['getPath', name]
  let userData = null
  const fakeApp = {
    isPackaged: appCfg.isPackaged,
    setPath: (name, val) => { calls.push(['setPath', name, val]); if (name === 'userData') userData = val },
    getPath: (name) => { calls.push(['getPath', name]); if (name === 'userData') return userData; return 'C:\\tmp' },
    getAppPath: () => 'C:\\app',
  }
  const orig = Module._load
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return { app: fakeApp }
    return orig.apply(this, arguments)
  }
  delete require.cache[require.resolve(DATA_ROOT_MOD)]
  const dataRoot = require(DATA_ROOT_MOD)
  Module._load = orig

  // 复刻 main.js 顶部 bootstrap 段（DP-2B 逻辑）
  const check = dataRoot.ensureDataRoots()
  if (!check.ok) return { ok: false, calls, check }
  fakeApp.setPath('userData', check.userDataRoot)
  // 模拟模块加载期消费者（main.js:114 / ConfigService:14 行为）
  const settingsPath = path.join(fakeApp.getPath('userData'), 'Settings.json')
  return { ok: true, calls, userData: fakeApp.getPath('userData'), settingsPath, check }
}

test('dev: bootstrap 后 getPath(userData)=项目根/userdata，setPath 先于 getPath', () => {
  const prevExe = process.execPath
  try {
    process.execPath = 'C:\\node_modules\\electron\\dist\\electron.exe'
    const r = runBootstrap({ isPackaged: false }, process.execPath)
    assert.strictEqual(r.ok, true)
    const expected = path.join(EXPECTED_PROJECT_ROOT, 'userdata')
    assert.strictEqual(r.userData, expected)
    assert.strictEqual(r.settingsPath, path.join(expected, 'Settings.json'))
    // 调用序列：setPath(userData) 必须先于 getPath(userData)
    const setIdx = r.calls.findIndex(c => c[0] === 'setPath' && c[1] === 'userData')
    const getIdx = r.calls.findIndex(c => c[0] === 'getPath' && c[1] === 'userData')
    assert.ok(setIdx >= 0 && getIdx >= 0 && setIdx < getIdx, `序列错误: ${JSON.stringify(r.calls)}`)
    console.log('  [dev] userData =', r.userData, '| setPath 先于 getPath ✓')
  } finally { process.execPath = prevExe }
})

test('packaged(resourcesPath=undefined): bootstrap 后 getPath(userData)=EXE 同级/userdata', () => {
  const prevExe = process.execPath
  const prevRes = process.resourcesPath
  try {
    process.execPath = 'D:\\FapiaoGO\\FapiaoGO.exe'
    process.resourcesPath = undefined // R4-P0-8 教训：不假设存在
    const r = runBootstrap({ isPackaged: true }, process.execPath)
    assert.strictEqual(r.ok, true)
    const expected = path.join('D:\\FapiaoGO', 'userdata')
    assert.strictEqual(r.userData, expected)
    assert.strictEqual(r.settingsPath, path.join(expected, 'Settings.json'))
    console.log('  [packaged] userData =', r.userData, '（resourcesPath=undefined 不受影响）✓')
  } finally { process.execPath = prevExe; process.resourcesPath = prevRes }
})

test('不可写目录: bootstrap 返回 ok:false（无 fallback，退出分支可触发）', () => {
  const prevExe = process.execPath
  try {
    process.execPath = 'D:\\FapiaoGO\\FapiaoGO.exe'
    const roFs = {
      mkdirSync: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e },
      writeFileSync: () => { throw new Error('EACCES') },
      unlinkSync: () => {},
    }
    const orig = Module._load
    Module._load = function (req, parent, isMain) {
      if (req === 'electron') return { app: { isPackaged: true, setPath: () => {}, getPath: () => 'C:\\tmp', getAppPath: () => 'C:\\app' } }
      return orig.apply(this, arguments)
    }
    delete require.cache[require.resolve(DATA_ROOT_MOD)]
    const dataRoot = require(DATA_ROOT_MOD)
    Module._load = orig
    const check = dataRoot.ensureDataRoots(roFs)
    assert.strictEqual(check.ok, false)
    assert.strictEqual(check.root, 'D:\\FapiaoGO\\database')
    assert.ok(check.error)
    console.log('  [read-only] ensureDataRoots →', JSON.stringify({ ok: check.ok, root: check.root }), '（main.js 走 showErrorBox+exit）✓')
  } finally { process.execPath = prevExe }
})
