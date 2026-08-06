'use strict'

const { PAPER_SIZE_MAP } = require('./shared/paper-registry')

// ============================
// 支持的文件扩展名
// ============================
const SUPPORTED_EXTENSIONS = ['.pdf', '.ofd', '.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif']

// 文件对话框过滤器（统一定义）
const FILE_DIALOG_FILTERS = [
  { name: '所有支持的文件', extensions: ['pdf', 'ofd', 'jpg', 'jpeg', 'png', 'bmp', 'tiff', 'tif'] },
  { name: 'PDF 文件', extensions: ['pdf'] },
  { name: 'OFD 文件', extensions: ['ofd'] },
  { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'tiff', 'tif'] },
]

// ============================
// 日期格式化（唯一权威定义）
// rename-utils.js、archive-utils.js 均引用此处
// 前端 SettingsWindow.jsx 的 DATE_FORMAT_OPTIONS 对应此映射
// ============================
const DATE_FORMAT_MAP = {
  none:           '',
  YYYYMMDD:       (Y, M, D) => `${Y}${M}${D}`,
  'YYYY年MM月DD日': (Y, M, D) => `${Y}年${M}月${D}日`,
  'YYYY年MM月DD':  (Y, M, D) => `${Y}年${M}月${D}`,
  'YYYY-MM-DD':    (Y, M, D) => `${Y}-${M}-${D}`,
  'YYYY.MM.DD':    (Y, M, D) => `${Y}.${M}.${D}`,
  'YYYY/MM/DD':    (Y, M, D) => `${Y}/${M}/${D}`,
  'MM月DD日':      (Y, M, D) => `${M}月${D}日`,
  'MM-DD':         (Y, M, D) => `${M}-${D}`,
  'MMDD':          (Y, M, D) => `${M}${D}`,
  'MM/DD':         (Y, M, D) => `${M}/${D}`,
}

/**
 * 将 YYYY-MM-DD 格式的日期字符串转为指定格式
 * @param {string} dateStr - 原始日期字符串（如 "2024-01-15"）
 * @param {string} format - 目标格式键名（如 "YYYYMMDD"）
 * @returns {string}
 */
function formatDate(dateStr, format) {
  if (!dateStr || dateStr === '未知日期') return ''

  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return dateStr

  const fn = DATE_FORMAT_MAP[format]
  return fn ? fn(m[1], m[2], m[3]) : `${m[1]}年${m[2]}月${m[3]}日`
}

/**
 * 将当前日期格式化为指定格式（供 archive-utils.js 等使用）
 * @param {string} format - 目标格式键名
 * @returns {string}
 */
function formatCurrentDate(format) {
  const now = new Date()
  const Y = String(now.getFullYear())
  const M = String(now.getMonth() + 1).padStart(2, '0')
  const D = String(now.getDate()).padStart(2, '0')

  const fn = DATE_FORMAT_MAP[format]
  return fn ? fn(Y, M, D) : `${Y}年${M}月${D}日`
}

// ============================
// 发票字段标签映射（唯一权威定义）
// rename-utils.js、RenameSettings.jsx 均引用此处
// ============================
const FIELD_LABELS = {
  type: '发票类型', fphm: '发票号码',
  kprq: '开票日期', gmfmc: '购买方名称', gmfsh: '购买方税号',
  xsfmc: '销售方名称', xsfsh: '销售方税号',
  amountJe: '发票金额', amountSe: '发票税额',
  amountHj: '价税合计', amountHjDx: '价税合计大写',
  note: '备注', skr: '收款人', fhr: '复核人', kpr: '开票人',
  cus: '自定义内容',
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  FILE_DIALOG_FILTERS,
  PAPER_SIZE_MAP,
  DATE_FORMAT_MAP,
  formatDate,
  formatCurrentDate,
  FIELD_LABELS,
}
