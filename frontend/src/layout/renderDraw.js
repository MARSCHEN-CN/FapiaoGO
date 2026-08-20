/**
 * renderDraw — Slice 1.3 (D1) 共享纯执行绘制例程
 *
 * 三处渲染位置（单文件预览 / Merge 主线程 / Merge Worker / Print）共用同一份几何执行逻辑，
 * 彻底消除「每处渲染位置各写一份 translate→rotate→scale→drawImage」的漂移风险。
 *
 * 纪律（对齐 D1 收敛不变式）：
 *  • 纯执行：只消费 RenderCommand，绝不重算 fit / center / rotate / swap。
 *  • DOM-free：仅依赖入参 ctx（CanvasRenderingContext2D 或 OffscreenCanvas 2D，API 一致），
 *    可在 Web Worker 内直接 import 使用。
 *  • 契约优先：绘制前 validateRenderCommand，结构非法直接跳过（fail-loud，不画 NaN 几何）。
 *  • ratio：命令空间(px@PREVIEW_DPI) → 目标画布(px@dpi) 的缩放。Merge/Print 命令与目标画布同 dpi ⇒ ratio=1；
 *    单文件全局画布(150dpi) vs 命令(300dpi) ⇒ ratio=0.5（与 switchPreviewFile/Image 一致）。
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {object} cmd - RenderCommand（含 placement / rotatedBounds / contentRotation / clip）
 * @param {CanvasImageSource} source - 已光栅化的内容源（canvas / image / ImageBitmap）
 * @param {number} contentW - source 固有宽（px@dpi，用于校验/日志；本例程按 drawW/drawH 落盘）
 * @param {number} contentH - source 固有高
 * @param {number} [ratio=1] - 命令空间 → 目标画布的缩放
 */
import { validateRenderCommand } from './RenderLayoutFactory.js'

export function drawRenderCommand(ctx, cmd, source, contentW, contentH, ratio = 1) {
  // 未就绪（空命令）或契约违例 → 跳过绘制（与单文件 Renderer 一致）。
  if (!cmd || !cmd.rotatedBounds || cmd.rotatedBounds.width <= 0) return
  try {
    validateRenderCommand(cmd)
  } catch (e) {
    console.error('[drawRenderCommand] RenderCommand 契约违例，跳过绘制:', e.message)
    return
  }

  const offsetX = cmd.placement.offsetX * ratio
  const offsetY = cmd.placement.offsetY * ratio
  const cr = cmd.contentRotation
  const scale = cmd.placement.scale * ratio

  // ⚠️ 旋转修复：
  //   当有旋转时，必须使用源的原始尺寸(contentW×contentH)来绘制源图像，
  //   然后让 Canvas.rotate 来处理旋转。
  //   旧代码用 rotatedBounds 尺寸绘制，导致源图像被先拉伸到旋转后尺寸，
  //   再旋转一次 = 双重变形。
  //   非旋转时用 rotatedBounds 尺寸是正确的（此时 rotatedBounds = 原始尺寸）。
  const srcDrawW = cr ? contentW * scale : cmd.rotatedBounds.width * scale
  const srcDrawH = cr ? contentH * scale : cmd.rotatedBounds.height * scale

  // 旋转后画布的 footprint（用于定位中心点）
  const footprintW = cmd.rotatedBounds.width * scale
  const footprintH = cmd.rotatedBounds.height * scale

  ctx.save()
  // clip：Merge 的每项裁剪到 slot 矩形；单文件预览 cmd.clip 为整页（或不传 → 不裁）。
  if (cmd.clip && typeof cmd.clip.width === 'number' && cmd.clip.width > 0) {
    ctx.beginPath()
    ctx.rect(cmd.clip.x, cmd.clip.y, cmd.clip.width, cmd.clip.height)
    ctx.clip()
  }

  if (!cr) {
    // 0°：直接 top-left 落盘（scale 已烘焙进 srcDrawW/srcDrawH）。
    ctx.drawImage(source, offsetX, offsetY, srcDrawW, srcDrawH)
  } else {
    // 旋转：以旋转后包围盒中心为支点旋转，用源的原始尺寸绘制
    ctx.translate(offsetX + footprintW / 2, offsetY + footprintH / 2)
    ctx.rotate((cr * Math.PI) / 180)
    ctx.drawImage(source, -srcDrawW / 2, -srcDrawH / 2, srcDrawW, srcDrawH)
  }
  ctx.restore()
}
