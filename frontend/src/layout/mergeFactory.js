/**
 * mergeFactory — Slice 1.3 (D1) Merge/N-Up 唯一布局派生点
 *
 * 收敛目标（与 buildRenderCommand 同源，消灭 Merge 路径上的「第三套」fit/rotate/center 数学）：
 *   • 单文件预览：buildRenderCommand 在 RenderLayoutFactory.js（Renderer 纯执行）。
 *   • Merge 主线程：renderers.js::_renderDirect（L1070-1093 旧内联数学 → 本工厂）。
 *   • Merge Worker：render.worker.js::compositeCanvas（L34-52 旧内联数学 → 本工厂产出 + drawRenderCommand 纯执行）。
 *
 * 设计纪律（对齐 V17 + D1 收敛不变式）：
 *  • 纯函数（F5）：仅依赖入参（layout / contentMeta / rotations / options），无 DOM / electron / React。
 *  • 复用 layout.js 的 calculateFitScale / calculateCenteredPosition 与 RenderLayoutFactory 的
 *    normalizeRotation —— 与单文件 buildRenderCommand 同源，杜绝「同一公式两份实现」漂移。
 *  • 产出的 RenderCommand 与单文件 RenderCommand 同构（version/placement/rotatedBounds/contentRotation/
 *    paperLandscape/clip），因此 drawRenderCommand / validateRenderCommand 三处渲染位置通用。
 *  • 本工厂只做布局数学；像素光栅化（PDF pdf.js / 图片 decode）仍在 renderers Phase 1 完成，不在此层。
 *
 * 调用方（renderers.js）职责：
 *   1. Phase 1 预加载得到 contentSources（每项真实像素尺寸 width/height）。
 *   2. createLayout 得到 page/area/slots（绝对坐标，px@dpi）。
 *   3. 用 contentSources 组装 contentMeta（Map<itemId,{width,height}>）。
 *   4. 调用本工厂得到 commands[]，逐条喂 drawRenderCommand(ctx, cmd, source, ...)。
 */

import { calculateFitScale, calculateCenteredPosition } from '../layout.js'
import { normalizeRotation, emptyRenderCommand } from './RenderLayoutFactory.js'

/**
 * 由 createLayout 产出的 page/area 构造一个最小 composite paperLayout，
 * 仅用于满足 validateRenderCommand 对 cmd.paper 的要求（truthy）与提供 paperRect/usableRect 上下文。
 * Merge 的「纸」就是整张合成画布；每个 slot 的裁剪由 cmd.clip 表达。
 *
 * @param {{width:number,height:number}} page 合成画布像素尺寸（px@dpi）
 * @param {{x:number,y:number,width:number,height:number}} area 可打印区
 * @returns {object} 最小 PaperLayout
 */
function makeCompositePaperLayout(page, area) {
  return {
    paperRect: { w: page.width, h: page.height },
    usableRect: { x: area.x, y: area.y, w: area.width, h: area.height },
    clipRect: { x: area.x, y: area.y, w: area.width, h: area.height },
    contentRect: { x: area.x, y: area.y, w: area.width, h: area.height },
  }
}

/**
 * 构建 Merge/N-Up 的 RenderCommand 数组（每 slot 一个）。
 *
 * @param {{page:object, area:object, slots:Array}} layout - createLayout 的输出
 * @param {Map<string,{width:number,height:number}>|Object} contentMeta - itemId → 内容真实像素尺寸
 * @param {Object} [rotations] - itemId → 旋转角(deg，任意值，工厂内 snap 到 90° 倍数)
 * @param {{isLandscape?:boolean, paperLayout?:object}} [options]
 *        isLandscape: 合成纸张是否横向（由调用方 getForcedLandscape 决定，是 PaperOrientation Fact 派生）
 *        paperLayout: 可选，覆盖默认 composite paperLayout（用于注入真实 PaperLayout 上下文）
 * @returns {Array<ReturnType<typeof emptyRenderCommand>>} 与 slots 对齐的 RenderCommand[]（跳过无内容的 slot）
 */
export function buildMergeRenderCommands(layout, contentMeta, rotations = {}, options = {}) {
  const { page, area, slots } = layout || {}
  if (!page || !slots || !slots.length) return []

  const isLandscape = options.isLandscape ?? (page.width > page.height)
  const paperLayout = options.paperLayout || makeCompositePaperLayout(page, area)
  const paperLandscape = isLandscape

  const getMeta = (id) => (contentMeta && typeof contentMeta.get === 'function'
    ? contentMeta.get(id)
    : (contentMeta ? contentMeta[id] : null))

  const commands = []
  for (const slot of slots) {
    if (!slot) continue
    const id = slot.itemId
    const meta = getMeta(id)
    if (!meta || !meta.width || !meta.height) continue

    const contentRotation = normalizeRotation((rotations && rotations[id]) || 0)
    const natW = meta.width
    const natH = meta.height

    // 旋转后内容包围盒（90/270 交换 natW/natH；0/180 不交换）。与 buildRenderCommand 同源逻辑。
    const rotated = contentRotation % 180 !== 0
    const rotatedBounds = rotated
      ? { width: natH, height: natW }
      : { width: natW, height: natH }

    // Fit + Center 在 slot（= 该项 usableRect）上做（Renderer 不重算）。
    const slotBox = { x: slot.x, y: slot.y, width: slot.width, height: slot.height }
    const fitScale = calculateFitScale(slotBox, rotatedBounds)
    const pos = calculateCenteredPosition(slotBox, rotatedBounds, fitScale)

    commands.push({
      version: 1,
      paper: paperLayout,
      paperRect: { w: page.width, h: page.height },
      usableRect: { x: area.x, y: area.y, w: area.width, h: area.height },
      rotatedBounds,
      placement: {
        scale: fitScale,
        offsetX: pos.x,
        offsetY: pos.y,
      },
      rotation: 0, // [LEGACY Wire] Slice 1.1 恒 0（与 buildRenderCommand 一致）
      contentRotation,
      paperLandscape,
      clip: { x: slot.x, y: slot.y, width: slot.width, height: slot.height },
    })
  }
  return commands
}
