/**
 * Preview 渲染目标解析 —— 纯函数，便于单测与在渲染 effect 中统一调用。
 *
 * 不变式（修复 print706 preview 切换陈旧 <img> bug 的核心纪律）：
 *   previewUrl 状态必须 === getRenderEnginePreviewUrl(previewFile)
 *   - RE 文件（有 http 预览 URL）→ 该 URL
 *   - 其它（canvas / pdfjs / 图片 blob / docId 缺失）→ null
 *
 * 违反该不变式会导致：切换到 canvas 路径文件时，previewUrl 残留上一个 RE 文件的
 * URL，PreviewCanvas 的 `if (previewUrl && displayInfo)` 误判为 RE 路径，
 * 用旧文件的 <img> 覆盖本文件，表现为「切回第一张卡在第二张内容 / 左上角缺失」。
 */

/**
 * @param {string} url - previewFile._previewImageUrl
 * @returns {boolean} 是否为 Render Engine 的 http 预览 URL
 */
export function isRenderEngineUrl(url) {
  return typeof url === 'string' && url.startsWith('http')
}

/**
 * 计算某文件应当使用的 RE 预览 URL（无则 null）。
 * 与 usePreview.js 渲染 effect 中 hasRenderEngineUrl 的判定保持一致。
 *
 * @param {Object} previewFile
 * @param {boolean} useRenderEnginePreview - 全局开关 USE_RENDER_ENGINE_PREVIEW
 * @returns {string|null}
 */
export function getRenderEnginePreviewUrl(previewFile, useRenderEnginePreview) {
  if (!useRenderEnginePreview) return null
  const url = previewFile && previewFile._previewImageUrl
  return isRenderEngineUrl(url) ? url : null
}
