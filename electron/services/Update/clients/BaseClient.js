'use strict'

/**
 * BaseClient — 更新客户端的接口规范。
 *
 * 所有具体客户端（ElectronUpdater / MockUpdater / HttpUpdater）实现以下接口。
 */
class BaseClient {
  /**
   * 检查更新。
   * @param {string} url - 完整 feed URL
   * @returns {Promise<{available: boolean, version?: string}>}
   */
  async check(url) { throw new Error('must implement check(url)') }

  /**
   * 后台下载更新包。
   * @returns {Promise<void>}
   */
  async download() { throw new Error('must implement download()') }

  /**
   * 重启并安装已下载的更新。
   */
  quitAndInstall() { throw new Error('must implement quitAndInstall()') }

  /**
   * 取消正在进行的下载。
   */
  cancel() {}
}

module.exports = { BaseClient }
