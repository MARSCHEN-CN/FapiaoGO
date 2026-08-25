/**
 * R-4.6-A Placement Bake v2 Contract — placement-bake-processor 结构校验 + spec 双发射测试
 *
 * 运行: node --test frontend/src/print/__tests__/placementBakeV2Contract.test.mjs
 *
 * 验证（D5 分层：JS 层只查结构合法性；物理一致性归 Python bake）：
 *   V2-1  hasPlacement v1 兼容：单 placement（无 pagePlacements）→ true（零行为变化）
 *   V2-2  hasPlacement v2：pagePlacements[] 合法 → true
 *   V2-3  hasPlacement v2 严格：pagePlacements 显式提供但结构非法 → false（禁静默回落）
 *   V2-4  hasPlacement：pagePlacements 空数组（显式提供）→ false
 *   V2-5  hasPlacement：placement / pagePlacements 全缺 → false
 *   V2-6  hasPlacement：非 PDF 源 → false（ext 守卫不变）
 *   V2-7  buildBakeSpec v1：无 pagePlacements → spec.placement 单对象（兼容）
 *   V2-8  buildBakeSpec v2：pagePlacements → spec.pagePlacements[] + spec.placement 同源
 *   V2-9  G1：v1 单 placement 与 v2 单元素数组 → spec.placement 逐字段一致（单页零变化）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const placementBake = require(path.join(REPO, 'electron', 'print-service', 'placement-bake-processor.js'))

// ── fixture：与 PrintService.buildPrintSettings 输出同构的生产形态 settings ──
function mkPlacement(over = {}) {
  return {
    scale: 0.5,
    offset: { x: 35.4, y: 35.4 },
    placedRect: { x: 35.4, y: 35.4, w: 700, h: 500 },
    layoutRotation: 0,
    contentRotation: 0,
    canvasSize: { width: 2480, height: 3508 },
    ...over,
  }
}

function mkSettings({ placement = mkPlacement(), pagePlacements = null, paper = 'A4', landscape = false } = {}) {
  return {
    rotation: 0,
    sourceRotation: 0,
    paper,
    paperkind: undefined,
    fit: 'contain',
    landscape,
    contentOrientation: 'portrait',
    duplex: false,
    grayscale: false,
    copies: 1,
    marginLeft: 3, marginRight: 3, marginTop: 3, marginBottom: 3,
    customPaper: undefined,
    placement,
    pagePlacements,
    executionPaper: {
      size: paper,
      orientation: landscape ? 'landscape' : 'portrait',
      widthMM: landscape ? 297 : 210,
      heightMM: landscape ? 210 : 297,
      customPaper: null,
    },
  }
}

const PDF_PATH = 'C:/tmp/invoice.pdf'
const OFD_PATH = 'C:/tmp/invoice.ofd'

test('V2-1: hasPlacement v1 兼容（单 placement，无 pagePlacements）→ true', () => {
  assert.equal(placementBake.hasPlacement(mkSettings(), PDF_PATH), true)
})

test('V2-2: hasPlacement v2（pagePlacements[] 合法，即使 placement 单对象也在）→ true', () => {
  const settings = mkSettings({
    pagePlacements: [
      { pageIndex: 0, placement: mkPlacement({ scale: 0.5 }) },
      { pageIndex: 1, placement: mkPlacement({ scale: 0.6 }) },
    ],
  })
  assert.equal(placementBake.hasPlacement(settings, PDF_PATH), true)
})

test('V2-3: hasPlacement v2 严格（pagePlacements 显式提供但结构非法）→ false（禁静默回落）', () => {
  // pageIndex 缺失 / 非整数 → 结构非法
  const bad = mkSettings({ pagePlacements: [{ placement: mkPlacement() }] })
  assert.equal(placementBake.hasPlacement(bad, PDF_PATH), false,
    '缺 pageIndex 必须拒绝（D5：结构合法性在 JS 层）')
  const bad2 = mkSettings({ pagePlacements: [{ pageIndex: -1, placement: mkPlacement() }] })
  assert.equal(placementBake.hasPlacement(bad2, PDF_PATH), false, '负 pageIndex 必须拒绝')
  const bad3 = mkSettings({ pagePlacements: [{ pageIndex: 0, placement: mkPlacement({ scale: 'x' }) }] })
  assert.equal(placementBake.hasPlacement(bad3, PDF_PATH), false, 'placement 字段非法必须拒绝')
})

test('V2-4: hasPlacement v2（pagePlacements 显式空数组）→ false', () => {
  assert.equal(placementBake.hasPlacement(mkSettings({ pagePlacements: [] }), PDF_PATH), false)
})

test('V2-5: hasPlacement（placement 与 pagePlacements 全缺）→ false', () => {
  assert.equal(placementBake.hasPlacement(mkSettings({ placement: null }), PDF_PATH), false)
})

test('V2-6: hasPlacement（非 PDF 源）→ false（ext 守卫不变）', () => {
  assert.equal(placementBake.hasPlacement(mkSettings(), OFD_PATH), false)
})

test('V2-7: buildBakeSpec v1（无 pagePlacements）→ spec.placement 单对象，无 pagePlacements 键', () => {
  const settings = mkSettings()
  const spec = placementBake.buildBakeSpec(PDF_PATH, settings, 'C:/tmp/out.pdf')
  assert.equal(spec.paper.widthMm, 210)
  assert.equal(spec.paper.heightMm, 297)
  assert.equal(spec.placement.scale, settings.placement.scale)
  assert.equal(spec.placement.offset.x, settings.placement.offset.x)
  assert.equal('pagePlacements' in spec, false, 'v1 无 pagePlacements 键')
})

test('V2-8: buildBakeSpec v2（pagePlacements）→ spec.pagePlacements[] + spec.placement 同源（page0）', () => {
  const pp = [
    { pageIndex: 0, placement: mkPlacement({ scale: 0.5 }) },
    { pageIndex: 3, placement: mkPlacement({ scale: 0.7 }) },
  ]
  const settings = mkSettings({ pagePlacements: pp })
  const spec = placementBake.buildBakeSpec(PDF_PATH, settings, 'C:/tmp/out.pdf')
  assert.ok(Array.isArray(spec.pagePlacements), 'spec.pagePlacements 应为数组')
  assert.equal(spec.pagePlacements.length, 2)
  assert.equal(spec.pagePlacements[0].pageIndex, 0)
  assert.equal(spec.pagePlacements[1].pageIndex, 3, 'pageIndex 显式携带（D3，不依赖数组位置）')
  assert.equal(spec.pagePlacements[1].placement.scale, 0.7)
  // 兼容：spec.placement == pagePlacements[0].placement（representative）
  assert.equal(spec.placement.scale, pp[0].placement.scale)
  assert.equal(spec.placement.offset.x, pp[0].placement.offset.x)
})

test('V2-9: G1 —— v1 单 placement 与 v2 单元素数组 → spec.placement 逐字段一致（单页零变化）', () => {
  const placement = mkPlacement({ scale: 0.42, contentRotation: 90, layoutRotation: -90 })
  const specV1 = placementBake.buildBakeSpec(PDF_PATH, mkSettings({ placement }), 'C:/tmp/o1.pdf')
  const specV2 = placementBake.buildBakeSpec(
    PDF_PATH, mkSettings({ placement, pagePlacements: [{ pageIndex: 0, placement }] }), 'C:/tmp/o2.pdf')
  assert.deepEqual(specV2.placement, specV1.placement, 'spec.placement 必须逐字段一致（G1）')
})
