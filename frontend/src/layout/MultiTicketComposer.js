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

import { computeTicketSlots } from './SlotLayout.js'
import { buildRenderCommand } from './RenderLayoutFactory.js'

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
export function compose({ paperLayout, documents, ticketCount }) {
  if (!paperLayout || !documents || !Array.isArray(documents) || documents.length === 0) {
    return []
  }

  const count = (ticketCount != null) ? ticketCount : documents.length
  const slots = computeTicketSlots(paperLayout, count)
  if (slots.length === 0) return []

  const result = []
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i]
    const slot = slots[i]
    if (!slot) {
      console.warn(`[MultiTicketComposer] documents[${i}] skipped: no slot (slot count=${slots.length}, doc count=${documents.length})`)
      continue
    }
    const renderCommand = buildRenderCommand(paperLayout, doc, slot)
    result.push({ documentState: doc, renderCommand })
  }

  return result
}
