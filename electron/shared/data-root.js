'use strict'

/**
 * data-root.js — 唯一业务数据根解析器（DATA-PATH Contract v1.1，DP-2A）
 *
 * APP_ROOT      = <exe 同级目录>             （dev = 项目根）
 * DATA_ROOT     = APP_ROOT/database          （所有 FapiaoGO 业务数据）
 * USERDATA_ROOT = APP_ROOT/userdata          （Electron/Chromium 数据，main.js 用 setPath 重定向）
 *
 * 冻结规则：
 *   1. DATA_ROOT 与 USERDATA_ROOT 完全分离；业务数据一律 DATA_ROOT，
 *      禁止经 app.getPath('userData') 间接获取。
 *   2. 不根据 packaged/dev 产生不同数据目录语义（dev 仅 APP_ROOT 例外：
 *      execPath=electron.exe 不可用，用项目根；落地仍是 项目根/database）。
 *   3. 禁止 %APPDATA% fallback / %LOCALAPPDATA% fallback /
 *      resources/backend/database / app.asar 内写入。
 *   4. 目标目录不可写 → ensureWritable 返回 { ok:false }，由调用方明确报错退出。
 *
 * 与 resources-path 的教训一致：不假设 process.resourcesPath 存在；
 * 只做纯路径派生，便于单测（Dev/Portable/Installer/Read-only 4 场景）。
 */

const path = require('path')
const { app } = require('electron')

// electron/shared/ → 项目根（dev 用）
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

/**
 * @returns {string} APP_ROOT：exe 同级目录（packaged）/ 项目根（dev）
 */
function getAppRoot() {
  if (app && app.isPackaged && process.execPath && typeof process.execPath === 'string' && process.execPath.length > 0) {
    return path.dirname(process.execPath)
  }
  return PROJECT_ROOT
}

/** @returns {string} DATA_ROOT = APP_ROOT/database */
function getDataRoot() {
  return path.join(getAppRoot(), 'database')
}

/** @returns {string} USERDATA_ROOT = APP_ROOT/userdata */
function getUserDataRoot() {
  return path.join(getAppRoot(), 'userdata')
}

/**
 * 可写性探测：mkdir -p + 写探测文件。
 * 语义：可写 = 能创建文件（mkdir + writeFileSync 成功）；探测文件清理为
 * best-effort（unlink 失败不代表目录不可写——某些环境/沙箱会拦截删除）。
 * 失败返回 { ok:false, error }（不抛异常，由调用方决定报错退出）。
 *
 * @param {string} dir 目标目录
 * @param {object} [fsImpl] 注入 fs（单测模拟只读用），默认 require('fs')
 */
function ensureWritable(dir, fsImpl) {
  const fs = fsImpl || require('fs')
  let probe = null
  try {
    fs.mkdirSync(dir, { recursive: true })
    probe = path.join(dir, `.writetest-${process.pid}-${Date.now()}`)
    fs.writeFileSync(probe, 'ok')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) }
  } finally {
    if (probe) {
      try { fs.unlinkSync(probe) } catch (_) { /* best-effort 清理，忽略失败 */ }
    }
  }
}

/**
 * 探测 DATA_ROOT 与 USERDATA_ROOT 均可写。
 * @returns {{ok:boolean, dataRoot?:string, userDataRoot?:string, root?:string, error?:string}}
 */
function ensureDataRoots(fsImpl) {
  const dataRoot = getDataRoot()
  const userDataRoot = getUserDataRoot()
  for (const root of [dataRoot, userDataRoot]) {
    const r = ensureWritable(root, fsImpl)
    if (!r.ok) return { ok: false, root, error: r.error }
  }
  return { ok: true, dataRoot, userDataRoot }
}

module.exports = {
  PROJECT_ROOT,
  getAppRoot,
  getDataRoot,
  getUserDataRoot,
  ensureWritable,
  ensureDataRoots,
}
