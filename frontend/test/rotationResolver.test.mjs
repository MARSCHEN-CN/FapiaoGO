/**
 * RotationResolver 单元测试 — 三层旋转模型验证（2026-08-06）
 *
 * 测试用例（用户定稿）：
 *   1. 竖内容 + 竖纸 → fitRotation=0, finalRotation=0
 *   2. 横内容 + 竖纸 → fitRotation=-90, finalRotation=-90
 *   3. 竖内容 + 横纸 → fitRotation=+90, finalRotation=+90
 *   4. contentRotation=90 + 竖内容 + 竖纸 → finalRotation=90
 *   5. contentRotation=90 + 竖纸（原横内容）→ 此时旋转后内容为横，fitRotation=-90，finalRotation=0
 *   6. 安全边距 → scale 计算正确
 *   7. 居中 → offset 非负且居中
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeRotation,
  isRotated,
  resolveContentBounds,
  detectContentOrientation,
  detectPaperOrientation,
  computeLayoutRotation,
  resolveContentPlacement,
} from '../src/layout/RotationResolver.js'

describe('normalizeRotation', () => {
  it('normalizes 0/90/180/270', () => {
    assert.equal(normalizeRotation(0), 0)
    assert.equal(normalizeRotation(90), 90)
    assert.equal(normalizeRotation(180), 180)
    assert.equal(normalizeRotation(270), 270)
  })
  it('wraps negative angles', () => {
    assert.equal(normalizeRotation(-90), 270)
    assert.equal(normalizeRotation(-180), 180)
    assert.equal(normalizeRotation(-270), 90)
  })
  it('wraps >360', () => {
    assert.equal(normalizeRotation(450), 90)
    assert.equal(normalizeRotation(720), 0)
  })
})

describe('isRotated', () => {
  it('90/270 swap width/height', () => {
    assert.equal(isRotated(90), true)
    assert.equal(isRotated(270), true)
  })
  it('0/180 do not swap', () => {
    assert.equal(isRotated(0), false)
    assert.equal(isRotated(180), false)
  })
})

describe('resolveContentBounds', () => {
  it('no rotation', () => {
    const r = resolveContentBounds({ width: 100, height: 200 }, 0)
    assert.deepEqual(r, { width: 100, height: 200 })
  })
  it('90 deg swaps', () => {
    const r = resolveContentBounds({ width: 100, height: 200 }, 90)
    assert.deepEqual(r, { width: 200, height: 100 })
  })
  it('180 deg no swap', () => {
    const r = resolveContentBounds({ width: 100, height: 200 }, 180)
    assert.deepEqual(r, { width: 100, height: 200 })
  })
})

describe('detectContentOrientation', () => {
  it('portrait: h > w', () => {
    assert.equal(detectContentOrientation({ width: 100, height: 200 }), 'portrait')
  })
  it('landscape: w > h', () => {
    assert.equal(detectContentOrientation({ width: 200, height: 100 }), 'landscape')
  })
  it('square → portrait (default)', () => {
    assert.equal(detectContentOrientation({ width: 100, height: 100 }), 'portrait')
  })
})

describe('detectPaperOrientation', () => {
  it('A4 portrait', () => {
    assert.equal(detectPaperOrientation({ widthMM: 210, heightMM: 297 }), 'portrait')
  })
  it('A4 landscape', () => {
    assert.equal(detectPaperOrientation({ widthMM: 297, heightMM: 210 }), 'landscape')
  })
})

describe('computeLayoutRotation', () => {
  it('portrait + portrait → 0', () => {
    assert.equal(computeLayoutRotation('portrait', 'portrait'), 0)
  })
  it('landscape + landscape → 0', () => {
    assert.equal(computeLayoutRotation('landscape', 'landscape'), 0)
  })
  it('landscape + portrait → -90', () => {
    assert.equal(computeLayoutRotation('landscape', 'portrait'), -90)
  })
  it('portrait + landscape → 90', () => {
    assert.equal(computeLayoutRotation('portrait', 'landscape'), 90)
  })
})

describe('resolveContentPlacement', () => {
  // 共用纸张：A4 竖向 @300dpi ≈ 2480×3508px
  const A4_PORTRAIT = { widthMM: 210, heightMM: 297 }
  const LANDSCAPE_PAPER = { widthMM: 297, heightMM: 210 }

  it('Case 1: 竖内容 + 竖纸 → fitRotation=0, finalRotation=0', () => {
    const r = resolveContentPlacement({
      contentSize: { width: 1000, height: 1400 },
      contentRotation: 0,
      paperSize: A4_PORTRAIT,
      dpi: 300,
    })
    assert.equal(r.fitRotation, 0)
    assert.equal(normalizeRotation(r.contentRotation + r.fitRotation), 0)
    assert.equal(r.contentOrientation, 'portrait')
    assert.equal(r.paperOrientation, 'portrait')
    // scale 应 ∈ (0, 1]（内容尺寸较小，不放大，scale=1）
    assert.ok(r.scale > 0 && r.scale <= 1)
    // available 宽 = 2480-6mm*2 ≈ 2339px（默认 margin=3mm → 35px each side）
  })

  it('Case 2: 横内容 + 竖纸 → fitRotation=-90, finalRotation=270', () => {
    const r = resolveContentPlacement({
      contentSize: { width: 1400, height: 1000 },
      contentRotation: 0,
      paperSize: A4_PORTRAIT,
      dpi: 300,
    })
    assert.equal(r.fitRotation, -90)
    assert.equal(normalizeRotation(r.contentRotation + r.fitRotation), 270)  // 0 + (-90) → 270
    assert.equal(r.contentOrientation, 'landscape')
    assert.equal(r.paperOrientation, 'portrait')
  })

  it('Case 3: 竖内容 + 横纸 → fitRotation=+90, finalRotation=90', () => {
    const A4_LANDSCAPE = { widthMM: 297, heightMM: 210 }
    const r = resolveContentPlacement({
      contentSize: { width: 1000, height: 1400 },
      contentRotation: 0,
      paperSize: A4_LANDSCAPE,
      dpi: 300,
    })
    assert.equal(r.fitRotation, 90)
    assert.equal(normalizeRotation(r.contentRotation + r.fitRotation), 90)
    assert.equal(r.contentOrientation, 'portrait')
    assert.equal(r.paperOrientation, 'landscape')
  })

  it('Case 4: contentRotation=90 竖内容 → 旋转后横内容 + 竖纸 → fitRotation=-90, finalRotation=0', () => {
    // 原始竖内容 1000×1400，contentRotation=90 → 有效横内容 + 竖纸 → fitRotation=-90
    const r = resolveContentPlacement({
      contentSize: { width: 1000, height: 1400 },  // 原始竖内容
      contentRotation: 90,
      paperSize: A4_PORTRAIT,
      dpi: 300,
    })
    assert.equal(r.contentRotation, 90)
    assert.equal(r.fitRotation, -90)
    assert.equal(normalizeRotation(r.contentRotation + r.fitRotation), 0)  // 90 + (-90) = 0
    assert.equal(r.contentOrientation, 'landscape')  // 旋转后内容是横的
  })

  it('Case 5: contentRotation=0 横内容 + 横纸 → fitRotation=0, finalRotation=0', () => {
    const A4_LANDSCAPE = { widthMM: 297, heightMM: 210 }
    const r = resolveContentPlacement({
      contentSize: { width: 1400, height: 1000 },
      contentRotation: 0,
      paperSize: A4_LANDSCAPE,
      dpi: 300,
    })
    assert.equal(r.fitRotation, 0)
    assert.equal(normalizeRotation(r.contentRotation + r.fitRotation), 0)
    assert.equal(r.contentOrientation, 'landscape')
    assert.equal(r.paperOrientation, 'landscape')
  })

  it('Case 6: 安全边距 10mm → availableRect 缩小，大内容时 scale < 1', () => {
    // 使用大内容（超出安全区）确保 scale < 1
    const pxPerMm = 300 / 25.4
    const availableW = Math.round((210 - 2 * 10) * pxPerMm)  // ≈ 2244px
    const availableH = Math.round((297 - 2 * 10) * pxPerMm)  // ≈ 3272px
    const r = resolveContentPlacement({
      contentSize: { width: availableW * 2, height: availableH * 2 },  // 内容远大于安全区
      contentRotation: 0,
      paperSize: A4_PORTRAIT,
      margins: { left: 10, right: 10, top: 10, bottom: 10 },
      dpi: 300,
    })
    const mPx = Math.round(10 * pxPerMm)
    const paperW = Math.round(210 * pxPerMm)
    const paperH = Math.round(297 * pxPerMm)
    assert.equal(r.availableRect.x, mPx)
    assert.equal(r.availableRect.y, mPx)
    assert.equal(r.availableRect.w, paperW - 2 * mPx)
    assert.equal(r.availableRect.h, paperH - 2 * mPx)
    // scale should be smaller due to margins
    assert.ok(r.scale < 1)
  })

  it('Case 7: offset is centered (non-negative, content within available)', () => {
    const r = resolveContentPlacement({
      contentSize: { width: 1000, height: 1400 },
      contentRotation: 0,
      paperSize: A4_PORTRAIT,
      dpi: 300,
    })
    assert.ok(r.offset.x >= r.availableRect.x)
    assert.ok(r.offset.y >= r.availableRect.y)
    assert.ok(r.placedRect.x >= r.availableRect.x)
    assert.ok(r.placedRect.y >= r.availableRect.y)
    assert.ok(r.placedRect.x + r.placedRect.w <= r.availableRect.x + r.availableRect.w)
    assert.ok(r.placedRect.y + r.placedRect.h <= r.availableRect.y + r.availableRect.h)
    // 居中：左右空白相等
    const leftGap = r.placedRect.x - r.availableRect.x
    const rightGap = (r.availableRect.x + r.availableRect.w) - (r.placedRect.x + r.placedRect.w)
    assert.ok(Math.abs(leftGap - rightGap) <= 1) // 1px 舍入误差
  })

  it('Case 8: canvasSize = paper size (paper does NOT rotate)', () => {
    const r = resolveContentPlacement({
      contentSize: { width: 1400, height: 1000 },
      contentRotation: 90,  // 旋转后横内容
      paperSize: A4_PORTRAIT,
      dpi: 300,
    })
    const pxPerMm = 300 / 25.4
    assert.equal(r.canvasSize.width, Math.round(210 * pxPerMm))
    assert.equal(r.canvasSize.height, Math.round(297 * pxPerMm))
    // 纸面不旋转，canvas 始终 = 纸张物理尺寸
  })

  it('Case 9: 180° contentRotation', () => {
    const r = resolveContentPlacement({
      contentSize: { width: 1000, height: 1400 },  // 180 不交换尺寸
      contentRotation: 180,
      paperSize: A4_PORTRAIT,
      dpi: 300,
    })
    assert.equal(r.contentRotation, 180)
    assert.equal(r.fitRotation, 0)  // 竖内容 + 竖纸
    assert.equal(normalizeRotation(r.contentRotation + r.fitRotation), 180)
  })

  it('Case 10: 270° contentRotation 竖内容 → 旋转后横内容 + 竖纸 → finalRotation=180', () => {
    // 原始竖内容 1000×1400，contentRotation=270(= -90) → 有效横内容 + 竖纸
    const r = resolveContentPlacement({
      contentSize: { width: 1000, height: 1400 },  // 原始竖内容
      contentRotation: 270,
      paperSize: A4_PORTRAIT,
      dpi: 300,
    })
    assert.equal(r.contentRotation, 270)
    assert.equal(r.fitRotation, -90)
    assert.equal(normalizeRotation(r.contentRotation + r.fitRotation), 180)  // 270 + (-90) = 180
  })

  it('rejects invalid contentSize', () => {
    assert.throws(() => resolveContentPlacement({
      contentSize: { width: 0, height: 0 },
      contentRotation: 0,
      paperSize: A4_PORTRAIT,
    }), /contentSize/)
  })

  it('Case 11: renderTransform — translate+scale+rotate 三段式数值锚点', () => {
    // 竖内容 1000×1400 + A4 portrait + 0° → 居中，scale≤1，rotation=0
    const r = resolveContentPlacement({
      contentSize: { width: 1000, height: 1400 },
      contentRotation: 0,
      paperSize: A4_PORTRAIT,
      margins: { left: 3, right: 3, top: 3, bottom: 3 },
      dpi: 300,
    })
    const rt = r.renderTransform
    assert.ok(rt, 'renderTransform must exist')
    assert.equal(rt.rotationDeg, 0, '竖内容+竖纸→不旋转')
    assert.ok(rt.scale > 0 && rt.scale <= 1, 'scale∈(0,1]')
    assert.ok(rt.translateX > 0, 'translateX>0（边距内）')
    assert.ok(rt.translateY > 0, 'translateY>0（边距内）')
    // rotation center = 内容中心
    assert.equal(rt.rotationCx, rt.imageWidth / 2)
    assert.equal(rt.rotationCy, rt.imageHeight / 2)
    // image 尺寸 = placedContent 尺寸（竖内容不变）
    assert.equal(rt.imageWidth, 1000)
    assert.equal(rt.imageHeight, 1400)
  })

  it('Case 12: renderTransform rot90 — 内容用户旋转90° + 竖纸 → fitRotation=-90', () => {
    // 原始竖内容 1000×1400，contentRotation=90 → 有效横内容 + 竖纸 → fitRotation=-90
    // 缩略图已 bake contentRotation（?content_rotation=90），SVG 只施加 fitRotation
    const r = resolveContentPlacement({
      contentSize: { width: 1000, height: 1400 },  // 原始竖内容
      contentRotation: 90,
      paperSize: A4_PORTRAIT,
      margins: { left: 3, right: 3, top: 3, bottom: 3 },
      dpi: 300,
    })
    const rt = r.renderTransform
    assert.equal(r.contentRotation + r.fitRotation, 0, '用户90+fit-90=0')
    // renderTransform 只施加 fitRotation（正常化为 270 = -90）
    assert.equal(rt.rotationDeg, normalizeRotation(r.fitRotation), 'renderTransform fitRotation=270')
    // 布局旋转后，imageWidth 交换
    assert.equal(rt.imageWidth, 1000, 'fitRotated后宽=有效高1000')
    assert.equal(rt.imageHeight, 1400, 'fitRotated后高=有效宽1400')
  })

  it('rejects invalid paperSize', () => {
    assert.throws(() => resolveContentPlacement({
      contentSize: { width: 100, height: 100 },
      contentRotation: 0,
      paperSize: {},
    }), /paperSize/)
  })

  // ── Commit 2-E Gate: 二阶段纸面适配矩阵 ──
  // 验证 shapeAdjustedOrientation + orientationFitRotation 显式中转
  it('Gate E1: 横票+横纸型+横向 → renderRotation=0', () => {
    const r = resolveContentPlacement({
      contentSize: { width: 1400, height: 1000 },  // 横向
      contentRotation: 0,
      paperSize: LANDSCAPE_PAPER,  // 297×210 横向纸型
      dpi: 300,
    })
    assert.equal(r.shapeFitRotation, 0)      // 横内容+横纸型=匹配
    assert.equal(r.shapeAdjustedOrientation, 'landscape')
    assert.equal(r.orientationFitRotation, 0) // 横向=横向
    assert.equal(r.renderRotation, 0)
  })

  it('Gate E2: 横票+横纸型+纵向 → renderRotation=-90(270)', () => {
    const r = resolveContentPlacement({
      contentSize: { width: 1400, height: 1000 },
      contentRotation: 0,
      paperSize: LANDSCAPE_PAPER,
      paperOrientation: 'portrait',  // 用户选纵向
      dpi: 300,
    })
    assert.equal(r.shapeFitRotation, 0)
    assert.equal(r.shapeAdjustedOrientation, 'landscape')
    assert.equal(r.orientationFitRotation, -90)  // 横→纵
    assert.equal(r.renderRotation, 270)  // normalize(-90)
  })

  it('Gate E3: 横票+竖纸型(A4)+竖向 → renderRotation=270', () => {
    const r = resolveContentPlacement({
      contentSize: { width: 1400, height: 1000 },
      contentRotation: 0,
      paperSize: A4_PORTRAIT,
      dpi: 300,
    })
    assert.equal(r.shapeFitRotation, -90)  // 横内容+竖纸型=不匹配
    assert.equal(r.shapeAdjustedOrientation, 'portrait')
    assert.equal(r.orientationFitRotation, 0) // 竖=竖
    assert.equal(r.renderRotation, 270)  // normalize(-90)
  })

  it('Gate E4: 横票+竖纸型(A4)+横向 → renderRotation=0', () => {
    const r = resolveContentPlacement({
      contentSize: { width: 1400, height: 1000 },
      contentRotation: 0,
      paperSize: A4_PORTRAIT,
      paperOrientation: 'landscape',  // 用户选横向
      dpi: 300,
    })
    assert.equal(r.shapeFitRotation, -90)
    assert.equal(r.shapeAdjustedOrientation, 'portrait')
    assert.equal(r.orientationFitRotation, 90)  // 竖→横
    assert.equal(r.renderRotation, 0)  // -90+90=0
  })
})
