/**
 * MultiTicketComposer.js — 一页多票合成薄层（纯函数 / node-safe）
 *
 * 职责（对齐 V16：Layout owns geometry / Placement only by createPlacement）：
 *   「给定 PaperLayout + N 个 DocumentState → N 个 RenderCommand（每票一个，fit 进其票位）」。
 *   不做任何 fit / scale / offset / margin 自算（全部委托 buildRenderCommand → createPlacement）。
 *
 * 使用场景：
 *   Preview 合并渲染 / Print 多票打印 / Export 一页多票 —— 三者公用此层，确保几何单源。
 *
 * @module MultiTicketComposer
 */

import { computeSlots } from './SlotLayout.js'
import { buildRenderCommand } from './RenderLayoutFactory.js'
import { documentStateToPlan } from '../compose/composePagePlan.js'  // 13-E.1 B-lite adapter

/**
 * @typedef {Object} DocumentState
 * @property {{w:number,h:number}} pageSize
 * @property {'portrait'|'landscape'} [pageOrientation]
 * @property {number} [rotation]
 */

/**
 * @typedef {Object} ComposedTicket
 * @property {DocumentState} documentState
 * @property {import('./RenderLayoutFactory.js').RenderCommand} renderCommand
 */

/**
 * 把一页 N 票的文档组 → 每票 RenderCommand（fit+center+clip 进其 slot）。
 *
 * 关键设计：
 *   ticketCount 与 documents.length 解耦——merge 模式下页面 slot 数由
 *   merge 设置（如 merge2=2）决定，独立于实际提供的文档数（如在 merge2
 *   + 1 文件场景下，页面仍然分为 2 个 slot，文件进 slot0，slot1 空）。
 *   当 ticketCount 缺省时，回退 documents.length（单文件/非 merge 兼容）。
 *
 * 调用方职责：
 *   ① 准备 paperLayout（computePaperLayout 产物，含已内缩边距的 usableRect）
 *   ② 准备 documents[]（来自 ImportSessionStore / 文件列表的 documentState）
 *   ③ ticketCount（可选）：页面 slot 总数；缺省=documents.length
 *
 * 不变量：
 *   • 输出数组长度 === min(documents.length, slots.length)（每文档一个 command）
 *   • 每个 renderCommand 的 clip 锁在 slot 边界，executor 端防邻票渗色
 *   • count<=1 退化为整页单票（无 slot 切割，与 buildRenderCommand() 无 slot 行为一致）
 *   • 非法 paperLayout → 返回空数组（调用方应跳过渲染）
 *
 * @param {Object} params
 * @param {Object} params.paperLayout  - computePaperLayout 产物（px@dpi，自然空间）
 * @param {DocumentState[]} params.documents - 文档状态数组
 * @param {number} [params.ticketCount] - 页面 slot 总数（可选；缺省=documents.length）
 * @returns {ComposedTicket[]}
 */
/**
 * 13-E.1 B-lite：由 ComposePagePlan[] 合成每票 RenderCommand。
 * 与 compose() 同契约，但输入是已携带来源身份的 plan（而非裸 DocumentState），
 * 并在产出的 RenderCommand 上附加 meta:{docId,pageId}（additive，executor 忽略）。
 *
 * @param {Object} params
 * @param {Object} params.paperLayout
 * @param {Object[]} params.plans - ComposePagePlan[]（含 source + documentState）
 * @param {number} [params.ticketCount]
 * @param {'vertical'|'grid'} [params.strategy='vertical'] - 切分策略
 * @param {number} [params.gridCols=2] - grid 模式列数
 * @param {number} [params.gridRows=2] - grid 模式行数
 * @returns {Array<{plan:Object, renderCommand:Object}>}
 */
export function composePlans({ paperLayout, plans, ticketCount, strategy = 'vertical', gridCols = 2, gridRows = 2 }) {
  if (!paperLayout || !plans || !Array.isArray(plans) || plans.length === 0) {
    return []
  }

  const count = (ticketCount != null) ? ticketCount : plans.length
  const slots = computeSlots(paperLayout, { count, strategy, gridCols, gridRows })
  if (slots.length === 0) return []

  const result = []
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]
    const slot = slots[i]
    if (!slot) {
      console.warn(`[composePlans] plans[${i}] skipped: no slot (slot count=${slots.length}, plan count=${plans.length})`)
      continue
    }
    // Gate 3-4A (D2/B-10): 把 plan 上挂载的 PrintGeometry 传给 Factory，作为 contentRotation 唯一来源；
    // 旧 3 参数路径（preview / compose() adapter）不传 printGeometry → 走 legacy shim（B-11）。
    const renderCommand = buildRenderCommand(paperLayout, plan.documentState, slot, plan.printGeometry)
    // 13-E.1：附加来源身份（drawRenderCommand / validateRenderCommand 均忽略 meta，冻结契约不受损）
    result.push({
      plan,
      renderCommand: { ...renderCommand, meta: plan.source ?? null },
    })
  }

  return result
}

/**
 * 兼容入口（13-E.1 前既有调用方：renderers / 测试）。
 * 将 DocumentState[] 经 documentStateToPlan 包装为 plan，委托 composePlans。
 * 返回形状保持 { documentState, renderCommand } 以兼容旧消费方。
 *
 * @param {Object} params
 * @param {Object} params.paperLayout
 * @param {DocumentState[]} params.documents
 * @param {number} [params.ticketCount]
 * @param {'vertical'|'grid'} [params.strategy='vertical']
 * @param {number} [params.gridCols=2]
 * @param {number} [params.gridRows=2]
 * @returns {Array<{documentState:Object, renderCommand:Object}>}
 */
export function compose({ paperLayout, documents, ticketCount, strategy = 'vertical', gridCols = 2, gridRows = 2 }) {
  const plans = (documents || []).map((d, i) => documentStateToPlan(d, i))
  return composePlans({ paperLayout, plans, ticketCount, strategy, gridCols, gridRows }).map(({ plan, renderCommand }) => ({
    documentState: plan.documentState,
    renderCommand,
  }))
}
