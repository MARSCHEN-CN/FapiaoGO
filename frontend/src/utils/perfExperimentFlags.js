/**
 * Preview Switch 性能实验开关 —— 默认全 OFF（零行为变化）。
 *
 * 背景：切换发票 → 展示区加载慢的诊断（outputs/switch-slow-root-cause.md）
 * 定位到多个嫌疑项。为遵守「单变量验证」纪律，每个嫌疑项做成独立开关，
 * 逐个开启、逐个测量，避免一次性改动后无法归因。
 *
 * 纪律（与 previewTrace / perfProbe 一致）：
 *   • 默认全部 OFF —— 合并后行为与改动前逐字节一致；
 *   • 只在 localStorage 显式打开时生效 —— 真机 DevTools 一行开启，刷新或切文件即生效；
 *   • 每次读取实时求值 —— 无需重启应用即可开关，便于 A/B 来回切换对比。
 *
 * 开启方式（DevTools Console，单行）：
 *   localStorage.setItem('fapiao.perf.disableLegacyReProbe','1')
 *   localStorage.setItem('fapiao.perf.disableFrontendPrefetch','1')
 *   localStorage.setItem('fapiao.perf.disableLegacyReProbe','0')   // 关闭（还原）
 *
 * @module utils/perfExperimentFlags
 */

const KEY_PREFIX = 'fapiao.perf.'

/**
 * 实时读取开关。localStorage 不可用（隐私模式 / SSR / 测试）时一律返回 false，
 * 即「拿不到开关 ⇒ 保持既有行为」，绝不因读取失败而改变渲染路径。
 *
 * @param {string} name - 开关名（不含前缀）
 * @returns {boolean}
 */
function readFlag(name) {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + name)
    return raw === '1' || raw === 'true'
  } catch (_e) {
    return false
  }
}

/**
 * P1-A：关闭遗留 usePreview 的 RE probe。
 *
 * 事实链（代码审计确认）：
 *   展示区（DocumentViewer → ViewerViewport → <img>）请求的 URL 不带 spec →
 *     后端 /preview 解析 render_spec = None → spec_tag = '' → cache_key = legacy；
 *   遗留 usePreview 的 RE probe URL 由 buildRenderSpec 追加 ?spec=&spec_sig= →
 *     后端解析出 render_spec 非 None → engine.py:321 spec_tag 非空 → **另一个 cache_key**，
 *     且执行路径分叉为 X-Render-Executor: renderspec（vs legacy）。
 *   ⇒ 一次切换 = 两次真实渲染 + 两条缓存条目。
 *
 * 开启后：DocumentViewer 激活时不再发起 probe 请求（不发 HTTP、不解码、不渲染）。
 */
export function isLegacyReProbeDisabled() {
  return readFlag('disableLegacyReProbe')
}

/**
 * P1-B：关闭前端文件间预取（App.jsx ±PREFETCH_RANGE=3，最多 6 个 /preview 请求）。
 *
 * 注意：这与后端 prefetch_neighbors 是**两件不同的事**——后端那个是「页内 ±1」
 * （单页发票 neighbor_pages 为空、不产生任何任务），前端这个是「文件间 ±3」。
 */
export function isFrontendPrefetchDisabled() {
  return readFlag('disableFrontendPrefetch')
}

/**
 * 调试辅助：一次性导出当前所有开关状态，便于 DevTools 核对实验组合。
 * @returns {Object}
 */
export function dumpPerfFlags() {
  return {
    disableLegacyReProbe: isLegacyReProbeDisabled(),
    disableFrontendPrefetch: isFrontendPrefetchDisabled(),
  }
}
