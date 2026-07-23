'use strict'

/**
 * 重命名工具函数模块
 * 提取自 main.js 中 rename-invoices 和 pack-invoices 的共享逻辑
 * FIELD_LABELS、formatDate 统一引用自 electron/constants.js
 */
const { FIELD_LABELS, formatDate } = require('./constants')

// Windows 文件名非法字符正则
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\n\r\t]/g
// 多个连续下划线/分隔符
const CONSECUTIVE_SEPARATORS = /_{2,}/g

/**
 * 清洗单个文件名片段：移除非法字符、去除首尾空格和点、限制长度
 * @param {string} str
 * @param {number} [maxLen=80] 单个片段最大长度
 * @returns {string}
 */
function sanitizeFilenamePart(str, maxLen = 80) {
  if (!str) return ''
  let cleaned = String(str)
    .replace(INVALID_FILENAME_CHARS, '_')
    .trim()
    .replace(/\.+$/, '')  // 去除尾部点
    .replace(/^\.+/, '')  // 去除首部点
  if (cleaned.length > maxLen) {
    cleaned = cleaned.substring(0, maxLen)
  }
  return cleaned
}

/**
 * 根据字段 key 和发票数据，生成该字段的文本内容
 * @param {string} fieldKey - 字段标识
 * @param {Object} invoiceFields - 发票字段数据
 * @param {number} fieldIndex - 字段索引
 * @param {Object} fieldDef - 字段定义（可能包含 dateFormat, customText）
 * @returns {string}
 */
function getFieldText(fieldKey, invoiceFields, fieldIndex, fieldDef) {
  if (!invoiceFields) return ''

  switch (fieldKey) {
    case 'type': return sanitizeFilenamePart(invoiceFields.type)
    case 'fphm': return sanitizeFilenamePart(invoiceFields.fphm)
    case 'kprq': {
      const rawDate = invoiceFields.kprq || ''
      const dateFormat = fieldDef?.dateFormat || 'YYYY年MM月DD日'
      return formatDate(rawDate, dateFormat)
    }
    case 'gmfmc': return sanitizeFilenamePart(invoiceFields.gmfmc)
    case 'gmfsh': return sanitizeFilenamePart(invoiceFields.gmfsh)
    case 'xsfmc': return sanitizeFilenamePart(invoiceFields.xsfmc)
    case 'xsfsh': return sanitizeFilenamePart(invoiceFields.xsfsh)
    case 'amountJe': return sanitizeFilenamePart(invoiceFields.amountJe)
    case 'amountSe': return sanitizeFilenamePart(invoiceFields.amountSe)
    case 'amountHj': return sanitizeFilenamePart(invoiceFields.amountHj)
    case 'amountHjDx': return sanitizeFilenamePart(invoiceFields.amountHjDx)
    case 'note': return sanitizeFilenamePart(invoiceFields.note)
    case 'skr': return sanitizeFilenamePart(invoiceFields.skr)
    case 'fhr': return sanitizeFilenamePart(invoiceFields.fhr)
    case 'kpr': return sanitizeFilenamePart(invoiceFields.kpr)
    case 'cus': return sanitizeFilenamePart(fieldDef?.customText)
    default: return ''
  }
}

/**
 * 将命名规则字段数组规整为统一结构 [{ key, ... }]
 * 兼容历史版本保存的 string[] 格式（如 ["fphm","kprq"]），
 * 避免 buildNameParts 取到 f.key 为 undefined 而整段被忽略、最终回退为「发票」。
 * @param {Array} fields
 * @returns {Array} 规整后的字段数组
 */
function normalizeRenameFields(fields = []) {
  if (!Array.isArray(fields)) return []
  return fields
    .map((f) => {
      if (typeof f === 'string') return { key: f }
      if (f && typeof f === 'object') return f
      return null
    })
    .filter(Boolean)
}

/**
 * 根据发票字段和命名规则，拼接文件名主体部分（不含扩展名）
 * @param {Object} invoiceFields - 发票字段数据
 * @param {Array} fields - 命名规则字段数组 [{ key, dateFormat?, customText? }, ...]
 * @param {Object} options
 * @param {string} [options.separator='_'] - 字段间分隔符
 * @param {boolean} [options.showIndex=false] - 是否显示序号
 * @param {boolean} [options.showPrefix=false] - 是否显示字段标签
 * @returns {string} 拼接后的文件名主体（不含扩展名），可能为空字符串
 */
function buildNameParts(invoiceFields, fields, { separator = '_', showIndex = false, showPrefix = false } = {}) {
  fields = normalizeRenameFields(fields)
  const parts = []
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    const key = f.key
    let text = getFieldText(key, invoiceFields, i, f)
    if (!text) continue

    let part = ''
    if (showIndex) part += `${i + 1}.`
    if (showPrefix) part += (FIELD_LABELS[key] || key) + ':'
    part += text
    parts.push(part)
  }

  let result = parts.join(separator)
  // 清理非法字符（已在 getFieldText 中清洗，此处二次保障）
  result = result.replace(INVALID_FILENAME_CHARS, '_')
  // 合并连续下划线
  result = result.replace(CONSECUTIVE_SEPARATORS, '_')
  // 截断超长文件名（Windows MAX_PATH 限制，留 40 字符余量给路径前缀和扩展名）
  if (result.length > 210) {
    result = result.substring(0, 210)
  }
  // 去除尾部点/空格（Windows 不允许）
  result = result.replace(/[\.\s]+$/, '')
  if (!result) {
    // 字段全部缺失时，回退到发票号/购买方名称等可辨识信息，避免整批撞名「发票」
    result = sanitizeFilenamePart(invoiceFields.fphm || invoiceFields.gmfmc || '未命名发票')
  }
  return result
}

module.exports = { FIELD_LABELS, formatDate, getFieldText, buildNameParts, sanitizeFilenamePart, normalizeRenameFields }
