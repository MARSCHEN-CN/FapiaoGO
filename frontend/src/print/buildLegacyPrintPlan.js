/**
 * buildLegacyPrintPlan — 旧打印逻辑「任务构建」纯函数抽取（A1.5 Legacy Oracle）
 *
 * 目的：
 *   把 executePrint / doPrint 中「构建打印任务队列」的内联逻辑（usePrint.js）原样抽成
 *   纯函数，作为 A1.5 的 **Legacy Oracle** —— 即「系统当前真实行为」的命名、可测、可比较基线。
 *
 * 为什么必须抽，而不是在测试里重写第二份旧代码：
 *   旧逻辑现在内联在 usePrint.js 的 executePrint / doPrint 里，没有独立函数。如果在测试里
 *   再写一份 `files.filter(...)` 当 expectation，那等于用「人工理解的旧逻辑」验证「新逻辑」，
 *   一旦理解偏差，错误新版与错误基线会一起通过测试，毫无价值。
 *   正确做法：把旧逻辑本身抽成 buildLegacyPrintPlan，由 equivalence test 与 shadow compare
 *   共同调用 —— 它正是 Commit 2/3 要替换掉的那段逻辑，是真正的 oracle。
 *
 * 忠实性原则（A1.5 命门）：
 *   - 过滤口径按「路径」内部派生，不接收外部 filter 参数：
 *       · merge 路径 → 镜像 doPrint L453-459（parsed||error，OFD 需 docId||previewImage）
 *       · source 路径 → 镜像 executePrint L817（status==='parsed' && (printPath||path)）
 *   - 顺序：保持过滤后自然顺序（与 executePrint/doPrint 一致）。
 *   - merge 分组：groupSize = parseInt(mergeMode.replace('merge',''))||2，滑窗分组（doPrint L493-502）。
 *   - 一普二专：仅 source 路径展开 round2（executePrint L822-829）；merge 路径 doPrint 忽略 extraSpecial。
 *   - 方向：merge 用 getForcedLandscape(mergeMode, landscape)；source 用 settings.landscape。
 *     （与 buildPrintExecutionPlan 同算法，故两者归一化后必等价 —— 这正是 projection 性质。）
 *
 * 输出形状：与 buildPrintExecutionPlan 完全一致（pages / extraPages / strategy / mergeMode），
 * 以便归一化比较。多页文档逐页展开留在渲染层（旧代码 renderFileToPrintImage / buildPrintJobItem），
 * Plan 层面每文件 = 1 执行单元。
 *
 * @module print/buildLegacyPrintPlan
 */

import { isMergeMode, getForcedLandscape } from '../utils/mergeMode.js'
import { resolveInvoiceIdentity } from '../utils/invoiceIdentityResolver.js'

/**
 * 旧 merge 路径过滤（doPrint L453-459）。
 * 允许 parsed||error；OFD 需 docId 或 previewImage 任一；必须有 printPath。
 */
function legacyMergeFilter(f) {
  if (!f.printPath) return false
  if (f.status !== 'parsed' && f.status !== 'error') return false
  if (f.fileFormat === 'ofd' && !f.docId && !f.previewImage) return false
  return true
}

/**
 * 旧 source 路径过滤（executePrint L817）。
 * 仅 parsed，且具备 printPath 或 path；OFD 不要求 docId（与 merge 路径不同）。
 */
function legacySourceFilter(f) {
  return f.status === 'parsed' && (f.printPath || f.path)
}

/**
 * 从文件列表 + 打印配置构建「旧版」打印计划（Legacy Oracle）。
 *
 * @param {Array<Object>} files - 前端文件对象数组
 * @param {Object} [options]
 * @param {Object} [options.settings] - { mergeMode, landscape, paperSize, extraSpecial }
 * @param {Object} [options.fileRotations] - { [fileKey]: rotationDegrees }
 * @param {Object} [options.placements] - { [fileKey]: PlacementResult }（Commit 3-A 新增，与新版保持字段一致）
 * @returns {{ strategy:{oneNormalTwoSpecial:boolean}, mergeMode:string, pages:Array, extraPages:Array }}
 */
export function buildLegacyPrintPlan(files, options = {}) {
  const { settings = {}, fileRotations = {}, placements = {} } = options

  const mergeMode = settings.mergeMode || 'none'
  const isMerge = isMergeMode(mergeMode)

  // 路径决定过滤口径（旧代码真实决策，不接收外部 filter）
  const sourceFiles = isMerge
    ? files.filter(legacyMergeFilter)
    : files.filter(legacySourceFilter)

  const paperSize = settings.paperSize || 'A4'
  const perFileRotation = (f) => fileRotations[f.key] || 0
  const perFilePlacement = (f) => placements[f.key] || null

  // Commit 3-A: slot 字段对齐 buildPrintExecutionPlan（contentRotation + placement + invoiceDocumentId）
  const buildSlot = (f) => {
    const contentRotation = perFileRotation(f)
    return {
      fileId: f.key,
      rotation: contentRotation,
      contentRotation,
      placement: perFilePlacement(f),
      invoiceDocumentId: f.invoiceDocumentId || resolveInvoiceIdentity(f) || '',
    }
  }

  // 方向：merge 强制 getForcedLandscape；source 用用户配置（与旧代码逐字同构）
  const orientation = isMerge
    ? (getForcedLandscape(mergeMode, settings.landscape) ? 'landscape' : 'portrait')
    : (settings.landscape ? 'landscape' : 'portrait')

  // ── merge 路径：按 groupSize 滑窗分组（doPrint L493-502） ──
  if (isMerge) {
    const groupSize = parseInt(mergeMode.replace('merge', ''), 10) || 2
    const pages = []
    for (let i = 0; i < sourceFiles.length; i += groupSize) {
      const group = sourceFiles.slice(i, i + groupSize)
      pages.push({
        type: 'multi-ticket',
        paper: { size: paperSize },
        orientation,
        invoiceDocumentIds: group.map((f) => f.invoiceDocumentId || resolveInvoiceIdentity(f) || ''),
        slots: group.map(buildSlot),
      })
    }
    // 关键不变量：doPrint 忽略 extraSpecial，merge 不展开 round2
    return {
      strategy: { oneNormalTwoSpecial: !!settings.extraSpecial },
      mergeMode,
      pages,
      extraPages: [],
    }
  }

  // ── source 路径：每文件 1 物理页（executePrint L817-841） ──
  const round1 = sourceFiles.map((f) => ({
    type: 'single',
    paper: { size: paperSize },
    orientation,
    invoiceDocumentId: f.invoiceDocumentId || resolveInvoiceIdentity(f) || '',
    source: { fileId: f.key, pageIndex: 0 },
    slots: [buildSlot(f)],
  }))

  // 一普二专：仅 source 路径，专票作第 2 轮（executePrint L822-829）
  let extraPages = []
  if (settings.extraSpecial) {
    const specialFiles = sourceFiles.filter(
      (f) => f.invoiceType && f.invoiceType.includes('专票')
    )
    extraPages = specialFiles.map((f) => ({
      type: 'single',
      paper: { size: paperSize },
      orientation,
      invoiceDocumentId: f.invoiceDocumentId || resolveInvoiceIdentity(f) || '',
      source: { fileId: f.key, pageIndex: 0 },
      slots: [buildSlot(f)],
      _round: 2,
    }))
  }

  return {
    strategy: { oneNormalTwoSpecial: !!settings.extraSpecial },
    mergeMode,
    pages: round1,
    extraPages,
  }
}

export default buildLegacyPrintPlan
