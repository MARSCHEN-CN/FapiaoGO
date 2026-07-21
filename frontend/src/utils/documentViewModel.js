/**
 * documentViewModel — Document 视图模型统一出口
 *
 * 职责（单一）：
 *   将 page-level files[] 聚合为 document-level 视图模型。
 *   统计 / 重复检测 / 排序分区 / 批量删除统一消费本模型，
 *   不再直接消费原始页记录。
 *
 * 边界冻结（D1，2026-07-21）：
 *   - 文件列表的最小业务单位是「发票 Document」，不是 Page。
 *     多页发票 = 一个发票 = 一个 invoiceNumber；
 *     Page 只是发票内部的展示/打印组成部分，不参与业务统计、重复检测、列表展示。
 *   - 统计单位 = Document（文件数 / 总金额 / 失败数 / 往年数）。
 *     金额属于发票而非页：每个 document 只取 representative 的金额一次。
 *   - 重复检测 = 按 invoiceNumber 分组，但输入是 document 条目
 *     （detectDuplicateInvoices(documents)）。三页同号发票 = 1 条 → 不构成重复；
 *     两个独立文件同号 = 2 条 → 重复组（保持现有产品语义）。
 *   - identityHash（docId/sourceHash）属于缓存 / DocumentStore / 渲染资源，
 *     不作为业务重复规则（同发票不同字节来源仍应检出）。
 *   - 打印管线继续消费 page-level files（打印需要页）。
 *
 * 不负责：
 *   - Import Pipeline（files[] 结构不变，本模块只做派生）
 *   - DocumentStore 注册 / Preview / OCR
 *   - 打印 / 导出（仍消费原始 page-level files）
 *
 * @module utils/documentViewModel
 */

import { groupFilesByDocument } from './groupDocuments.js'
import { detectDuplicateInvoices, isFailedFile, isPreviousYearFile } from '../utils.js'

/**
 * document 条目包含的页数组。
 * 聚合条目（_isDocumentGroup）取 _pages（含 representative 自身）；
 * 普通条目（单页 PDF / 图片 / OFD）即文件自身。
 *
 * @param {Object|null} docEntry - groupFilesByDocument 产出的 document 条目
 * @returns {Object[]} 页级 fileObj 数组
 */
export function documentPages(docEntry) {
  if (!docEntry) return []
  return docEntry._isDocumentGroup && Array.isArray(docEntry._pages)
    ? docEntry._pages
    : [docEntry]
}

/**
 * document 行身份键（重复组 badge / 查找用）= uiKey。
 *
 * 为什么不用 docId：docId 是内容身份（sha256(bytes)[:24]，backend
 * registry._make_doc_id），相同内容重复导入会得到相同 docId，无法区分
 * "两份同样的发票"——用它做行身份会使重复组 Map 键碰撞、互相覆盖。
 * uiKey = representative 页的 key（name+timestamp+uuid，导入实例唯一），
 * 即 Identity Contract v1.1 定义的「React key / FileList 行 / selection」身份。
 *
 * 领域分离（冻结）：文件列表行身份 = uiKey；多页识别 = docId + pageNum
 * 唯一性；重复检测 = invoiceNumber。三者不混用，invoiceNumber 永不参与身份键。
 *
 * @param {Object|null} docEntry - document 条目（groupFilesByDocument 产出）
 * @returns {string} 行身份键
 */
export function documentIdentityKey(docEntry) {
  return docEntry?.key || ''
}

// 金额解析规则与原 FileContext 一致：剥离 ¥/￥/千分位逗号后 parseFloat
function parseAmount(amountStr) {
  return parseFloat((amountStr || '').replace(/[¥￥,]/g, '')) || 0
}

/**
 * 构建 Document 视图模型（纯函数，派生自 page-level files，不修改入参）。
 *
 * @param {Object[]} files - page-level fileObj 数组（来自 FileContext）
 * @returns {{
 *   documents: Object[],            document 条目数组（groupFilesByDocument 产出）
 *   documentCount: number,          文件数（统计单位 = document）
 *   duplicateGroups: Map<string, Object[]>,  重复组：invoiceNumber → document 条目数组（仅 size>1）
 *   totalAmount: number,            总金额（每 document 取 representative 金额一次）
 *   failedCount: number,            失败 document 数（任一页失败即计入）
 *   previousYearCount: number,      往年发票 document 数
 * }}
 */
export function buildDocumentViewModel(files) {
  const documents = groupFilesByDocument(files)

  // 重复检测：函数体不变（按 invoiceNumber 分组），输入升级为 document 条目
  const duplicateGroups = detectDuplicateInvoices(documents)

  let totalAmount = 0
  let failedCount = 0
  let previousYearCount = 0
  for (const doc of documents) {
    totalAmount += parseAmount(doc.amount)
    if (documentPages(doc).some(isFailedFile)) failedCount++
    if (isPreviousYearFile(doc)) previousYearCount++
  }

  return {
    documents,
    documentCount: documents.length,
    duplicateGroups,
    totalAmount,
    failedCount,
    previousYearCount,
  }
}

/**
 * document 级重复组信息（FileList badge 消费）。
 * key = documentIdentityKey(doc)，value = {groupIndex, isFirst, total, groupKey}。
 * groupIndex 为 1-based 顺序号（驱动「重复组 N」标签）。
 *
 * @param {Map<string, Object[]>} duplicateGroups - buildDocumentViewModel 产出
 * @returns {Map<string, {groupIndex: number, isFirst: boolean, total: number, groupKey: string}>}
 */
export function buildDocumentDuplicateInfo(duplicateGroups) {
  const info = new Map()
  let groupIndex = 0
  duplicateGroups.forEach((dupDocs, groupKey) => {
    groupIndex++
    dupDocs.forEach((doc, idx) => {
      info.set(documentIdentityKey(doc), {
        groupIndex,
        isFirst: idx === 0,
        total: dupDocs.length,
        groupKey,
      })
    })
  })
  return info
}

/**
 * page 级重复组索引投影（applySort 分区消费）。
 * applySort 操作 page-level files[]，需要每个页 key 的组归属；
 * 同一 document 的所有页共享同一 groupIndex，保证拆分页排序后仍相邻。
 *
 * @param {Map<string, Object[]>} duplicateGroups - buildDocumentViewModel 产出
 * @returns {Map<string, {groupIndex: number, isFirst: boolean}>} key 为页 key
 */
export function buildPageDuplicateInfo(duplicateGroups) {
  const info = new Map()
  let groupIndex = 0
  duplicateGroups.forEach((dupDocs) => {
    groupIndex++
    dupDocs.forEach((doc) => {
      for (const page of documentPages(doc)) {
        info.set(page.key, { groupIndex, isFirst: false })
      }
    })
  })
  return info
}
