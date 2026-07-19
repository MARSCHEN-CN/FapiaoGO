/**
 * Export Render 常量（D2-2-c1）。
 *
 * EXPORT_DPI：物理输出分辨率，独立于 Preview DPI（72/96）。
 *   createPlacement 产出的 scale/offset 由 contentRect 尺寸决定，必须 @EXPORT_DPI 重算，
 *   绝不能转发 Preview @72 的 command —— 否则内容会被缩到纸张角落
 *   （见 docs/architecture/d2-2-c0-export-migration-design.md 陷阱 A）。
 *
 * EXPORT_RENDER_ENABLED：RenderCommand 管线主开关，默认 true（D4-2 起渲染管线成为主路径）。
 *   D4-3 删除 legacy 前保持双路径并存；useExport 在 flag 开启但 Preview 几何状态缺失时
 *   仍回落 legacy /api/export-pdf（保险出口）。
 *   node-safe：仅读 process.env（浏览器中 process 为 undefined → 默认 true）；
 *   紧急情况下设 EXPORT_RENDER_ENABLED=false 可强制走 legacy（kill-switch）。
 */

export const EXPORT_DPI = 300

export const EXPORT_RENDER_ENABLED =
  (typeof process !== 'undefined' && process.env && process.env.EXPORT_RENDER_ENABLED === 'false')
    ? false
    : true
