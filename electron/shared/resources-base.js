'use strict'

/**
 * resources-base.js — 唯一生产资源根解析器（R4-P0-8-G）
 *
 * 真机铁证（2026-08-27）：packaged 运行时 app.isPackaged=true 但
 * process.resourcesPath=undefined，导致 pdf-margin / placement-bake 等
 * 模块把资源根 fallback 到 __dirname（app.asar/electron/... 内）→
 * tools/pdf_tool/pdf_tool.exe 找不到 → P1 边距 / P2 旋转 bake 全失效。
 *
 * fallback 链（只对 packaged 生效；dev 返回 null 由各模块保持原 dev 逻辑）：
 *   1. process.resourcesPath          —— Electron 注入（正常时存在）
 *   2. dirname(process.execPath)/resources —— Portable 与 Installer 均成立：
 *         Portable:  <解压目录>/FapiaoGO.exe + resources/
 *         Installer: <Program Files>/FapiaoGO/FapiaoGO.exe + resources/
 *
 * 约定：所有业务模块（pdf-margin / placement-bake / Sumatra / backend / 未来 standalone）
 * 统一从本模块取资源根，禁止各自再依赖 process.resourcesPath 或 __dirname 推断。
 */

const path = require('path')
const { app } = require('electron')

/**
 * @returns {string|null} 生产资源根目录（packaged）；dev 返回 null。
 */
function getResourcesBase() {
  if (!app || !app.isPackaged) return null

  if (process.resourcesPath && typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    return process.resourcesPath
  }

  // 兜底：FapiaoGO.exe 所在目录 / resources（portable + installer 同构）
  if (process.execPath && typeof process.execPath === 'string' && process.execPath.length > 0) {
    return path.join(path.dirname(process.execPath), 'resources')
  }

  return null
}

module.exports = { getResourcesBase }
