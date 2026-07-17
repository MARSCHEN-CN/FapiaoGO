'use strict'

const { autoUpdater } = require('electron-updater')
const { app, dialog } = require('electron')
const { BaseClient } = require('./BaseClient')

/**
 * ElectronUpdaterClient — 基于 electron-updater 的真实更新客户端。
 *
 * check / download / quitAndInstall 三阶段分离，
 * 支持手动/自动下载、下载进度、安装前确认等场景。
 */
class ElectronUpdaterClient extends BaseClient {
  constructor() {
    super()

    this._listenersAttached = false
    this._downloadPromise = null
    this._downloadResolve = null
  }

  /**
   * 检查更新。
   * 不会自动下载——调用方根据用户意愿决定是否 call download()。
   *
   * @param {string} url - 完整 feed URL
   * @returns {Promise<{available: boolean, version?: string}>}
   */
  async check(url) {
    autoUpdater.setFeedURL({ provider: 'generic', url })
    this._attachListenersOnce()

    const result = await autoUpdater.checkForUpdates()
    if (result && result.updateInfo) {
      return { available: true, version: result.updateInfo.version }
    }
    return { available: false }
  }

  /**
   * 下载更新包（后台下载）。
   * 调用方应该先 check() 确认有更新再 download()。
   *
   * @returns {Promise<void>} 下载完成后 resolve
   */
  async download() {
    return new Promise((resolve, reject) => {
      this._downloadResolve = resolve
      autoUpdater.once('update-downloaded', () => {
        this._downloadResolve = null
        resolve()
      })
      autoUpdater.once('error', (err) => {
        this._downloadResolve = null
        reject(err)
      })
      autoUpdater.downloadUpdate()
    })
  }

  /**
   * 重启安装已下载的更新。
   * 调用前建议弹窗确认用户。
   */
  quitAndInstall() {
    autoUpdater.quitAndInstall()
  }

  /** 取消下载（仅作标记，electron-updater 不直接支持中断） */
  cancel() {
    if (this._downloadResolve) {
      this._downloadResolve()
      this._downloadResolve = null
    }
  }

  /** 内部：注册一次 autoUpdater 事件监听 */
  _attachListenersOnce() {
    if (this._listenersAttached) return
    this._listenersAttached = true

    autoUpdater.on('checking-for-update', () => {
      console.log('[ElectronUpdaterClient] 正在检查更新...')
    })

    autoUpdater.on('update-available', (info) => {
      console.log(`[ElectronUpdaterClient] 发现新版本: ${info.version}`)
    })

    autoUpdater.on('update-not-available', () => {
      console.log('[ElectronUpdaterClient] 当前已是最新版本')
    })

    autoUpdater.on('download-progress', (progress) => {
      console.log(`[ElectronUpdaterClient] 下载进度: ${Math.round(progress.percent)}%`)
    })

    autoUpdater.on('update-downloaded', (info) => {
      console.log(`[ElectronUpdaterClient] 下载完成: ${info.version}`)
    })

    autoUpdater.on('error', (err) => {
      console.error('[ElectronUpdaterClient] 更新错误:', err.message)
    })
  }
}

module.exports = { ElectronUpdaterClient }
