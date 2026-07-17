'use strict'

const path = require('path')
const fs = require('fs')
const { app } = require('electron')

const { resolveChannelPath } = require('./ChannelResolver')
const { resolveSourceUrl, OFFICIAL_BASE } = require('./SourceResolver')
const { checkForUpdates } = require('./UpdateService')

// ── 配置文件路径与默认值 ──
const CONFIG_DIR = app.getPath('userData')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

const DEFAULT_CONFIG = {
  updateChannel: 'stable',       // stable | rc | dev
  updateSource: 'official',      // official | enterprise
  enterpriseUpdateUrl: '',       // 企业自定义 URL（管理员填写）
  fallbackSource: 'official',    // 主源失败后的回退源
}

/**
 * ConfigProvider — 读写 userData/config.json。
 * 用 spread 合并默认值，保证版本升级新增字段自动生效。
 */
function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function writeConfig(changes) {
  const current = readConfig()
  const merged = { ...current, ...changes }
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}

// ── URL 构建 ──

/**
 * 组合最终更新 URL：baseURL + channelPath。
 * 例如  "https://update.fapiaogo.com" + "/stable/" → "https://update.fapiaogo.com/stable/"
 */
function buildUpdateUrl(baseUrl, channel) {
  const base = baseUrl.replace(/\/+$/, '')
  const ch = channel.startsWith('/') ? channel : `/${channel}/`
  return `${base}${ch}`
}

// ── 主入口 ──

/**
 * 初始化更新系统。在内核 ready 后调用一次。
 *
 * 流程：
 *   1. 读 config
 *   2. ChannelResolver → 渠道 path（/stable/）
 *   3. SourceResolver → base URL
 *   4. 组合完整 URL
 *   5. 检查更新
 *   6. 失败 → 回退源重试
 */
async function initUpdateManager() {
  const config = readConfig()
  const { updateChannel, updateSource, enterpriseUpdateUrl, fallbackSource } = config

  // 解析渠道路径
  const channelPath = resolveChannelPath(updateChannel)
  console.log(`[UpdateManager] 渠道: ${updateChannel} → ${channelPath}`)

  // 解析主源
  const primaryBase = await resolveSourceUrl(updateSource, enterpriseUpdateUrl)
  const primaryUrl = buildUpdateUrl(primaryBase, channelPath)
  console.log(`[UpdateManager] 主源: ${primaryUrl}`)

  try {
    await checkForUpdates(primaryUrl)
    return // 成功，退出
  } catch (err) {
    console.warn(`[UpdateManager] 主源检查失败: ${err.message}`)
  }

  // ── 回退 ──
  if (fallbackSource && fallbackSource !== updateSource) {
    const fallbackBase = await resolveSourceUrl(fallbackSource, '')
    const fallbackUrl = buildUpdateUrl(fallbackBase, channelPath)
    console.log(`[UpdateManager] 主源失败，切换到回退源: ${fallbackUrl}`)
    try {
      await checkForUpdates(fallbackUrl)
      return
    } catch (err2) {
      console.warn(`[UpdateManager] 回退源也失败: ${err2.message}`)
    }
  }

  console.log('[UpdateManager] 所有更新源均不可达，本次跳过')
}

module.exports = { initUpdateManager, readConfig, writeConfig, CONFIG_PATH, buildUpdateUrl }
