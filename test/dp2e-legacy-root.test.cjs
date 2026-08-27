'use strict'
// DATA-PATH-2 DP-2E-1 单测：legacy-data-root.js 旧 userData 捕获（setPath 前）
const test = require('node:test')
const assert = require('node:assert')

const MOD = 'E:\\print706\\electron\\shared\\legacy-data-root.js'

function freshModule() {
  delete require.cache[require.resolve(MOD)]
  return require(MOD)
}

test('capture 在 setPath 前调用 → 捕获旧 userData；setPath 后仍返回旧值', () => {
  const m = freshModule()
  // 模拟真实时序：app.getPath('userData') 先返回旧 %APPDATA%，setPath 后返回新路径
  let userData = 'C:\\Users\\it01\\AppData\\Roaming\\FapiaoGO'
  const fakeApp = {
    getPath: (name) => name === 'userData' ? userData : 'C:\\tmp',
    setPath: (name, val) => { if (name === 'userData') userData = val },
  }
  // DP-2B 时序：setPath 之前捕获
  const captured = m.captureLegacyUserDataRoot(fakeApp)
  assert.strictEqual(captured, 'C:\\Users\\it01\\AppData\\Roaming\\FapiaoGO')
  // 模拟 setPath 重定向
  fakeApp.setPath('userData', 'D:\\FapiaoGO\\userdata')
  // setPath 之后 getLegacyUserDataRoot 仍为旧值（迁移定位用）
  assert.strictEqual(m.getLegacyUserDataRoot(), 'C:\\Users\\it01\\AppData\\Roaming\\FapiaoGO')
  // 且此时 app.getPath('userData') 已是新值
  assert.strictEqual(fakeApp.getPath('userData'), 'D:\\FapiaoGO\\userdata')
})

test('无 electron 上下文 → capture 返回 null（不抛）', () => {
  const m = freshModule()
  const r = m.captureLegacyUserDataRoot(null)
  assert.strictEqual(r, null)
  assert.strictEqual(m.getLegacyUserDataRoot(), null)
})

test('getPath 抛异常 → capture 返回 null 不崩溃', () => {
  const m = freshModule()
  const badApp = { getPath: () => { throw new Error('boom') } }
  const r = m.captureLegacyUserDataRoot(badApp)
  assert.strictEqual(r, null)
})
