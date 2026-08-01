/**
 * previewPrefetcher — 预览资源预热（Step 6B-3 v1）
 *
 * 职责（极窄）：
 *   输入 preview URL 数组，后台把 render resource 变热。
 *   通过 <img>（decoding=async，与 ViewerViewport 真实展示路径一致）加载：
 *   - 浏览器写 HTTP cache
 *   - 后端 render_engine 生成并写 render cache
 *   用户点击相邻文件时 <img src> 直接命中（双热）。
 *
 * 明确不做：
 *   ❌ 判断附近文件（Policy 在调用方，如 App 的相邻文件计算）
 *   ❌ 缓存管理 / LRU / Blob / ObjectURL / Memory cache
 *   ❌ viewer state / render 生命周期管理
 *
 * 取消语义（用户规格）：
 *   cancel() 只丢弃「未开始」的任务；已发出的 <img> 请求不打断
 *   （已发出的请求已触发后端 render cache 预热，无害）。
 *
 * @module utils/previewPrefetcher
 */

const DEFAULT_CONCURRENCY = 2

/**
 * 在空闲时后台预热一批 preview URL。
 *
 * @param {string[]} urls - preview 资源 URL（必须与真实打开完全一致，命中才有效）
 * @param {Object} [opts]
 * @param {number} [opts.concurrency=2] - 同时进行的 <img> 加载数（render_engine 压力控制）
 * @returns {() => void} cancel - 取消未开始的任务（已发出的不打断）
 */
export function prefetchPreviewUrls(urls, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  if (!Array.isArray(urls) || urls.length === 0) return () => {}

  let cancelled = false
  let queue = [...urls]

  const run = () => {
    if (cancelled) return
    let active = 0
    const startNext = () => {
      if (cancelled || queue.length === 0) return
      const url = queue.shift()
      active += 1
      const img = new Image()
      img.decoding = 'async' // 与 ViewerViewport <img decoding="async"> 一致
      img.onload = () => { active -= 1; startNext() }
      img.onerror = () => { active -= 1; startNext() } // 失败不阻塞队列（fire-and-forget）
      img.src = url
    }
    const n = Math.min(concurrency, queue.length)
    for (let i = 0; i < n; i += 1) startNext()
  }

  // idle 触发：不抢主线程；1s 超时兜底（idle 长时间不来也要开始）。
  if (typeof requestIdleCallback === 'function') {
    const idleId = requestIdleCallback(run, { timeout: 1000 })
    return () => {
      cancelled = true
      queue = []
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idleId)
    }
  }
  const timer = setTimeout(run, 0)
  return () => {
    cancelled = true
    queue = []
    clearTimeout(timer)
  }
}
