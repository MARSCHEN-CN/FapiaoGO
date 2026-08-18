/**
 * PrintGeometryBuilder.test.js — Gate 3-1 向量测试。
 *
 * 覆盖：D3 4 格（R1/R2/R3/R3b）+ R4(userRotation≠autoRotation) + R5(Builder 命名结构非透传)
 * + R6(user cancel auto 叠加非覆盖) + B-6(canonical) + B-8(paperLandscape 不输出)
 * + G3-R1(print≡preview 同 resolver)。
 *
 * 不依赖 resolvePaper / config / import.meta.env（避免 vite 技术债）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrintGeometry } from './PrintGeometryBuilder.js'
import { buildPreviewGeometry } from './PreviewGeometryBuilder.js'

// 构造一个 print geometry 输入
function geo({ w, h, orientation = 'portrait', userDeg = 0 }) {
  return {
    rawDocumentGeometry: { widthPx: w, heightPx: h },
    requestedPaperGeometry: { orientation },
    userRotation: { degrees: userDeg },
  }
}

// --- D3 4-cell autoRotation (userRotation=0) ---

test('R1 横票 + A4 portrait → auto rotation 生效 (270)', () => {
  const r = buildPrintGeometry(geo({ w: 3508, h: 2480, orientation: 'portrait' }))
  assert.equal(r.autoRotation, 270)
  assert.equal(r.effectiveRotation, 270)
  assert.equal(r.sourceContentLandscape, true)
  assert.equal(r.effectiveContentLandscape, false) // 旋转 270° 后内容变为竖置
})

test('R2 竖票 + A4 portrait → effectiveRotation=0', () => {
  const r = buildPrintGeometry(geo({ w: 2480, h: 3508, orientation: 'portrait' }))
  assert.equal(r.autoRotation, 0)
  assert.equal(r.effectiveRotation, 0)
  assert.equal(r.sourceContentLandscape, false)
  assert.equal(r.effectiveContentLandscape, false)
})

test('R3 横票 + landscape paper → 不强制旋转 (0)', () => {
  const r = buildPrintGeometry(geo({ w: 3508, h: 2480, orientation: 'landscape' }))
  assert.equal(r.autoRotation, 0)
  assert.equal(r.effectiveRotation, 0)
})

test('R3b 竖票 + landscape paper → auto 90', () => {
  // 竖内容塞横纸 → 内容方向 landscape? 不，contentOrientation=portrait≠landscape → 90
  const r = buildPrintGeometry(geo({ w: 2480, h: 3508, orientation: 'landscape' }))
  assert.equal(r.autoRotation, 90)
  assert.equal(r.effectiveRotation, 90)
})

// --- R4 userRotation !== autoRotation ---

test('R4 横票+portrait + userRotation=90 → normalize(270+90)=0', () => {
  const r = buildPrintGeometry(geo({ w: 3508, h: 2480, orientation: 'portrait', userDeg: 90 }))
  assert.equal(r.autoRotation, 270)
  assert.equal(r.effectiveRotation, 0)
})

// --- R6 user cancel auto（叠加 not 覆盖）---

test('R6 user cancel auto: effectiveRotation = auto+user 叠加，非 auto 恒赢 / 非 user 覆盖', () => {
  const r = buildPrintGeometry(geo({ w: 3508, h: 2480, orientation: 'portrait', userDeg: 90 }))
  assert.equal(r.autoRotation, 270)
  assert.notEqual(r.effectiveRotation, 270) // 不是 auto 恒赢
  assert.notEqual(r.effectiveRotation, 90) // 不是 user 覆盖
  assert.equal(r.effectiveRotation, 0) // 真实叠加：normalize(270+90)=0
})

// --- R5 Builder 输出为命名结构，非透传 Policy 原始返回 (B-7) ---

test('R5 Builder 返回命名 PrintPlacementGeometry，不含 Policy 原始字段 (effectiveContentWidth/Height)', () => {
  const r = buildPrintGeometry(geo({ w: 3508, h: 2480, orientation: 'portrait' }))
  assert.ok('effectiveRotation' in r)
  assert.ok('autoRotation' in r)
  assert.ok('sourceContentGeometry' in r)
  assert.ok('effectiveContentGeometry' in r)
  assert.ok('sourceContentLandscape' in r)
  assert.ok('effectiveContentLandscape' in r)
  // Policy 返回原始字段不应透传
  assert.equal('effectiveContentWidth' in r, false)
  assert.equal('effectiveContentHeight' in r, false)
})

// --- B-8 paperLandscape 不输出（D3）---

test('B-8 PrintGeometryBuilder 不输出 paperLandscape / orientationMismatch / preview 字段', () => {
  const r = buildPrintGeometry(geo({ w: 3508, h: 2480, orientation: 'landscape' }))
  assert.equal('paperLandscape' in r, false)
  assert.equal('orientationMismatch' in r, false)
})

// --- B-6 canonical degrees ∈ {0,90,180,270} ---

test('B-6 effectiveRotation 始终 canonical ∈ {0,90,180,270}', () => {
  const cases = [
    [3508, 2480, 'portrait', 0, 270],
    [2480, 3508, 'portrait', 0, 0],
    [3508, 2480, 'landscape', 0, 0],
    [2480, 3508, 'landscape', 0, 90],
    [3508, 2480, 'portrait', 90, 0],
    [3508, 2480, 'portrait', 180, 90],
    [3508, 2480, 'portrait', 270, 180],
  ]
  const canonical = [0, 90, 180, 270]
  for (const [w, h, o, u, exp] of cases) {
    const r = buildPrintGeometry(geo({ w, h, orientation: o, userDeg: u }))
    assert.ok(canonical.includes(r.effectiveRotation), `canonical check failed: ${r.effectiveRotation}`)
    assert.equal(r.effectiveRotation, exp)
  }
})

// --- G3-R1 print ≡ preview 同 resolver ---

test('G3-R1 print ≡ preview: 同输入 effectiveRotation 相等（4 格 × 4 userRotation）', () => {
  const matrix = [
    [3508, 2480, 'portrait'],
    [2480, 3508, 'portrait'],
    [3508, 2480, 'landscape'],
    [2480, 3508, 'landscape'],
  ]
  for (const [w, h, o] of matrix) {
    for (const u of [0, 90, 180, 270]) {
      const args = {
        rawDocumentGeometry: { widthPx: w, heightPx: h },
        requestedPaperGeometry: { orientation: o },
        userRotation: { degrees: u },
      }
      const print = buildPrintGeometry(args)
      const preview = buildPreviewGeometry(args)
      assert.equal(print.effectiveRotation, preview.effectiveRotation, `equal at ${w}x${h} ${o} u=${u}`)
    }
  }
})

// --- B-2 纯函数：无状态 ---

test('B-2 纯函数：相同输入多次调用结果一致', () => {
  const a = buildPrintGeometry(geo({ w: 3508, h: 2480, orientation: 'portrait', userDeg: 90 }))
  const b = buildPrintGeometry(geo({ w: 3508, h: 2480, orientation: 'portrait', userDeg: 90 }))
  assert.deepEqual(a, b)
})
