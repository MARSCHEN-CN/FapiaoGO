/**
 * fallbackParseRunner — 逐个文件解析执行器
 *
 * 当批量解析接口不可用时，作为逐文件回退路径。
 * 职责：文件读取 → fetch → 重试 → ParseResult
 *
 * 不负责：
 *   ❌ React state
 *   ❌ ImportSessionStore
 *   ❌ 进度管理
 *   ❌ 文件列表操作
 *
 * @module runners/fallbackParseRunner
 */

import { BACKEND_URL } from '../config'
import { prepareSingleRequest } from '../services/ParseBatchClient'
import { createParseResult } from '../models/ParseResult'

const RETRY_DELAY_MS = 2000

/**
 * 执行单文件解析（含重试），返回 ParseResult。
 *
 * @param {{ fileObj: object }} task - 解析任务（含 file, name, path, key 等）
 * @param {{ ipc: object, autoOrient: boolean, maxRetry?: number }} options
 * @returns {Promise<{ success: boolean, result?: object, error?: string, status: string }>}
 */
export async function runFallbackParseTask(task, { ipc, autoOrient, maxRetry = 1 }) {
  const { fileObj } = task
  const MAX_RETRY = maxRetry
  let retries = 0
  let lastError = null

  while (retries <= MAX_RETRY) {
    try {
      // ── 准备请求 ────────────────────────────────────
      const request = await prepareSingleRequest(fileObj, { ipc, autoOrient })
      if (!request) {
        return { success: false, error: '无法读取文件: ' + fileObj.name, status: 'error' }
      }

      const { url, formData } = request

      // ── 发送请求 ────────────────────────────────────
      const resp = await fetch(url, { method: 'POST', body: formData })

      // ── 429 限流 → 重试 ────────────────────────────
      if (resp.status === 429) {
        if (retries < MAX_RETRY) {
          console.log(`[fallbackParse] 服务器繁忙，等待 ${RETRY_DELAY_MS}ms 后重试: ${fileObj.key}`)
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
          retries++
          continue
        }
        return { success: false, error: '服务器繁忙，请稍后重试', status: 'error' }
      }

      // ── 非 200 → 错误 ──────────────────────────────
      if (!resp.ok) {
        const errMsg = `解析失败: HTTP ${resp.status}`
        if (retries < MAX_RETRY) {
          console.log(`[fallbackParse] ${errMsg}，重试第 ${retries + 1} 次: ${fileObj.key}`)
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
          retries++
          continue
        }
        return { success: false, error: errMsg, status: 'error' }
      }

      // ── 成功：解析响应 → ParseResult ──────────────
      const data = await resp.json()
      const result = createParseResult(data, fileObj.name)
      return { success: true, result, status: 'parsed' }

    } catch (err) {
      lastError = err
      console.warn('[fallbackParse] 解析异常:', fileObj.key, err.message)

      if (retries < MAX_RETRY) {
        console.log(`[fallbackParse] 重试第 ${retries + 1} 次: ${fileObj.key}`)
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
        retries++
      } else {
        return { success: false, error: lastError?.message || '解析失败', status: 'error' }
      }
    }
  }

  return { success: false, error: '解析失败（重试耗尽）', status: 'error' }
}
