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
 *   - 导入实例分区：docId 是内容哈希（sha256(bytes)[:24]，backend
 *     registry._make_doc_id，filename 不参与），相同内容重复导入会得到
 *     相同 docId，无法区分"两份同样的发票"。合法多页文档的 pageNum(1..N)
 *     各出现一次；同 docId 下 pageNum 重复（如两个 p1、两个 p2）即判定为
 *     多个导入实例，按 pageNum 唯一性拆分为相互独立的 document
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

  // Pass 1: 收集拆分页，按 docId + pageNum 唯一性分区为「导入实例」。
  // docId 是内容哈希：相同内容重复导入 → 相同 docId（两份同样的发票无法
  // 仅凭 docId 区分）。合法多页文档的 pageNum(1..N) 各出现一次；同 docId
  // 下 pageNum 重复即多个导入实例。按 files[] 顺序将每页分配到该 docId 下
  // 第一个 pageNum 不冲突的实例，冲突则新建实例。
  const docInstances = new Map()   // docId → [{ pageNums: Set, pages: [] }]
  const pageInstance = new Map()   // 页 fileObj → 所属实例
  for (const f of files) {
    // 只跳过无 docId 的非拆分页；pageNum 为 null 代表首页（buildFileObj 将 page_index=0 转为 null）
    // null 是合法页码，应参与分组
    if (!f?.docId) continue
    const pageKey = f.pageNum ?? 0
    let instances = docInstances.get(f.docId)
    if (!instances) {
      instances = []
      docInstances.set(f.docId, instances)
    }
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
      // pageNum 可能为 0，不能用 || 1 导致排序错乱
      inst.pages.sort((a, b) => (a.pageNum ?? 0) - (b.pageNum ?? 0))
    }
  }

  // Pass 2: 构建结果——每个实例在其首页出现位置输出一条聚合条目，后续页跳过
  const result = []
  const emitted = new Set()

  for (const f of files) {
    const instance = pageInstance.get(f)
    if (instance) {
      if (!emitted.has(instance)) {
        emitted.add(instance)
        const pages = instance.pages
        const rep = pages[0] // pageNum 最小的页（representative）
        result.push({
          ...rep,
          // display identity
          name: restoreOriginalName(rep.name),
          // export identity — raw page-level filename (e.g. "invoice_p1.pdf"),
          // must match DB file_name column for backend lookup
          originalName: rep.name,
          // source document identity (content hash) — NOT invoice business identity.
          // Equivalent to InvoiceDocument.docId in the InvoiceDocument model.
          // Future: should migrate export lookup from filename to documentId.
          documentId: rep.docId,
          _pages: pages,
          _pageCount: pages.length,
          _isDocumentGroup: true,
        })
      }
      // 已聚合进实例的页：跳过
    } else {
      // 非拆分页：补齐 identity contract，与分组路径一致。
      // 已有 originalName 的文件（如已迁移的新路径）透传原引用，不意外 clone。
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
 * 使用 instanceId + sourceDocId 进行更可靠的分组（增强降级路径）。
 *
 * 修复：当主路径 session.documents 失效（如 TTL 回收）时，
 *       使用更强的身份字段（instanceId > sourceDocId > docId）进行分组，
 *       确保多页文档不会退化为独立单页。
 *
 * @param {Object[]} files - page-level fileObj 数组
 * @returns {Object[]} document-level 展示条目数组（结构与 groupFilesByDocument 一致）
 */
export function groupFilesByInstance(files) {
  if (!Array.isArray(files) || files.length === 0) return files || []

  // Pass 1: 收集拆分页，按 instanceId + sourceDocId 分区
  // 优先级：instanceId > sourceDocId > docId
  const instanceGroups = new Map()
  const fileToGroup = new Map()

  for (const f of files) {
    if (!f) continue
    // 获取分组键（优先级：instanceId > sourceDocId > docId）
    const groupKey = f.instanceId || f.sourceDocId || f.docId
    if (!groupKey) continue // 无任何可分组身份的文件跳过

    // 同一 groupKey 下，按 pageNum 唯一性分区
    let groups = instanceGroups.get(groupKey)
    if (!groups) {
      groups = []
      instanceGroups.set(groupKey, groups)
    }

    const pageKey = f.pageNum ?? 0
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
      group.pages.sort((a, b) => (a.pageNum ?? 0) - (b.pageNum ?? 0))
    }
  }

  // Pass 2: 构建结果
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
          documentId: rep.docId || rep.instanceId,
          _pages: pages,
          _pageCount: pages.length,
          _isDocumentGroup: pages.length > 1,
        })
      }
    } else {
      // 无分组身份的文件保持原样
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
