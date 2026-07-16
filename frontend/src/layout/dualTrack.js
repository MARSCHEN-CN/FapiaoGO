/**
 * 1.2C Commit A — Canvas 双轨验证（仅日志，不切换）。
 *
 * 比较 Canvas 旧 fit/center 算法产出的「最终绘制几何」与 RenderCommand.placement。
 *
 * ⚠️ 单位纪律（关键！）：
 *  - 旧算法 scale 是 pdf-points→canvas-px 缩放（含 72→GLOBAL_PREVIEW_DPI 因子），
 *    与 RenderCommand.placement.scale（px@PREVIEW_DPI 无因次 fit 因子）**不可直接比较**。
 *  - 全局 Canvas 实际以 GLOBAL_PREVIEW_DPI(150) 渲染，而 RenderCommand 以 PREVIEW_DPI(300) 计算，
 *    二者差 2×。比较前必须把 RenderCommand 几何按 (globalDpi/PREVIEW_DPI) 缩放对齐。
 *  - 因此只比较「最终 draw 几何」（offset + drawW/drawH），且由调用方传入已对齐 DPI 的 cmd 几何。
 *
 * 本模块是纯函数（无 DOM 依赖），便于 node:test 单测；renderers.js 仅在此处消费它。
 *
 * @param {string} label 渲染路径标记（'pdf' / 'image'）
 * @param {{offsetX:number,offsetY:number,drawW:number,drawH:number}} legacy 旧算法最终绘制几何（全局 Canvas DPI 空间）
 * @param {{offsetX:number,offsetY:number,drawW:number,drawH:number}} cmd RenderCommand 期望绘制几何（须已由调用方缩放到全局 Canvas DPI 空间）
 * @param {number} [epsilon=1.0] 容差（px@全局DPI，吸收取整/四舍五入噪声）
 * @returns {boolean} true=一致（maxDiff<=ε）
 */
export function dualTrackAssertGeometry(label, legacy, cmd, epsilon = 1.0) {
  if (!cmd) return true
  const d = [
    Math.abs(legacy.offsetX - cmd.offsetX),
    Math.abs(legacy.offsetY - cmd.offsetY),
    Math.abs(legacy.drawW - cmd.drawW),
    Math.abs(legacy.drawH - cmd.drawH),
  ]
  const maxDiff = Math.max(...d)
  if (maxDiff > epsilon) {
    console.warn(
      `[1.2C DUAL-TRACK] ${label}: Canvas 旧算法与 RenderCommand 几何不一致 ` +
      `(maxDiff=${maxDiff.toFixed(2)}px > ε=${epsilon})\n` +
      `  legacy=${JSON.stringify(legacy)} cmd=${JSON.stringify(cmd)}`
    )
    return false
  }
  return true
}
