'use strict'

const { OfficialProvider } = require('./providers/OfficialProvider')
const { EnterpriseProvider } = require('./providers/EnterpriseProvider')
const { ElectronUpdaterClient } = require('./clients/ElectronUpdaterClient')
const { MockUpdaterClient } = require('./clients/MockUpdaterClient')
const { checkForUpdates: checkGithub } = require('./GithubApiChecker')
const { app } = require('electron')

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
 * @param {boolean} [options.enableGithubFallback=true] - 是否启用 GitHub API 作为最终回退
 */
async function initUpdateManager(config, options = {}) {
  const { updateChannel, updateSource, enterpriseUpdateUrl, fallbackSource, githubOwner, githubRepo } = config
  const useMock = options.useMock || !require('electron').app.isPackaged
  const enableGithubFallback = options.enableGithubFallback !== false

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
      return
    }
  } catch (err) {
    console.warn(`[UpdateManager] 主源失败: ${err.message}`)
  }

  // ── 回退源（electron-updater 层）──
  if (fallbackProvider) {
    const fallbackUrl = (await fallbackProvider.resolve(updateChannel)).url
    console.log(`[UpdateManager] 回退源: ${fallbackUrl}`)
    try {
      const result = await client.check(fallbackUrl)
      if (result.available) {
        console.log(`[UpdateManager] 回退源发现更新: ${result.version}`)
        return
      }
    } catch (err2) {
      console.warn(`[UpdateManager] 回退源失败: ${err2.message}`)
    }
  }

  // ── GitHub API 双源回退 ──
  // 当所有 electron-updater 源均不可达时，尝试通过 GitHub REST API 检查。
  // 主源: api.github.com（海外网络）
  // 回退: gh-proxy.com（国内加速代理）
  if (enableGithubFallback && githubOwner && githubRepo) {
    console.log(`[UpdateManager] 所有源不可达，尝试 GitHub API 双源检查...`)
    try {
      const currentVersion = app.getVersion()
      const ghResult = await checkGithub({
        owner: githubOwner,
        repo: githubRepo,
        currentVersion,
      })
      if (ghResult.available) {
        console.log(`[UpdateManager] GitHub 检查发现新版本: ${ghResult.version} (via ${ghResult.source})`)
        // 仅记录——真正的下载/安装需要 UI 层配合或通过 electron-updater 完成。
        // 这里可以通过 IPC 通知渲染进程提示用户。
        if (global._updateCallbacks?.onGithubUpdate) {
          global._updateCallbacks.onGithubUpdate(ghResult)
        }
      } else {
        console.log(`[UpdateManager] GitHub 检查结果: ${ghResult.reason} (via ${ghResult.source || 'n/a'})`)
      }
    } catch (ghErr) {
      console.warn(`[UpdateManager] GitHub API 检查异常: ${ghErr.message}`)
    }
  }

  console.log('[UpdateManager] 更新检查完成')
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
