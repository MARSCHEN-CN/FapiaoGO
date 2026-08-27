'use strict'
// Packaged Electron Cold-Start Regression (R4-P0)
// 模拟打包后主进程冷启动：主进程在模块求值阶段就会 require 这两个模块。
// 任何「模块顶层 path.join(undefined)」都会导致双击 EXE 立即崩溃。
// 此测试在 Node 下用桩 electron 加载真实源码，断言模块求值不抛错。

const test = require('node:test')
const assert = require('node:assert')
const Module = require('module')

// 真实打包运行时由 Electron 注入 process.resourcesPath / app.getPath。
// 这里用桩 electron 覆盖 require('electron')，并使用 undefined 的 resourcesPath
// 来强制触发「最危险」分支，验证防御性兜底生效（不发生崩溃）。
function makeElectronStub() {
  return {
    app: {
      isPackaged: true,
      getPath: (name) => (name === 'temp' ? 'C:\\Windows\\Temp' : 'C:\\Windows\\Temp'),
      getAppPath: () => 'C:\\app',
    },
  }
}

const origLoad = Module._load
function loadWithStub() {
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return makeElectronStub()
    return origLoad.apply(this, arguments)
  }
}
function restoreLoad() {
  Module._load = origLoad
}

test('pdf-margin-processor 与 temp-manager 模块加载不抛错（冷启动）', () => {
  loadWithStub()
  try {
    const margin = require('../electron/print-service/pdf-margin-processor')
    const tm = require('../electron/temp-manager')
    assert.ok(typeof margin.process === 'function', 'pdf-margin-processor.process 应存在')
    assert.ok(typeof margin.checkPythonEnv === 'function', 'pdf-margin-processor.checkPythonEnv 应存在')
    assert.ok(typeof tm.TEMP_DIR === 'string' && tm.TEMP_DIR.length > 0, 'temp-manager.TEMP_DIR 应为非空字符串')
  } finally {
    restoreLoad()
  }
})

test('process.resourcesPath 缺失时仍能加载（兜底生效）', () => {
  loadWithStub()
  const prev = process.resourcesPath
  try {
    process.resourcesPath = undefined
    const margin = require('../electron/print-service/pdf-margin-processor')
    assert.ok(typeof margin.process === 'function')
  } finally {
    process.resourcesPath = prev
    restoreLoad()
  }
})

test('正常语义保持：TEMP_DIR 仍 = app.getPath(temp)/FapiaoGO（防御不改变正常路径）', () => {
  loadWithStub()
  try {
    const tm = require('../electron/temp-manager')
    assert.strictEqual(tm.TEMP_DIR, 'C:\\Windows\\Temp\\FapiaoGO')
  } finally {
    restoreLoad()
  }
})
