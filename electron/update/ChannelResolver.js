'use strict'

/**
 * ChannelResolver — 渠道名字 → URL path 段
 *
 * 程序只认识 stable / rc / dev 三个名字，不解构 URL。
 * 以后加 nightly / beta 等只改这里，下游完全无感知。
 */
const CHANNEL_MAP = {
  stable: '/stable/',
  rc: '/rc/',
  dev: '/dev/',
}

const DEFAULT_CHANNEL = 'stable'

/**
 * @param {string} [channel]
 * @returns {string} URL path，如 "/stable/"
 */
function resolveChannelPath(channel) {
  const name = (channel && CHANNEL_MAP[channel]) ? channel : DEFAULT_CHANNEL
  return CHANNEL_MAP[name]
}

/**
 * @returns {string[]} 所有支持的渠道名
 */
function getSupportedChannels() {
  return Object.keys(CHANNEL_MAP)
}

module.exports = { resolveChannelPath, getSupportedChannels, DEFAULT_CHANNEL }
