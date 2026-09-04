/**
 * previewPolicy.js — Preview Snapshot Policy 纯模块
 *
 * 依据：PreviewScheduler-Contract-v2.md + P2-GATE（G2）决定
 *   displayability 属于「preview snapshot policy」，不属于 transaction scheduler，
 *   故独立成模块，不塞 previewScheduler.js（避免其承担 transition/execution/debounce/
 *   displayability 四类职责）。
 *
 * 职责边界：
 *   isDisplayablePreview 是 **commit eligibility predicate**——只回答
 *   「这个 snapshot 能不能成为 committed preview？」；不得滚成第二套渲染判断、
 *   不 import / 不触碰 DisplayAdapter、不改 resolver、不扩展成渲染策略系统。
 *
 * 冻结事实（P2-GATE 重申，不扩展）：
 *   - pdf-backed = _pdfData 或 _fileFormat === 'pdf'
 *   - effective docId：split-page（sourceDocId && docId !== sourceDocId，对齐
 *     usePreview.js L1993-1994 口径）→ 取 sourceDocId；否则顶层 docId ?? identity.docId
 *   - 纯图像（_previewImageUrl 就绪、非 pdf-backed）不经 DocumentStore → 无 docId 也允许
 *
 * Runtime 依据：outputs/perf-runs/preview-r2-8files-20260904.json
 *   X3: seq 38-43 v6 半壳（docId=null + _pdfData=true）COMMIT_SUCCESS → 展示区空白固化
 *
 * @module utils/previewPolicy
 */

/**
 * isDisplayablePreview — 该 snapshot 是否可成为 committed preview（半壳 commit gate）。
 *
 * 决策表：
 *   | snapshot 形态                                        | 结果  |
 *   |------------------------------------------------------|-------|
 *   | null / undefined                                     | false |
 *   | pdf-backed（_pdfData / _fileFormat==='pdf'）         |       |
 *   |   ├─ 无有效 effective docId（半壳）                  | false |
 *   |   └─ 有 effective docId（含 split-page sourceDocId） | true  |
 *   | 非 pdf-backed（image / OFD）                         |       |
 *   |   ├─ _previewImageUrl 就绪                           | true  |
 *   |   └─ 无预览 URL（无内容可展示）                      | false |
 *
 * @param {Object|null} file - 即将 commit 的 loadedFile snapshot
 * @returns {boolean} 允许 commit
 */
export function isDisplayablePreview(file) {
  if (!file) return false

  // pdf-backed：pdf 快照走 DocumentStore 渲染，必须寻得到档（docId 哈希）才能展示
  const pdfBacked = !!file._pdfData || file._fileFormat === 'pdf'
  if (!pdfBacked) {
    // image / OFD：不经 DocumentStore，_previewImageUrl 就绪即允许（无 docId 不误伤）
    return !!file._previewImageUrl
  }

  // split-page（对齐 usePreview.js L1993：sourceDocId && docId !== sourceDocId）→ 以 sourceDocId 寻档
  const isParsedSplitPage = !!(file.sourceDocId && file.docId && file.docId !== file.sourceDocId)
  const effectiveDocId = isParsedSplitPage
    ? file.sourceDocId
    : (file.docId ?? file.identity?.docId ?? null)

  return !!effectiveDocId
}
