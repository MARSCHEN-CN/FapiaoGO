/**
 * groupDocuments — 文件列表 document-level 聚合（纯函数）
 *
 * ⚠️ DEPRECATED for List/Store/Identity usage per Invoice Entity Boundary Contract §八.
 *   本模块的函数禁止用于 FileList 展示、Store 注册、身份判定。
 *   允许用途：Render（渲染分组）、Preview（预览分组）、Print（打印分组）。
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
 * 构建分组键：instanceId + sourceDocId 复合键。
 *
 * 为什么需要复合键：
 *   sourceDocId 是内容哈希（backend registry._make_doc_id），
 *   相同内容的不同导入会得到相同 sourceDocId，但 instanceId 不同。
 *   如果只用 sourceDocId 分组，两次导入的同票多页会被错误合并。
 *
 *   instanceId 是文件实例身份（前端 producer 生成、assembly 透传）：
 *   - 同一次导入的多页 PDF 所有拆分页共享同一 instanceId
 *   - 不同导入或不同文件的 instanceId 唯一
 *   因此 instanceId + sourceDocId 复合键能精确标识一个文档实例。
 *
 * 降级：instanceId 缺失时（legacy 数据），退化为 sourceDocId 单键，
 * 保持向后兼容，同时通过 totalPages>1 闸门排除单页文件。
 *
 * @param {Object} f - fileObj
 * @returns {string} 分组键
 */
function makeGroupKey(f) {
  const instanceId = f?.instanceId || ''
  const sourceDocId = f?.sourceDocId || ''
  if (instanceId && sourceDocId) {
    return `${instanceId}::${sourceDocId}`
  }
  // 降级：legacy 数据无 instanceId，仅用 sourceDocId
  return sourceDocId || instanceId || ''
}

/**
 * 将 page-level fileObj 数组聚合为 document-level 展示条目。
 *
 * 严格约束（防止错误合并不同发票）：
 *   1. 只有同时满足 sourceDocId + totalPages(>1) + pageNum 的文件才能参与分组。
 *   2. 使用 instanceId + sourceDocId 复合键分组，防止不同导入的同内容文件错误合并。
 *   3. 不满足条件的文件一律视为独立单页。
 *
 * @param {Object[]} files - page-level fileObj 数组（来自 FileContext）
 * @returns {Object[]} document-level 展示条目数组：
 *   - 拆分页聚合后: { ...representative, name: 原始文件名, _pages: fileObj[], _pageCount: number, _isDocumentGroup: true }
 *   - 非拆分页: 原 fileObj 引用不变（无 _isDocumentGroup 属性）
 */
export function groupFilesByDocument(files) {
  // ── P1：空输入直接 return，不 warn（纯 observability cleanup，零逻辑变更） ──
  if (!Array.isArray(files) || files.length === 0) return files || []

  // ── [TRACE] 临时 dev 取证：groupFilesByDocument 调用栈 + 状态 ──
  // 零逻辑改动，仅把原单条 DEPRECATED warn 展开为带栈快照的 trace
  if (process.env.NODE_ENV === 'development') {
    const _stackLines = new Error().stack
      .split('\n')
      .slice(2, 6)   // 去掉 "Error" + 本行，取前 4 层调用者
      .map(s => s.trim())
    console.warn('[TRACE groupFilesByDocument]', {
      fileCount: files?.length,
      nonNullCount: files?.filter?.(Boolean)?.length ?? 0,
      stack: _stackLines,
    })
  }

  // Pass 1: 收集严格满足多页条件的文件，按复合键分区
  // 关键约束：instanceId + sourceDocId 复合键，严格防止跨实例合并
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

    // 使用复合键分组：instanceId + sourceDocId
    const groupKey = makeGroupKey(f)
    if (!groupKey) {
      nonMultiPageFiles.push(f)
      continue
    }

    let instances = docInstances.get(groupKey)
    if (!instances) {
      instances = []
      docInstances.set(groupKey, instances)
    }

    const pageKey = f.pageNum
    let instance = instances.find(inst => !inst.pageNums.has(pageKey))
    if (!instance) {
      instance = { pageNums: new Set(), pages: [], totalPages: f.totalPages }
      instances.push(instance)
    }
    instance.pageNums.add(pageKey)
    instance.pages.push(f)
    pageInstance.set(f, instance)
  }

  // 实例内按 pageNum 升序排列 + 完整性校验
  for (const instances of docInstances.values()) {
    for (const inst of instances) {
      inst.pages.sort((a, b) => a.pageNum - b.pageNum)
      // totalPages 完整性校验：如果分组页数与 totalPages 不一致，记录警告
      // 但不拆散分组（可能是部分导入），仅做日志告警
      if (inst.totalPages && inst.pages.length !== inst.totalPages) {
        console.warn(
          `[groupDocuments] 文档页数不匹配: 实际 ${inst.pages.length} 页，预期 ${inst.totalPages} 页`,
        )
      }
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
 * 只有同时满足四个条件的文件才能被视为多页文档的一部分：
 *   1. sourceDocId != null：有明确的来源文档标识
 *   2. totalPages != null 且 > 1：有明确的总页数标识，且至少有 2 页（排除单页）
 *   3. pageNum != null：有明确的页码标识（可以是 0）
 *
 * 这是防止不同发票被错误合并的核心护栏。
 * 特别地，totalPages > 1 确保单页文件（即使意外携带了 sourceDocId）
 * 不会被误判为多页文档的一部分。
 *
 * @param {Object|null} file - fileObj
 * @returns {boolean}
 */
export function isMultiPageDocumentFile(file) {
  if (!file) return false
  return !!(
    file.sourceDocId != null &&
    file.totalPages != null &&
    file.totalPages > 1 &&
    file.pageNum != null
  )
}

/**
 * 使用 instanceId + sourceDocId 复合键进行文档分组（增强降级路径）。
 *
 * 设计原则（严格约束，防止错误合并）：
 *   1. 只有同时满足 sourceDocId + totalPages(>1) + pageNum 的文件才能参与分组
 *   2. 使用 instanceId + sourceDocId 复合键分组，防止不同导入的同内容文件错误合并
 *   3. 分组后验证：所有文件的页码唯一，页数与 totalPages 一致
 *   4. 不满足条件的文件一律视为独立单页
 *
 * @param {Object[]} files - page-level fileObj 数组
 * @returns {Object[]} document-level 展示条目数组（结构与 groupFilesByDocument 一致）
 */
export function groupFilesByInstance(files) {
  console.warn('[DEPRECATED] groupFilesByInstance: 仅允许 Render/Preview/Print，禁止 List/Store/Identity 用途。见 docs/invoice_entity_boundary.md §八。')
  if (!Array.isArray(files) || files.length === 0) return files || []

  // Pass 1: 收集严格满足多页条件的文件，按复合键分区
  const instanceGroups = new Map()
  const fileToGroup = new Map()

  for (const f of files) {
    if (!f) continue

    // 严格验证：只有满足多页条件的文件才能参与分组
    if (!isMultiPageDocumentFile(f)) {
      continue
    }

    // 使用复合键分组：instanceId + sourceDocId
    const groupKey = makeGroupKey(f)
    if (!groupKey) continue

    let groups = instanceGroups.get(groupKey)
    if (!groups) {
      groups = []
      instanceGroups.set(groupKey, groups)
    }

    const pageKey = f.pageNum
    let group = groups.find(g => !g.pageNums.has(pageKey))
    if (!group) {
      group = { pageNums: new Set(), pages: [], totalPages: f.totalPages }
      groups.push(group)
    }
    group.pageNums.add(pageKey)
    group.pages.push(f)
    fileToGroup.set(f, group)
  }

  // 实例内按 pageNum 升序排列 + 完整性校验
  for (const groups of instanceGroups.values()) {
    for (const group of groups) {
      group.pages.sort((a, b) => a.pageNum - b.pageNum)
      if (group.totalPages && group.pages.length !== group.totalPages) {
        console.warn(
          `[groupDocuments/instance] 文档页数不匹配: 实际 ${group.pages.length} 页，预期 ${group.totalPages} 页`,
        )
      }
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
