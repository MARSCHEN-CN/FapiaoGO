'use strict'

const { OfficialProvider } = require('./providers/OfficialProvider')
const { EnterpriseProvider } = require('./providers/EnterpriseProvider')
const { ElectronUpdaterClient } = require('./clients/ElectronUpdaterClient')
const { MockUpdaterClient } = require('./clients/MockUpdaterClient')

/**
 * UpdateManager — 更新编排器。
 *
 * 职责：纯编排，不读配置，不知道 electron-updater。
 * 输入来自 ConfigService（或 UI 设置），输出通过 IUpdateClient 执行。
 *
 * 数据流（V2）：
 *
 *   ConfigService.load()
 *        │
 *        ├── updateChannel → ChannelResolver.resolve(channel)
 *        │                      (future: extract as separate module)
 *        ├── updateSource  → SourceProvider.resolve(channel)
 *        │                      ├── OfficialProvider
 *        │                      └── EnterpriseProvider
 *        └── app.isPackaged → UpdateClient
 *                               ├── ElectronUpdaterClient (packaged)
 *                               └── MockUpdaterClient (dev)
 *
 *        ↓
 *   UpdateManager.check(provider, channel, client)
 *        ↓
 *   IUpdateClient.check(url)
 *
 *   ── 失败 ──
 *        ↓
 *   UpdateManager.fallback(fallbackProvider, channel, client)
 *        ↓
 *   IUpdateClient.check(url2)
 */

/**
 * 初始化更新系统。在 app.whenReady() 后调用一次。
 *
 * @param {object} config - ConfigService.load() 的输出
 * @param {object} [options]
 * @param {boolean} [options.useMock=false] - 强制使用 MockUpdaterClient（测试用）
 */
async function initUpdateManager(config, options = {}) {
  const { updateChannel, updateSource, enterpriseUpdateUrl, fallbackSource } = config
  const useMock = options.useMock || !require('electron').app.isPackaged

  // ── 选择 Provider ──
  const primaryProvider = createProvider(updateSource, { enterpriseUrl: enterpriseUpdateUrl })
  const fallbackProvider = fallbackSource && fallbackSource !== updateSource
    ? createProvider(fallbackSource, { enterpriseUrl: '' })
    : null

  // ── 选择 Client ──
  const client = useMock
    ? new MockUpdaterClient()
    : new ElectronUpdaterClient()

  // ── 主源检查 ──
  const primaryUrl = (await primaryProvider.resolve(updateChannel)).url
  console.log(`[UpdateManager] 主源: ${primaryUrl}  (client: ${client.constructor.name})`)

  try {
    const result = await client.check(primaryUrl)
    if (result.available) {
      console.log(`[UpdateManager] 发现更新: ${result.version}`)
      // 下载 + 安装留给 UI 层控制，这里只做检查
      // UI 层可以：
      //   1. 弹窗问用户是否下载
      //   2. 调用 client.download()
      //   3. 下载完调用 client.quitAndInstall()
    }
    return
  } catch (err) {
    console.warn(`[UpdateManager] 主源失败: ${err.message}`)
  }

  // ── 回退 ──
  if (fallbackProvider) {
    const fallbackUrl = (await fallbackProvider.resolve(updateChannel)).url
    console.log(`[UpdateManager] 回退源: ${fallbackUrl}`)
    try {
      const result = await client.check(fallbackUrl)
      if (result.available) {
        console.log(`[UpdateManager] 回退源发现更新: ${result.version}`)
      }
      return
    } catch (err2) {
      console.warn(`[UpdateManager] 回退源失败: ${err2.message}`)
    }
  }

  console.log('[UpdateManager] 所有更新源不可达，跳过')
}

/**
 * 根据 source 名创建对应的 Provider 实例。
 */
function createProvider(source, options = {}) {
  switch (source) {
    case 'enterprise':
      return new EnterpriseProvider({ enterpriseUrl: options.enterpriseUrl })
    case 'official':
    default:
      return new OfficialProvider()
  }
}

module.exports = { initUpdateManager, createProvider }
