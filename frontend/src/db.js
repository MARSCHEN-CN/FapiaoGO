// frontend/src/db.js
// 数据操作通过 HTTP API 调用 Python 后端（不再走 Electron IPC）

import { BACKEND_URL } from './config'

const API = BACKEND_URL || 'http://localhost:5000'
const DEFAULT_TIMEOUT_MS = 30000

/**
 * 统一的 DB 错误对象
 */
function dbError(message, code = 'DB_ERROR') {
  return { __error: true, message, code }
}

/**
 * 检查返回值是否为 DB 错误对象
 */
function isDbError(res) {
  return res && typeof res === 'object' && res.__error === true
}

/**
 * 通用 HTTP 请求封装
 *
 * 特性：
 * - 默认 30s 超时（通过 AbortController 实现）
 * - 支持通过 options.timeout 自定义超时时长
 * - 超时/Abort 时返回 DB_ERROR，不会挂起 UI
 */
async function api(path, options = {}) {
  const controller = new AbortController()
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const url = `${API}${path}`
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      ...options,
    })
    clearTimeout(timeoutId)

    if (!res.ok) {
      const errMsg = `HTTP ${res.status}: ${res.statusText}`
      console.error(`[DB] ${path} 失败:`, errMsg)
      return dbError(errMsg, 'HTTP_ERROR')
    }

    const data = await res.json()
    if (data.success === false) {
      console.error(`[DB] ${path} 失败:`, data.error)
      return dbError(data.error, 'API_ERROR')
    }
    return data.data !== undefined ? data.data : data
  } catch (err) {
    clearTimeout(timeoutId)
    const errMsg = err.name === 'AbortError'
      ? `请求超时（${timeoutMs}ms）`
      : err.message
    console.error(`[DB] ${path} 请求失败:`, errMsg)
    return dbError(errMsg, 'NETWORK_ERROR')
  }
}

/**
 * GET 请求（自动拼接查询参数）
 */
async function apiGet(path, params = {}) {
  const qs = new URLSearchParams()
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') {
      qs.set(key, val)
    }
  }
  const qsStr = qs.toString()
  return api(qsStr ? `${path}?${qsStr}` : path)
}

export const db = {
  /** 获取数据库文件路径 */
  getPath() {
    return apiGet('/api/db/path')
  },

  /** 搜索发票 */
  search(filters = {}) {
    return apiGet('/api/db/search', filters)
  },

  /** 获取单条发票
   * @param {string} id 发票 id（迁移后为 uuid hex 字符串，非数字）
   * 下同 deleteInvoice / restoreInvoice / update 的 id 参数均为字符串
   */
  get(id) {
    return apiGet(`/api/db/invoice/${id}`)
  },

  /** 统计汇总 */
  statistics() {
    return apiGet('/api/db/statistics')
  },

  /** 软删除 */
  deleteInvoice(id) {
    return api(`/api/db/invoice/${id}`, { method: 'DELETE' })
  },

  /** 恢复软删除 */
  restoreInvoice(id) {
    return api(`/api/db/invoice/${id}/restore`, { method: 'POST' })
  },

  /** 更新标签/分类/备注等字段 */
  update(id, fields) {
    return api(`/api/db/invoice/${id}`, {
      method: 'PUT',
      body: JSON.stringify(fields),
    })
  },

  /** 去重检查 */
  findDuplicates(number) {
    return apiGet(`/api/db/duplicates/${encodeURIComponent(number)}`)
  },

  /** 插入或更新发票记录（按 hash 去重） */
  upsert(row) {
    return api('/api/db/upsert', {
      method: 'POST',
      body: JSON.stringify(row),
    })
  },

  /** 读取配置 */
  getConfig(key) {
    return apiGet('/api/config/get', { key })
  },

  /** 写入配置 */
  setConfig(key, value) {
    return api(`/api/config/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    })
  },

  /** 通用 SELECT 查询（已废弃，使用 search 替代） */
  query(_sql, _params = []) {
    console.warn('[DB] query() 已废弃，请使用 search() 替代')
    return Promise.resolve([])
  },

  /** 通用写入（已废弃，使用具体方法替代） */
  run(_sql, _params = []) {
    console.warn('[DB] run() 已废弃，请使用 upsert/update/deleteInvoice 替代')
    return Promise.resolve({ changes: 0 })
  },
}

// 导出错误检查工具供调用方使用
export { isDbError, dbError }
