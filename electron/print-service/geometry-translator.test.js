'use strict'

/**
 * geometry-translator.test.js — G1d Translator 单元测试（纯 CommonJS，无 electron 依赖）
 *
 * 验证 §9.4 R6：{ orientation, rotate } → { nativePaperW_mm, nativePaperH_mm, contentRotation }
 * 经 apply_pdf 的 policy_a 后输出方向 == Truth.orientation（无双重交换）。
 *
 * policy_a 在此【独立重新实现】（不 import 任何 Python/生产几何），
 * 与黄金向量 Layer B 的 method 一致：独立实现 → 断言 policy_a 输出 == Truth.orientation。
 *
 * 运行：node --test electron/print-service/geometry-translator.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { translateGeometry, opposite } = require('./geometry-translator')

// ── A4 baseDims（orientation-agnostic，与 resolvePaperMmFromSettings 产出一致）──
const A4 = { width: 210, height: 297 }
const PORTRAIT_A4 = { w: 210, h: 297 }
const LANDSCAPE_A4 = { w: 297, h: 210 }

/**
 * 独立复刻 margin_contract.apply_pdf 的 policy_a 输出方向推导。
 *   swap ⟺ contentRotation % 180 === 90 （即 90 / 270）
 *   输出方向 = swap 后的纸方向（宽>高 → landscape）
 */
function policyAOutputOrientation(nativeW, nativeH, contentRotation) {
  const swap = (((Math.round(contentRotation / 90) % 4) + 4) % 4) % 2 === 1
  const outW = swap ? nativeH : nativeW
  const outH = swap ? nativeW : nativeH
  return outW > outH ? 'landscape' : 'portrait'
}

// Truth 8 组合（对齐黄金向量 Layer B B1-B8）
const CASES = [
  { id: 'B1-landscape-rot0',   orientation: 'landscape', rotate: 0,   expectNative: LANDSCAPE_A4,  expectOut: 'landscape' },
  { id: 'B2-landscape-rot90',  orientation: 'landscape', rotate: 90,  expectNative: PORTRAIT_A4,   expectOut: 'landscape' },
  { id: 'B3-landscape-rot180', orientation: 'landscape', rotate: 180, expectNative: LANDSCAPE_A4,  expectOut: 'landscape' }, // T5 candidate
  { id: 'B4-landscape-rot270', orientation: 'landscape', rotate: 270, expectNative: PORTRAIT_A4,   expectOut: 'landscape' },
  { id: 'B5-portrait-rot0',    orientation: 'portrait',  rotate: 0,   expectNative: PORTRAIT_A4,   expectOut: 'portrait' },
  { id: 'B6-portrait-rot90',   orientation: 'portrait',  rotate: 90,  expectNative: LANDSCAPE_A4,  expectOut: 'portrait' },
  { id: 'B7-portrait-rot180',  orientation: 'portrait',  rotate: 180, expectNative: PORTRAIT_A4,   expectOut: 'portrait' },
  { id: 'B8-portrait-rot270',  orientation: 'portrait',  rotate: 270, expectNative: LANDSCAPE_A4,  expectOut: 'portrait' },
]

test('Translator: 8 Truth combinations → native paper → policy_a == Truth.orientation (no double swap)', () => {
  for (const c of CASES) {
    const geo = translateGeometry({ orientation: c.orientation, rotate: c.rotate, baseDims: A4 })

    // ① native paper 尺寸正确
    assert.equal(geo.nativePaperW_mm, c.expectNative.w,
      `${c.id}: nativePaperW_mm 期望 ${c.expectNative.w}，实际 ${geo.nativePaperW_mm}`)
    assert.equal(geo.nativePaperH_mm, c.expectNative.h,
      `${c.id}: nativePaperH_mm 期望 ${c.expectNative.h}，实际 ${geo.nativePaperH_mm}`)

    // ② contentRotation 直通
    assert.equal(geo.contentRotation, c.rotate % 360,
      `${c.id}: contentRotation 应直通 Truth.rotate`)

    // ③ policy_a 输出方向 == Truth.orientation（R6 无双重交换）
    const out = policyAOutputOrientation(geo.nativePaperW_mm, geo.nativePaperH_mm, geo.contentRotation)
    assert.equal(out, c.expectOut,
      `${c.id}: policy_a 输出 ${out}，期望 ${c.expectOut} —— 双重交换！`)
    assert.equal(out, c.orientation,
      `${c.id}: 最终方向 ${out} ≠ Truth.orientation ${c.orientation}`)
  }
})

test('Translator: 显式 landscape+90 负向控制（naïve 不 swap 必错）', () => {
  // 反例：若把 landscape+90 直接传 landscape 原生纸（不经 Translator 的 opposite swap）
  const naiveNativeW = LANDSCAPE_A4.w // 297
  const naiveNativeH = LANDSCAPE_A4.h // 210
  const out = policyAOutputOrientation(naiveNativeW, naiveNativeH, 90)
  assert.equal(out, 'portrait',
    'naïve landscape+90 经 policy_a 应得 portrait（与 Truth.landscape 矛盾）→ 证明 Translator 的 opposite 不可省略')
  assert.notEqual(out, 'landscape', 'naïve 实现错误地得到 landscape，证明必须走 Translator')
})

test('Translator: landscape+90 走 Translator 须得 landscape（正例对照负向控制）', () => {
  const geo = translateGeometry({ orientation: 'landscape', rotate: 90, baseDims: A4 })
  assert.equal(geo.nativePaperW_mm, PORTRAIT_A4.w) // 210：Translator 已 opposite swap 成 portrait 原生纸
  assert.equal(geo.nativePaperH_mm, PORTRAIT_A4.h) // 297
  const out = policyAOutputOrientation(geo.nativePaperW_mm, geo.nativePaperH_mm, geo.contentRotation)
  assert.equal(out, 'landscape', '走 Translator 的 landscape+90 必须收敛回 landscape')
})

test('Translator: T5 candidate (landscape+180) 几何一致', () => {
  const geo = translateGeometry({ orientation: 'landscape', rotate: 180, baseDims: A4 })
  assert.equal(geo.nativePaperW_mm, LANDSCAPE_A4.w)
  assert.equal(geo.nativePaperH_mm, LANDSCAPE_A4.h)
  const out = policyAOutputOrientation(geo.nativePaperW_mm, geo.nativePaperH_mm, geo.contentRotation)
  assert.equal(out, 'landscape', 'T5 candidate landscape+180 几何层一致（仍待 Gate 3 物理复核升 frozen）')
})

test('Translator: baseDims 无效抛错', () => {
  assert.throws(() => translateGeometry({ orientation: 'portrait', rotate: 0, baseDims: null }),
    /baseDims/)
  assert.throws(() => translateGeometry({ orientation: 'portrait', rotate: 0, baseDims: { width: 0, height: 0 } }),
    /baseDims/)
})

test('opposite() 正确', () => {
  assert.equal(opposite('landscape'), 'portrait')
  assert.equal(opposite('portrait'), 'landscape')
})
