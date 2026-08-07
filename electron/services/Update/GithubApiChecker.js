'use strict'

const https = require('https')
const http = require('http')

/**
 * GithubApiChecker — 通过 GitHub REST API 检查新版本。
 *
 * 主备双源策略：
 *   1. 直连 api.github.com（海外网络友好）
 *   2. 失败后回退 gh-proxy.com（国内加速代理）
 *
 * 仅负责"检查"，不处理下载/安装——下游可复用 electron-updater 或原生下载。
 */

const GITHUB_API = 'https://api.github.com'
const GH_PROXY = 'https://gh-proxy.com'

const DEFAULT_TIMEOUT_MS = 10000
const COMPARE_BASE = /^v?(\d+\.\d+\.\d+)/

/**
 * @param {object}   params
 * @param {string}   params.owner       GitHub 组织/用户名
 * @param {string}   params.repo        GitHub 仓库名
 * @param {string}   params.currentVersion 当前版本号（如 "1.2.3"）
 * @param {number}   [params.timeoutMs=10000] 单次请求超时
 * @param {boolean}  [params.allowPrerelease=false] 是否接受 prerelease
 */
async function checkForUpdates({ owner, repo, currentVersion, timeoutMs = DEFAULT_TIMEOUT_MS, allowPrerelease = false }) {
  if (!owner || !repo) {
    return { available: false, reason: 'missing_owner_or_repo' }
  }

  const primaryUrl = `${GITHUB_API}/repos/${owner}/${repo}/releases/latest`
  const proxyUrl = `${GH_PROXY}/api.github.com/repos/${owner}/${repo}/releases/latest`

  // Step 1: 直连 api.github.com
  try {
    const release = await _fetchJson(primaryUrl, timeoutMs)
    return _parseRelease(release, currentVersion, allowPrerelease, 'primary')
  } catch (primaryErr) {
    console.warn(`[GithubApiChecker] 主源 (api.github.com) 失败: ${primaryErr.message}`)
  }

  // Step 2: 回退 gh-proxy.com
  try {
    const release = await _fetchJson(proxyUrl, timeoutMs)
    return _parseRelease(release, currentVersion, allowPrerelease, 'proxy')
  } catch (proxyErr) {
    console.warn(`[GithubApiChecker] 回退源 (gh-proxy.com) 也失败: ${proxyErr.message}`)
  }

  return { available: false, reason: 'all_sources_failed' }
}

/**
 * HTTP GET JSON，支持 https/http，带超时。
 */
function _fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'FapiaoGO-Updater/1.0',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8')
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}`))
        }
      })
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`timeout after ${timeoutMs}ms`))
    })

    req.on('error', reject)
  })
}

/**
 * 解析 GitHub release 响应，判断是否有新版本。
 */
function _parseRelease(release, currentVersion, allowPrerelease, source) {
  if (!release || !release.tag_name) {
    return { available: false, reason: 'no_release', source }
  }

  if (!allowPrerelease && (release.prerelease || release.draft)) {
    console.log(`[GithubApiChecker] 跳过 prerelease/draft: ${release.tag_name}`)
    return { available: false, reason: 'prerelease_skipped', source }
  }

  const remoteVersion = _extractVersion(release.tag_name)
  if (!remoteVersion) {
    return { available: false, reason: 'unparseable_version', source }
  }

  const cmp = _semverCompare(remoteVersion, currentVersion)
  if (cmp <= 0) {
    return { available: false, reason: 'already_latest', version: remoteVersion, source }
  }

  // 寻找适合的资产（Windows .exe / .zip）
  const assets = (release.assets || [])
    .filter((a) => /\.(exe|zip)$/i.test(a.name))
    .map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))

  return {
    available: true,
    version: remoteVersion,
    tagName: release.tag_name,
    releaseUrl: release.html_url,
    releaseNotes: release.body || '',
    publishedAt: release.published_at,
    assets,
    source,  // 'primary' | 'proxy' — 告知调用方使用的是哪个源
  }
}

/**
 * 从 tag name 提取版本号（支持 v1.2.3 → 1.2.3）。
 */
function _extractVersion(tagName) {
  const m = tagName.match(COMPARE_BASE)
  return m ? m[1] : null
}

/**
 * 简易 semver 比较：a > b 返回 1，a < b 返回 -1，相等返回 0。
 * 支持纯数字版本（如 "1.2.3"）。
 */
function _semverCompare(a, b) {
  const pa = (a || '0').split('.').map(Number)
  const pb = (b || '0').split('.').map(Number)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

module.exports = { checkForUpdates, GITHUB_API, GH_PROXY }