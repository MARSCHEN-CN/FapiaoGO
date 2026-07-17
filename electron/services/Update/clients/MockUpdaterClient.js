'use strict'

const { BaseClient } = require('./BaseClient')

/**
 * MockUpdaterClient —— 开发/测试模式使用，不依赖 electron-updater。
 *
 * 在非打包环境（dev）下替换 ElectronUpdaterClient，避免在开发者电脑上
 * 未安装 NSIS/npm 时 electron-updater 抛出异常。
 */
class MockUpdaterClient extends BaseClient {
  async check(url) {
    console.log(`[MockUpdater] 模拟检查更新 (URL: ${url})`)
    return { available: false }
  }

  async download() {
    console.log('[MockUpdater] 模拟下载更新')
  }

  quitAndInstall() {
    console.log('[MockUpdater] 模拟重启安装')
  }

  cancel() {}
}

module.exports = { MockUpdaterClient }
