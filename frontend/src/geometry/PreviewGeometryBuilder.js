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
 *   - paperLandscape   ← PaperGeometry       （物理纸张方向，外部约束，A4 portrait 恒 210×297，不随 rotation 改变）
 *   - contentLandscape ← effectiveContentGeometry（施加 effectiveRotation 后的内容几何）
 *   - isLandscape（display swap）← 二者组合，仅在此处计算，绝不从 effectiveRotation 单独推导。
 * effectiveRotation 不得成为 paperLandscape 的来源，否则内容旋转重新耦合物理纸张方向，
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
 *   { degrees }       // manual rotation (session authority, e.g. user-set per-file rotation), default 0
 * @returns {PreviewPlacementGeometry}
 *   {
 *     effectiveRotation,           // canonical clockwise {0,90,180,270}   (from Policy)
 *     paperGeometry,               // { orientation } — physical paper, external constraint, NEVER from effectiveRotation
 *     effectiveContentGeometry,    // { widthPx, heightPx } — post-auto-rotation content geometry (from Policy)
 *     contentLandscape,            // boolean: content is landscape, from effectiveContentGeometry (post-rotation)
 *     paperLandscape,              // boolean: paper is landscape, from PaperGeometry (physical paper orientation)
 *     isLandscape,                 // preview container swap — combination of the two, computed ONLY inside Builder
 *   }
 */
export function buildPreviewGeometry({ rawDocumentGeometry, requestedPaperGeometry, userRotation }) {
  const sourceContentGeometry = {
    widthPx: rawDocumentGeometry.widthPx,
    heightPx: rawDocumentGeometry.heightPx,
    orientation: rawDocumentGeometry.heightPx > rawDocumentGeometry.widthPx ? 'portrait' : 'landscape',
  }
  const targetPaperGeometry = { orientation: requestedPaperGeometry.orientation }

  // 旋转决策唯一出口：PrintAutoRotationPolicy（B-7：Builder 不重算 ±90 / normalize）
  const { autoRotation, effectiveRotation, effectiveContentWidth, effectiveContentHeight } =
    resolvePrintAutoRotation({ sourceContentGeometry, targetPaperGeometry, userRotation: userRotation.degrees || 0 })

  // FROZEN DIRECTION (D2 amendment — MUST NOT reverse):
  //   paperLandscape   ← PaperGeometry       (physical paper, external constraint: A4 portrait = 210×297 always)
  //   contentLandscape ← effectiveContentGeometry (post-rotation)
  //   isLandscape (display swap) ← combination of the two, computed ONLY here — never from effectiveRotation alone.
  // effectiveRotation MUST NOT become the source of paperLandscape: that would couple content
  // rotation back into physical paper, violating INV-2 and corrupting Sumatra / MediaBox / Margin Contract.
  const paperLandscape = requestedPaperGeometry.orientation === 'landscape'
  const contentLandscape = effectiveContentWidth > effectiveContentHeight
  const isLandscape = contentLandscape !== paperLandscape

  // FIXED OUTPUT CONTRACT (B-7): return a named PreviewPlacementGeometry object, NOT the raw
  // resolvePrintAutoRotation(...) return. Consumption domain (Preview) connects to the decision
  // domain (Policy) via this data contract, not object pass-through.
  return {
    effectiveRotation,
    paperGeometry: { orientation: requestedPaperGeometry.orientation },
    effectiveContentGeometry: { widthPx: effectiveContentWidth, heightPx: effectiveContentHeight },
    contentLandscape,
    paperLandscape,
    isLandscape,
  }
}
