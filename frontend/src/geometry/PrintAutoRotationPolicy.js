/**
 * PrintAutoRotationPolicy — 打印层「内容方向 → 纸张方向」纠正式自动对齐。
 *
 * 领域层（geometry/）纯函数，归属 Print Auto Rotation Contract v1.0 FINAL（docs/print_auto_rotation_contract_v1.md）。
 * 消费方：PreviewGeometryBuilder / PrintGeometryBuilder / MergePlacementBuilder（见契约 D7）。
 * 禁止：usePrint.js / usePreview.js / renderer / canvas 直接判断 orientation。
 *
 * ⚠️ 与既有 `layout/RotationResolver` 的关系（契约 X-1）：
 *   RotationResolver 是 Viewer/PrintPreview 域，其 `layoutRotation ∈ {0,-90}`（逆时针，contentRotation 已 bake 进 thumbnail），
 *   且输入是「**用户旋转后**的有效内容方向 vs **物理**纸张方向」。
 *   本策略是**打印层**决策，输入是「**原始**内容几何 vs **requested** 纸张方向」，autoRotation 算出后**再叠加** userRotation。
 *   二者关注点不同、符号约定不同（本策略为 canonical clockwise，见 INV-D4-3），故不复用、不改 RotationResolver。
 */

/**
 * canonical clockwise degree 归一化。
 * 输出 ∈ {0,90,180,270}（0 <= r < 360）。禁止负值（如 -90）进入 renderer（INV-D4-3）。
 * @param {number} deg
 * @returns {number}
 */
export function normalizeRotation(deg) {
  const r = Math.round(deg) % 360
  return (r + 360) % 360
}

/**
 * 解析打印层自动旋转。
 *
 * @param {{sourceContentGeometry:{widthPx:number,heightPx:number,orientation?:'portrait'|'landscape'}, targetPaperGeometry:{orientation:'portrait'|'landscape'}, userRotation?:number}} input
 *   - sourceContentGeometry：原始栅格像素尺寸（img.naturalWidth/Height，对所有格式可见）；
 *     orientation 可选，缺省由 widthPx/heightPx 派生（仅作语义标签，决策以像素为准）。
 *   - targetPaperGeometry：用户选择的纸张方向 requestedPaperOrientation。
 *   - userRotation：用户手动旋转（fileRotations[f.key]，默认 0），在 autoRotation 之后叠加（INV-D4-2）。
 * @returns {{autoRotation:number, effectiveRotation:number, effectiveContentWidth:number, effectiveContentHeight:number}}
 *   - autoRotation：仅由原始内容方向 vs 纸张方向算一次（INV-D4-1），与 userRotation 无关。
 *   - effectiveRotation：normalize(autoRotation + userRotation)，canonical clockwise。
 *   - effectiveContentWidth/Height：施加 effectiveRotation 后的有效内容像素尺寸（供 layout/placement 消费）。
 */
export function resolvePrintAutoRotation({ sourceContentGeometry, targetPaperGeometry, userRotation = 0 }) {
  const widthPx = sourceContentGeometry?.widthPx
  const heightPx = sourceContentGeometry?.heightPx
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
    throw new Error('PrintAutoRotationPolicy: sourceContentGeometry 需含正数 widthPx/heightPx')
  }
  const paperOrientation = targetPaperGeometry?.orientation
  if (paperOrientation !== 'portrait' && paperOrientation !== 'landscape') {
    throw new Error('PrintAutoRotationPolicy: targetPaperGeometry.orientation 必须是 portrait|landscape')
  }

  const contentOrientation = (widthPx > heightPx) ? 'landscape' : 'portrait'

  // INV-D4-1：autoRotation 只由「原始内容方向 vs 纸张方向」计算一次，禁止把 effectiveRotation 回流重算（防循环旋转）。
  // 方向一致 → 0；不一致 → 横内容塞竖纸 = -90 → canonical 270；竖内容塞横纸 = +90。
  const autoRotation = (contentOrientation === paperOrientation)
    ? 0
    : (contentOrientation === 'landscape' ? 270 : 90)

  // INV-D4-2：用户旋转在 autoRotation 基线上叠加（final control，但非覆盖）。
  const effectiveRotation = normalizeRotation(autoRotation + (userRotation || 0))

  const swapped = (effectiveRotation % 180) === 90
  const effectiveContentWidth = swapped ? heightPx : widthPx
  const effectiveContentHeight = swapped ? widthPx : heightPx

  return { autoRotation, effectiveRotation, effectiveContentWidth, effectiveContentHeight }
}
