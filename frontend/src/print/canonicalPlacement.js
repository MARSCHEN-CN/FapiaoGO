/**
 * canonicalPlacement.js — R2.1 纯数据结构提炼（Canonical Print Composition）
 *
 * ❄️ 阶段定位：R2.1 严格只做「数据结构提炼」，零渲染行为变更。
 *   • 不重新设计公式 / 不重算几何 —— 几何 100% 委托 RotationResolver.resolveContentPlacement
 *     计算，本模块只把它的输出重新组织成稳定的 CanonicalPlacement 契约。
 *   • 不改 RotationResolver、不动 Preview / Print / Raster Path、不接 Canvas。
 *   • Golden 真值源 = PrintPreviewCanvas + PrintPreviewModel + RotationResolver（N6 已 PASS）。
 *
 * CanonicalPlacement 字段归组（来自 R2 设计文档 §Q4）：
 *   source        —— 原件引用（docId/page/contentRotation 等任意结构），几何与源解耦
 *   virtualPaper   —— Virtual Paper 描述（外框物理尺寸 / 方向 / 边距 / 可用区）
 *   contentRect    —— 可用区别名（virtualPaper.contentRectPx 的同值复制，方便消费者直接取）
 *   scale          —— fit scale（px@dpi）
 *   translation    —— 内容在画布上的左上角偏移（px@dpi, slot-local）
 *   rotation       —— 两阶段旋转分解 {content, layout, render}（保留 Golden 双阶段语义）
 *   pivot          —— 内容中心（effective content space, px），旋转绕此点
 *   placedRect     —— 缩放居中后内容包围盒（px@dpi, slot-local）
 *   renderTransform —— Golden 原样携带的投影矩阵（R2.2 新增）
 *
 * @module print/canonicalPlacement
 */

import { resolveContentPlacement } from '../layout/RotationResolver.js'

/** CanonicalPlacement 契约版本号（下游消费者可据此判断是否兼容）。 */
export const CANONICAL_PLACEMENT_VERSION = 1

/**
 * 从 RotationResolver 当前正确输出提炼 CanonicalPlacement（纯函数，无副作用）。
 *
 * ⚠️ 纪律：本函数不重算任何 fit / rotation 公式，几何完全源自 resolveContentPlacement。
 *   任何「看起来像 RotationResolver」的重算都违反 R2.1； geometries 的唯一权威仍是 Golden。
 *
 * @param {Object} request
 * @param {{width:number, height:number}} request.contentPhysicalSize - 物理内容尺寸 px@dpi（旋转前原始）
 * @param {number} request.contentRotation - 用户旋转 0/90/180/270
 * @param {{widthMM:number, heightMM:number}} request.physicalPaper - Virtual Paper 物理尺寸（mm）
 * @param {{left?:number, right?:number, top?:number, bottom?:number}} [request.margins] - 安全边距 mm
 * @param {number} [request.dpi=300]
 * @param {object} [request.source] - 原件引用（任意结构），原样透传，几何与源解耦
 * @returns {Object} CanonicalPlacement
 */
export function buildCanonicalPlacement(request) {
  // ✅ 委托给 Golden 几何真值源；本模块不重算任何 fit/rotation 公式。
  const r = resolveContentPlacement({
    contentPhysicalSize: request.contentPhysicalSize,
    contentRotation: request.contentRotation,
    physicalPaper: request.physicalPaper,
    margins: request.margins,
    dpi: request.dpi,
  })

  return {
    source: request.source ?? null,
    virtualPaper: {
      paperSizeMM: { widthMM: request.physicalPaper.widthMM, heightMM: request.physicalPaper.heightMM },
      orientation: r.physicalPaperOrientation,
      marginsMM: request.margins ?? {},
      paperRectPx: { ...r.canvasSize },
      contentRectPx: { ...r.availableRect },
    },
    contentRect: { ...r.availableRect },
    scale: r.scale,
    translation: { x: r.offset.x, y: r.offset.y },
    rotation: {
      content: r.contentRotation,
      layout: r.layoutRotation,
      render: r.renderRotation,
    },
    pivot: {
      x: r.renderTransform.rotationCx,
      y: r.renderTransform.rotationCy,
    },
    placedRect: { ...r.placedRect },
    // R2.2（旁路投影验证）：原样携带 Golden 的 SVG renderTransform —— 唯一无损投影描述。
    //   R2.1 只保留了 pivot/scale/translation(=取整 offset)，投影矩阵本身被丢弃；
    //   Canvas Adapter 要成为「零计算投影仪」（只执行 translate/rotate/scale/drawImage），
    //   必须直接消费 renderTransform（逐字带上，非重算、非派生）。
    renderTransform: { ...r.renderTransform },
  }
}

export default buildCanonicalPlacement
