'use strict'

const { BaseProvider } = require('./BaseProvider')

const OFFICIAL_BASE = 'https://update.fapiaogo.com'

const CHANNEL_PATHS = {
  stable: '/stable/',
  rc: '/rc/',
  dev: '/dev/',
}

/**
 * 官方更新源。
 * 硬编码域名，永远跑在 `https://update.fapiaogo.com`.
 */
class OfficialProvider extends BaseProvider {
  resolve(channel) {
    const path = CHANNEL_PATHS[channel] || CHANNEL_PATHS.stable
    return { url: `${OFFICIAL_BASE}${path}` }
  }
}

module.exports = { OfficialProvider, OFFICIAL_BASE }
