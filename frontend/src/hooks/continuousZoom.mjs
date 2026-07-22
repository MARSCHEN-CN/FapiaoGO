// 纯函数：Ctrl/⌘ + wheel 连续缩放（V16.1 平滑增强）。
// 不依赖 React / DOM / zoom state，单一真相，便于单测；与 nextZoomStep（离散档位，供按钮）
// 并列，避免两套步进逻辑漂移。
//
// 语义：
//  - 在「百分比空间」做乘性缩放：pct' = pct * exp(-deltaY * sensitivity)
//  - adaptive 模式锚点视为 100（= fit 比例 1.0），与 nextZoomStep 一致，因此滚轮从「适应窗口」
//    起步时也连续放大，不会跳到 125 档。
//  - deltaY < 0（向上滚）→ 放大；deltaY > 0（向下滚）→ 缩小（与浏览器/地图类应用一致）。
//  - 指数而非线性：缩放是乘法关系，exp 保证任意比例下「滚一格」视觉增量一致
//    （线性会在小比例过慢、大比例过快）。
// 乘性缩放因子：exp(-deltaY * sensitivity)。
// deltaY < 0（向上滚）→ factor > 1（放大）；deltaY > 0（向下滚）→ factor < 1（缩小）。
// 指数而非线性：缩放是乘法关系，exp 保证任意比例下「滚一格」视觉增量一致
//   （线性会在小比例过慢、大比例过快）。
// D2-3：提取为独立函数，供 applyWheelZoom（百分比空间，旧模型）与 ViewerViewport
//   新模型（绝对 scale 空间，currentScale × factor）共用，避免两套因子逻辑漂移。
export function wheelZoomFactor(deltaY, sensitivity = 0.0012) {
  return Math.exp(-deltaY * sensitivity)
}

export function applyWheelZoom(currentPct, deltaY, { sensitivity = 0.0012, min = 10, max = 500 } = {}) {
  const next = currentPct * wheelZoomFactor(deltaY, sensitivity)
  return Math.min(max, Math.max(min, next))
}
