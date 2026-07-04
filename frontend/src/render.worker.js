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
function compositeCanvas(sources, layout, rotations, layoutOptions) {
  const { page, area, slots } = layout
  const canvas = new OffscreenCanvas(page.width, page.height)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const fitMode = 'fit'

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const source = sources[i]
    if (!source) continue

    const rotate = (rotations && rotations[slot.itemId]) || 0
    const { width: contentW, height: contentH } = source

    const isRotated90 = rotate === 90 || rotate === 270
    const effectiveW = isRotated90 ? contentH : contentW
    const effectiveH = isRotated90 ? contentW : contentH

    const scale = fitMode === 'fill'
      ? Math.max(slot.width / effectiveW, slot.height / effectiveH)
      : Math.min(slot.width / effectiveW, slot.height / effectiveH)

    ctx.save()
    ctx.beginPath()
    ctx.rect(slot.x, slot.y, slot.width, slot.height)
    ctx.clip()

    ctx.translate(slot.x + slot.width / 2, slot.y + slot.height / 2)
    if (rotate) ctx.rotate(rotate * Math.PI / 180)
    ctx.scale(scale, scale)
    ctx.drawImage(source, -contentW / 2, -contentH / 2, contentW, contentH)

    ctx.restore()
  }

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
  const { sources, layout, rotations, layoutOptions, cacheKey, id, version } = e.data

  try {
    const resultCanvas = compositeCanvas(sources, layout, rotations, layoutOptions)
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
