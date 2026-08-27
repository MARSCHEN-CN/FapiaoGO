'use strict'
// R4-P0-8-G PRINT-3A 单测：getResourcesBase() 纯路径解析（4 场景）
const test = require('node:test')
const assert = require('node:assert')
const Module = require('module')
const path = require('path')

const MOD = 'E:\\print706\\electron\\shared\\resources-base.js'

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

test('dev: app.isPackaged=false → null', () => {
  const { getResourcesBase } = loadWith({ isPackaged: false })
  const prev = process.resourcesPath
  const prevExe = process.execPath
  try {
    process.resourcesPath = 'C:\\app\\resources'
    process.execPath = 'C:\\app\\FapiaoGO.exe'
    assert.strictEqual(getResourcesBase(), null)
  } finally { process.resourcesPath = prev; process.execPath = prevExe }
})

test('packaged + resourcesPath 注入 → 用 resourcesPath', () => {
  const { getResourcesBase } = loadWith({ isPackaged: true })
  const prev = process.resourcesPath
  const prevExe = process.execPath
  try {
    process.resourcesPath = 'C:\\Program Files\\FapiaoGO\\resources'
    process.execPath = 'C:\\Program Files\\FapiaoGO\\FapiaoGO.exe'
    assert.strictEqual(getResourcesBase(), 'C:\\Program Files\\FapiaoGO\\resources')
  } finally { process.resourcesPath = prev; process.execPath = prevExe }
})

test('packaged + resourcesPath undefined + Portable → dirname(execPath)/resources', () => {
  const { getResourcesBase } = loadWith({ isPackaged: true })
  const prev = process.resourcesPath
  const prevExe = process.execPath
  try {
    process.resourcesPath = undefined
    process.execPath = 'C:\\Users\\it01\\Desktop\\FapiaoGO-1.0.0-win-x64\\FapiaoGO.exe'
    const expected = path.join('C:\\Users\\it01\\Desktop\\FapiaoGO-1.0.0-win-x64', 'resources')
    assert.strictEqual(getResourcesBase(), expected)
  } finally { process.resourcesPath = prev; process.execPath = prevExe }
})

test('packaged + resourcesPath undefined + Installer → dirname(execPath)/resources', () => {
  const { getResourcesBase } = loadWith({ isPackaged: true })
  const prev = process.resourcesPath
  const prevExe = process.execPath
  try {
    process.resourcesPath = undefined
    process.execPath = 'C:\\Program Files\\FapiaoGO\\FapiaoGO.exe'
    const expected = path.join('C:\\Program Files\\FapiaoGO', 'resources')
    assert.strictEqual(getResourcesBase(), expected)
  } finally { process.resourcesPath = prev; process.execPath = prevExe }
})
