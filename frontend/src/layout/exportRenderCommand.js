/**
 * exportRenderCommand.js — D3-2 Export RenderCommand Producer（纯函数 / node-safe）
 *
 * 给 Export 增加 RenderCommand 生产能力（D3 混合路线：PDF 保留 insert_pdf 透传，
 * 非 PDF / 一页多票重排版 Export 走 RenderCommand）。本文件只做「几何 → 命令组装」，
 * 是 producer，不是 executor（禁止任何 ctx.* / fit / dpi 重算）。
 *
 * 设计纪律（对齐 D3-1 边界冻结 + D1 收敛不变式）：
 *  • 零第三套 placement：单源直接委托 buildSingleFileRenderCommand，多票走 createPlacement
 *    内联循环——两者都收敛到 createPlacement 这一唯一几何来源，与 Preview / Print 同构。
 *  • 纯函数、DOM-free、node-safe：仅 import createPlacement / buildSingleFileRenderCommand
 *    （均为纯数学），不 import config / renderers / window / React。
 *  • clip === contentRect（几何所有权边界），绝不透出裸 margin / dpi / slot 几何给 Renderer / Executor。
 *  • 禁止 calculateFitScale / calculateCenteredPosition（D3-1 冻结 schema，禁止引入第三套 fit）。
 *
 * 一致性契约（V16：Preview geometry ≡ Export placement semantics）：
 *   相同 {sourceWidth, sourceHeight, contentRect, rotation} 输入，
 *   buildExportRenderCommand 必须 === buildSingleFileRenderCommand 输出（见 exportRenderCommand.test.js）。
 *
 * @param {Object} docState
 * @param {number} docState.sourceWidth  - 内容固有宽(px，非预旋)
 * @param {number} docState.sourceHeight - 内容固有高(px，非预旋)
 * @param {Object} docState.contentRect  - 可打印区域 px 矩形 {x,y,width,height}
 * @param {0|90|180|270} [docState.rotation=0]
 * @param {Object} [docState.paper=null] - 满足 validateRenderCommand 的 paper（透传，executor 用）
 * @param {*} [docState.sourceRef=null] - 可选：内容源引用，仅透传不决策
 * @returns {Object} RenderCommand（与 buildSingleFileRenderCommand / _buildComposeCommand 同形状）
 */
import { createPlacement } from '../compose/composePlacement.js'
import { buildSingleFileRenderCommand } from './singleFileRenderCommand.js'

/**
 * 单源 Export RenderCommand Producer。
 * 直接委托 buildSingleFileRenderCommand（同一 createPlacement 来源）→ 字节同构 Preview，
 * 锁死 Preview≡Export 几何一致。非 PDF / 单 PDF 重排版 Export（Case ④ / Case ③ 单源）走此。
 */
export function buildExportRenderCommand(docState) {
  const {
    sourceWidth,
    sourceHeight,
    contentRect,
    rotation = 0,
    paper = null,
    sourceRef = null,
  } = docState || {}

  return buildSingleFileRenderCommand({
    sourceWidth,
    sourceHeight,
    contentRect,
    rotation,
    paper,
    sourceRef,
  })
}

/**
 * 多票（一页多票重排版）Export RenderCommand Producer（Case ③）。
 * 复用 createPlacement 内联循环——与 Preview / Print 的 _buildComposeCommand 字节同构
 * （同一几何来源 createPlacement，非第三套 fit）。此处不 import renderers.js 以保持 node-safe；
 * 缺内容源 → null（与 _buildComposeCommand 一致），executor 端跳过。
 *
 * @param {Object} docState
 * @param {Array<{itemId:string,contentRect:Object}>} docState.slots - 重排版槽位（含 contentRect）
 * @param {Map<string,{width:number,height:number}>} docState.contentSources - itemId → 内容固有尺寸
 * @param {Object<string,number>} [docState.rotations] - itemId → 旋转角(0/90/180/270)
 * @param {Object} [docState.paper=null] - 透传 paper
 * @returns {(Object|null)[]} 与 slots 一一对应的 RenderCommand
 */
export function buildExportRenderCommands(docState) {
  const { slots = [], contentSources, rotations, paper = null } = docState || {}
  return slots.map((slot) => {
    if (!slot) return null
    const cs = contentSources && contentSources.get(slot.itemId)
    if (!cs) return null // 缺内容源 → null（与 _buildComposeCommand 一致）
    const rotate = (rotations && rotations[slot.itemId]) || 0
    // 复用 createPlacement（唯一几何来源）组装单票命令，clip 锁 slot.contentRect。
    const p = createPlacement({ contentRect: slot.contentRect, sourceWidth: cs.width, sourceHeight: cs.height, rotation: rotate })
    return {
      version: 1,
      paper,
      rotatedBounds: p.rotatedBounds,
      placement: { scale: p.scale, offsetX: p.offsetX, offsetY: p.offsetY },
      contentRotation: rotate,
      rotation: 0, // [LEGACY Wire] 兼容字段，恒 0
      clip: p.clip,
      sourceRef: null,
    }
  })
}
