'use strict'

const dns = require('dns')
const OFFICIAL_BASE = 'https://update.fapiaogo.com'

// 企业自动发现的 DNS 名称
const ENTERPRISE_DNS_NAME = 'update.company.local'

const SOURCE_NAMES = {
  official: 'official',
  enterprise: 'enterprise',
}

/**
 * 解析更新源的 base URL。
 *
 * @param {'official'|'enterprise'} sourceType
 * @param {string} [enterpriseUrl] - 企业管理员配置的 URL（如 http://10.0.0.5/update/）
 * @returns {Promise<string>} 完整的 base URL（不含 channel path）
 */
async function resolveSourceUrl(sourceType, enterpriseUrl) {
  if (sourceType === SOURCE_NAMES.enterprise) {
    // 1. 优先使用管理员手动配置的 URL
    if (enterpriseUrl) {
      return enterpriseUrl.replace(/\/+$/, '') // 去尾部斜杠
    }

    // 2. DNS 自动发现：如果 update.company.local 可解析，自动切企业源
    const autoUrl = await tryDnsDetect()
    if (autoUrl) return autoUrl
  }

  // 兜底：官方源
  return OFFICIAL_BASE
}

/**
 * DNS 自动发现企业更新服务器。
 * 内部网络配一条 DNS A 记录（update.company.local → 10.0.0.5）即可，
 * 管理员无需在每台机器上配置 URL。
 */
function tryDnsDetect() {
  return new Promise((resolve) => {
    dns.lookup(ENTERPRISE_DNS_NAME, { all: false }, (err, address) => {
      if (err || !address) {
        resolve(null)
      } else {
        console.log(`[SourceResolver] DNS 自动发现企业更新服务器: ${ENTERPRISE_DNS_NAME} → ${address}`)
        resolve(`http://${ENTERPRISE_DNS_NAME}`)
      }
    })
  })
}

function getSupportedSources() {
  return Object.values(SOURCE_NAMES)
}

module.exports = {
  resolveSourceUrl,
  getSupportedSources,
  SOURCE_NAMES,
  OFFICIAL_BASE,
}
