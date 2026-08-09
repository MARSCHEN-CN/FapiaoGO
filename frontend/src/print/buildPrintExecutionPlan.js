/**
 * buildPrintExecutionPlan — 打印执行计划纯函数提取（A1）
 *
 * 职责：
 *   把 executePrint / doPrint 中「构建打印任务」的逻辑（过滤、顺序、合并分组、
 *   一普二专展开、每文件旋转）抽成一个 pipeline-agnostic 的纯函数。
 *
 * 冻结边界（A1 不越界）：
 *   - 只描述「打印什么」：哪些文件、什么顺序、如何组合成物理页、每 slot 旋转、策略展开。
 *   - 不描述「怎么画」：禁止 usableRect / slotRect / transform / scale / canvas / dpi。
 *   - 不接任何执行路由，不改变打印行为（source / canvas 几何差异全部留在各自 adapter）。
 *   - 多页文档（OFD/PDF 多页）的逐页展开留在渲染层（renderFileToPrintImage / buildPrintJobItem），
 *     Plan 层面每个文件 = 1 个执行单元（与 executePrint / doPrint 当前粒度一致）。
 *   - Step 5A: 每页 plan 加 invoiceDocumentId 标注（Invoice Entity Boundary Freeze v1）。
 *     不替换 f.key（打印执行需要文件路径），作为身份追踪字段。
 *
 * 这是 executePrint / doPrint / 未来 PrintPreviewModel 的共同「打印事实描述」来源。
 * Plan 是共同语言，不是要求所有执行路径立即一致 —— source adapter 与 canvas adapter 各自
 * 消费同一 Plan 时保留其现有几何差异（见冻结文档 §A0/A1）。
 *
 * @module print/buildPrintExecutionPlan
 */

import { isMergeMode, getForcedLandscape } from '../utils/mergeMode.js'
import { resolveInvoiceIdentity } from '../utils/invoiceIdentityResolver.js'

/**
 * Source 打印入口过滤（忠实镜像 executePrint L817）。
 * 仅已解析、且具备 printPath/path 的文件参与。
 */
export const SOURCE_FILE_FILTER = (f) =>
  f.status === 'parsed' && (f.printPath || f.path)

/**
 * Merge 打印入口过滤（忠实镜像 doPrint L453-459）。
 * 允许已解析与解析失败（有 printPath 即可打印）；OFD 需 docId 或 previewImage 任一。
 * ⚠️ 与 SOURCE_FILE_FILTER 故意不同 —— A1 不统一过滤规则，保留入口差异。
 */
export const MERGE_FILE_FILTER = (f) => {
  if (!f.printPath) return false
  if (f.status !== 'parsed' && f.status !== 'error') return false
  if (f.fileFormat === 'ofd' && !f.docId && !f.previewImage) return false
  return true
}

/**
 * normalizePrintSources — 将 page-level 文件选择转换为 source-level 打印目标
 *
 * 核心职责：
 *   - 识别多页文档（通过 sourceDocId + instanceId 聚合）
 *   - 判断是否为完整文档选择（所有页面都被选中）
 *   - 完整文档选择 → 合并为单个 Source 打印目标
 *   - 部分页面选择 → 保持逐页模式
 *
 * 设计原则：
 *   - 不修改 buildPrintExecutionPlan 的内部逻辑
 *   - 只在输入层做 Document→PrintSource 的转换
 *   - 使用领域字段（sourceDocId/instanceId/pageNum/totalPages），不依赖 UI 层字段
 *
 * @module print/normalizePrintSources
 */

/**
 * 判断文件是否为多页文档的一页（仅 PDF 格式支持源文件聚合打印）
 * OFD 格式不支持源文件打印，需逐页渲染，因此不参与聚合
 * @param {Object} file - 文件对象
 * @returns {boolean}
 */
function isMultiPageDocumentFile(file) {
  if (!file) return false
  if (file.fileFormat === 'ofd') return false
  return !!(
    file.sourceDocId != null &&
    file.totalPages != null &&
    file.totalPages > 1 &&
    file.pageNum != null
  )
}

/**
 * 构建分组键：instanceId + sourceDocId 复合键
 * @param {Object} f - 文件对象
 * @returns {string}
 */
function makeSourceGroupKey(f) {
  const instanceId = f?.instanceId || ''
  const sourceDocId = f?.sourceDocId || ''
  if (instanceId && sourceDocId) {
    return `${instanceId}::${sourceDocId}`
  }
  return sourceDocId || instanceId || ''
}

/**
 * 归一化打印源：将 page-level 文件选择转换为 source-level 打印目标
 *
 * 转换逻辑：
 *   1. 按 source identity 分组（instanceId + sourceDocId）
 *   2. 对每个分组检查是否为完整选择
 *      - 完整选择：合并为单个 source 打印目标
 *      - 部分选择：保持逐页模式
 *   3. 单页文件：保持原样
 *
 * @param {Array<Object>} files - page-level 文件数组
 * @returns {Array<Object>} normalized 后的文件数组（可能包含聚合的 source 目标）
 */
export function normalizePrintSources(files) {
  if (!Array.isArray(files) || files.length === 0) return files || []

  // Pass 1: 按 source identity 分组，同时记录每个分组/文件在原始数组中的首个位置
  const sourceGroups = new Map()
  const nonMultiPageFiles = []

  let globalIndex = 0

  for (const f of files) {
    if (!f) { globalIndex++; continue }

    if (!isMultiPageDocumentFile(f)) {
      nonMultiPageFiles.push({ file: f, index: globalIndex })
      globalIndex++
      continue
    }

    const groupKey = makeSourceGroupKey(f)
    if (!groupKey) {
      nonMultiPageFiles.push({ file: f, index: globalIndex })
      globalIndex++
      continue
    }

    let group = sourceGroups.get(groupKey)
    if (!group) {
      group = {
        key: groupKey,
        totalPages: f.totalPages,
        pages: [],
        seenPageNums: new Set(),
        firstIndex: globalIndex,   // Bug A-1: 按首个出现位置保持原始文件列表顺序
      }
      sourceGroups.set(groupKey, group)
    }

    // 避免重复页面
    if (!group.seenPageNums.has(f.pageNum)) {
      group.seenPageNums.add(f.pageNum)
      group.pages.push(f)
    }
    globalIndex++
  }

  // Pass 2: 构建结果，按 firstIndex/index 排序以保持原始文件列表顺序
  const items = []

  // 多页文档（完整选择 → 聚合为 source 目标；部分选择 → 逐页）
  for (const [key, group] of sourceGroups) {
    // 按页码排序
    group.pages.sort((a, b) => (a.pageNum ?? 0) - (b.pageNum ?? 0))

    const isCompleteSelection = group.seenPageNums.size >= group.totalPages

    if (isCompleteSelection) {
      // 完整选择：聚合为单个 source 打印目标
      const representative = group.pages[0]
      items.push({
        index: group.firstIndex,
        file: {
          ...representative,
          key: `__source_${key}`,  // 唯一标识
          _sourceGroupKey: key,
          _isAggregatedSource: true,
          _aggregatedPages: group.pages,
          _aggregatedPageCount: group.pages.length,
        },
      })
    } else {
      // 部分选择：保持逐页模式，位置在分组首出现处
      for (const page of group.pages) {
        items.push({ index: group.firstIndex, file: page })
      }
    }
  }

  // 非多页文件
  for (const { file, index } of nonMultiPageFiles) {
    items.push({ index, file })
  }

  // 按原始位置排序 → 保持文件列表顺序
  items.sort((a, b) => a.index - b.index)
  return items.map((item) => item.file)
}

/**
 * 打印会话上下文 → Plan 输入（Preview 与 Execute 唯一共享入口）。
 *
 * 冻结边界（打印预览 = PrintExecutionPlan 的可视化，非第二个预览器）：
 *   - Preview 不自行决定「打印哪些文件 / 用什么参数」——它只消费 Plan 的派生视图。
 *   - 本函数把「用户点击打印时的会话上下文」（files + settings + fileRotations）
 *     解析为 buildPrintExecutionPlan 的统一输入；Preview（derived previewModel）
 *     与 Execute（doPrint / executePrint）都从这里取参，杜绝
 *     「Print 用 A 参数、Preview 用 B 参数」的分叉（Commit 1 修复 P1/P2）。
 *   - filter 对齐规则：merge 模式 → MERGE_FILE_FILTER（允许 error 态有 printPath
 *     的文件参与），非 merge → SOURCE_FILE_FILTER（仅 parsed）。预览与执行同参
 *     同 filter → 纯函数同参同果，plan 即唯一事实源。
 *   - 未来新增参数分叉点（paper orientation / copies / extraSpecial / grayscale）
 *     一律在此收敛，不散落到各消费方。
 *
 * @param {Array<Object>} files - 文件对象数组（同 buildPrintExecutionPlan）
 * @param {Object} [settings] - 打印设置（mergeMode/paperSize/...）
 * @param {Object} [fileRotations] - { [fileKey]: rotationDegrees }
 * @param {Object} [placements] - { [fileKey]: PlacementResult }（Commit 3-A 新增：
 *   RotationResolver 输出，含 scale/offset/rotation。Preview 与 Print 共享布局结果。）
 * @returns {{files: Array<Object>, options: {filter: Function, settings: Object, fileRotations: Object, placements: Object}}}
 *   可直接解构传给 buildPrintExecutionPlan。
 */
export function createPrintPlanInput(files, settings = {}, fileRotations = {}, placements = {}) {
  const filter = isMergeMode(settings.mergeMode)
    ? MERGE_FILE_FILTER
    : SOURCE_FILE_FILTER

  // ⭐ 新增：在 source 模式下，先对文件进行归一化
  //   多页文档完整选择 → 聚合为单个 source 打印目标
  //   多页文档部分选择 → 保持逐页模式
  //   单页文件 → 保持原样
  const normalizedFiles = isMergeMode(settings.mergeMode)
    ? files  // merge 模式暂不处理，后续按需扩展
    : normalizePrintSources(files)

  return { files: normalizedFiles, options: { filter, settings, fileRotations, placements } }
}

/**
 * 从文件列表 + 打印配置提取打印执行计划。
 *
 * @param {Array<Object>} files - 前端文件对象数组（含 key/status/printPath/fileFormat/docId/previewImage/invoiceType）
 * @param {Object} [options]
 * @param {(f:Object)=>boolean} [options.filter] - 入口特定过滤器（默认不过滤，使用原始 files 副本）
 * @param {Object} [options.settings] - { mergeMode, landscape, paperSize, extraSpecial }
 * @param {Object} [options.fileRotations] - { [fileKey]: rotationDegrees }
 * @param {Object} [options.placements] - { [fileKey]: PlacementResult }（Commit 3-A 新增：
 *   RotationResolver 输出。Preview 与 Print 共享布局结果，避免各自解释旋转。）
 * @param {string} [options.mode] - 仅作注释/未来；Plan 数据本身 pipeline-agnostic
 * @returns {{
 *   strategy: { oneNormalTwoSpecial: boolean },
 *   mergeMode: string,
 *   pages: Array<Object>,
 *   extraPages: Array<Object>,
 * }}
 */
export function buildPrintExecutionPlan(files, options = {}) {
  const {
    filter,
    settings = {},
    fileRotations = {},
    placements = {},
  } = options

  // 1. 过滤（保留入口差异：filter 完全透传，A1 不统一口径）
  const sourceFiles = filter ? files.filter(filter) : files.slice()

  // 2. 顺序：保持 files 过滤后的自然顺序（与 executePrint/doPrint 一致）
  const mergeMode = settings.mergeMode || 'none'
  const isMerge = isMergeMode(mergeMode)
  const groupSize = isMerge
    ? (parseInt(mergeMode.replace('merge', ''), 10) || 2)
    : 1

  // 3. 实现方向（执行事实，非几何）：merge 模式强制方向，其余用用户配置
  const orientation = isMerge
    ? (getForcedLandscape(mergeMode, settings.landscape) ? 'landscape' : 'portrait')
    : (settings.landscape ? 'landscape' : 'portrait')

  const paperSize = settings.paperSize || 'A4'
  const perFileRotation = (f) => fileRotations[f.key] || 0
  const perFilePlacement = (f) => placements[f.key] || null

  // Commit 3-A: 统一 slot 构建函数，确保 contentRotation / placement 字段一致
  const buildSlot = (f) => {
    const contentRotation = perFileRotation(f)
    return {
      fileId: f.key,
      rotation: contentRotation,  // deprecated alias → 迁移后删除
      contentRotation,           // 用户旋转（来自 fileRotations）
      placement: perFilePlacement(f),  // RotationResolver 布局结果（Commit 3-A 新增）
      invoiceDocumentId: f.invoiceDocumentId || resolveInvoiceIdentity(f) || '',
    }
  }

  // ── merge 模式：按 groupSize 滑窗分组，每组 = 1 物理页（多 slot） ──
  // 忠实镜像 doPrint L493-502
  if (isMerge) {
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
    // 注意：当前 doPrint 不处理一普二专（保留该行为不变量，不在此展开 extraPages）
    return {
      strategy: { oneNormalTwoSpecial: !!settings.extraSpecial },
      mergeMode,
      pages,
      extraPages: [],
    }
  }

  // ── 单文件 / source 模式：每个文件 = 1 物理页（1 slot） ──
  // 忠实镜像 executePrint L817-841（source 单文件逐文件打印）
  const round1 = sourceFiles.map((f) => ({
    type: 'single',
    paper: { size: paperSize },
    orientation,
    invoiceDocumentId: f.invoiceDocumentId || resolveInvoiceIdentity(f) || '',
    // 多页文档逐页展开在渲染层（renderFileToPrintImage / buildPrintJobItem）；
    // Plan 层面每文件=1 单元，pageIndex 默认 0。
    source: { fileId: f.key, pageIndex: 0 },
    slots: [buildSlot(f)],
  }))

  // 一普二专：专票作为第 2 轮额外打印
  // 忠实镜像 executePrint L822-829（仅 source 路径；merge 路径 doPrint 忽略，已在上分支处理）
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

export default buildPrintExecutionPlan
