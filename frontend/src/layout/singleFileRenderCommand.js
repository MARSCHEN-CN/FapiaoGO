/**
 * singleFileRenderCommand.js — D1-1 单文件预览 RenderCommand Producer（纯函数 / node-safe）
 *
 * 把单文件预览（PDF 页 / 图片 / OFD）的几何推导（fit / 居中 / 旋转）统一收敛为 RenderCommand，
 * 复用 createPlacement 作为唯一几何来源（与 _buildComposeCommand / mergeFactory 同构），
 * 让单文件预览与 Compose / Print 共用同一套 RenderCommand 契约（D1 不变式：Preview≡Export≡Print）。
 *
 * 纪律（对齐 D1 收敛不变式）：
 *  • 纯函数、DOM-free、node-safe：仅依赖 createPlacement（纯数学），不 import config / renderers / window。
 *  • source 必须是「非预旋」的原始内容（rotatedBounds 描述旋转后包围盒，contentRotation 由 executor 旋转），
 *    不再像旧 switchPreviewFile 把旋转烤进 bitmap、也不像 switchPreviewImage 用 ctx.rotate 现转——
 *    两端统一为「Factory 单一决策 + Executor 纯执行」模型（D1-2 切换执行点时，PDF 改为 rotation:0 光栅、交 executor 旋转）。
 *  • clip === contentRect（几何所有权边界），绝不透出裸 margin / dpi / slot 几何给 Renderer。
 *  • 本函数只做「几何 → 命令组装」，不持有任何 margin / dpi 重算逻辑（Derived geometry 只跨越所有权边界一次）。
 *
 * @param {Object} params
 * @param {number} params.sourceWidth  - 内容固有宽(px，非预旋)
 * @param {number} params.sourceHeight - 内容固有高(px，非预旋)
 * @param {Object} params.contentRect  - 可打印区域 px 矩形 {x,y,width,height}
 *                                       （来自单文件预览画布的 marginL/marginT/contentW/contentH）
 * @param {0|90|180|270} [params.rotation=0]
 * @param {Object} [params.paper=null] - 满足 validateRenderCommand 的 paper（truthy 即可；caller 传入纸张上下文）
 * @param {*} [params.sourceRef=null]  - 可选：内容源引用（ImageHandle 等），仅透传不决策
 * @returns {Object} RenderCommand（与 _buildComposeCommand 同形状）
 */
import { createPlacement } from '../compose/composePlacement.js'

export function buildSingleFileRenderCommand({
  sourceWidth,
  sourceHeight,
  contentRect,
  rotation = 0,
  paper = null,
  sourceRef = null,
}) {
  // 未就绪态：可打印区域坍缩（null / 非正）→ 返回 scale=0 的 empty 语义命令。
  // executor 端 validateRenderCommand 会拦截（rotatedBounds 非正），与 compose/print 行为一致。
  if (!contentRect || !(contentRect.width > 0) || !(contentRect.height > 0)) {
    return {
      version: 1,
      paper,
      rotatedBounds: { width: 0, height: 0 },
      placement: { scale: 0, offsetX: 0, offsetY: 0 },
      contentRotation: rotation,
      rotation: 0,
      clip: contentRect && contentRect.width >= 0
        ? { x: contentRect.x, y: contentRect.y, width: contentRect.width, height: contentRect.height }
        : { x: 0, y: 0, width: 0, height: 0 },
      sourceRef,
    }
  }

  // 唯一几何决策点：fit / 居中 / 旋转包围盒全部由 createPlacement 计算，本函数只组装命令。
  const p = createPlacement({ contentRect, sourceWidth, sourceHeight, rotation })

  return {
    version: 1,
    paper,
    rotatedBounds: p.rotatedBounds,
    placement: { scale: p.scale, offsetX: p.offsetX, offsetY: p.offsetY },
    contentRotation: rotation,
    rotation: 0, // [LEGACY Wire] 兼容字段，恒 0（rotation 暂不发给 RE）
    clip: p.clip,
    sourceRef,
  }
}
