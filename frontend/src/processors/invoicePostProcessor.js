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

import { applySort, getPreviousYearInfo } from '../utils'
import { buildDocumentViewModel, buildPageDuplicateInfo } from '../utils/documentViewModel'

/**
 * @typedef {Object} PostProcessResult
 * @property {Array} files - 处理后的文件列表
 * @property {Map} duplicateInfo - 重复发票分组信息（page key → 组索引投影）
 */

/**
 * 处理导入完成的文件列表。
 *
 * D1：重复检测以 document 为单位（多页发票 = 一个发票 = 不构成重复），
 * 再投影到页 key 供 applySort 分区（同一 document 的页共享组索引，排序后仍相邻）。
 *
 * @param {Array} files - 当前文件列表（含解析结果）
 * @param {string} sortBy - 排序字段
 * @param {string} sortOrder - 排序方向（'asc'/'desc'）
 * @returns {PostProcessResult}
 */
export function processImportedFiles(files, sortBy, sortOrder) {
  const { duplicateGroups } = buildDocumentViewModel(files)
  const duplicateInfo = buildPageDuplicateInfo(duplicateGroups)
  return {
    files: applySort(files, sortBy, sortOrder, duplicateInfo, getPreviousYearInfo(files)),
    duplicateInfo,
  }
}
