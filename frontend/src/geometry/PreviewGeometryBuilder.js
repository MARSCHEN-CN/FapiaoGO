/**
 * PreviewGeometryBuilder — 将打印层旋转决策（PrintAutoRotationPolicy）适配为 Preview 消费域几何。
 *
 * 领域层（geometry/）纯函数。归属 PreviewGeometryBuilder Boundary Contract
 * （docs/preview_geometry_builder_boundary_contract.md，Gate 2 实施附录）。
 * 消费方：usePreview.js。
 *
 * 禁止：usePreview.js 直接调用 PrintAutoRotationPolicy（边界契约 B-1）。
 *
 * ⚠️ B-7：本 Builder 不是第二个 Resolver。
 *   - 不得独立判断 landscape/portrait；
 *   - 不得自己算 ±90 映射；
 *   - 不得自己 normalize。
 * 旋转决策唯一归属 PrintAutoRotationPolicy。本 Builder 只做「组合」：把 Policy 输出与
 * PaperGeometry 组合成 PreviewPlacementGeometry。组合 ≠ 决策。
 *
 * ⚠️ D2（几何语义修正）：rotation 改内容，不改纸。
 *   - paperLandscape         ← PaperGeometry       （物理纸张方向，外部约束，A4 portrait 恒 210×297，不随 rotation 改变）
 *   - sourceContentLandscape ← sourceContentGeometry（旋转前内容几何）
 *   - effectiveContentLandscape ← effectiveContentGeometry（旋转后内容几何）
 *   - orientationMismatch    ← sourceContentLandscape !== paperLandscape（= 旧 isLandscape 的 cache key / identity 语义）
 * 注意：isLandscape 在旧代码里被复用了两个语义——
 *   (a) 旋转前 contentOrient !== paperOrient → 服务 cache key / identity / layout branch；
 *   (b) 最终内容方向是否横向。
 * 二者在 4 格里有 2 格不同（横票+竖纸 / 竖票+横纸）。本 Builder 显式拆开：
 *   orientationMismatch 承担 (a)，effectiveContentLandscape 承担 (b)。
 * effectiveRotation / 内容旋转 均不得成为 paperLandscape 的来源，否则内容旋转重新耦合物理纸张方向，
 * 违反 INV-2 并破坏 Sumatra 参数 / MediaBox / Margin Contract。
 */

import { resolvePrintAutoRotation } from './PrintAutoRotationPolicy.js'

/**
 * @param {object} rawDocumentGeometry
 *   Raw CONTENT geometry from the file object — 与 detectDocumentOrientation 读取同一来源，但保留 px。
 *   { widthPx, heightPx }
 * @param {object} requestedPaperGeometry
 *   { orientation }   // from resolvePaper(paperSize, customPaper): widthMM > heightMM ? 'landscape' : 'portrait'
 * @param {object} userRotation
 *   { degrees }       // manual rotation (session authority), default 0
 * @returns {PreviewPlacementGeometry}
 *   {
 *     effectiveRotation,            // canonical clockwise {0,90,180,270}      (from Policy)
 *     sourceContentGeometry,        // { widthPx, heightPx, orientation } — 旋转前原始内容几何
 *     effectiveContentGeometry,     // { widthPx, heightPx, orientation } — 旋转后内容几何 (from Policy)
 *     paperGeometry,                // { orientation } — 物理纸张，外部约束，NEVER from effectiveRotation
 *     sourceContentLandscape,       // boolean: 旋转前内容是否横置（来自 sourceContentGeometry）
 *     effectiveContentLandscape,    // boolean: 旋转后内容是否横置（来自 effectiveContentGeometry）
 *     paperLandscape,               // boolean: 物理纸是否横置（来自 PaperGeometry，D2 修正）
 *     orientationMismatch,          // boolean: sourceContentLandscape !== paperLandscape（= 旧 isLandscape，cache key / identity / layout branch 语义）
 *   }
 */
export function buildPreviewGeometry({ rawDocumentGeometry, requestedPaperGeometry, userRotation }) {
  const sourceContentGeometry = {
    widthPx: rawDocumentGeometry.widthPx,
    heightPx: rawDocumentGeometry.heightPx,
    orientation: rawDocumentGeometry.heightPx > rawDocumentGeometry.widthPx ? 'portrait' : 'landscape',
  }
  const sourceContentLandscape = rawDocumentGeometry.widthPx > rawDocumentGeometry.heightPx

  const targetPaperGeometry = { orientation: requestedPaperGeometry.orientation }

  // 旋转决策唯一出口：PrintAutoRotationPolicy（B-7：Builder 不重算 ±90 / normalize）
  const { effectiveRotation, effectiveContentWidth, effectiveContentHeight } =
    resolvePrintAutoRotation({ sourceContentGeometry, targetPaperGeometry, userRotation: userRotation.degrees || 0 })

  const effectiveContentGeometry = {
    widthPx: effectiveContentWidth,
    heightPx: effectiveContentHeight,
    orientation: effectiveContentHeight > effectiveContentWidth ? 'portrait' : 'landscape',
  }
  const effectiveContentLandscape = effectiveContentWidth > effectiveContentHeight

  // FROZEN DIRECTION (D2 amendment — MUST NOT reverse):
  //   paperLandscape         ← PaperGeometry             (physical paper, external constraint: A4 portrait = 210×297 always)
  //   sourceContentLandscape ← sourceContentGeometry    (pre-rotation content)
  //   effectiveContentLandscape ← effectiveContentGeometry (post-rotation content)
  //   orientationMismatch    ← sourceContentLandscape !== paperLandscape (pre-rotation compare = old isLandscape for cache key)
  // effectiveRotation / content rotation 均不得成为 paperLandscape 的来源：那会把内容旋转重新耦合物理纸张方向，
  // 违反 INV-2 并破坏 Sumatra 参数 / MediaBox / Margin Contract。
  const paperLandscape = requestedPaperGeometry.orientation === 'landscape'
  const orientationMismatch = sourceContentLandscape !== paperLandscape

  // FIXED OUTPUT CONTRACT (B-7): return a named PreviewPlacementGeometry object, NOT the raw
  // resolvePrintAutoRotation(...) return. Consumption domain (Preview) connects to the decision
  // domain (Policy) via this data contract, not object pass-through.
  return {
    effectiveRotation,
    sourceContentGeometry,
    effectiveContentGeometry,
    paperGeometry: { orientation: requestedPaperGeometry.orientation },
    sourceContentLandscape,
    effectiveContentLandscape,
    paperLandscape,
    orientationMismatch,
  }
}
