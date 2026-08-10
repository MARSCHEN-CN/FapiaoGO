/**
 * PrintSpec.normalize 单测 — Phase 1-C-1（G-C1-2 / G-C1-3 + 行为等价回归）
 *
 * 运行: node --test frontend/test/printGate/printSpecNormalize.test.mjs
 *
 * 覆盖：
 *   G-C1-2  paper 缺失 → throw MissingPrintSpecPaperError（禁止隐式 A4）
 *   G-C1-3  legacy settings → 权威 PrintSpec（字段映射正确）
 *   行为等价 buildPrintSettings 旧输入 → 相同 Sumatra DSL（C-1-a 不改变打印行为）
 *   兼容    paper 与 paperSize 都给 → paper 优先
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ps = require(path.join(REPO, 'electron', 'print-service', 'print-settings.js'))

test('G-C1-2: paper 缺失 → throw MissingPrintSpecPaperError（禁止隐式 A4 fallback）', () => {
  assert.throws(() => ps.normalize({ landscape: true }), {
    name: 'MissingPrintSpecPaperError',
  })
  assert.throws(() => ps.normalize({}), { name: 'MissingPrintSpecPaperError' })
  assert.throws(() => ps.buildPrintSettings({ landscape: true }), {
    name: 'MissingPrintSpecPaperError',
  })
})

test('G-C1-3: legacy settings → 权威 PrintSpec（字段映射）', () => {
  const spec = ps.normalize({
    paperSize: 'A4',
    paperkind: 9,
    customPaper: null,
    marginLeft: 10, marginRight: 5, marginTop: 30, marginBottom: 10,
    fit: 'none',
    sourceRotation: 90,
    contentOrientation: 'landscape',
    paperOrientation: 'portrait',
    grayscale: true,
    copies: 2,
  })
  assert.deepEqual(spec.paper, {
    sizeName: 'A4', orientation: 'portrait',
    widthMM: 210, heightMM: 297,
    paperkind: 9, customPaper: null,
  })
  assert.deepEqual(spec.margins, { left: 10, right: 5, top: 30, bottom: 10 })
  assert.equal(spec.scalePolicy, 'none')
  assert.equal(spec.contentRotation, 90)
  assert.equal(spec.contentOrientation, 'landscape')
  assert.equal(spec.paperOrientation, 'portrait')
  assert.equal(spec.grayscale, true)
  assert.equal(spec.copies, 2)
})

test('G-C1-3: contentRotation 双字段回退（sourceRotation ?? rotation ?? 0）', () => {
  assert.equal(ps.normalize({ paperSize: 'A4', rotation: 180 }).contentRotation, 180)
  assert.equal(ps.normalize({ paperSize: 'A4' }).contentRotation, 0)
})

test('C1-B-V1: 横向票据 + A4 portrait → paper.orientation 解析 + contentRotation 承载（纸张方向 ≠ 内容旋转，三分离冻结）', () => {
  // 场景：横向票据内容（841.89×595.27pt）打到 A4 竖向纸。
  // 终态正确行为（Preview/Policy A 约定，符号不改）：paper rotate → usableRect rebuild
  // → content rotate。本 commit 只承载字段，不实现几何重算（用户裁决：C-1-b 不改符号）。
  const spec = ps.normalize({
    paperSize: 'A4',
    contentOrientation: 'landscape',   // 横向内容
    fit: 'contain',
    sourceRotation: 0,
  })
  // paper.orientation（纸张形状方向，决定 W/H 与 usableRect）
  assert.equal(spec.paper.sizeName, 'A4')
  assert.equal(spec.paper.orientation, 'portrait')     // A4 竖向纸
  assert.equal(spec.paper.widthMM, 210)
  assert.equal(spec.paper.heightMM, 297)
  // contentRotation（内容变换，与 paper.orientation 分离）
  assert.equal(spec.contentRotation, 0)
  assert.equal(spec.contentOrientation, 'landscape')
})

test('C1-B-V1b: 自定义横向纸（Voucher240x140）→ paper.orientation=landscape + W/H', () => {
  const spec = ps.normalize({
    paperSize: 'Voucher240x140',
    fit: 'contain',
  })
  assert.equal(spec.paper.orientation, 'landscape')
  assert.equal(spec.paper.widthMM, 240)
  assert.equal(spec.paper.heightMM, 140)
})

test('C1-B-V1c: Custom paper（240×140mm）→ orientation 由宽高比决定', () => {
  const spec = ps.normalize({
    paperSize: 'Custom',
    customPaper: { widthMM: 240, heightMM: 140 },
    fit: 'contain',
  })
  assert.equal(spec.paper.orientation, 'landscape')
  assert.equal(spec.paper.widthMM, 240)
  assert.equal(spec.paper.heightMM, 140)
})

test('未知纸型 → widthMM/heightMM 为 null（不隐式默认，仅名称透传）', () => {
  const spec = ps.normalize({ paperSize: 'SomeUnknownPaper', fit: 'contain' })
  assert.equal(spec.paper.sizeName, 'SomeUnknownPaper')
  assert.equal(spec.paper.widthMM, null)
  assert.equal(spec.paper.heightMM, null)
  assert.equal(spec.paper.orientation, 'portrait')   // getPaperShapeOrientation 默认
})

test('G-C1-3: scalePolicy 回退（scalePolicy ?? fit ?? contain）', () => {
  assert.equal(ps.normalize({ paperSize: 'A4' }).scalePolicy, 'contain')
  assert.equal(ps.normalize({ paperSize: 'A4', fit: 'fill' }).scalePolicy, 'fill')
  assert.equal(ps.normalize({ paperSize: 'A4', fit: 'none', scalePolicy: 'contain' }).scalePolicy, 'contain')
})

test('兼容: paper 与 paperSize 都给 → paper 优先', () => {
  const spec = ps.normalize({ paper: 'A3', paperSize: 'A4' })
  assert.equal(spec.paper.sizeName, 'A3')
})

test('行为等价: buildPrintSettings 旧输入 → 相同 Sumatra DSL（C-1-a 不改变打印行为）', () => {
  const cases = [
    [{ paperSize: 'A4', fit: 'contain' }, 'disable-auto-rotation,fit,paper=a4'],
    [{ paperSize: 'A4', fit: 'none' }, 'disable-auto-rotation,noscale,paper=a4'],
    [{ paperSize: 'A4', fit: 'fill' }, 'disable-auto-rotation,stretch,paper=a4'],
    [{ paperSize: 'A4', contentOrientation: 'landscape', paperOrientation: 'portrait', fit: 'contain' },
      'landscape,fit,paper=a4'],
    [{ paperSize: 'A4', contentOrientation: 'landscape', paperOrientation: 'portrait', sourceRotation: 90, fit: 'contain' },
      'disable-auto-rotation,rotate=90,fit,paper=a4'],
    [{ paperSize: 'Voucher240x140', fit: 'contain' }, 'disable-auto-rotation,fit,paper=240mm x 140mm'],
    [{ paperSize: 'Custom', customPaper: { widthMM: 240, heightMM: 140 }, fit: 'contain' },
      'disable-auto-rotation,fit,paper=240mm x 140mm'],
    [{ paperSize: 'A4', paperkind: 9, fit: 'contain' }, 'disable-auto-rotation,fit,paperkind=9,paper=a4'],
    [{ paperSize: 'A4', fit: 'contain', duplex: true }, 'disable-auto-rotation,fit,paper=a4,duplexlong'],
    [{ paperSize: 'A4', fit: 'contain', grayscale: true }, 'disable-auto-rotation,fit,paper=a4,monochrome'],
    [{ paperSize: 'A4', fit: 'contain', copies: 3 }, 'disable-auto-rotation,fit,paper=a4,3x'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(ps.buildPrintSettings(input), expected, JSON.stringify(input))
  }
})

test('纯函数: normalize 不修改输入', () => {
  const input = { paperSize: 'A4', fit: 'none' }
  const snapshot = JSON.stringify(input)
  ps.normalize(input)
  assert.equal(JSON.stringify(input), snapshot)
})
