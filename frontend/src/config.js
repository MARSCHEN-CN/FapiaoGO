// ============================
// 应用配置常量
// ============================

// ── 打印管线版本开关 ──
// 'source' = 源文件直通 Sumatra（新管线）
// 'legacy' = 旧管线（Canvas→PNG→PDF→Sumatra，可回滚）
export const PRINT_PIPELINE = {
  mode: 'source',    // 'source' | 'legacy'
  backend: 'sumatra', // 'sumatra' | 'electron'
}

// ── PrintSettings 默认值（landscape 已废弃，由 detectOrientation 自动判断） ──
export const PRINT_SETTINGS_DEFAULTS = {
  rotation: 0,
  fit: 'contain',
  paper: 'A4',
  margin: 'default',
  duplex: false,
  grayscale: false,
  copies: 1,
}

export const BACKEND_URL = import.meta.env?.VITE_BACKEND_URL || 'http://localhost:5000'

// ─── Render Engine Preview（Phase 1 Feature Flag）─────────────────
// true  = usePreview 走 /preview/{doc_id} HTTP 渲染
// false = 回退 pdf.js + Canvas 旧链路
export const USE_RENDER_ENGINE_PREVIEW = true

/**
 * 构建 Render Engine 预览 URL。
 *
 * @param {string} docId   内容寻址的文档 ID（sha256(file_bytes+filename)[:24]）
 * @param {number} page    页码（已进入 URL，是资源身份的一部分）
 * @param {string} vsHash  视图状态哈希（预留，Highlight 阶段启用，当前未使用）
 *
 * 设计约束（immutable 缓存正确性）：URL 必须唯一确定最终输出字节。
 * 凡是影响渲染字节的参数，必须在 URL 中体现——直接 ?page= 或用 ?vs=<hash>
 * 折叠进视图状态哈希。否则 immutable 会让浏览器对同一 URL 永远返回陈旧字节，
 * 且不会发起 304 协商来纠正。
 *
 * vsHash 的设计价值：rotation / highlight / crop / invert / 未来批注 全部折叠进
 * 一个视图状态哈希，URL API 永不膨胀。真正实现 Highlight 时，再让 vsHash 进入
 * URL 并让 /preview 路由解析 ?vs=，此刻保持预留、不启用。
 */
export const buildPreviewUrl = (docId, page = 1, vsHash = '') => {
  let url = `${BACKEND_URL}/preview/${docId}?page=${page}`
  if (vsHash) url += `&vs=${vsHash}`
  return url
}

// ─── 安全边距预设 ─────────────────────────────────────────────────
export const MARGIN_PRESETS = {
  default:    { label: '普通安全边距', left: 3, right: 3, top: 3, bottom: 3 },
  binding:    { label: '装订加宽',     left: 8, right: 3, top: 3, bottom: 3 },
  label:      { label: '标签/票据',    left: 3, right: 3, top: 10, bottom: 3 },
  leftOffset: { label: '打印机左偏',   left: 5, right: 2, top: 3, bottom: 3 },
  borderless: { label: '无边距',       left: 0, right: 0, top: 0, bottom: 0 },
  custom:     { label: '自定义',       left: 3, right: 3, top: 3, bottom: 3 },
}

// 缩放档位
export const ZOOM_STEPS = [25, 50, 75, 100, 125, 150, 200]

// 支持的文件扩展名
export const SUPPORTED_EXTENSIONS = [
  '.pdf', '.ofd', '.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif',
]

// 预览 DPI（屏幕显示用， 300在高分屏上更清晰）
export const PREVIEW_DPI = 300
// 全局 Canvas 预览 DPI（可低于 PREVIEW_DPI 以节省内存）
export const GLOBAL_PREVIEW_DPI = 150
// 打印 DPI（保持300保证打印质量）
export const PRINT_DPI = 300

// ─── 纸张注册表 ───────────────────────────────────────────────────
// 数据源自 electron/shared/paper-registry.js (CJS, Electron 后端用)
// 前端直接内联数据，避免跨 CJS/ESM 模块边界导入

/** @type {Array<{id:string,label:string,widthMM:number,heightMM:number,source:string}>} */
const REGISTRY_DATA = [
  { id: 'A4',            label: 'A4',                  widthMM: 210,   heightMM: 297,   source: 'system' },
  { id: 'A5',            label: 'A5',                  widthMM: 148,   heightMM: 210,   source: 'system' },
  { id: 'A3',            label: 'A3',                  widthMM: 297,   heightMM: 420,   source: 'system' },
  { id: 'Letter',        label: 'Letter',              widthMM: 215.9, heightMM: 279.4, source: 'system' },
  { id: 'Voucher240x140',label: '凭证纸',    widthMM: 240,   heightMM: 140,   source: 'system' },
  { id: 'Custom',        label: '自定义尺寸',           widthMM: 0,     heightMM: 0,     source: 'system' },
]

const labelMap = {}
const sizeMap = {}
for (const p of REGISTRY_DATA) {
  if (p.widthMM > 0) sizeMap[p.id] = { widthMM: p.widthMM, heightMM: p.heightMM }
  labelMap[p.id] = p.label
}
// Merge mode pseudo-entry (not a real paper size, only used in frontend)
labelMap['A4Merge2'] = 'A4×2'

export const PAPER_REGISTRY = REGISTRY_DATA
export const PAPER_SIZE_MAP = sizeMap
export const PAPER_LABEL_MAP = labelMap
