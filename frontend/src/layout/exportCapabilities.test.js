/**
 * D4-2.1 验收测试：Render Export 能力守卫（纯函数，无 React / 无 shim 依赖）。
 *
 * 运行方式：`node --test src/layout/exportCapabilities.test.js`
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { supportsRenderExport, isRenderExportEligible } from './exportCapabilities.js'

// ── supportsRenderExport ──
test('supportsRenderExport: empty / non-array -> false', () => {
  assert.equal(supportsRenderExport([]), false)
  assert.equal(supportsRenderExport(undefined), false)
  assert.equal(supportsRenderExport(null), false)
})

test('supportsRenderExport: pdf only -> true', () => {
  assert.equal(supportsRenderExport([{ fileFormat: 'pdf' }]), true)
})

test('supportsRenderExport: image only -> true', () => {
  assert.equal(supportsRenderExport([{ fileFormat: 'image' }]), true)
})

test('supportsRenderExport: ofd only -> false', () => {
  assert.equal(supportsRenderExport([{ fileFormat: 'ofd' }]), false)
})

test('supportsRenderExport: mixed pdf+ofd -> false (whole batch falls back)', () => {
  assert.equal(supportsRenderExport([{ fileFormat: 'pdf' }, { fileFormat: 'ofd' }]), false)
})

test('supportsRenderExport: mixed pdf+image -> true', () => {
  assert.equal(supportsRenderExport([{ fileFormat: 'pdf' }, { fileFormat: 'image' }]), true)
})

test('supportsRenderExport: missing fileFormat -> false (not silently supported)', () => {
  assert.equal(supportsRenderExport([{ name: 'x.pdf' }]), false)
})

test('supportsRenderExport: unknown format -> false', () => {
  assert.equal(supportsRenderExport([{ fileFormat: 'tiff' }]), false)
})

// ── isRenderExportEligible ──
test('eligible: enabled + previewState + settings + pdf -> true', () => {
  assert.equal(
    isRenderExportEligible({ enabled: true, previewState: {}, settings: {}, files: [{ fileFormat: 'pdf' }] }),
    true,
  )
})

test('eligible: ofd files -> false (legacy fallback)', () => {
  assert.equal(
    isRenderExportEligible({ enabled: true, previewState: {}, settings: {}, files: [{ fileFormat: 'ofd' }] }),
    false,
  )
})

test('eligible: disabled flag -> false (kill-switch)', () => {
  assert.equal(
    isRenderExportEligible({ enabled: false, previewState: {}, settings: {}, files: [{ fileFormat: 'pdf' }] }),
    false,
  )
})

test('eligible: no previewState -> false', () => {
  assert.equal(
    isRenderExportEligible({ enabled: true, previewState: null, settings: {}, files: [{ fileFormat: 'pdf' }] }),
    false,
  )
})

test('eligible: no settings -> false', () => {
  assert.equal(
    isRenderExportEligible({ enabled: true, previewState: {}, settings: null, files: [{ fileFormat: 'pdf' }] }),
    false,
  )
})

test('eligible: empty files -> false', () => {
  assert.equal(
    isRenderExportEligible({ enabled: true, previewState: {}, settings: {}, files: [] }),
    false,
  )
})
