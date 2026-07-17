'use strict'

/**
 * BaseProvider — 更新源 Provider 的基类 / 接口规范。
 *
 * 所有 Provider 实现：
 *   resolve(channel) → { url: string }
 *
 * channel 是类似 "stable"/"rc"/"dev" 的渠道名。
 * Provider 自己决定如何把渠道名映射到最终 URL 的哪个 path。
 */

class BaseProvider {
  /**
   * @param {'stable'|'rc'|'dev'} channel
   * @returns {{ url: string }}
   * @abstract
   */
  resolve(channel) {
    throw new Error('Subclass must implement resolve(channel)')
  }
}

module.exports = { BaseProvider }
