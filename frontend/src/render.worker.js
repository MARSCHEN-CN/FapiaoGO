// ═══════════════════════════════════════════════════════════════
// render.worker.js — Phase 2 合成专用 Worker
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

  // 用户安全边距
  const userMargins = layoutOptions?.userMargins
  if (userMargins) {
    const dpi = layoutOptions._dpi || 300
    const mL = Math.round((userMargins.left || 0) * dpi / 25.4)
    const mR = Math.round((userMargins.right || 0) * dpi / 25.4)
    const mT = Math.round((userMargins.top || 0) * dpi / 25.4)
    const mB = Math.round((userMargins.bottom || 0) * dpi / 25.4)
    if (mL || mR || mT || mB) {
      const newCanvas = new OffscreenCanvas(canvas.width + mL + mR, canvas.height + mT + mB)
      const newCtx = newCanvas.getContext('2d')
      newCtx.fillStyle = '#ffffff'
      newCtx.fillRect(0, 0, newCanvas.width, newCanvas.height)
      newCtx.drawImage(canvas, mL, mT)
      return newCanvas
    }
  }

  return canvas
}

// ── onmessage ──
self.onmessage = async (e) => {
  const { sources, layout, rotations, layoutOptions, cacheKey, id } = e.data

  try {
    const resultCanvas = compositeCanvas(sources, layout, rotations, layoutOptions)
    const bitmap = resultCanvas.transferToImageBitmap()
    self.postMessage({ type: 'result', bitmap, cacheKey, id }, [bitmap])
  } catch (err) {
    self.postMessage({ type: 'error', cacheKey, id, error: err.message })
  }
}
