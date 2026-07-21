/**
 * groupDocuments — 文件列表 document-level 聚合（纯函数）
 *
 * 职责：
 *   将 page-level fileObj 数组聚合为 document-level 展示条目。
 *   供 FileList 消费，使侧栏显示"一张发票"而非"每页一条"。
 *
 * 产品语义：
 *   文件列表 = 用户导入的一张张发票（业务记录）
 *   展示区   = 当前这张发票内部有多少页（DocumentViewer pages[]）
 *   本函数只做列表层的展示聚合，不改变底层 files[] 数据结构。
 *
 * 规则：
 *   - 有 docId + pageNum 的文件视为拆分页，按 docId 聚合为一条 document 条目
 *   - 其余文件（单页 PDF / 图片 / OFD / 无 docId）保持原样
 *   - document 条目的 representative = pageNum 最小的 fileObj（通常 pageNum=1）
 *   - 保持原始顺序（document 条目出现在其第一个拆分页的位置）
 *   - 纯函数，不修改输入数组或对象
 *
 * 不负责：
 *   - DocumentStore 注册（由 hydration / consumeParseResult 负责）
 *   - 打印 / 导出（仍消费原始 page-level files）
 *   - 排序（在聚合前已完成）
 *   - 文件选择 / 预览加载（由 FileList onPreview 回调负责）
 *
 * @module utils/groupDocuments
 */

/**
 * 从拆分页文件名还原原始文件名。
 * "invoice_p1.pdf" → "invoice.pdf"
 * "report_2024_p12.pdf" → "report_2024.pdf"
 *
 * @param {string} pageName - 拆分页文件名（含 _pN 后缀）
 * @returns {string} 原始文件名
 */
export function restoreOriginalName(pageName) {
  if (!pageName) return pageName
  return pageName.replace(/_p\d+\.pdf$/i, '.pdf')
}

/**
 * 将 page-level fileObj 数组聚合为 document-level 展示条目。
 *
 * @param {Object[]} files - page-level fileObj 数组（来自 FileContext）
 * @returns {Object[]} document-level 展示条目数组：
 *   - 拆分页聚合后: { ...representative, name: 原始文件名, _pages: fileObj[], _pageCount: number, _isDocumentGroup: true }
 *   - 非拆分页: 原 fileObj 引用不变（无 _isDocumentGroup 属性）
 */
export function groupFilesByDocument(files) {
  if (!Array.isArray(files) || files.length === 0) return files || []

  // Pass 1: 收集拆分页分组（docId → pages[]）
  const groups = new Map()
  for (const f of files) {
    if (f.docId && f.pageNum) {
      if (!groups.has(f.docId)) groups.set(f.docId, [])
      groups.get(f.docId).push(f)
    }
  }

  // 组内按 pageNum 升序排列
  for (const [, pages] of groups) {
    pages.sort((a, b) => (a.pageNum || 1) - (b.pageNum || 1))
  }

  // Pass 2: 构建结果——每个 docId 在首次出现位置输出一条聚合条目，后续页跳过
  const result = []
  const emitted = new Set()

  for (const f of files) {
    if (f.docId && f.pageNum && groups.has(f.docId)) {
      if (!emitted.has(f.docId)) {
        emitted.add(f.docId)
        const pages = groups.get(f.docId)
        const rep = pages[0] // pageNum 最小的页（representative）
        result.push({
          ...rep,
          name: restoreOriginalName(rep.name),
          _pages: pages,
          _pageCount: pages.length,
          _isDocumentGroup: true,
        })
      }
      // 后续拆分页：已聚合，跳过
    } else {
      // 非拆分页：原样保留
      result.push(f)
    }
  }

  return result
}
