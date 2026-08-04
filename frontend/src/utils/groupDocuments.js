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
 * 严格约束（防止错误合并不同发票）：
 *   只有同时满足以下 3 个条件的文件才能被视为多页文档的一部分：
 *     1. sourceDocId != null：有明确的来源文档标识
 *     2. totalPages != null：有明确的总页数标识
 *     3. pageNum != null：有明确的页码标识（可以是 0）
 *   不满足条件的文件一律视为独立单页，不参与分组。
 *   仅使用 sourceDocId 作为分组键，禁止使用 instanceId/docId。
 *
 * 规则：
 *   - 满足多页条件的文件按 sourceDocId + pageNum 唯一性聚合
 *   - 其余文件（单页 PDF / 图片 / OFD / 无 sourceDocId）保持原样
 *   - document 条目的 representative = pageNum 最小的 fileObj
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
 * 严格约束（防止错误合并不同发票）：
 *   只有同时满足 sourceDocId + totalPages + pageNum 的文件才能参与分组。
 *   不满足条件的文件一律视为独立单页。
 *
 * @param {Object[]} files - page-level fileObj 数组（来自 FileContext）
 * @returns {Object[]} document-level 展示条目数组：
 *   - 拆分页聚合后: { ...representative, name: 原始文件名, _pages: fileObj[], _pageCount: number, _isDocumentGroup: true }
 *   - 非拆分页: 原 fileObj 引用不变（无 _isDocumentGroup 属性）
 */
export function groupFilesByDocument(files) {
  if (!Array.isArray(files) || files.length === 0) return files || []

  // Pass 1: 收集严格满足多页条件的文件，按 sourceDocId + pageNum 唯一性分区
  // 关键约束：只使用 sourceDocId 作为分组键，且严格验证多页条件
  const docInstances = new Map()
  const pageInstance = new Map()
  const nonMultiPageFiles = []

  for (const f of files) {
    if (!f) continue

    // 严格验证：只有满足多页条件的文件才能参与分组
    if (!isMultiPageDocumentFile(f)) {
      nonMultiPageFiles.push(f)
      continue
    }

    // 仅使用 sourceDocId 作为分组键（严格约束）
    let instances = docInstances.get(f.sourceDocId)
    if (!instances) {
      instances = []
      docInstances.set(f.sourceDocId, instances)
    }

    const pageKey = f.pageNum
    let instance = instances.find(inst => !inst.pageNums.has(pageKey))
    if (!instance) {
      instance = { pageNums: new Set(), pages: [] }
      instances.push(instance)
    }
    instance.pageNums.add(pageKey)
    instance.pages.push(f)
    pageInstance.set(f, instance)
  }

  // 实例内按 pageNum 升序排列
  for (const instances of docInstances.values()) {
    for (const inst of instances) {
      inst.pages.sort((a, b) => a.pageNum - b.pageNum)
    }
  }

  // Pass 2: 构建结果（保持原始顺序）
  const result = []
  const emitted = new Set()

  for (const f of files) {
    const instance = pageInstance.get(f)
    if (instance) {
      if (!emitted.has(instance)) {
        emitted.add(instance)
        const pages = instance.pages
        const rep = pages[0]
        result.push({
          ...rep,
          name: restoreOriginalName(rep.name),
          originalName: rep.name,
          documentId: rep.docId || rep.sourceDocId,
          _pages: pages,
          _pageCount: pages.length,
          _isDocumentGroup: pages.length > 1,
        })
      }
      // 已聚合进实例的页：跳过
    } else {
      // 非多页文件：补齐 identity contract
      if (f.originalName !== undefined) {
        result.push(f)
      } else {
        result.push({
          ...f,
          originalName: f.name,
          documentId: f.documentId || f.docId,
        })
      }
    }
  }

  return result
}

/**
 * 验证文件是否满足多页文档的严格业务条件。
 * 只有同时满足三个条件的文件才能被视为多页文档的一部分。
 *
 * 这是防止不同发票被错误合并的核心护栏。
 *
 * @param {Object|null} file - fileObj
 * @returns {boolean}
 */
export function isMultiPageDocumentFile(file) {
  if (!file) return false
  // 必须同时满足三个条件（与 parseRunner.js 的业务逻辑一致）
  // 条件1：有来源文档标识
  // 条件2：有总页数标识
  // 条件3：有页码标识（可以是 0）
  return !!(
    file.sourceDocId != null &&
    file.totalPages != null &&
    file.pageNum != null
  )
}

/**
 * 使用 sourceDocId + 严格多页验证进行文档分组（增强降级路径）。
 *
 * 设计原则（严格约束，防止错误合并）：
 *   1. 只有同时满足以下 3 个条件的文件才能被视为多页文档的一部分：
 *      - sourceDocId != null：有明确的来源文档标识
 *      - totalPages != null：有明确的总页数标识
 *      - pageNum != null：有明确的页码标识（可以是 0）
 *   2. 仅使用 sourceDocId 作为分组键（instanceId/docId 不作为分组依据）
 *   3. 分组后必须验证：所有文件的页码唯一
 *   4. 不满足条件的文件一律视为独立单页，不参与分组
 *
 * @param {Object[]} files - page-level fileObj 数组
 * @returns {Object[]} document-level 展示条目数组（结构与 groupFilesByDocument 一致）
 */
export function groupFilesByInstance(files) {
  if (!Array.isArray(files) || files.length === 0) return files || []

  // Pass 1: 收集严格满足多页条件的文件，按 sourceDocId 分区
  const instanceGroups = new Map()
  const fileToGroup = new Map()

  for (const f of files) {
    if (!f) continue

    // 严格验证：只有满足多页条件的文件才能参与分组
    if (!isMultiPageDocumentFile(f)) {
      continue
    }

    // 仅使用 sourceDocId 作为分组键（严格约束）
    const groupKey = f.sourceDocId
    if (!groupKey) continue

    // 同一 sourceDocId 下，按 pageNum 唯一性分区
    let groups = instanceGroups.get(groupKey)
    if (!groups) {
      groups = []
      instanceGroups.set(groupKey, groups)
    }

    const pageKey = f.pageNum
    let group = groups.find(g => !g.pageNums.has(pageKey))
    if (!group) {
      group = { pageNums: new Set(), pages: [] }
      groups.push(group)
    }
    group.pageNums.add(pageKey)
    group.pages.push(f)
    fileToGroup.set(f, group)
  }

  // 实例内按 pageNum 升序排列
  for (const groups of instanceGroups.values()) {
    for (const group of groups) {
      group.pages.sort((a, b) => a.pageNum - b.pageNum)
    }
  }

  // Pass 2: 构建结果（保持原始顺序）
  const result = []
  const emitted = new Set()

  for (const f of files) {
    const group = fileToGroup.get(f)
    if (group) {
      if (!emitted.has(group)) {
        emitted.add(group)
        const pages = group.pages
        const rep = pages[0]
        result.push({
          ...rep,
          name: restoreOriginalName(rep.name),
          originalName: rep.name,
          documentId: rep.docId || rep.sourceDocId,
          _pages: pages,
          _pageCount: pages.length,
          _isDocumentGroup: pages.length > 1,
        })
      }
    } else {
      // 非多页文件：补齐 identity contract
      if (f.originalName !== undefined) {
        result.push(f)
      } else {
        result.push({
          ...f,
          originalName: f.name,
          documentId: f.documentId || f.docId,
        })
      }
    }
  }

  return result
}
