/**
 * composePlacement.test.js — B1 characterization 测试
 *
 * 目的：冻结「内容 → 虚拟纸 contentRect」的 placement 几何契约。
 * 纯 Node 可跑（不导入 config / renderers / worker）。
 * 数值为手算确定性结果，对照 renderers.js:731-755 旧内联数学（contentRect 替换 slot）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPlacement, mmSlotToPx } from './composePlacement.js'
import { buildComposeSlots } from './composeSlot.js'

// Case 1：A5 merge2 横票，旋转 90°，内容 fit 到 contentRect
// 用户指定：source 210×99, rotation 90, content 138×95(px)
test('createPlacement: landscape invoice rotates and fits into contentRect', () => {
  const p = createPlacement({
    contentRect: { x: 5, y: 5, width: 138, height: 95 },
    sourceWidth: 210,
    sourceHeight: 99,
    rotation: 90,
  })
  // rotatedBounds = 未缩放旋转后内容尺寸
  assert.deepEqual(p.rotatedBounds, { width: 99, height: 210 })
  // scale = min(138/99, 95/210) = 0.45238...
  assert.ok(Math.abs(p.scale - 0.45238) < 1e-3, `scale ≈ 0.452, got ${p.scale}`)
  // 左上角：offsetX = 5 + (138 - 99*scale)/2 ≈ 51.607
  assert.ok(Math.abs(p.offsetX - 51.607) < 1e-2, `offsetX ≈ 51.6, got ${p.offsetX}`)
  // offsetY = 5 + (95 - 210*scale)/2 ≈ 5.0
  assert.ok(Math.abs(p.offsetY - 5.0) < 1e-2, `offsetY ≈ 5.0, got ${p.offsetY}`)
  // 边界：clip 锁 contentRect，不越界到 slot
  assert.deepEqual(p.clip, { x: 5, y: 5, width: 138, height: 95 })
  assert.equal(p.contentRotation, 90)
  // 关键边界：产物不含 RenderCommand 组装字段
  assert.ok(!('version' in p), 'must not include version')
  assert.ok(!('paper' in p), 'must not include paper')
  assert.ok(!('command' in p), 'must not include command')
})

// Case 2：不旋转 → effective 维度不交换
test('createPlacement: no rotation keeps effective dims unswapped', () => {
  const p = createPlacement({
    contentRect: { x: 0, y: 0, width: 138, height: 95 },
    sourceWidth: 100,
    sourceHeight: 50,
    rotation: 0,
  })
  assert.equal(p.rotatedBounds.width, 100)
  assert.equal(p.rotatedBounds.height, 50)
  // scale = min(138/100, 95/50) = 1.38
  assert.ok(Math.abs(p.scale - 1.38) < 1e-6, `scale ≈ 1.38, got ${p.scale}`)
  // offsetY = (95 - 50*1.38)/2 = 13
  assert.ok(Math.abs(p.offsetY - 13) < 1e-6, `offsetY ≈ 13, got ${p.offsetY}`)
})

// Case 3：薄 contentRect 防御（对应 B0 reviewer 提醒）→ scale=0 且 finite，绝不 Infinity/NaN
test('createPlacement: degenerate contentRect yields scale 0 (no Infinity/NaN)', () => {
  const p = createPlacement({
    contentRect: { x: 0, y: 0, width: 0, height: 95 },
    sourceWidth: 210,
    sourceHeight: 99,
    rotation: 90,
  })
  assert.equal(p.scale, 0)
  assert.ok(Number.isFinite(p.offsetX), 'offsetX must be finite')
  assert.ok(Number.isFinite(p.offsetY), 'offsetY must be finite')
  assert.ok(Number.isFinite(p.scale), 'scale must be finite')
})

// mmSlotToPx：仅单位换算，保留结构
test('mmSlotToPx: converts all rects and preserves id/index/gridPosition', () => {
  const slots = buildComposeSlots({
    paper: { widthMM: 148, heightMM: 210, isLandscape: false },
    mergeMode: 'merge2',
  })
  const px = mmSlotToPx(slots[0], 300)
  assert.equal(px.id, slots[0].id)
  assert.equal(px.index, 0)
  assert.equal(px.gridPosition, undefined)
  // 105mm * 300/25.4
  assert.ok(Math.abs(px.paperRect.height - (105 * 300) / 25.4) < 1e-6)
  assert.ok(Math.abs(px.contentRect.width - (138 * 300) / 25.4) < 1e-6)
  // 不改入参
  assert.equal(slots[0].paperRect.height, 105)
})

// Integration：B0 slot(mm) → mmSlotToPx → createPlacement 落在 contentRect 内（不溢出到 margin）
test('integration: B0 slot through mmSlotToPx fits content inside contentRect', () => {
  const slots = buildComposeSlots({
    paper: { widthMM: 148, heightMM: 210, isLandscape: false },
    mergeMode: 'merge2',
  })
  const px = mmSlotToPx(slots[0], 300)
  const p = createPlacement({
    contentRect: px.contentRect,
    sourceWidth: 210,
    sourceHeight: 99,
    rotation: 90,
  })
  // placement 绘制范围不应越出 contentRect（含极小浮点容差）
  const eps = 1e-6
  assert.ok(p.offsetX >= px.contentRect.x - eps)
  assert.ok(p.offsetY >= px.contentRect.y - eps)
  assert.ok(
    p.offsetX + p.rotatedBounds.width * p.scale <= px.contentRect.x + px.contentRect.width + eps,
  )
  assert.ok(
    p.offsetY + p.rotatedBounds.height * p.scale <= px.contentRect.y + px.contentRect.height + eps,
  )
})
