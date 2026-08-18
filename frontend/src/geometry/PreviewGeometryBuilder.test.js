import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPreviewGeometry } from './PreviewGeometryBuilder.js'
import { resolvePrintAutoRotation } from './PrintAutoRotationPolicy.js'

// ───────────────────────────────────────────────────────────
// Gate 2 验收矩阵（PreviewGeometryBuilder Boundary Contract）
// 纯函数 + 向量；不接任何生产调用。
// ───────────────────────────────────────────────────────────

// 1) D3 四格矩阵 + D2 几何语义（rotation 改内容，不改纸）
test('D3+ D2：横票 + 竖纸 → effectiveRotation 270，纸张仍 portrait，contentLandscape 变 portrait', () => {
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 },
    requestedPaperGeometry: { orientation: 'portrait' },
    userRotation: { degrees: 0 },
  })
  assert.equal(out.effectiveRotation, 270)
  // D2 守卫：effectiveRotation=270 不得让 paperLandscape 翻成 true（物理 A4 portrait 不变）
  assert.equal(out.paperLandscape, false)
  assert.equal(out.paperGeometry.orientation, 'portrait')
  // 内容几何旋转后：2480×3508 → 内容非横置（portrait）
  assert.equal(out.effectiveContentGeometry.widthPx, 2480)
  assert.equal(out.effectiveContentGeometry.heightPx, 3508)
  assert.equal(out.contentLandscape, false)
  // isLandscape = contentLandscape !== paperLandscape = false !== false = false
  assert.equal(out.isLandscape, false)
})

test('D3 + D2：竖票 + 横纸 → effectiveRotation 90，纸张仍 landscape', () => {
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 2480, heightPx: 3508 },
    requestedPaperGeometry: { orientation: 'landscape' },
    userRotation: { degrees: 0 },
  })
  assert.equal(out.effectiveRotation, 90)
  assert.equal(out.paperLandscape, true) // 物理纸 landscape 不变
  assert.equal(out.effectiveContentGeometry.widthPx, 3508)
  assert.equal(out.effectiveContentGeometry.heightPx, 2480)
  assert.equal(out.contentLandscape, true)
  assert.equal(out.isLandscape, false)
})

test('D3：横票 + 横纸 → effectiveRotation 0', () => {
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 3508, heightPx: 2318 },
    requestedPaperGeometry: { orientation: 'landscape' },
    userRotation: { degrees: 0 },
  })
  assert.equal(out.effectiveRotation, 0)
  assert.equal(out.isLandscape, false)
})

test('D3：竖票 + 竖纸 → effectiveRotation 0', () => {
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 2480, heightPx: 3508 },
    requestedPaperGeometry: { orientation: 'portrait' },
    userRotation: { degrees: 0 },
  })
  assert.equal(out.effectiveRotation, 0)
  assert.equal(out.isLandscape, false)
})

// 2) D4 叠加式：effectiveRotation = normalize(autoRotation + userRotation)（INV-D4-2，委托 Policy）
test('D4 叠加：横票+竖纸 autoRotation 270 + userRotation 90 → 0', () => {
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 },
    requestedPaperGeometry: { orientation: 'portrait' },
    userRotation: { degrees: 90 },
  })
  assert.equal(out.effectiveRotation, 0)
})

test('D4 叠加：横票+竖纸 autoRotation 270 + userRotation 270 → 180', () => {
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 },
    requestedPaperGeometry: { orientation: 'portrait' },
    userRotation: { degrees: 270 },
  })
  assert.equal(out.effectiveRotation, 180)
})

// 3) D2 强度守卫：effectiveRotation 任意值都不得改变 paperLandscape（来自 PaperGeometry 唯一来源）
test('D2 守卫：paperLandscape 恒等于 requestedPaperGeometry.orientation，与 effectiveRotation 无关', () => {
  const base = { rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 }, requestedPaperGeometry: { orientation: 'portrait' } }
  for (const deg of [0, 90, 180, 270, -90]) {
    const out = buildPreviewGeometry({ ...base, userRotation: { degrees: deg } })
    assert.equal(out.paperLandscape, false, `userRotation=${deg} 不应翻转物理纸`)
    assert.equal(out.paperGeometry.orientation, 'portrait')
  }
})

// 4) G2-INV-D4-1 Regression：二次调用不回流、不改输入
test('G2-INV-D4-1：同输入二次调用输出一致，且原始输入对象未被修改', () => {
  const raw = { widthPx: 3508, heightPx: 2480 }
  const input = {
    rawDocumentGeometry: raw,
    requestedPaperGeometry: { orientation: 'portrait' },
    userRotation: { degrees: 0 },
  }
  const out1 = buildPreviewGeometry(input)
  const out2 = buildPreviewGeometry(input)
  assert.deepEqual(out2, out1)
  // 输入未被 transpose / mutate
  assert.equal(input.rawDocumentGeometry.widthPx, 3508)
  assert.equal(input.rawDocumentGeometry.heightPx, 2480)
})

// 5) B-7 Fixed Output Contract：返回命名结构，非 Policy 返回值透传
test('B-7：返回命名 PreviewPlacementGeometry，且不含 Policy 内部字段（如 autoRotation）', () => {
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 },
    requestedPaperGeometry: { orientation: 'portrait' },
    userRotation: { degrees: 0 },
  })
  const keys = Object.keys(out).sort()
  assert.deepEqual(keys, [
    'contentLandscape',
    'effectiveContentGeometry',
    'effectiveRotation',
    'isLandscape',
    'paperGeometry',
    'paperLandscape',
  ].sort())
  assert.equal('autoRotation' in out, false, '不得透传 Policy 内部 autoRotation')
})

// 6) B-7 守卫：Builder 不做第二 Resolver 决策 —— 仅委托 Policy，组合 PaperGeometry
test('B-7：横票+竖纸的 effectiveRotation 与 Policy 直算一致（决策唯一出口）', () => {
  const policy = resolvePrintAutoRotation({
    sourceContentGeometry: { widthPx: 3508, heightPx: 2480 },
    targetPaperGeometry: { orientation: 'portrait' },
    userRotation: 0,
  })
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 },
    requestedPaperGeometry: { orientation: 'portrait' },
    userRotation: { degrees: 0 },
  })
  assert.equal(out.effectiveRotation, policy.effectiveRotation)
})
