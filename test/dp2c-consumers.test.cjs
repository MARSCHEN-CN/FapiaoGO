'use strict'
// DATA-PATH-2 DP-2C 验证：Electron 业务消费者全部收敛 DATA_ROOT（Contract v1.1）
// 断言：Settings/DocFacts/ConfigService/logger/paper-registry/printer-cache
//       不再经 userData / %APPDATA% 落盘，一律 getDataRoot()。
const test = require('node:test')
const assert = require('node:assert')
const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const files = {
  main: 'E:\\print706\\electron\\main.js',
  cfg: 'E:\\print706\\electron\\services\\ConfigService.js',
  logger: 'E:\\print706\\electron\\logger.js',
  ups: 'E:\\print706\\electron\\shared\\UserPaperStore.js',
  pr: 'E:\\print706\\electron\\shared\\paper-registry.js',
  pc: 'E:\\print706\\electron\\print-service\\printer-capability.js',
}

// ---------- 1. 静态残留断言 ----------
test('DP-2C: 6 消费者源码不再经 getPath(userData)/%APPDATA% 落盘（main.js:935 后端注入除外）', () => {
  const skipMain935 = true
  for (const [name, p] of Object.entries(files)) {
    const src = fs.readFileSync(p, 'utf8')
    const lines = src.split('\n')
    lines.forEach((l, i) => {
      const t = l.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return // 注释
      if (name === 'main' && l.includes("FAPIAOGO_DB_PATH")) return // DP-2D 后端注入，暂留
      assert.ok(!l.includes("getPath('userData')") && !l.includes('process.env.APPDATA'),
        `${name} L${i + 1} 残留: ${t.slice(0, 80)}`)
    })
  }
  console.log('  [静态] 6 消费者均无 userData/APPDATA 数据路径残留 ✓')
})

// ---------- 2. ConfigService ----------
test('DP-2C: ConfigService CONFIG_DIR = DATA_ROOT（非 userData）', () => {
  const base = path.join(os.tmpdir(), 'fg-dp2c-cfg-' + Date.now())
  const fakeApp = { isPackaged: true, setPath: () => {}, getPath: () => 'C:\\WRONG-USERDATA', getAppPath: () => base }
  const orig = Module._load
  Module._load = function (req, p, i) { if (req === 'electron') return { app: fakeApp }; return orig.apply(this, arguments) }
  process.execPath = path.join(base, 'FapiaoGO.exe')
  delete require.cache[require.resolve(files.cfg)]
  const cfg = require(files.cfg)
  Module._load = orig
  const expected = path.join(base, 'database')
  assert.strictEqual(cfg.CONFIG_DIR, expected)
  assert.strictEqual(cfg.CONFIG_PATH, path.join(expected, 'config.json'))
  // 确认不是 userData 假路径
  assert.ok(!cfg.CONFIG_DIR.includes('WRONG-USERDATA'))
  console.log('  [ConfigService] CONFIG_DIR =', cfg.CONFIG_DIR, '✓')
  process.execPath = ''
})

// ---------- 3. logger ----------
test('DP-2C: logger.init() 落盘 DATA_ROOT/logs（packaged）', async () => {
  const base = path.join(os.tmpdir(), 'fg-dp2c-log-' + Date.now())
  const fakeApp = { isPackaged: true, setPath: () => {}, getPath: () => 'C:\\WRONG-USERDATA', getAppPath: () => base }
  const orig = Module._load
  Module._load = function (req, p, i) { if (req === 'electron') return { app: fakeApp }; return orig.apply(this, arguments) }
  process.execPath = path.join(base, 'FapiaoGO.exe')
  delete require.cache[require.resolve(files.logger)]
  const logger = require(files.logger)
  Module._load = orig
  logger.init()
  logger.log('DP-2C probe log') // writeToFile 走 buffer，需等 FLUSH_INTERVAL_MS(500) 定时 flush
  await new Promise(r => setTimeout(r, 800))
  const today = new Date().toISOString().split('T')[0]
  const logFile = path.join(base, 'database', 'logs', `app-${today}.log`)
  assert.ok(fs.existsSync(logFile), `日志文件应存在于 DATA_ROOT/logs: ${logFile}`)
  const content = fs.readFileSync(logFile, 'utf8')
  assert.ok(content.includes('DP-2C probe log'), '日志内容应含 probe 行')
  // 确认不是 userData 假路径
  assert.ok(!logFile.includes('WRONG-USERDATA'))
  console.log('  [logger] logDir =', path.join(base, 'database', 'logs'), '✓')
  try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {}
  process.execPath = ''
})

// ---------- 4. UserPaperStore ----------
test('DP-2C: UserPaperStore.load() 落盘 DATA_ROOT/paper-registry', async () => {
  const base = path.join(os.tmpdir(), 'fg-dp2c-ups-' + Date.now())
  const fakeApp = { isPackaged: true, setPath: () => {}, getPath: () => 'C:\\WRONG-USERDATA', getAppPath: () => base }
  const orig = Module._load
  Module._load = function (req, p, i) { if (req === 'electron') return { app: fakeApp }; return orig.apply(this, arguments) }
  process.execPath = path.join(base, 'FapiaoGO.exe')
  delete require.cache[require.resolve(files.ups)]
  const ups = require(files.ups)
  Module._load = orig
  await ups.load() // load() 内部 ensureStorage 创建目录 + 初始化文件
  const expectedDir = path.join(base, 'database', 'paper-registry')
  const expectedFile = path.join(expectedDir, 'user-papers.json')
  assert.ok(fs.existsSync(expectedFile), `user-papers.json 应存在于 DATA_ROOT/paper-registry: ${expectedFile}`)
  assert.ok(!expectedFile.includes('WRONG-USERDATA'))
  console.log('  [UserPaperStore] storageDir =', expectedDir, '✓')
  try { fs.rmSync(base, { recursive: true, force: true }) } catch (e) {}
  process.execPath = ''
})

// ---------- 5. printer-capability（_getCacheDir 未导出 → 静态断言） ----------
test('DP-2C: printer-capability _getCacheDir 使用 getDataRoot()，无 %APPDATA%', () => {
  const src = fs.readFileSync(files.pc, 'utf8')
  const seg = src.split('async function _getCacheDir()')[1].split('\n').slice(0, 6).join('\n')
  assert.ok(seg.includes('getDataRoot()'), '_getCacheDir 必须用 getDataRoot()')
  assert.ok(!seg.includes('process.env.APPDATA'), '_getCacheDir 不得用 %APPDATA%')
  console.log('  [printer-capability] _getCacheDir → getDataRoot()/printer-cache ✓')
})

// ---------- 6. main.js settingsPath / docFactsPath 静态断言 ----------
test('DP-2C: main.js settingsPath / docFactsPath 用 getDataRoot()', () => {
  const src = fs.readFileSync(files.main, 'utf8')
  const sLine = src.split('\n').find(l => l.includes('settingsPath = path.join'))
  const dLine = src.split('\n').find(l => l.includes('docFactsPath = path.join'))
  assert.ok(sLine && sLine.includes('getDataRoot()'), `settingsPath 行: ${sLine}`)
  assert.ok(dLine && dLine.includes('getDataRoot()'), `docFactsPath 行: ${dLine}`)
  console.log('  [main.js] settingsPath + docFactsPath → getDataRoot() ✓')
})
