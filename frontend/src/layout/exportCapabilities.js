/**
 * exportCapabilities.js — D4-2.1 Render Export 能力守卫
 *
 * 把「哪些输入类型能走 RenderCommand 导出管线」从审计文档（d4-3-0）搬进运行时契约。
 * 当前事实（见 d4-3-0-export-legacy-usage-audit.md）：
 *   - render 路径覆盖 PDF（fitz insert_pdf 透传）+ Image（source_adapter → insert_image）
 *   - OFD 在 render 路径零处理器（source_adapter.py 'later OFD'，D3-3c 推迟）
 *   - legacy /api/export-pdf 的 OfdExportHandler 是当前唯一能导出 OFD 的通路
 * 结论：含 OFD 的导出批次必须回落 legacy，否则 OFD 导出会断。
 *
 * 设计边界（重要，勿混淆）：
 *   - 此处只表达「能力矩阵」缺口（OFD）。
 *   - image 的 rotation/fit/clip 缺口（D3-3-0）是**另一个** capability，不要在此阻塞 image。
 *     未来若要排除 rotatedImage，扩展 RENDER_EXPORT_CAPABILITIES 即可，勿与 OFD 耦合。
 */

// render 管线支持能力矩阵。true = 可走 /api/export-render。
// 当前：pdf/image 支持，ofd 不支持（D3-3c 把 OFD 接入 render 路径后翻 ofd: true）。
const RENDER_EXPORT_CAPABILITIES = {
  pdf: true,
  image: true,
  ofd: false,
}

/**
 * 判断一组文件是否全部能走 render 导出管线。
 * 任一文件格式不被支持 → 整体回落 legacy（避免混合批次部分走 render、部分走 legacy）。
 * @param {Array<{fileFormat?:string}>} [files]
 * @returns {boolean}
 */
export function supportsRenderExport(files) {
  if (!Array.isArray(files) || files.length === 0) return false
  return files.every((f) => {
    const fmt = (f && f.fileFormat) || ''
    return RENDER_EXPORT_CAPABILITIES[fmt] === true
  })
}

/**
 * 完整导出策略 eligibility（D4-2.1 落点）：
 *   flag 开启 且 Preview 几何状态可用 且 所有文件格式受 render 管线支持
 *   → 走 /api/export-render；否则回落 /api/export-pdf。
 * 纯函数、DOM-free，便于 node --test 直接验证（无需 React 运行时）。
 * @param {Object} ctx
 * @param {boolean} [ctx.enabled]
 * @param {*} [ctx.previewState]
 * @param {*} [ctx.settings]
 * @param {Array} [ctx.files]
 * @returns {boolean} true=render path, false=legacy fallback
 */
export function isRenderExportEligible({ enabled, previewState, settings, files }) {
  return Boolean(enabled && previewState && settings && supportsRenderExport(files))
}
