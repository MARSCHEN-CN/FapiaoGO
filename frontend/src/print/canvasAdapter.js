/**
 * canvasAdapter.js — R2.2 旁路 Canvas 投影器（零计算投影仪）
 *
 * ❄️ 阶段定位：R2.2 第一刀 = 完全旁路的 Canvas 验证器，不碰
 *   PrintPreviewCanvas / renderMultipleItemsToCanvas / Preview / Print / Raster Path。
 *
 * 职责边界（用户钉死 + R2 设计文档 §6.3）：
 *   ✅ 输入 CanonicalPlacement（其 renderTransform 字段），输出 Canvas 2D 操作序列：
 *        translate → scale → translate(pivot) → rotate → translate(-pivot) → drawImage
 *   ✅ 只执行「把已经决定好的几何画出来」：translate / rotate / scale / drawImage。
 *   ❌ 黑名单（本模块绝不出现）：
 *        fit 计算 / margin 计算 / rotation 判断 / orientation 判断 / slot 计算 /
 *        scale 重新计算 / placement 重新计算。
 *
 * 一句话契约：Canvas 不知道「为什么放这里」，只知道「把已经决定好的东西画到这里」。
 * 几何唯一权威 = RotationResolver → CanonicalPlacement.renderTransform（Golden，N6 PASS）。
 *
 * @module print/canvasAdapter
 */

/** Canvas Adapter 契约版本号（下游消费者可据此判断是否兼容）。 */
export const CANVAS_ADAPTER_VERSION = 1

/**
 * 从 CanonicalPlacement 生成 Canvas 2D 操作序列（纯函数，零几何计算）。
 *
 * 输入只读 `placement.renderTransform`（Golden 原样携带的投影矩阵），逐字映射为操作列表：
 *   translate(translateX, translateY)
 *   scale(scale)
 *   translate(rotationCx, rotationCy)
 *   rotate(rotationDeg)            ← 角度原样透传，radian 换算由执行器完成
 *   translate(-rotationCx, -rotationCy)
 *   drawImage(0, 0, imageWidth, imageHeight)   ← 源以自然尺寸绘制，不被二次拉伸
 *
 * ⚠️ 纪律：本函数不读取 placedRect / contentRect / scale / translation / pivot /
 *   rotation 判断 / margins —— 那些字段是「决策结果」；投影只认 renderTransform。
 *
 * @param {Object} placement - CanonicalPlacement（buildCanonicalPlacement 产物）
 * @returns {Array<{type:string, ...}>} 有序操作列表（可 JSON 序列化，测试可直读）
 */
export function buildCanvasDrawOps(placement) {
  const rt = placement.renderTransform
  if (!rt) {
    throw new Error('canvasAdapter: placement.renderTransform 缺失（需 R2.2 版 CanonicalPlacement，VERSION>=1）')
  }
  // 只读 renderTransform，逐字段映射（无任何派生/换算/判断）。
  return [
    { type: 'translate', x: rt.translateX, y: rt.translateY },
    { type: 'scale', s: rt.scale },
    { type: 'translate', x: rt.rotationCx, y: rt.rotationCy },
    { type: 'rotate', rotationDeg: rt.rotationDeg },
    { type: 'translate', x: -rt.rotationCx, y: -rt.rotationCy },
    { type: 'drawImage', x: 0, y: 0, width: rt.imageWidth, height: rt.imageHeight },
  ]
}

/**
 * 把操作序列应用到 Canvas 2D 上下文（唯一执行点；单元换算在此层）。
 *
 * @param {CanvasRenderingContext2D} ctx - 浏览器 / Electron canvas context
 * @param {Array} ops - buildCanvasDrawOps 产物
 * @param {CanvasImageSource} [image] - 待绘制源图像（drawImage 时才需要）
 * @returns {Array} 透传 ops（便于链式断言）
 */
export function applyDrawOps(ctx, ops, image) {
  for (const op of ops) {
    switch (op.type) {
      case 'translate':
        ctx.translate(op.x, op.y)
        break
      case 'scale':
        ctx.scale(op.s, op.s)
        break
      case 'rotate':
        ctx.rotate((op.rotationDeg * Math.PI) / 180)
        break
      case 'drawImage':
        ctx.drawImage(image, op.x, op.y, op.width, op.height)
        break
      default:
        throw new Error(`canvasAdapter: 未知操作类型 '${op.type}'`)
    }
  }
  return ops
}

export default buildCanvasDrawOps
