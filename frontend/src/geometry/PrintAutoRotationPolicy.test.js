import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePrintAutoRotation, normalizeRotation } from './PrintAutoRotationPolicy.js'

// ───────────────────────────────────────────────────────────
// Gate 1 验收矩阵（Print Auto Rotation Contract v1.0 FINAL）
// 不接任何生产调用；仅验证领域层纯函数。
// ───────────────────────────────────────────────────────────

// 1) D3 四格矩阵：autoRotation 仅由「原始内容方向 vs 纸张方向」决定（userRotation=0）
test('D3 矩阵：横票 + 横纸 → autoRotation 0', () => {
  const r = resolvePrintAutoRotation({
    sourceContentGeometry: { widthPx: 3508, heightPx: 2318 },
    targetPaperGeometry: { orientation: 'landscape' },
  })
  assert.equal(r.autoRotation, 0)
  assert.equal(r.effectiveRotation, 0)
  assert.equal(r.effectiveContentWidth, 3508)
  assert.equal(r.effectiveContentHeight, 2318)
})

test('D3 矩阵：横票 + 竖纸 → autoRotation canonical 270（数学记号 -90）', () => {
  const r = resolvePrintAutoRotation({
    sourceContentGeometry: { widthPx: 3508, heightPx: 2318 },
    targetPaperGeometry: { orientation: 'portrait' },
  })
  // INV-D4-3：负值 -90 必须归一为 canonical 270
  assert.equal(r.autoRotation, 270)
  assert.equal(r.effectiveRotation, 270)
  // 旋转后有效尺寸交换：2318×3508（横内容塞竖纸）
  assert.equal(r.effectiveContentWidth, 2318)
  assert.equal(r.effectiveContentHeight, 3508)
})

test('D3 矩阵：竖票 + 横纸 → autoRotation canonical 90（数学记号 +90）', () => {
  const r = resolvePrintAutoRotation({
    sourceContentGeometry: { widthPx: 2480, heightPx: 3508 },
    targetPaperGeometry: { orientation: 'landscape' },
  })
  assert.equal(r.autoRotation, 90)
  assert.equal(r.effectiveRotation, 90)
  // 旋转后有效尺寸交换：3508×2480（竖内容塞横纸）
  assert.equal(r.effectiveContentWidth, 3508)
  assert.equal(r.effectiveContentHeight, 2480)
})

test('D3 矩阵：竖票 + 竖纸 → autoRotation 0', () => {
  const r = resolvePrintAutoRotation({
    sourceContentGeometry: { widthPx: 2480, heightPx: 3508 },
    targetPaperGeometry: { orientation: 'portrait' },
  })
  assert.equal(r.autoRotation, 0)
  assert.equal(r.effectiveRotation, 0)
  assert.equal(r.effectiveContentWidth, 2480)
  assert.equal(r.effectiveContentHeight, 3508)
})

// 2) 方向驱动 autoRotation，几何驱动有效尺寸（验证「orientation 标签 vs 真实像素」解耦）
test('方向相同的内容（不同像素）autoRotation 一致，但有效尺寸随几何变化', () => {
  const a = resolvePrintAutoRotation({
    sourceContentGeometry: { widthPx: 3508, heightPx: 2318 },
    targetPaperGeometry: { orientation: 'portrait' },
  })
  const b = resolvePrintAutoRotation({
    sourceContentGeometry: { widthPx: 1600, heightPx: 1200 }, // 同为 landscape，像素更小
    targetPaperGeometry: { orientation: 'portrait' },
  })
  assert.equal(a.autoRotation, b.autoRotation) // 都是 270
  assert.notEqual(a.effectiveContentWidth, b.effectiveContentWidth) // 有效尺寸按真实像素
  assert.equal(b.effectiveContentWidth, 1200)
  assert.equal(b.effectiveContentHeight, 1600)
})

// 3) D4 叠加式：effectiveRotation = normalize(autoRotation + userRotation)（INV-D4-2）
test('D4 叠加：autoRotation 270 + userRotation 90 → 360 → 0', () => {
  const r = resolvePrintAutoRotation({
    sourceContentGeometry: { widthPx: 3508, heightPx: 2318 },
    targetPaperGeometry: { orientation: 'portrait' },
    userRotation: 90,
  })
  assert.equal(r.autoRotation, 270) // auto 不变
  assert.equal(r.effectiveRotation, 0) // 270+90=360→0
})

test('D4 叠加：autoRotation 270 + userRotation -90 → 180', () => {
  const r = resolvePrintAutoRotation({
    sourceContentGeometry: { widthPx: 3508, heightPx: 2318 },
    targetPaperGeometry: { orientation: 'portrait' },
    userRotation: -90,
  })
  assert.equal(r.effectiveRotation, 180)
  // 180%180=0 → 不交换 → 仍为横尺寸
  assert.equal(r.effectiveContentWidth, 3508)
})

test('D4 叠加：autoRotation 90 + userRotation 90 → 180', () => {
  const r = resolvePrintAutoRotation({
    sourceContentGeometry: { widthPx: 2480, heightPx: 3508 },
    targetPaperGeometry: { orientation: 'landscape' },
    userRotation: 90,
  })
  assert.equal(r.effectiveRotation, 180)
})

// 4) normalizeRotation canonical（INV-D4-3）
test('normalizeRotation：负值/超界均归一为 canonical clockwise', () => {
  assert.equal(normalizeRotation(-90), 270)
  assert.equal(normalizeRotation(450), 90)
  assert.equal(normalizeRotation(-450), 270)
  assert.equal(normalizeRotation(360), 0)
  assert.equal(normalizeRotation(0), 0)
  assert.equal(normalizeRotation(180), 180)
})

// 5) INV-D4-1 防循环：autoRotation 与 userRotation 无关（扫 userRotation 不变）
test('INV-D4-1：autoRotation 不随 userRotation 变化（仅由原始内容几何算一次）', () => {
  const base = { sourceContentGeometry: { widthPx: 3508, heightPx: 2318 }, targetPaperGeometry: { orientation: 'portrait' } }
  const expected = resolvePrintAutoRotation(base).autoRotation
  for (const u of [0, 90, 180, 270, -90, 45]) {
    assert.equal(resolvePrintAutoRotation({ ...base, userRotation: u }).autoRotation, expected)
  }
})

// 6) 守卫：几何非法 / 纸张方向非法 → 抛错
test('守卫：widthPx/heightPx 非正数 → 抛错', () => {
  assert.throws(() => resolvePrintAutoRotation({
    sourceContentGeometry: { widthPx: 0, heightPx: 2318 },
    targetPaperGeometry: { orientation: 'portrait' },
  }))
  assert.throws(() => resolvePrintAutoRotation({
    sourceContentGeometry: { widthPx: 3508 },
    targetPaperGeometry: { orientation: 'portrait' },
  }))
})

test('守卫：paper orientation 非法 → 抛错', () => {
  assert.throws(() => resolvePrintAutoRotation({
    sourceContentGeometry: { widthPx: 3508, heightPx: 2318 },
    targetPaperGeometry: { orientation: 'diagonal' },
  }))
})
