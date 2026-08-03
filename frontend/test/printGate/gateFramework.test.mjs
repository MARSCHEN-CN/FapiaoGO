/**
 * A2-G0 Gate 框架自检（node --test，纯 node 可跑，不接 React/Electron）
 *
 * 覆盖：
 *  1. measureMarginsPx / pxToMm / mmToPx / marginsToMm 纯函数正确性
 *  2. assertSafeMarginAlignment 容差断言（≤0.5mm 通过 / >0.5mm 失败）
 *  3. anchorManifest 结构校验（A1-A6 齐全、derived 引用）
 *  4. 双执行器比较管线结构：Plan → legacy/canvas 双输出 → compare
 *     （用 mock 输出演示管线形状；真实双轨输出采集属 G1，需 Electron 环境）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measureMarginsPx, pxToMm, mmToPx, marginsToMm, assertSafeMarginAlignment } from './measureMargins.mjs'
import { anchorManifest, validateAnchorManifest } from './anchorManifest.mjs'
import { SAFE_MARGIN_TOLERANCE_MM, GATE_DPI, PAPER_SIZES_MM } from './gateConfig.mjs'

// ── 1. 测量纯函数 ──────────────────────────────────────────────
test('measureMarginsPx: bbox 贴左边缘 → left=0', () => {
  const m = measureMarginsPx({ x: 0, y: 100, w: 500, h: 700 }, { w: 1000, h: 1400 })
  assert.deepEqual(m, { left: 0, top: 100, right: 500, bottom: 600 })
})

test('measureMarginsPx: 居中 bbox → 四边对称', () => {
  const m = measureMarginsPx({ x: 200, y: 200, w: 600, h: 1000 }, { w: 1000, h: 1400 })
  assert.equal(m.left, m.right)
  assert.equal(m.top, m.bottom)
  assert.equal(m.left, 200)
  assert.equal(m.top, 200)
})

test('measureMarginsPx: 满纸 bbox → 四边全 0', () => {
  const m = measureMarginsPx({ x: 0, y: 0, w: 1000, h: 1400 }, { w: 1000, h: 1400 })
  assert.deepEqual(m, { left: 0, top: 0, right: 0, bottom: 0 })
})

test('measureMarginsPx: bbox 越界抛错', () => {
  assert.throws(() => measureMarginsPx({ x: 0, y: 0, w: 1100, h: 1400 }, { w: 1000, h: 1400 }))
  assert.throws(() => measureMarginsPx({ x: -5, y: 0, w: 100, h: 100 }, { w: 1000, h: 1400 }))
})

test('px↔mm 换算：300dpi 下 1mm ≈ 11.811px（A4 宽 210mm ≈ 2480px）', () => {
  assert.ok(Math.abs(pxToMm(mmToPx(210)) - 210) < 1e-6)
  const a4pxW = Math.round(210 * GATE_DPI / 25.4)
  assert.equal(a4pxW, 2480)
})

test('marginsToMm：A4@300dpi 四边 20mm 边距 → 236.22px', () => {
  const px = mmToPx(20)
  const m = marginsToMm({ left: px, top: px, right: px, bottom: px })
  for (const e of ['left', 'top', 'right', 'bottom']) assert.ok(Math.abs(m[e] - 20) < 0.001)
})

// ── 2. 容差断言 ────────────────────────────────────────────────
test('assertSafeMarginAlignment: 0.4mm 差 → pass', () => {
  const r = assertSafeMarginAlignment(
    { left: 20, top: 20, right: 20, bottom: 20 },
    { left: 20.4, top: 20.1, right: 19.9, bottom: 20 },
  )
  assert.equal(r.pass, true)
  assert.ok(r.maxDiffMm <= SAFE_MARGIN_TOLERANCE_MM)
})

test('assertSafeMarginAlignment: 0.7mm 差 → fail（任一超容差即失败）', () => {
  const r = assertSafeMarginAlignment(
    { left: 20, top: 20, right: 20, bottom: 20 },
    { left: 20.7, top: 20, right: 20, bottom: 20 },
  )
  assert.equal(r.pass, false)
  assert.equal(r.maxDiffMm, 0.7)
})

test('assertSafeMarginAlignment: 缺边值抛错', () => {
  assert.throws(() => assertSafeMarginAlignment({ left: 20, top: 20, right: 20, bottom: 20 }, { left: 20, top: 20 }))
})

// ── 3. manifest 结构 ───────────────────────────────────────────
test('anchorManifest: A1-A6 齐全、无重复、derived 有引用', () => {
  const { valid, errors } = validateAnchorManifest()
  assert.equal(valid, true, errors.join('; '))
  assert.equal(anchorManifest.length, 6)
  const a4 = anchorManifest.find(a => a.id === 'A4')
  assert.equal(a4.status, 'derived')
  assert.ok(a4.source.startsWith('derived:'))
})

test('anchorManifest: 至少 1 个 missing（A2 OFD 待用户提供）', () => {
  const missing = anchorManifest.filter(a => a.status === 'missing')
  assert.ok(missing.length >= 1, '应标记缺失样本（A2 OFD）')
  assert.equal(missing[0].id, 'A2')
})

// ── 4. 双执行器比较管线结构（从 Plan 出发，§11.5）──────────────
test('gate pipeline: Plan → legacy/canvas 双输出 → compare（mock 演示形状）', () => {
  // 形状：files → buildPrintExecutionPlan → 双执行器 → 同源比较。
  // 真实采集（Sumatra vs Canvas 输出）属 G1，需 Electron 环境；
  // 此处用与 A1/A1.5 相同的 Plan 结构 mock，验证 compare 断言管线可用。
  const plan = {
    strategy: { oneNormalTwoSpecial: false },
    mergeMode: null,
    pages: [{ type: 'single', source: { fileId: 'A1' }, slots: [{ fileId: 'A1', rotation: 0 }] }],
    extraPages: [],
  }
  assert.equal(plan.pages.length, 1)

  // 双执行器共享同一 Plan → 输出同纸面（mock：source 与 canvas 都按 A4 渲染）
  const paperPx = { w: Math.round(PAPER_SIZES_MM.A4.width * GATE_DPI / 25.4), h: Math.round(PAPER_SIZES_MM.A4.height * GATE_DPI / 25.4) }
  // source 轨：pdfMargin.process 烘焙（main.js:515-553）→ 内容 bbox 内缩 20mm
  const sourceBbox = { x: mmToPx(20), y: mmToPx(20), w: paperPx.w - mmToPx(40), h: paperPx.h - mmToPx(40) }
  // canvas 轨：createPlacement 的 usableRect（期望与 source 对齐 ±0.5mm）
  const canvasBbox = { x: mmToPx(20.2), y: mmToPx(20), w: paperPx.w - mmToPx(40.4), h: paperPx.h - mmToPx(40) }

  const sourceMm = marginsToMm(measureMarginsPx(sourceBbox, paperPx))
  const canvasMm = marginsToMm(measureMarginsPx(canvasBbox, paperPx))
  const r = assertSafeMarginAlignment(canvasMm, sourceMm)

  assert.equal(r.pass, true)
  assert.ok(r.maxDiffMm <= SAFE_MARGIN_TOLERANCE_MM)
  assert.ok(r.maxDiffMm > 0, '应测出 ~0.2mm 的真实差异')
})
