// 纯函数：滚轮缩放的档位推进（V16.1 UX 增强）。
// 不依赖 React / DOM / zoom state，单一真相，便于单测；zoomIn / zoomOut 与 wheel handler
// 共用本函数，避免两套步进逻辑漂移。
//
// 语义（与 usePreview 中 zoomIn/zoomOut 一致）：
//  - adaptive 模式锚点视为 100（= fit）
//  - direction 'in'  → 取大于 current 的最小档（到顶夹取为最大档）
//  - direction 'out' → 取小于 current 的最大档（到底夹取为最小档）
export function nextZoomStep(current, direction, steps = [25, 50, 75, 100, 125, 150, 200]) {
  if (direction === 'in') {
    return steps.find((s) => s > current) ?? steps[steps.length - 1]
  }
  return [...steps].reverse().find((s) => s < current) ?? steps[0]
}
