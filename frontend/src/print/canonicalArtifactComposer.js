/**
 * canonicalArtifactComposer.js — R2.3-A Final Artifact 组合器（CanonicalPlacement 驱动，纯函数）
 *
 * ❄️ 阶段定位：R2.3-A 把 Final Artifact 的 PNG 生产端接到
 *   `RotationResolver → CanonicalPlacement → CanvasAdapter`，替代旧
 *   `MultiTicketComposer / buildRenderCommand / createPlacement` 几何。
 *   • 不碰 Preview（R1-Apply 已解耦）、不删旧 Raster（renderers.js 原样保留）、
 *     不改 Sumatra 链（PNG→PDF(margins=0)→Sumatra 不变）。
 *
 * 几何契约（严格复现 Golden PrintPreviewModel，N6 PASS 的真值源）：
 *   1. 可用区：paperLayout.usableRect（外纸边距已烤入）；横纸用 landUsable——
 *      swap 尺寸但边距不随内容旋转（PrintPreviewModel.js:157-161），
 *      **不用 slotToLandscape 轴交换**（非对称边距会溢出）。
 *   2. slot 划分：computeSlots({ usableRect: usable }, {count, strategy, gridCols, gridRows})——
 *      **与 Golden 一致不传 slotMarginPx**（Golden slot 内边距=0；
 *      旧 Print 的 5mm slotMarginPx 正是 N6 分叉源之一，不复现）。
 *   3. 每 slot = Virtual Paper：physicalPaper = slot.paperRect→mm，
 *      margins = paperRect→contentRect 四边内缩→mm（PrintPreviewModel.js:276-289 同款公式）。
 *   4. placement = buildCanonicalPlacement(...)（100% 委托 RotationResolver）；
 *      draw ops = buildCanvasDrawOps(placement)（零计算投影仪）；
 *      paper-absolute 偏移 = translate(slot.paperRect.x, slot.paperRect.y)。
 *   5. 源 = raw raster（rotation:0，PDF 无 paperKey 光栅化），contentRotation 由
 *      bake 进源（executor 层），adapter 只施加 layoutRotation——与 Golden 一致。
 *
 * 本模块零 canvas / DOM / pdf.js 依赖（纯几何），node 可直测；
 * 执行层（executeComposePlan / bakeSlotSource）通过注入 createCanvas 保持同样 node-safe。
 *
 * @module print/canonicalArtifactComposer
 */

import { computeSlots } from '../layout/SlotLayout.js'
import { buildCanonicalPlacement } from './canonicalPlacement.js'
import { buildCanvasDrawOps, applyDrawOps } from './canvasAdapter.js'

/** 组合器契约版本号。 */
export const CANONICAL_COMPOSE_VERSION = 1

/**
 * 生成 Canonical Final Artifact 合成计划（纯几何，零渲染）。
 *
 * @param {Object} p
 * @param {Object} p.paperLayout - computePaperLayout 产物（paperRect / usableRect）
 * @param {number} p.groupSize - 一页票数（merge2/3/4）
 * @param {'vertical'|'grid'} [p.strategy='vertical']
 * @param {number} [p.gridCols=2]
 * @param {number} [p.gridRows=2]
 * @param {boolean} [p.forcedLandscape=false]
 * @param {number} [p.dpi=300]
 * @param {Array<{width:number, height:number, contentRotation?:number}|null>} [p.slotSources]
 *   每 slot 的 raw 源描述（旋转前 px@dpi）；null/缺失 = 空 slot（不绘制）。仅需尺寸与旋转，不含图像本体。
 * @returns {{canvasSize:{width:number,height:number}|null, slots:Array<Object>, invalid:boolean}}
 *   slots[i] = { index, sourceIndex, translate:{x,y}, ops, contentRotation, placement, slot }
 */
export function composeCanonicalArtifactPlan({
  paperLayout,
  groupSize,
  strategy = 'vertical',
  gridCols = 2,
  gridRows = 2,
  forcedLandscape = false,
  dpi = 300,
  slotSources = [],
}) {
  if (!paperLayout || !paperLayout.paperRect || !paperLayout.usableRect) {
    throw new Error('canonicalArtifactComposer: paperLayout 需含 paperRect/usableRect（computePaperLayout 产物）')
  }
  const { paperRect, usableRect } = paperLayout

  // Golden 横纸语义（PrintPreviewModel.js:157-161）：swap 尺寸，边距不随内容旋转。
  const mR = paperRect.w - usableRect.w - usableRect.x
  const mB = paperRect.h - usableRect.h - usableRect.y
  const usable = forcedLandscape
    ? { x: usableRect.x, y: usableRect.y, w: paperRect.h - usableRect.x - mR, h: paperRect.w - usableRect.y - mB }
    : usableRect
  if (usable.w <= 0 || usable.h <= 0) {
    return { canvasSize: null, slots: [], invalid: true }
  }

  // 与 Golden 一致的 slot 划分：不传 slotMarginPx（slot 内边距=0，contentRect==paperRect）。
  const count = Math.max(1, Math.floor(groupSize) || 1)
  const slots = computeSlots({ usableRect: usable }, { count, strategy, gridCols, gridRows })

  const canvasSize = {
    width: forcedLandscape ? paperRect.h : paperRect.w,
    height: forcedLandscape ? paperRect.w : paperRect.h,
  }
  const pxPerMm = dpi / 25.4

  const out = slots.map((s, i) => {
    const src = slotSources[i]
    if (!src || !(src.width > 0) || !(src.height > 0)) {
      // 空 slot：不绘制（与旧路径 contentSources 缺失跳过语义一致）
      return { index: i, sourceIndex: -1, translate: { x: s.paperRect.x, y: s.paperRect.y }, ops: [], contentRotation: 0, placement: null, slot: s }
    }
    const slotPaper = s.paperRect
    const slotContent = s.contentRect || slotPaper
    // slot-local margins = paperRect → contentRect 四边内缩（px）→ mm（PrintPreviewModel.js:279-289 同款）
    const slotMarginLeft = slotContent.x - slotPaper.x
    const slotMarginTop = slotContent.y - slotPaper.y
    const slotMarginRight = slotPaper.width - slotContent.width - slotMarginLeft
    const slotMarginBottom = slotPaper.height - slotContent.height - slotMarginTop
    const placement = buildCanonicalPlacement({
      contentPhysicalSize: { width: src.width, height: src.height },
      contentRotation: src.contentRotation || 0,
      physicalPaper: { widthMM: slotPaper.width / pxPerMm, heightMM: slotPaper.height / pxPerMm },
      margins: {
        left: slotMarginLeft / pxPerMm,
        right: slotMarginRight / pxPerMm,
        top: slotMarginTop / pxPerMm,
        bottom: slotMarginBottom / pxPerMm,
      },
      dpi,
    })
    return {
      index: i,
      sourceIndex: i,
      translate: { x: slotPaper.x, y: slotPaper.y },
      ops: buildCanvasDrawOps(placement),
      contentRotation: placement.rotation.content,
      placement,
      slot: s,
    }
  })

  return { canvasSize, slots: out, invalid: false }
}

/**
 * 把 raw 源按 contentRotation bake 成「已烤旋转」的源（尺寸 = effectiveContentSize）。
 * 与 Golden 缩略图（后端已 bake contentRotation）语义一致；adapter 只施加 layoutRotation。
 *
 * @param {Object} source - { source: canvas/image, width, height }（raw，rotation:0）
 * @param {number} contentRotation - 0/90/180/270
 * @param {(w:number,h:number)=>CanvasRenderingContext2D} createCanvas - 画布工厂（注入，node-safe）
 * @returns {Canvas}
 */
export function bakeSlotSource(source, contentRotation, createCanvas) {
  const rot = ((contentRotation % 360) + 360) % 360
  const sw = source.width
  const sh = source.height
  const effW = rot === 90 || rot === 270 ? sh : sw
  const effH = rot === 90 || rot === 270 ? sw : sh
  const b = createCanvas(effW, effH)
  const ctx = b.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, effW, effH)
  ctx.translate(effW / 2, effH / 2)
  ctx.rotate((rot * Math.PI) / 180)
  ctx.drawImage(source.source, -sw / 2, -sh / 2, sw, sh)
  return b
}

/**
 * 执行合成计划到给定 2D context（唯一执行点：白底 + bake + translate + 投影 ops）。
 *
 * @param {CanvasRenderingContext2D} ctx - 目标画布 context（尺寸 = plan.canvasSize）
 * @param {Object} plan - composeCanonicalArtifactPlan 产物
 * @param {Array<Object|null>} sources - 与 slotSources 对齐的真实源图像（含 source/width/height）
 * @param {(w:number,h:number)=>Canvas} createCanvas - 画布工厂（bake 用）
 */
export function executeComposePlan(ctx, plan, sources, createCanvas) {
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, plan.canvasSize.width, plan.canvasSize.height)
  for (const slot of plan.slots) {
    if (slot.sourceIndex < 0 || !sources[slot.sourceIndex]) continue
    const baked = bakeSlotSource(sources[slot.sourceIndex], slot.contentRotation, createCanvas)
    ctx.save()
    ctx.translate(slot.translate.x, slot.translate.y)
    applyDrawOps(ctx, slot.ops, baked)
    ctx.restore()
  }
}

export default composeCanonicalArtifactPlan
