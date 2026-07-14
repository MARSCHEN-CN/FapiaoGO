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
    placement: { scale: 0, offsetX: 0, offsetY: 0 },
    rotation: 0,
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
  if (!paperLayout || !paperLayout.contentRect || !paperLayout.contentRect.w) {
    return emptyRenderLayout()
  }

  const { contentRect, clipRect, paperRect } = paperLayout

  // 1) 纸随内容方向（V17 paperLandscape 模型）：
  //    旧模型用 swapRotation=90 把内容旋转进固定纸；新模型改为「翻转纸张尺寸」，
  //    内容永远自然方向（rotation=0）。paperLandscape 即有效纸张的横竖。
  const paperOrient = paperRect.w > paperRect.h ? 'landscape' : 'portrait'
  const docOrient = documentState?.pageOrientation
  const swapped = !!docOrient && docOrient !== paperOrient
  const swapRotation = swapped ? 90 : 0

  // 2) 文件级旋转（/Rotate 或预览旋转）→ 仅影响纸张方向（横/竖），不再旋转内容
  const fileRotation = normalizeRotation(documentState?.rotation || 0)
  const totalRot = normalizeRotation(swapRotation + fileRotation)
  // 🆕 paperLandscape：有效纸张是否横向（内容方向 + 手动旋转共同决定）
  const paperLandscape = totalRot === 90 || totalRot === 270

  // 3) 内容自然尺寸（rotation 已废弃为 0，内容不再旋转）
  let natW = documentState?.pageSize?.w || 0
  let natH = documentState?.pageSize?.h || 0
  if (!natW || !natH) return emptyRenderLayout()

  // 4) 有效纸张/内容矩形：paperLandscape 时交换宽高（纸随内容）
  const effContentW = paperLandscape ? contentRect.h : contentRect.w
  const effContentH = paperLandscape ? contentRect.w : contentRect.h

  // 5) fit（复用 layout.js 纯函数），在 usableRect 内居中。
  //    usableRect 已含边距原点（x=mLeft, y=mTop），paperLandscape 时交换 x/y 与 w/h
  //    （90° CW：物理 top 边 → 有效 left 边，物理 left 边 → 有效 top 边），
  //    使四边距在横竖向均生效。calculateCenteredPosition 用 slot.x/y 作居中基准，
  //    故图永远落在安全区内，而非绕纸张中心。
  const usableRect = paperLayout.usableRect || { x: 0, y: 0, w: contentRect.w, h: contentRect.h }
  const slot = paperLandscape
    ? { x: usableRect.y, y: usableRect.x, width: effContentW, height: effContentH }
    : { x: usableRect.x, y: usableRect.y, width: effContentW, height: effContentH }
  const contentBounds = { width: natW, height: natH }
  const fitScale = calculateFitScale(slot, contentBounds)
  const pos = calculateCenteredPosition(slot, contentBounds, fitScale)

  return {
    // PaperLayout 是 Derived（非 Facts），可持有引用
    paper: paperLayout,
    placement: {
      scale: fitScale,
      offsetX: pos.x,
      offsetY: pos.y,
    },
    // 🆕 V17 deprecated：内容不再旋转；方向完全由 paperLandscape 表达（RE/Canvas/Print 三端统一）
    rotation: 0,
    paperLandscape,
    // clip 完全等于 PaperLayout.clipRect（评审修正④），paperLandscape 时交换宽高
    clip: {
      x: clipRect?.x ?? 0,
      y: clipRect?.y ?? 0,
      width: paperLandscape ? clipRect?.h ?? 0 : clipRect?.w ?? 0,
      height: paperLandscape ? clipRect?.w ?? 0 : clipRect?.h ?? 0,
    },
  }
}
