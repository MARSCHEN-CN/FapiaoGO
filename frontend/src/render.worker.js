// [D1] 共享纯执行绘制例程（与单文件预览 / _renderDirect 同源；DOM-free，Worker 可直接 import）。
//      仅消费主线程建好的 RenderCommand，绝不自算 fit/rotate/center/swap。
import { drawRenderCommand } from './layout/renderDraw.js'
import { iterateSlots } from './composeExecutor.js'

console.log('[Worker] VERSION 10 — sources.close enabled')
// ═══════════════════════════════════════════════════════════════
// render.worker.js — Phase 2 合成专用 Worker
self.postMessage({ type: 'debug', msg: 'VERSION 10 — sources.close enabled' })
// 主线程完成 Phase 1 (pdfjs/图片渲染) + Layout 计算后，
// 将 ImageBitmap + layout 传入 Worker，由 Worker 执行 slot 合成。
// ═══════════════════════════════════════════════════════════════

const SEPARATOR_MARGIN = 20
const DASH_PATTERN = [6, 4]

// ── 就绪信号 ──
self.postMessage({ type: 'ready' })

// ── Phase 2 合成 ──
//     主线程已通过 _buildComposeCommands（Commit A）把 slot + 内容尺寸 + 旋转 收敛为 RenderCommand[]，
//     此处只做纯执行：逐条 drawRenderCommand（clip 到 slot、按 placement 落盘、按 contentRotation 旋转）。
//     layout 仅用于画布尺寸(page) 与分隔线(area/slots)，不再参与任何 fit 数学。
export function compositeCanvas(sources, layout, commands, layoutOptions) {
  const { page, area, slots } = layout
  const canvas = new OffscreenCanvas(page.width, page.height)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // ratio=1：Worker 画布与命令同 dpi（均 PREVIEW_DPI），无需缩放对齐
  iterateSlots(ctx, slots, sources, commands, drawRenderCommand)

  // 分隔线
  if (slots.length > 1) {
    ctx.save()
    ctx.strokeStyle = '#cccccc'
    ctx.lineWidth = 1
    ctx.setLineDash(DASH_PATTERN)

    if (layoutOptions?.strategy === 'grid') {
      const gridCols = layoutOptions.gridCols || 2
      const gridRows = layoutOptions.gridRows || 2
      const cellWidth = area.width / gridCols
      const cellHeight = area.height / gridRows

      for (let c = 1; c < gridCols; c++) {
        const x = area.x + c * cellWidth
        ctx.beginPath()
        ctx.moveTo(x, area.y + SEPARATOR_MARGIN)
        ctx.lineTo(x, area.y + area.height - SEPARATOR_MARGIN)
        ctx.stroke()
      }
      for (let r = 1; r < gridRows; r++) {
        const y = area.y + r * cellHeight
        ctx.beginPath()
        ctx.moveTo(area.x + SEPARATOR_MARGIN, y)
        ctx.lineTo(area.x + area.width - SEPARATOR_MARGIN, y)
        ctx.stroke()
      }
    } else {
      for (let i = 0; i < slots.length - 1; i++) {
        const y = slots[i + 1].y
        ctx.beginPath()
        ctx.moveTo(area.x + SEPARATOR_MARGIN, y)
        ctx.lineTo(area.x + area.width - SEPARATOR_MARGIN, y)
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  return canvas
}

// ── onmessage ──
self.onmessage = async (e) => {
  const { sources, layout, commands, layoutOptions, cacheKey, id, version } = e.data

  try {
    const resultCanvas = compositeCanvas(sources, layout, commands, layoutOptions)
    const bitmap = resultCanvas.transferToImageBitmap()

    // ✅ 关闭输入的 ImageBitmap，释放 GPU 纹理
    sources.forEach(b => b?.close())

    self.postMessage({ type: 'result', bitmap, cacheKey, id, version }, [bitmap])
  } catch (err) {
    // ✅ 异常分支也要关闭
    sources.forEach(b => b?.close())
    self.postMessage({ type: 'error', cacheKey, id, version, error: err.message })
  }
}
