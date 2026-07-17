'use strict'

const { autoUpdater } = require('electron-updater')
const { app, dialog } = require('electron')

/**
 * 「更新下载器」—— 纯 electron-updater 封装，不涉及任何渠道/源/配置知识。
 *
 * 职责：
 *   1. setFeedURL(url) — 设置更新源
 *   2. checkForUpdates() — 发起检查
 *   3. 事件处理（弹窗提示 / 下载 / 安装）
 *
 * 谁调用它，谁负责提供最终的完整 URL（含 channel path）。
 * 上游：UpdateManager（组合 ChannelResolver + SourceResolver 的结果）。
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 小时
let _interval = null

function _clearInterval() {
  if (_interval) { clearInterval(_interval); _interval = null }
}

/**
 * 检查更新。
 *
 * @param {string} url - 完整的 feed URL（含 channel），如 "https://update.fapiaogo.com/stable/"
 * @param {{ silent?: boolean }} [options]
 * @returns {Promise<void>}
 */
async function checkForUpdates(url, options = { silent: false }) {
  _clearInterval()

  if (!url) {
    if (!options.silent) console.log('[UpdateService] 未提供更新 URL，跳过')
    return
  }

  console.log(`[UpdateService] 更新源: ${url}`)

  autoUpdater.setFeedURL({
    provider: 'generic',
    url,
  })

  // ── 事件监听（仅注册一次）──
  if (!autoUpdater._listenersAttached) {
    autoUpdater._listenersAttached = true

    autoUpdater.on('checking-for-update', () => {
      console.log('[UpdateService] 正在检查更新...')
    })

    autoUpdater.on('update-available', (info) => {
      console.log(`[UpdateService] 发现新版本: ${info.version}`)
      dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `FapiaoGO ${info.version} 可用，是否下载更新？`,
        detail: `当前版本: ${app.getVersion()}\n新版本: ${info.version}`,
        buttons: ['下载', '稍后'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.downloadUpdate()
      })
    })

    autoUpdater.on('update-not-available', () => {
      console.log('[UpdateService] 当前已是最新版本')
    })

    autoUpdater.on('download-progress', (progress) => {
      console.log(`[UpdateService] 下载进度: ${Math.round(progress.percent)}%`)
    })

    autoUpdater.on('update-downloaded', (info) => {
      console.log(`[UpdateService] 下载完成: ${info.version}`)
      dialog.showMessageBox({
        type: 'info',
        title: '更新就绪',
        message: '更新已下载，是否立即重启安装？',
        buttons: ['重启安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall()
      })
    })

    autoUpdater.on('error', (err) => {
      console.error('[UpdateService] 更新错误:', err.message)
    })
  }

  // ── 启动检查 ──
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.warn('[UpdateService] 检查失败:', err.message)
    // UpdateManager 处理回退
    throw err
  }

  // ── 周期检查 ──
  _interval = setInterval(() => {
    autoUpdater.checkForUpdates().catch(e =>
      console.warn('[UpdateService] 周期检查失败:', e.message)
    )
  }, CHECK_INTERVAL_MS)
  if (_interval.unref) _interval.unref()
}

/**
 * 手动触发检查（用户点击"检查更新"按钮时）。
 * 与 checkForUpdates 不同：不启动周期检查、且有明确反馈。
 */
async function checkNow(url) {
  _clearInterval()
  if (!url) return console.warn('[UpdateService] checkNow: 未提供 URL')
  autoUpdater.setFeedURL({ provider: 'generic', url })
  await autoUpdater.checkForUpdates()
}

module.exports = { checkForUpdates, checkNow }
