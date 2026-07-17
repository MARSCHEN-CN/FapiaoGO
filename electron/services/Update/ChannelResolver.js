'use strict'

/**
 * ChannelResolver — 纯函数：渠道名 → URL path 段。
 *
 * 不依赖任何外部状态。
 */
const CHANNEL_MAP = {
  stable: '/stable/',
  rc: '/rc/',
  dev: '/dev/',
}

const DEFAULT_CHANNEL = 'stable'

function resolveChannelPath(channel) {
  const name = (channel && CHANNEL_MAP[channel]) ? channel : DEFAULT_CHANNEL
  return CHANNEL_MAP[name]
}

function getSupportedChannels() {
  return Object.keys(CHANNEL_MAP)
}

module.exports = { resolveChannelPath, getSupportedChannels, DEFAULT_CHANNEL }
