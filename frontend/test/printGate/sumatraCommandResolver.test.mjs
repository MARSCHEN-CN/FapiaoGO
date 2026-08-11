#!/usr/bin/env node
/**
 * Sumatra Command Resolver 单元测试 — C-2-Sumatra-Command-Matrix（2026-08-11）
 *
 * 16-case 实测表（Wondershare PDFelement 真实打印，用户提供矩阵）固化：
 *   invoiceRotation × paperOrientation → Sumatra {orientation, rotate}
 *
 * 用法: node --test sumatraCommandResolver.test.mjs（0 = PASS）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const require = createRequire(import.meta.url)
const { resolveSumatraRotation, toOrientationParts } = require(
  path.join(REPO, 'electron', 'print-service', 'sumatra-command-resolver.js'))

// ── 实测矩阵（用户 2026-08-11 数据，16 case）──
// [contentOrientation][contentRotation][paperOrientation] = { orientation, rotate }
const CASES = [
  // 横发票
  ['landscape', 0,   'landscape', { orientation: 'landscape', rotate: 90 }],
  ['landscape', 0,   'portrait',  { orientation: 'portrait',  rotate: 90 }],
  ['landscape', 90,  'landscape', { orientation: 'landscape', rotate: 90 }],
  ['landscape', 90,  'portrait',  { orientation: 'portrait',  rotate: 270 }],
  ['landscape', 180, 'landscape', { orientation: 'landscape', rotate: 270 }],
  ['landscape', 180, 'portrait',  { orientation: 'portrait',  rotate: 270 }],
  ['landscape', 270, 'landscape', { orientation: 'landscape', rotate: 270 }],
  ['landscape', 270, 'portrait',  { orientation: 'portrait',  rotate: 90 }],
  // 竖发票
  ['portrait', 0,   'landscape', { orientation: 'landscape', rotate: 270 }],
  ['portrait', 0,   'portrait',  { orientation: 'portrait',  rotate: 90 }],
  ['portrait', 90,  'landscape', { orientation: 'landscape', rotate: 90 }],
  ['portrait', 90,  'portrait',  { orientation: 'portrait',  rotate: 90 }],
  ['portrait', 180, 'landscape', { orientation: 'landscape', rotate: 90 }],
  ['portrait', 180, 'portrait',  { orientation: 'portrait',  rotate: 270 }],
  ['portrait', 270, 'landscape', { orientation: 'landscape', rotate: 270 }],
  ['portrait', 270, 'portrait',  { orientation: 'portrait',  rotate: 270 }],
]

test('C-2-Sumatra-Command-Matrix: 16/16 实测 case 全匹配', () => {
  for (const [contentOrientation, contentRotation, paperOrientation, expected] of CASES) {
    const got = resolveSumatraRotation({ contentOrientation, contentRotation, paperOrientation })
    assert.deepStrictEqual(got, expected,
      `content=${contentOrientation} rot=${contentRotation} paper=${paperOrientation}`)
  }
})

test('orientation 恒等于 paperOrientation（纸方向直接决定 landscape/portrait）', () => {
  for (const contentOrientation of ['landscape', 'portrait']) {
    for (const contentRotation of [0, 90, 180, 270]) {
      for (const paperOrientation of ['landscape', 'portrait']) {
        const { orientation } = resolveSumatraRotation({ contentOrientation, contentRotation, paperOrientation })
        assert.strictEqual(orientation, paperOrientation)
      }
    }
  }
})

test('rotate 只产生 90/270（实测两值域）', () => {
  for (const contentOrientation of ['landscape', 'portrait']) {
    for (const contentRotation of [0, 90, 180, 270]) {
      for (const paperOrientation of ['landscape', 'portrait']) {
        const { rotate } = resolveSumatraRotation({ contentOrientation, contentRotation, paperOrientation })
        assert.ok(rotate === 90 || rotate === 270, `rotate=${rotate} 非法`)
      }
    }
  }
})

test('toOrientationParts: landscape/portrait + rotate 编码', () => {
  assert.deepStrictEqual(
    toOrientationParts({ orientation: 'landscape', rotate: 90 }),
    ['landscape', 'rotate=90'])
  assert.deepStrictEqual(
    toOrientationParts({ orientation: 'portrait', rotate: 270 }),
    ['disable-auto-rotation', 'rotate=270'])
})

test('非法输入抛错', () => {
  assert.throws(() => resolveSumatraRotation({ contentOrientation: 'bad', contentRotation: 0, paperOrientation: 'portrait' }))
  assert.throws(() => resolveSumatraRotation({ contentOrientation: 'landscape', contentRotation: 45, paperOrientation: 'portrait' }))
  assert.throws(() => resolveSumatraRotation({ contentOrientation: 'landscape', contentRotation: 0, paperOrientation: 'bad' }))
})

// ── Symmetry invariant（用户裁决 2026-08-11 17:30）──
// 对称性是【验证约束，非运行时实现】：查表保持 16-case 直查，测试额外保证
//   横向表 == 竖向 golden base + orientation swap（8/8 双向）
// swap 规则（实测归纳，2026-08-11）：
//   内容有效方向 eff = (contentBase + rot) mod 180（横 contentBase=0°，竖=90°）
//     eff==0（横向布局）→ rotate 不变；eff==90（竖向布局）→ rotate 翻转（90↔270）
test('Symmetry: 横向表 == 竖向 golden base + orientation swap（8/8 双向）', () => {
  const eff = (content, rot) => ((content === 'landscape' ? 0 : 90) + rot) % 180
  const swapRotate = (content, rot, baseRot) => (eff(content, rot) === 90 ? (baseRot + 180) % 360 : baseRot)
  for (const content of ['landscape', 'portrait']) {
    for (const rot of [0, 90, 180, 270]) {
      const base = resolveSumatraRotation({ contentOrientation: content, contentRotation: rot, paperOrientation: 'portrait' }).rotate
      const actual = resolveSumatraRotation({ contentOrientation: content, contentRotation: rot, paperOrientation: 'landscape' }).rotate
      const derived = swapRotate(content, rot, base)
      assert.strictEqual(derived, actual,
        `竖→横 swap 推导不符: ${content}-rot${rot}（base=${base} 推导=${derived} 查表=${actual}）`)
      assert.strictEqual(swapRotate(content, rot, actual), base,
        `横→竖 反向不符: ${content}-rot${rot}`)
    }
  }
})
