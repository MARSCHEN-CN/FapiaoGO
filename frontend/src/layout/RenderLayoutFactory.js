/**
 * RenderLayoutFactory — V16 Stage 1 唯一布局派生点（F3）
 *
 * 设计纪律（与 v16-stage1-design.md / v16-architecture-target.md 对齐）：
 *  • 纯函数（F5）：仅依赖入参，不读 React state / container / zoom / settingsRef。
 *  • 唯一构造点（F3）：Preview/Print/Export/RE 共用，禁止各端自算 fit/scale/placement。
 *  • 不反向持有 Facts（评审修正①）：输出 RenderLayout 只含解析后几何
 *    （paper/placement/rotation/clip），不挂 DocumentState 引用。
 *  • 单位一致性（评审修正②）：与 PaperLayout 同一坐标系（当前 px@PREVIEW_DPI），
 *    禁止 px/mm 混用；RE 末端仅做一次 坐标→设备像素(dpi) 换算。
 *  • rotation ∈ {0,90,180,270} 顺时针（评审修正③）；clip ≡ PaperLayout.clipRect（修正④）。
 *
 * 视口变换（paper→window fit、zoomPercent）属于 Preview 的 ViewportTransform 层，
 * 永不进本工厂（I1：RenderLayout 永远描述纸张，不描述屏幕）。
 */

import { calculateFitScale, calculateCenteredPosition } from '../layout.js'
import { isPaperLayoutInvalid } from '../previewState.js'

/**
 * @typedef {Object} RenderCommand
 * Page Placement Pipeline 的最终产出（Renderer 纯执行契约，2026-07-16 锁定）。
 * 所有消费方（Canvas / Render Engine / Print）只消费本结构，绝不重算 Fit/Center/Landscape/换宽高。
 * @property {Size}    paperRect      - 有效纸张像素尺寸（paperLandscape 时已是横/竖交换后）
 * @property {Size}    usableRect     - 安全区（含原点 mLeft/mTop，已按 paperLandscape 重生）
 * @property {Size}    rotatedBounds  - 内容旋转后的包围盒（90/270 交换 natW/natH）
 * @property {0|90|180|270} contentRotation - 【Slice 1.1 契约】内容旋转角（= ContentRotation Fact）；Factory 单一决策点产出，Renderer/RE 在 Slice 1.2+ 才消费
 * @property {0}       rotation       - [LEGACY Wire] 兼容字段，Slice 1.1 恒为 0（避免提前改协议：rotation 暂不发给 RE）；Slice 1.2 起 = contentRotation
 * @property {number}  scale          - fit 缩放（基于 rotatedBounds）
 * @property {{x:number,y:number}} offset - 居中偏移（rotatedBounds 在 usableRect 内）
 * @property {boolean} paperLandscape - 有效纸张是否横向（= PaperOrientation Fact 派生）
 */

/**
 * 归一化旋转角到 {0,90,180,270}（顺时针）。
 * 任何输入（含 45° 等非法值）都被 snap 到最近的 90° 倍数，
 * 防止 RE/Canvas/Print 三端各自支持渐变旋转导致复杂度失控。
 * @param {number} deg
 * @returns {0|90|180|270}
 */
function normalizeRotation(deg) {
  const snapped = Math.round((deg || 0) / 90) * 90
  return (((snapped % 360) + 360) % 360)
}

/**
 * 空 RenderLayout（输入非法时返回，scale=0 表示未就绪）。
 */
export function emptyRenderLayout() {
  return {
    paper: null,
    paperRect: { w: 0, h: 0 },
    usableRect: { x: 0, y: 0, w: 0, h: 0 },
    rotatedBounds: { width: 0, height: 0 },
    placement: { scale: 0, offsetX: 0, offsetY: 0 },
    rotation: 0,
    paperLandscape: false,
    clip: { x: 0, y: 0, width: 0, height: 0 },
  }
}

/**
 * 唯一布局派生点（F3/F5）。
 *
 * @param {import('../previewState.js').PaperLayout} paperLayout
 *   来自 computePaperLayout(paperSpec)，纯纸张坐标（I1）。
 * @param {import('../previewState.js').DocumentState} documentState
 *   仅作输入：工厂内读取 pageOrientation / pageSize / rotation 等事实意图，
 *   **输出不得反向持有该对象**（评审修正①）。
 * @returns {ReturnType<typeof emptyRenderLayout>}
 */
export function buildRenderLayout(paperLayout, documentState) {
  // V16 F1/F2 守卫：非法/坍缩的 PaperLayout 不应进入 Render 派生层。
  // 不变量校验收口到 isPaperLayoutInvalid（previewState.js 单一来源）：
  //   • 信任 Layout 不变量（contentRect.w/h>0）而非一个可能过期的 valid 字段；
  //   • 即便将来有人写出 {valid:true, contentRect:{w:0}}，仍会被判 invalid；
  //   • placeholder（valid===undefined）属「未就绪」而非「非法」，由该函数豁免，走下方 WARN 守卫返 empty。
  if (isPaperLayoutInvalid(paperLayout)) {
    const c = paperLayout.contentRect || { w: 0, h: 0 }
    const reason = paperLayout.reason
      || (paperLayout.valid === false ? 'valid:false' : 'contentRect collapsed (w/h<=0)')
    const fmt = (n) => (typeof n === 'number' ? n : '?')
    console.error(
      '[V16 ASSERT] PaperLayout invariant violated\n' +
      `  valid=${paperLayout.valid}\n` +
      `  paper=${fmt(paperLayout.paperRect?.w)}x${fmt(paperLayout.paperRect?.h)}\n` +
      `  content=${fmt(c.w)}x${fmt(c.h)}\n` +
      `  reason=${reason}\n` +
      '  Caller must recover (reset to defaults / prompt user) before layout.'
    )
    return emptyRenderLayout()
  }
  if (!paperLayout || !paperLayout.contentRect || !paperLayout.contentRect.w) {
    console.warn(`[V16 WARN] buildRenderLayout: paperLayout.contentRect.w is 0/undefined — returning empty (scale=0). Check PaperLayout derivation (margins may still be invalid).`)
    return emptyRenderLayout()
  }

  const { contentRect, clipRect, paperRect } = paperLayout

  // ── Page Placement Pipeline（2026-07-16 锁定模型）──
  // 输入两个独立 Fact（互不 Derived，且都不在本层被重新推导 = Single Decision Point）：
  //   paperOrientation : 有效纸张方向（Portrait/Landscape）→ 决定 paperRect / usableRect 是否交换。
  //   contentRotation  : 内容旋转角(0/90/180/270)          → 决定 rotatedBounds 是否交换 + 输出 rotation。
  const paperOrientation =
    documentState?.paperOrientation || documentState?.pageOrientation || 'portrait'
  const contentRotation = normalizeRotation(
    documentState?.contentRotation ?? documentState?.rotation ?? 0
  )
  // 有效纸张是否横向：直接由 PaperOrientation Fact 派生，根除旧 totalRot 推导的 180° bug。
  const paperLandscape = paperOrientation === 'landscape'

  // 内容内禀尺寸
  const natW = documentState?.pageSize?.w || 0
  const natH = documentState?.pageSize?.h || 0
  if (!natW || !natH) {
    console.warn(`[V16 WARN] buildRenderLayout: documentState pageSize missing/zero (natW=${natW}, natH=${natH}) — returning empty (scale=0).`)
    return emptyRenderLayout()
  }

  // 旋转后的内容包围盒（90/270 交换 natW/natH；0/180 不交换）。Renderer 不再旋转内容。
  const rotated = contentRotation % 180 !== 0
  const rotatedBounds = rotated
    ? { width: natH, height: natW }
    : { width: natW, height: natH }

  // 有效 usableRect：paperLandscape 时按新纸坐标重生（margins 物理值不变，仅 w/h 依据新纸重算）。
  //   margins 属于 Paper 坐标（Top 仍是物理上边、Left 仍是物理左边），绝不随内容旋转。
  const naturalUsable = paperLayout.usableRect || { x: 0, y: 0, w: contentRect.w, h: contentRect.h }
  const mL = naturalUsable.x
  const mT = naturalUsable.y
  const mR = paperRect.w - naturalUsable.w - mL
  const mB = paperRect.h - naturalUsable.h - mT
  const usableRect = paperLandscape
    ? { x: mL, y: mT, w: paperRect.h - mL - mR, h: paperRect.w - mT - mB }
    : naturalUsable

  // Fit + Center 在 rotatedBounds 上做（Renderer 不重算）。
  const slot = { x: usableRect.x, y: usableRect.y, width: usableRect.w, height: usableRect.h }
  const fitScale = calculateFitScale(slot, rotatedBounds)
  const pos = calculateCenteredPosition(slot, rotatedBounds, fitScale)

  // 有效纸张像素尺寸（paperLandscape 时交换），供 Renderer 直接使用，无需再次 swap。
  const effPaperRect = paperLandscape
    ? { w: paperRect.h, h: paperRect.w }
    : { w: paperRect.w, h: paperRect.h }

  return {
    // PaperLayout 是 Derived（非 Facts），可持有引用（自然纸坐标；有效纸见 paperRect）
    paper: paperLayout,
    paperRect: effPaperRect,
    usableRect,
    rotatedBounds,
    placement: {
      scale: fitScale,
      offsetX: pos.x,
      offsetY: pos.y,
    },
    rotation: 0, // [LEGACY Wire] Slice 1.1 恒 0：协议不变（rotation 暂不发给 RE）；Slice 1.2 起 = contentRotation
    contentRotation, // 【契约】内容旋转角，Factory 唯一决策点产出；Renderer/RE 在 Slice 1.2+ 消费
    paperLandscape,
    clip: paperLandscape
      ? { x: 0, y: 0, width: paperRect.h, height: paperRect.w }
      : {
          x: clipRect?.x ?? 0,
          y: clipRect?.y ?? 0,
          width: clipRect?.w ?? paperRect.w,
          height: clipRect?.h ?? paperRect.h,
        },
  }
}
