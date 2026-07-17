'use strict'

const dns = require('dns')
const { BaseProvider } = require('./BaseProvider')
const { OFFICIAL_BASE } = require('./OfficialProvider')

const CHANNEL_PATHS = {
  stable: '/stable/',
  rc: '/rc/',
  dev: '/dev/',
}

const ENTERPRISE_DNS_NAME = 'update.company.local'

/**
 * 企业更新源。
 *
 * 更新 URL 优先级：
 *   1. config.enterpriseUpdateUrl（管理员手动配）
 *   2. DNS 自动发现 update.company.local
 *   3. 兜底 → 官方源（隔离网络无内网服务器时仍可从公网更新）
 */
class EnterpriseProvider extends BaseProvider {
  /**
   * @param {object} [options]
   * @param {string}  [options.enterpriseUrl] - 管理员配置的企业 URL
   */
  constructor(options = {}) {
    super()
    this._enterpriseUrl = options.enterpriseUrl || ''
  }

  async resolve(channel) {
    const path = CHANNEL_PATHS[channel] || CHANNEL_PATHS.stable
    const base = await this._resolveBase()
    return { url: `${base.replace(/\/+$/, '')}${path}` }
  }

  async _resolveBase() {
    // 1. 管理员手动配置 URL
    if (this._enterpriseUrl) return this._enterpriseUrl.replace(/\/+$/, '')

    // 2. DNS 自动发现
    const auto = await this._dnsDetect()
    if (auto) return auto

    // 3. 兜底——官方源
    return OFFICIAL_BASE
  }

  _dnsDetect() {
    return new Promise((resolve) => {
      dns.lookup(ENTERPRISE_DNS_NAME, { all: false }, (err, address) => {
        if (err || !address) return resolve(null)
        console.log(`[EnterpriseProvider] DNS 发现: ${ENTERPRISE_DNS_NAME} → ${address}`)
        resolve(`http://${ENTERPRISE_DNS_NAME}`)
      })
    })
  }
}

module.exports = { EnterpriseProvider, ENTERPRISE_DNS_NAME }
