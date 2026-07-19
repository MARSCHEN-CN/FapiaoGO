/**
 * invoicePostProcessor — 发票导入后处理器
 *
 * 职责：
 *   对导入完成的文件执行后处理：重复检测 + 排序。
 *   纯函数，不涉及 React state / Store 写入。
 *
 * 调用方（useFileOps / processFilesForAddition）负责：
 *   - 传入 files 数组
 *   - 将处理结果写入 ImportSessionStore 或 React state
 *
 * @module processors/invoicePostProcessor
 */

import { detectDuplicateInvoices, applySort, getPreviousYearInfo } from '../utils'

/**
 * @typedef {Object} PostProcessResult
 * @property {Array} files - 处理后的文件列表
 * @property {Map} duplicateInfo - 重复发票分组信息
 */

/**
 * 处理导入完成的文件列表。
 *
 * @param {Array} files - 当前文件列表（含解析结果）
 * @param {string} sortBy - 排序字段
 * @param {string} sortOrder - 排序方向（'asc'/'desc'）
 * @returns {PostProcessResult}
 */
export function processImportedFiles(files, sortBy, sortOrder) {
  const duplicates = detectDuplicateInvoices(files)
  const duplicateInfo = new Map()
  duplicates.forEach((dupFiles, groupIndex) => {
    dupFiles.forEach((file, idx) => {
      duplicateInfo.set(file.key, { groupIndex, isFirst: idx === 0 })
    })
  })
  return {
    files: applySort(files, sortBy, sortOrder, duplicateInfo, getPreviousYearInfo(files)),
    duplicateInfo,
  }
}
