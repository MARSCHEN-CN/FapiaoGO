'use strict'

/**
 * ConfigService — 共享配置读写服务。
 *
 * 所有 services 统一通过此文件读写 userData/config.json。
 * 避免各 Manager 各自存 Config，分散配置来源。
 */

const path = require('path')
const fs = require('fs')
const { app } = require('electron')

const CONFIG_DIR = app.getPath('userData')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

const DEFAULT_CONFIG = {
  // Update
  updateChannel: 'stable',
  updateSource: 'official',
  enterpriseUpdateUrl: '',
  fallbackSource: 'official',

  // 未来: Print, Preview, 许可证等也放这里
}

/**
 * @returns {object} 合并默认值的配置（保证升级新增字段自动生效）
 */
function load() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * @param {object} changes - 要写入的配置字段（部分更新，不覆盖其他字段）
 * @returns {object} 写入后的完整配置
 */
function write(changes) {
  const current = load()
  const merged = { ...current, ...changes }
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}

module.exports = { load, write, CONFIG_PATH, CONFIG_DIR }
