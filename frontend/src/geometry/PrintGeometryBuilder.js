/**
 * PrintGeometryBuilder — 将打印层旋转决策（PrintAutoRotationPolicy）适配为 Print / RenderCommand 消费域几何。
 *
 * 领域层（geometry/）纯函数。归属 Gate 3 Contract
 * （docs/gate3_print_geometry_builder_contract.md）。
 * 消费方：usePrint.js / buildRenderCommand（RenderCommand Factory）。
 *
 * 禁止：usePrint.js / buildRenderCommand 直接调用 PrintAutoRotationPolicy（边界契约 B-1）。
 *
 * ⚠️ B-7：本 Builder 不是第二个 Resolver。
 *   - 不得独立判断 landscape/portrait；
 *   - 不得自己算 ±90 映射；
 *   - 不得自己 normalize。
 * 旋转决策唯一归属 PrintAutoRotationPolicy。本 Builder 只做「组合」：把 Policy 输出与
 * PaperGeometry 组合成 PrintPlacementGeometry。组合 ≠ 决策。
 *
 * ⚠️ D3：paperLandscape 不归本 Builder（物理纸向由 RenderLayoutFactory 拥有）。
 *   - 本 Builder 读取 requestedPaperGeometry.orientation 作为 Policy 输入，但 MUST NOT 输出 paperLandscape。
 *   - effectiveRotation / 内容旋转 均不得成为 paperLandscape 来源（Gate 2 已踩的坑，不重犯）。
 *
 * ⚠️ B-10a：本 Builder 是唯一 canonicalization 出口。
 *   RenderCommand Factory 只能「消费」effectiveRotation，不得再 normalize。
 *   故本 Builder 输出的 effectiveRotation 已是 canonical clockwise ∈ {0,90,180,270}。
 */

import { resolvePrintAutoRotation } from './PrintAutoRotationPolicy.js'

/**
 * @param {object} rawDocumentGeometry
 *   Raw CONTENT geometry from the file object — 与 PreviewGeometryBuilder / extractContentPx 同源（fileContentPx）。
 *   { widthPx, heightPx }
 * @param {object} requestedPaperGeometry
 *   { orientation }   // from resolvePaperSpec(settings).orientation: 'portrait' | 'landscape'
 * @param {object} userRotation
 *   { degrees }       // manual rotation (fileRotations[f.key], session authority), default 0
 * @returns {PrintPlacementGeometry}
 *   {
 *     effectiveRotation,          // canonical clockwise {0,90,180,270}   (from Policy: autoRotation + userRotation)
 *     autoRotation,               // canonical clockwise, auto-only (INV-D4-1: computed once)
 *     sourceContentGeometry,      // { widthPx, heightPx, orientation } — 旋转前原始内容几何
 *     effectiveContentGeometry,   // { widthPx, heightPx, orientation } — 旋转后内容几何 (from Policy)
 *     sourceContentLandscape,     // boolean: 旋转前内容是否横置（来自 sourceContentGeometry）
 *     effectiveContentLandscape,  // boolean: 旋转后内容是否横置（来自 effectiveContentGeometry）
 *     // ⚠️ NO paperLandscape field — ownership stays with RenderLayoutFactory (D3).
 *     // ⚠️ NO orientationMismatch / cache / preview fields — print domain only.
 *   }
 */
export function buildPrintGeometry({ rawDocumentGeometry, requestedPaperGeometry, userRotation }) {
  const sourceContentGeometry = {
    widthPx: rawDocumentGeometry.widthPx,
    heightPx: rawDocumentGeometry.heightPx,
    orientation: rawDocumentGeometry.heightPx > rawDocumentGeometry.widthPx ? 'portrait' : 'landscape',
  }
  const sourceContentLandscape = rawDocumentGeometry.widthPx > rawDocumentGeometry.heightPx

  const targetPaperGeometry = { orientation: requestedPaperGeometry.orientation }

  // 旋转决策唯一出口：PrintAutoRotationPolicy（B-7：Builder 不重算 ±90 / normalize）
  const { autoRotation, effectiveRotation, effectiveContentWidth, effectiveContentHeight } =
    resolvePrintAutoRotation({ sourceContentGeometry, targetPaperGeometry, userRotation: userRotation.degrees || 0 })

  const effectiveContentGeometry = {
    widthPx: effectiveContentWidth,
    heightPx: effectiveContentHeight,
    orientation: effectiveContentHeight > effectiveContentWidth ? 'portrait' : 'landscape',
  }
  const effectiveContentLandscape = effectiveContentWidth > effectiveContentHeight

  // D3: paperLandscape intentionally ABSENT — owned by RenderLayoutFactory (paperOrientation Fact).
  // effectiveRotation / 内容旋转 不得成为 paperLandscape 来源（B-8 / D3）。
  return {
    effectiveRotation,
    autoRotation,
    sourceContentGeometry,
    effectiveContentGeometry,
    sourceContentLandscape,
    effectiveContentLandscape,
  }
}
