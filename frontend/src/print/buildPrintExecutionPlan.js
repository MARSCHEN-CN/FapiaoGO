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
  return { files, options: { filter, settings, fileRotations, placements } }
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
