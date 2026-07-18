/**
 * composeExecutor — V16 Worker 纯执行层（A.5 抽出，便于 Node 下 characterization 测试）
 *
 * 职责单一：按 items 索引遍历 slots，对每一项调用传入的 draw 例程。
 * 不创建画布、不读 window/dpi/config、不依赖任何浏览器 API —— 因此可在 Node 直接测试。
 *
 * 契约（index alignment invariant，B1 p2 review 锁定的 V16 不变式之一）：
 *   sources / commands / slots 三者按 items 索引对齐（缺内容的项为 null）。
 *   遍历必须以同一索引 i 取 source 与 command，绝不能用第二个 cursor 代替 i，
 *   否则中间 source 为 null（渲染失败）时 `continue` 不推进 cursor，
 *   会连带静默丢弃后续 slot 的 command。
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {Array<{x:number,y:number,width:number,height:number}>} slots
 * @param {Array<CanvasImageSource|null>} sources - 与 slots 同序同长，缺项为 null
 * @param {Array<object|null>} commands - 与 slots 同序同长（RenderCommand），缺项为 null
 * @param {(ctx,cmd,source,contentW,contentH,ratio)=>void} draw - 实际绘制例程（Worker 传 drawRenderCommand）
 */
export function iterateSlots(ctx, slots, sources, commands, draw) {
  for (let i = 0; i < slots.length; i++) {
    const source = sources[i]
    if (!source) continue
    const cmd = commands[i]
    if (!cmd) continue
    draw(ctx, cmd, source, source.width, source.height, 1)
  }
}
