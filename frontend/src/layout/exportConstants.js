/**
 * Export Render 常量（D2-2-c1）。
 *
 * EXPORT_DPI：物理输出分辨率，独立于 Preview DPI（72/96）。
 *   createPlacement 产出的 scale/offset 由 contentRect 尺寸决定，必须 @EXPORT_DPI 重算，
 *   绝不能转发 Preview @72 的 command —— 否则内容会被缩到纸张角落
 *   （见 docs/architecture/d2-2-c0-export-migration-design.md 陷阱 A）。
 *
 * EXPORT_RENDER_ENABLED：灰度开关，默认 false（legacy /api/export-pdf 仍主用）。
 *   D4 删除 legacy 前保持双路径并存；置 true 切到 RenderCommand 管线。
 *   通过环境变量 EXPORT_RENDER_ENABLED=true 翻转。
 *   node-safe：仅读 process.env（浏览器中 process 为 undefined → 恒 false），不引 import.meta.env。
 */
export const EXPORT_DPI = 300

export const EXPORT_RENDER_ENABLED =
  (typeof process !== 'undefined' && process.env && process.env.EXPORT_RENDER_ENABLED === 'true') ||
  false
