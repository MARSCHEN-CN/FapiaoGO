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

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000'

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
