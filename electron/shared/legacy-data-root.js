'use strict'

/**
 * legacy-data-root.js — 旧数据根捕获（DATA-PATH Contract v1.1，DP-2E）
 *
 * DP-2B 已把 app.setPath('userData') 重定向到 USERDATA_ROOT（EXE 同级/userdata），
 * 因此 setPath 之后 app.getPath('userData') 不再指向旧位置。旧版本（< DATA-PATH）
 * 产生的业务数据在 %APPDATA%\FapiaoGO\ —— 必须在 setPath **之前**捕获一次，
 * 供迁移器（migrateLegacyBusinessData）定位旧数据。
 *
 * 用法（main.js 最早期，setPath 之前）：
 *   const legacyUserData = captureLegacyUserDataRoot(app)
 *   app.setPath('userData', USERDATA_ROOT)
 *   ...
 *   const oldRoot = getLegacyUserDataRoot()   // 仍为 %APPDATA%\FapiaoGO
 */

let _legacyUserDataRoot = null

/**
 * 在 app.setPath('userData') 之前调用，捕获旧 userData 路径。
 * @param {object} app electron app
 * @returns {string|null} 旧 userData 路径（无 electron 上下文时 null）
 */
function captureLegacyUserDataRoot(app) {
  try {
    if (app && typeof app.getPath === 'function') {
      _legacyUserDataRoot = app.getPath('userData')
    }
  } catch (e) {
    _legacyUserDataRoot = null
  }
  return _legacyUserDataRoot
}

/**
 * @returns {string|null} 已捕获的旧 userData 路径（%APPDATA%/<appName>）
 */
function getLegacyUserDataRoot() {
  return _legacyUserDataRoot
}

module.exports = { captureLegacyUserDataRoot, getLegacyUserDataRoot }
