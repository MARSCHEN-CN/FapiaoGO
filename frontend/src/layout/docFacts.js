// 纯函数模块：文档方向 Fact 的 Initialize Once 推导。
// 无 DOM / 无 electron 依赖，可在 node 下直接单测。
// 对应 Commit C：纸张方向(paperOrientation) 与 内容旋转(contentRotation)
// 作为两个独立 Fact，按 doc_id 持久化；"自动" = 持久层无记录。

export function normalizeRotation(deg) {
  const r = Math.round(Number(deg) || 0) % 360
  return r < 0 ? r + 360 : r
}

/**
 * 推导文档加载时的初始方向 Fact。
 * @param {null|{paperOrientation?:string, contentRotation?:number}} loadedFacts 持久层记录（无则 null）
 * @param {('portrait'|'landscape'|null)} naturalOrientation 文档天然方向（由页面/图片尺寸推导）
 * @returns {{paperOrientation:string, contentRotation:number, isAuto:boolean, shouldPersist:boolean}}
 *   - 有合法记录 → 返回记录值，isAuto=false，shouldPersist=false（不重复写）
 *   - 无记录 → 返回天然方向 + contentRotation=0，isAuto=true，shouldPersist=true（Initialize Once 写回）
 */
export function computeInitialDocFacts(loadedFacts, naturalOrientation) {
  const hasRecord =
    loadedFacts &&
    typeof loadedFacts === 'object' &&
    (loadedFacts.paperOrientation === 'portrait' || loadedFacts.paperOrientation === 'landscape')

  if (hasRecord) {
    return {
      paperOrientation: loadedFacts.paperOrientation,
      contentRotation: normalizeRotation(loadedFacts.contentRotation),
      isAuto: false,
      shouldPersist: false,
    }
  }

  const natural = naturalOrientation === 'landscape' ? 'landscape' : 'portrait'
  return {
    paperOrientation: natural,
    contentRotation: 0,
    isAuto: true,
    shouldPersist: true,
  }
}

/**
 * 判断文档在文件名/导出名中是否需要页码后缀（如 `+P1` / `_p1`）。
 *
 * 纪律（V17 Fact 原则）：
 *   pageNum 是渲染事实，不应影响文件名。
 *   判断依据永远是「是否多页文档」（pageCount > 1），而非 pageNum 是否存在。
 *
 *   ❌ 旧模式：if (pageNum) — 一旦单页文档的 pageNum 从 null 升格为 1（Fact 语义升级），
 *      所有单页文件都会错误地附上 `+P1` 后缀。
 *   ✓ 新模式：if (shouldAppendPageSuffix(doc)) — 规则集中在一处（pageCount > 1），
 *      以后规则修改（PDF 多页需要、OFD 永远不要、TIFF 每页需要）只改一处。
 *
 * 所有消费方（Rename / 导出 / 一键打包 / 历史记录 / 缓存）统一调用本函数。
 *
 * @param {{pageCount?:number}|null} doc - DocumentState 或带 pageCount 的文件对象
 * @returns {boolean}
 */
export function shouldAppendPageSuffix(doc) {
  return !!(doc && typeof doc.pageCount === 'number' && doc.pageCount > 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// 导出文件名生成 —— Rename / Pack / 导出 的唯一命名决策点
//
// 背景（Commit 1b）：
//   此前 Rename 域与 Pack 域各自生成文件名，规则不同：
//     Rename: handleRenameConfirm 内联拼 `_p${pageNum+1}`  → 12345678_p2.pdf
//     Pack:   ipc-pack.generateNewName 只认 invoiceFields  → 12345678.pdf（两页同名）
//             再由 archive-utils.resolveArchiveFileNames 静默去重 → 12345678_1.pdf
//   后果：同一份同票多页，重命名后叫 _p2，打包后叫 _1；且 `_1` 挂在哪一页
//   取决于输入数组顺序（archive 层不感知页序），用户无法从压缩包判断页序。
//
// 纪律：页码后缀是**业务语义**，必须由 Document 域决定，不能让 archive 层补救。
//   archive 层的去重只保留为「最后一道保险」，不再承担语义职责。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从文件名提取扩展名（含点），无法识别时回退 `.pdf`。
 * 与 handleRenameConfirm 原有的 `/\.\w+$/` 行为保持一致。
 * @param {string} name
 * @returns {string}
 */
export function extractExt(name) {
  return (name || '').match(/\.\w+$/)?.[0] || '.pdf'
}

/**
 * 取出一个 document 条目的页面数组，并按页序归一化。
 *
 * 输入可能是两种形状（历史原因，两者都要支持）：
 *   - group 条目：{ ...rep, _pages: [...], _isDocumentGroup: true }（多页）
 *   - 裸 fileObj：单页文档，document 条目就是页面本身
 *
 * 排序：pageNum 升序。pageNum 可能为 0（第一页）或 null（未标注），
 * 用 `?? 0` 而非 `|| 0`，避免 0 被当作缺失。invoiceDocumentToRow 已排过一次，
 * 这里再排是幂等的，目的是让 fallback 路径（groupFilesByDocument）也获得同样保证。
 *
 * @param {Object|null} doc
 * @returns {Object[]} 按页序排列的页面对象数组
 */
export function getDocumentPages(doc) {
  if (!doc) return []
  if (doc._isDocumentGroup && Array.isArray(doc._pages) && doc._pages.length > 0) {
    return [...doc._pages].sort((a, b) => (a?.pageNum ?? 0) - (b?.pageNum ?? 0))
  }
  return [doc]
}

/**
 * 生成单页的页码后缀。
 *
 * 规则（唯一定义处）：
 *   - 单页文档            → ''         （不加后缀）
 *   - 多页文档第 1 页     → ''         （首页保持"干净"名字，便于用户识别主文件）
 *   - 多页文档第 N 页     → `_p{N}`    （N 为 1-based 序号）
 *
 * 刻意用**排序后的序号**而非 page.pageNum：pageNum 在部分链路缺失或非连续
 * （首页常为 null），用它算后缀会产生 `_p1`/空洞。序号由 getDocumentPages
 * 的排序保证连续，是更稳健的事实来源。
 *
 * @param {number} pageIndex - 0-based 页序号
 * @param {number} pageCount - 该文档总页数
 * @returns {string}
 */
export function buildPageSuffix(pageIndex, pageCount) {
  if (!shouldAppendPageSuffix({ pageCount })) return ''
  if (pageIndex === 0) return ''
  return `_p${pageIndex + 1}`
}

/**
 * 拼接单页的最终文件名。
 * @param {string} baseName - 命名规则算出的主体（不含扩展名、不含页码后缀）
 * @param {string} ext - 扩展名（含点）
 * @param {{pageIndex?:number, pageCount?:number}} [pos]
 * @returns {string}
 */
export function buildDocumentExportName(baseName, ext, { pageIndex = 0, pageCount = 1 } = {}) {
  const safeExt = !ext ? '' : (ext.startsWith('.') ? ext : `.${ext}`)
  return `${baseName}${buildPageSuffix(pageIndex, pageCount)}${safeExt}`
}

/**
 * 把一个 document 条目展开为「每页 → 最终文件名」的完整清单。
 *
 * 这是 Rename 与 Pack 的共同入口：两者消费同一份输出，
 * 从结构上杜绝「重命名叫 _p2、打包叫 _1」这类跨域漂移。
 *
 * @param {Object} doc - document 条目（group 或裸 fileObj）
 * @param {string} baseName - 命名规则算出的主体（不含扩展名）
 * @returns {Array<{key:string, pageIndex:number, pageCount:number,
 *                  originalPath:string, originalName:string,
 *                  targetBaseName:string, targetName:string}>}
 *   - targetBaseName：不含扩展名，供 rename-invoices IPC（它自己补扩展名）
 *   - targetName：含扩展名，供 pack-invoices IPC（zip entry 名）
 */
/**
 * 跨文档消歧：保证整批导出名字唯一。
 *
 * 与页码后缀的分工（两种冲突，两种语义，不可混用）：
 *   - 文档**内**的页序   → `_p2` / `_p3`，由 buildPageSuffix 生成，是业务语义
 *   - 文档**间**的撞名   → `_1` / `_2`，由本函数生成，纯粹是消歧
 *
 * 为什么必须在业务层做而不是交给 archive 层：
 *   命名规则字段全部缺失时，buildNameParts 会回退到「未命名发票」，
 *   多张票因此撞名。若把这种情况丢给 archive 严格模式，整批打包会直接失败
 *   （旧行为是能打包成功的）——那是回归。业务层先消歧，严格模式就只在
 *   真正的命名缺陷时报警。
 *
 * 大小写不敏感比较：zip 内区分大小写，但解压到 Windows/macOS 后
 * `A.pdf` 与 `a.pdf` 会互相覆盖。按小写去重可避免这种跨平台丢文件。
 *
 * @param {Array<{targetName:string}>} entries
 * @returns {Array} 同结构数组，targetName 已保证唯一（未冲突的条目原样返回）
 */
export function dedupeExportNames(entries) {
  const used = new Set()
  return (entries || []).map((entry) => {
    const original = entry?.targetName || ''
    const extMatch = original.match(/\.[^.]*$/)
    const ext = extMatch ? extMatch[0] : ''
    const base = ext ? original.slice(0, -ext.length) : original

    let name = original
    let counter = 1
    while (used.has(name.toLowerCase())) {
      name = `${base}_${counter}${ext}`
      counter++
    }
    used.add(name.toLowerCase())
    return name === original ? entry : { ...entry, targetName: name }
  })
}

export function buildDocumentPageNames(doc, baseName) {
  const pages = getDocumentPages(doc)
  const pageCount = pages.length
  return pages.map((page, pageIndex) => {
    const originalName = page?.name || ''
    const ext = extractExt(originalName)
    const suffix = buildPageSuffix(pageIndex, pageCount)
    return {
      key: page?.key,
      pageIndex,
      pageCount,
      originalPath: page?.printPath || page?.path || '',
      originalName,
      targetBaseName: `${baseName}${suffix}`,
      targetName: `${baseName}${suffix}${ext}`,
    }
  })
}
