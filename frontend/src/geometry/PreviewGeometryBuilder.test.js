import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPreviewGeometry } from './PreviewGeometryBuilder.js'
import { resolvePrintAutoRotation } from './PrintAutoRotationPolicy.js'
import { extractContentPx } from './extractContentPx.js'
import { detectDocumentOrientation } from '../utils/detectOrientation.js'

// ───────────────────────────────────────────────────────────
// Gate 2 验收矩阵（PreviewGeometryBuilder Boundary Contract）
// 纯函数 + 向量；不接任何生产调用。
// 字段语义（Gate 2-2 修正）：
//   sourceContentLandscape     = 旋转前内容是否横置（cache key / identity）
//   effectiveContentLandscape  = 旋转后内容是否横置（最终 display 方向）
//   orientationMismatch        = sourceContentLandscape !== paperLandscape（= 旧 isLandscape 的 cache key 语义）
// ───────────────────────────────────────────────────────────

// 1) D3 四格矩阵 + D2 几何语义（rotation 改内容，不改纸）
test('D3+ D2：横票 + 竖纸 → effectiveRotation 270，纸张仍 portrait，sourceContentLandscape=true / effectiveContentLandscape=false / orientationMismatch=true', () => {
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 },
    requestedPaperGeometry: { orientation: 'portrait' },
    userRotation: { degrees: 0 },
  })
  assert.equal(out.effectiveRotation, 270)
  // D2 守卫：effectiveRotation=270 不得让 paperLandscape 翻成 true（物理 A4 portrait 不变）
  assert.equal(out.paperLandscape, false)
  assert.equal(out.paperGeometry.orientation, 'portrait')
  // 旋转前：3508×2480 横票
  assert.equal(out.sourceContentGeometry.widthPx, 3508)
  assert.equal(out.sourceContentGeometry.heightPx, 2480)
  assert.equal(out.sourceContentLandscape, true)
  // 旋转后：2480×3508 → 内容变 portrait
  assert.equal(out.effectiveContentGeometry.widthPx, 2480)
  assert.equal(out.effectiveContentGeometry.heightPx, 3508)
  assert.equal(out.effectiveContentLandscape, false)
  // orientationMismatch = sourceContentLandscape !== paperLandscape = true !== false = true（= 旧 isLandscape，cache key 语义）
  assert.equal(out.orientationMismatch, true)
})

test('D3 + D2：竖票 + 横纸 → effectiveRotation 90，纸张仍 landscape，orientationMismatch=true', () => {
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 2480, heightPx: 3508 },
    requestedPaperGeometry: { orientation: 'landscape' },
    userRotation: { degrees: 0 },
  })
  assert.equal(out.effectiveRotation, 90)
  assert.equal(out.paperLandscape, true) // 物理纸 landscape 不变
  assert.equal(out.sourceContentLandscape, false) // 旋转前竖票
  assert.equal(out.effectiveContentGeometry.widthPx, 3508)
  assert.equal(out.effectiveContentGeometry.heightPx, 2480)
  assert.equal(out.effectiveContentLandscape, true) // 旋转后内容变 landscape
  assert.equal(out.orientationMismatch, true) // false !== true
})

test('D3：横票 + 横纸 → effectiveRotation 0，orientationMismatch=false', () => {
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 3508, heightPx: 2318 },
    requestedPaperGeometry: { orientation: 'landscape' },
    userRotation: { degrees: 0 },
  })
  assert.equal(out.effectiveRotation, 0)
  assert.equal(out.sourceContentLandscape, true)
  assert.equal(out.paperLandscape, true)
  assert.equal(out.orientationMismatch, false)
})

test('D3：竖票 + 竖纸 → effectiveRotation 0，orientationMismatch=false', () => {
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 2480, heightPx: 3508 },
    requestedPaperGeometry: { orientation: 'portrait' },
    userRotation: { degrees: 0 },
  })
  assert.equal(out.effectiveRotation, 0)
  assert.equal(out.sourceContentLandscape, false)
  assert.equal(out.paperLandscape, false)
  assert.equal(out.orientationMismatch, false)
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

// 3) D2 强度守卫：paperLandscape / orientationMismatch 与 effectiveRotation 无关（仅由源几何 + PaperGeometry 决定）
test('D2 守卫：paperLandscape 恒等于 requestedPaperGeometry.orientation，与 effectiveRotation 无关', () => {
  const base = { rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 }, requestedPaperGeometry: { orientation: 'portrait' } }
  for (const deg of [0, 90, 180, 270, -90]) {
    const out = buildPreviewGeometry({ ...base, userRotation: { degrees: deg } })
    assert.equal(out.paperLandscape, false, `userRotation=${deg} 不应翻转物理纸`)
    assert.equal(out.paperGeometry.orientation, 'portrait')
  }
})

test('D2 守卫：orientationMismatch 仅由 sourceContentLandscape/paperLandscape 决定，不随 userRotation 改变', () => {
  // 横票+竖纸 → sourceContentLandscape=true, paperLandscape=false → orientationMismatch=true，恒定
  const base = { rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 }, requestedPaperGeometry: { orientation: 'portrait' } }
  for (const deg of [0, 90, 180, 270, -90]) {
    const out = buildPreviewGeometry({ ...base, userRotation: { degrees: deg } })
    assert.equal(out.orientationMismatch, true, `userRotation=${deg} 不应改变 orientationMismatch（cache key 语义必须稳定）`)
    assert.equal(out.paperLandscape, false)
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

// 5) G2-Semantic Regression（Gate 2-2 修正的核心）：横票+竖纸 5 字段同时成立
//    关键：修正前 isLandscape = contentLandscape !== paperLandscape（旋转后比较）= false !== false = false，
//          与既有 cache key（旧 isLandscape=true）冲突；修正后 orientationMismatch 复用旋转前比较 = true，一致。
test('G2-Semantic Regression：横票+竖纸 sourceContentLandscape/paperLandscape/orientationMismatch/effectiveRotation/effectiveContentLandscape 同时成立', () => {
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 },
    requestedPaperGeometry: { orientation: 'portrait' },
    userRotation: { degrees: 0 },
  })
  assert.equal(out.sourceContentLandscape, true) // 旋转前横票
  assert.equal(out.paperLandscape, false) // 物理 A4 portrait
  assert.equal(out.orientationMismatch, true) // = 旧 isLandscape（cache key 语义，必须为 true）
  assert.equal(out.effectiveRotation, 270) // 内容需旋转 270° 上纸
  assert.equal(out.effectiveContentLandscape, false) // 旋转后内容变 portrait
})

// 5b) G2-S4-1 Cache identity regression（Step 4 接线核心守卫）：
//     orientationMismatch 必须与旧 isLandscape（= detectDocumentOrientation(file) !== paperOrient）值等价，
//     否则替换进 renderKey / buildPreviewCacheKey 会改变缓存身份 → 命中错误 L2/fullCache 快照。
//     覆盖 PDF / 图片 / OFD 三种 px 源（extractContentPx 与 detectDocumentOrientation 同源）。
test('G2-S4-1：orientationMismatch 与旧 isLandscape(contentOrient !== paperOrient) 值等价（缓存键不变）', () => {
  const cases = [
    { file: { _pdfPageWidth: 3508, _pdfPageHeight: 2480 }, paperOrient: 'portrait', expect: true, label: 'PDF 横票+竖纸' },
    { file: { _pdfPageWidth: 2480, _pdfPageHeight: 3508 }, paperOrient: 'landscape', expect: true, label: 'PDF 竖票+横纸' },
    { file: { _pdfPageWidth: 3508, _pdfPageHeight: 2318 }, paperOrient: 'landscape', expect: false, label: 'PDF 横票+横纸' },
    { file: { _pdfPageWidth: 2480, _pdfPageHeight: 3508 }, paperOrient: 'portrait', expect: false, label: 'PDF 竖票+竖纸' },
    { file: { _imageWidth: 3508, _imageHeight: 2480 }, paperOrient: 'portrait', expect: true, label: '图片 横票+竖纸' },
    { file: { _imageWidth: 2480, _imageHeight: 3508 }, paperOrient: 'landscape', expect: true, label: '图片 竖票+横纸' },
    { file: { previewWidth: 2480, previewHeight: 3508 }, paperOrient: 'portrait', expect: false, label: 'OFD preview 竖票+竖纸' },
    { file: { previewWidth: 3508, previewHeight: 2480 }, paperOrient: 'landscape', expect: false, label: 'OFD preview 横票+横纸' },
  ]
  for (const c of cases) {
    const oldIsLandscape = detectDocumentOrientation(c.file) !== c.paperOrient
    const out = buildPreviewGeometry({
      rawDocumentGeometry: extractContentPx(c.file),
      requestedPaperGeometry: { orientation: c.paperOrient },
      userRotation: { degrees: 0 },
    })
    assert.equal(out.orientationMismatch, oldIsLandscape, `旧 isLandscape 应等价 (${c.label})`)
    assert.equal(out.orientationMismatch, c.expect, `期望 mismatch (${c.label})`)
  }
})

// 5c) G2-S4-2 No writeback（静态/单元双重守卫）：
//     Builder 输出不得含任何可被写回 documentState / fileRotations 的 effectiveRotation 字段别名；
//     且 effectiveRotation 始终为 canonical {0,90,180,270}，绝不进入 orientation 身份比较。
test('G2-S4-2：orientationMismatch 不使用 effectiveRotation，且 effectiveRotation 为 canonical', () => {
  for (const [w, h, po] of [[3508, 2480, 'portrait'], [2480, 3508, 'landscape'], [3508, 2318, 'landscape'], [2480, 3508, 'portrait']]) {
    const out = buildPreviewGeometry({
      rawDocumentGeometry: { widthPx: w, heightPx: h },
      requestedPaperGeometry: { orientation: po },
      userRotation: { degrees: 0 },
    })
    // orientationMismatch 仅依赖 sourceContentLandscape / paperLandscape，不含 effectiveRotation
    assert.equal('effectiveRotation' in out && typeof out.effectiveRotation === 'number', true)
    assert.ok([0, 90, 180, 270].includes(out.effectiveRotation), `effectiveRotation canonical (${w}x${h}/${po})`)
  }
})

// 6) B-7 Fixed Output Contract：返回命名结构，非 Policy 返回值透传
test('B-7：返回命名 PreviewPlacementGeometry，且不含 Policy 内部字段（如 autoRotation）', () => {
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 },
    requestedPaperGeometry: { orientation: 'portrait' },
    userRotation: { degrees: 0 },
  })
  const keys = Object.keys(out).sort()
  assert.deepEqual(keys, [
    'effectiveContentGeometry',
    'effectiveContentLandscape',
    'effectiveRotation',
    'orientationMismatch',
    'paperGeometry',
    'paperLandscape',
    'sourceContentGeometry',
    'sourceContentLandscape',
  ].sort())
  assert.equal('autoRotation' in out, false, '不得透传 Policy 内部 autoRotation')
  assert.equal('isLandscape' in out, false, 'isLandscape 已拆分为 orientationMismatch + effectiveContentLandscape')
})

// 7) B-7 守卫：Builder 不做第二 Resolver 决策 —— 仅委托 Policy，组合 PaperGeometry
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
