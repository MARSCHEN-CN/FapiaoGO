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
