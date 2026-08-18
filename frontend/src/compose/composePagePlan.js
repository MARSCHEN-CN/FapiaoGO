/**
 * composePagePlan.js — 13-E.1 B-lite 中间层（纯函数 / node-safe）
 *
 * 定位（对齐 13-E.0 triage 结论）：补 V16 唯一真实断层——
 *   FileObj[]（merge 入口）不携带 Document/Page 身份，导致 RenderCommand
 *   无法回溯来源 docId/pageId。本模块在「FileObj → RenderCommand」之间
 *   插入一层轻量 ComposePagePlan，仅承载「来源身份 + 几何输入(documentState)」，
 *   不持有也不污染 slot 几何（slot 由 compose/* 几何层自有）。
 *
 * 设计纪律（对齐 13-E.1 冻结清单）：
 *  • 不修改 drawRenderCommand / createPlacement / RenderCommand 既有契约 / usePrint。
 *  • 不把 docId/pageId 挂到 slot 上（slot 只知几何，不知来源）——故 plan.placement.slot
 *    在 v1 保留为占位 null，不注入几何，避免「几何层知道来源」的耦合回潮。
 *  • 不引入 render 字段（无 previewUrl/thumbnailUrl），避免与 RenderCommand.previewUrl /
 *    DocumentPage.previewUrl 形成第三个事实源。
 *  • 纯函数、DOM-free：仅依赖入参，不依赖 React / electron / config。
 *
 * @module composePagePlan
 */

import { buildPrintGeometry } from '../geometry/PrintGeometryBuilder.js'

/**
 * 由 FileObj（merge 入口项）构造 ComposePagePlan。
 *
 * 身份派生优先级：
 *   docId  : item.docId ?? item.id ?? item.key
 *   pageId : item.pageId ?? `${docId}#p${(item.pageIndex ?? index) + 1}`
 *   —— 若上游（13-D.2 DocumentStore）已填充 docId，则真实回源；否则退化为
 *      item.id 派生（保证 plan 永远可构造，绝不因缺 identity 抛错）。
 *
 * @param {Object} item - FileObj（含 id/key/docId/pageId/pageIndex/width/height/rotation）
 * @param {number} [index=0] - 在 merge 组内的序号（用于 pageId 兜底派生）
 * @param {{width:number,height:number}|null} [cs] - Phase1 已光栅化的真实像素尺寸（可选）
 * @param {'portrait'|'landscape'} [forcedOrient='portrait'] - 合并模式强制纸张方向
 * @param {Object<string,number>} [rotations] - itemId → 旋转角覆盖（与 renderers 同源）
 * @returns {Object} ComposePagePlan { planId, source:{docId,pageId}, placement:{slot:null}, documentState }
 */
export function fileObjToComposePagePlan(item, index = 0, cs = null, forcedOrient = 'portrait', rotations = null) {
  const it = item || {}
  const id = it.id || it.key || `item-${index}`
  const docId = it.docId ?? id
  const pageId = it.pageId ?? `${docId}#p${(it.pageIndex ?? index) + 1}`

  const w = cs ? cs.width : (it.width || 0)
  const h = cs ? cs.height : (it.height || 0)

  const fileRotation = it.rotation || 0
  const rotation = (rotations && rotations[id]) ? rotations[id] : fileRotation

  // Gate 3-4A (D2/B-10): 内容旋转决策收敛到 PrintGeometryBuilder（单一 resolver）。
  // 与既有的 w/h/pageSize/forcedOrient/rotation 同源输入，不引入新的内容几何来源；
  // 输出的 effectiveRotation 已是 canonical {0,90,180,270}，供 RenderCommand Factory 直接消费（B-10a 不二次 normalize）。
  const printGeometry = buildPrintGeometry({
    rawDocumentGeometry: { widthPx: w, heightPx: h },
    requestedPaperGeometry: { orientation: forcedOrient },
    userRotation: { degrees: rotation },
  })

  const documentState = {
    pageSize: { w, h },
    pageOrientation: (w >= h) ? 'landscape' : 'portrait',
    requestedPaperOrientation: forcedOrient,
    rotation,
  }

  return {
    planId: `plan-${docId}-${pageId}-${index}`,
    source: { docId, pageId },
    // v1 保留占位：slot 几何由 compose 层 computeTicketSlots 自有，plan 不持有，
    // 严格隔离「身份层」与「几何层」（slot 不应知道来源）。
    placement: { slot: null },
    // Gate 3-4A: 挂载 PrintGeometry（含 canonical effectiveRotation），供 composePlans → buildRenderCommand 消费；
    // documentStateToPlan 路径不挂此字段 → 走 legacy shim（B-11 兼容）。
    printGeometry,
    documentState,
  }
}

/**
 * 由既有 DocumentState 构造 ComposePagePlan（供 compose() adapter 复用）。
 * 若 documentState 已携带 docId/pageId（未来单文件路径接入 plan 时），直接采用；
 * 否则 source 为 null（graceful：plan 可构造，renderCommand 不带 meta）。
 *
 * @param {Object} documentState
 * @param {number} [index=0]
 * @returns {Object} ComposePagePlan
 */
export function documentStateToPlan(documentState, index = 0) {
  const ds = documentState || {}
  const docId = ds.docId ?? null
  const pageId = ds.pageId ?? null
  return {
    planId: `plan-ds-${index}-${docId || 'none'}`,
    source: (docId && pageId) ? { docId, pageId } : null,
    placement: { slot: null },
    documentState: ds,
  }
}
