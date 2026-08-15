/**
 * canonicalPlacement.test.mjs — R2.1 纯数据结构提炼回归
 *
 * 验证目标（R2.1 验收门槛）：
 *   ✅ CanonicalPlacement 与 Golden Geometry 逐字段相等（无损重打包）
 *   ✅ 几何正确性不变量（独立于重打包，定义「正确」）
 *   ✅ 静态契约：buildCanonicalPlacement 委托 resolveContentPlacement，不重算几何
 *   ❌ RotationResolver 行为 / Preview / Print / Raster / Canvas 均不改动（本测试只新增，不触碰）
 *
 * 运行：node frontend/src/print/__tests__/canonicalPlacement.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildCanonicalPlacement, CANONICAL_PLACEMENT_VERSION } from '../canonicalPlacement.js'
import { resolveContentPlacement } from '../../layout/RotationResolver.js'

const DPI = 300
const A4 = { widthMM: 210, heightMM: 297 }
const A4_L = { widthMM: 297, heightMM: 210 }
const CUSTOM = { widthMM: 100, heightMM: 150 }
const CUSTOM_L = { widthMM: 150, heightMM: 100 }
// 通用发票内容尺寸（px@300，旋转前）
const CONTENT = { width: 1400, height: 1980 }

function mk(over) {
  return {
    contentPhysicalSize: CONTENT,
    contentRotation: 0,
    physicalPaper: A4,
    margins: { left: 3, right: 3, top: 3, bottom: 3 },
    dpi: DPI,
    source: { docId: 'doc-1', page: 1 },
    ...over,
  }
}

// 镜像 N6 回归矩阵：2/3/4 票 slot、横/竖纸、rot0/90/180/270、margin 0/3mm、custom、无 source
const CASES = [
  { name: 'Normal A4 竖 rot0 margin3', req: mk({}) },
  { name: 'Normal A4 竖 rot90', req: mk({ contentRotation: 90 }) },
  { name: 'Normal A4 竖 rot180', req: mk({ contentRotation: 180 }) },
  { name: 'Normal A4 竖 rot270', req: mk({ contentRotation: 270 }) },
  { name: 'Merge2 slot (210x148.5) rot0', req: mk({ physicalPaper: { widthMM: 210, heightMM: 148.5 } }) },
  { name: 'Merge3 slot (210x99) rot0', req: mk({ physicalPaper: { widthMM: 210, heightMM: 99 } }) },
  { name: 'Merge4 slot (105x148.5) rot0', req: mk({ physicalPaper: { widthMM: 105, heightMM: 148.5 } }) },
  { name: 'A4 横 slot rot90 (内容横 vs 纸横 → layout0)', req: mk({ physicalPaper: A4_L, contentRotation: 90 }) },
  { name: 'A4 横 slot rot0 (内容竖 vs 纸横 → layout-90)', req: mk({ physicalPaper: A4_L }) },
  { name: 'margin 0', req: mk({ margins: { left: 0, right: 0, top: 0, bottom: 0 } }) },
  { name: 'custom paper 100x150 rot0', req: mk({ physicalPaper: CUSTOM }) },
  { name: 'custom paper 横 150x100 rot90', req: mk({ physicalPaper: CUSTOM_L, contentRotation: 90 }) },
  { name: '无 source（几何与源解耦）', req: mk({ source: undefined }) },
]

// 用相同入参调用 Golden 真值源（不含 slot 偏移，纯单票 placement）
function goldenOf(req) {
  return resolveContentPlacement({
    contentPhysicalSize: req.contentPhysicalSize,
    contentRotation: req.contentRotation,
    physicalPaper: req.physicalPaper,
    margins: req.margins,
    dpi: req.dpi,
  })
}

let failed = 0
const fail = (m) => { failed++; console.error('  ✗ ' + m) }
const ok = (m) => console.log('  ✓ ' + m)

// ───────────── [1] CanonicalPlacement == Golden 几何（无损重打包）─────────────
console.log('\n[1] CanonicalPlacement 与 Golden 几何逐字段相等（无损重打包）')
for (const c of CASES) {
  const canon = buildCanonicalPlacement(c.req)
  const g = goldenOf(c.req)
  try {
    assert.deepEqual(canon.placedRect, g.placedRect, 'placedRect')
    assert.equal(canon.scale, g.scale, 'scale')
    assert.deepEqual(canon.translation, { x: g.offset.x, y: g.offset.y }, 'translation')
    assert.deepEqual(canon.contentRect, g.availableRect, 'contentRect')
    assert.deepEqual(canon.virtualPaper.contentRectPx, g.availableRect, 'virtualPaper.contentRectPx')
    assert.deepEqual(canon.virtualPaper.paperRectPx, g.canvasSize, 'virtualPaper.paperRectPx')
    assert.deepEqual(
      canon.rotation,
      { content: g.contentRotation, layout: g.layoutRotation, render: g.renderRotation },
      'rotation 两阶段分解',
    )
    assert.deepEqual(canon.pivot, { x: g.renderTransform.rotationCx, y: g.renderTransform.rotationCy }, 'pivot')
    // R2.2：投影矩阵原样携带（Canvas Adapter 零计算投影的唯一输入）
    assert.deepEqual(canon.renderTransform, g.renderTransform, 'renderTransform 原样携带（R2.2）')
    assert.equal(canon.source, c.req.source ?? null, 'source 透传')
    assert.equal(canon.virtualPaper.orientation, g.physicalPaperOrientation, 'orientation')
    ok(c.name)
  } catch (e) {
    fail(`${c.name}: ${e.message}`)
  }
}

// ───────────── [2] 几何正确性不变量（定义「正确」的独立校验）─────────────
console.log('\n[2] 几何正确性不变量（与重打包无关，定义正确 placement）')
for (const c of CASES) {
  const canon = buildCanonicalPlacement(c.req)
  const g = goldenOf(c.req)
  try {
    assert.ok(canon.scale > 0 && Number.isFinite(canon.scale), 'scale 正且有限')
    assert.ok(canon.rotation.layout === 0 || canon.rotation.layout === -90, 'layoutRotation ∈ {0,-90}')

    // placedRect 居中于 contentRect（rounding 容差 2px）
    const cRect = canon.contentRect
    const cx = cRect.x + cRect.w / 2
    const cy = cRect.y + cRect.h / 2
    const px = canon.placedRect.x + canon.placedRect.w / 2
    const py = canon.placedRect.y + canon.placedRect.h / 2
    assert.ok(Math.abs(cx - px) <= 2 && Math.abs(cy - py) <= 2, `placedRect 在 contentRect 内居中 (Δ=${Math.abs(cx - px)},${Math.abs(cy - py)})`)

    // placedRect 尺寸 = effectiveContent * scale（fitRotated 时宽高交换）
    const e = g.effectiveContentSize
    const fw = canon.rotation.layout === -90 ? e.height : e.width
    const fh = canon.rotation.layout === -90 ? e.width : e.height
    assert.ok(Math.abs(canon.placedRect.w - Math.round(fw * canon.scale)) <= 1, 'placedRect.w = effectiveContentW * scale')
    assert.ok(Math.abs(canon.placedRect.h - Math.round(fh * canon.scale)) <= 1, 'placedRect.h = effectiveContentH * scale')

    // contentRect 在 paper 内（含 margin，容差 0.5px 防 round 边界）
    assert.ok(cRect.x >= -0.5 && cRect.y >= -0.5, 'contentRect 原点不越界')
    assert.ok(cRect.x + cRect.w <= canon.virtualPaper.paperRectPx.width + 0.5, 'contentRect 不超出纸宽')
    assert.ok(cRect.y + cRect.h <= canon.virtualPaper.paperRectPx.height + 0.5, 'contentRect 不超出纸高')

    // content rotation 元数据原样保留
    assert.equal(canon.rotation.content, c.req.contentRotation ?? 0, 'content rotation 元数据保留')

    ok(c.name)
  } catch (e) {
    fail(`${c.name}: ${e.message}`)
  }
}

// ───────────── [3] 静态契约：委托 Golden，不重算几何 ─────────────
console.log('\n[3] 静态契约 — buildCanonicalPlacement 委托 resolveContentPlacement，不重算几何')
{
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../canonicalPlacement.js')
  const src = readFileSync(path, 'utf8')

  if (!/import\s*\{?[^}]*resolveContentPlacement/.test(src)) fail('canonicalPlacement.js 未 import resolveContentPlacement')
  else ok('canonicalPlacement.js import resolveContentPlacement')

  // 不得内联重算 Golden 的 fit-scale 公式（签名：availableW / placedContentW 或 Math.min(availableW ...）
  if (/availableW\s*\/\s*placedContentW/.test(src)) fail('canonicalPlacement.js 内联重算了 placedContentW 除法')
  else ok('canonicalPlacement.js 无 placedContentW 内联除法')

  if (/Math\.min\(\s*availableW/.test(src)) fail('canonicalPlacement.js 内联重算了 fit-scale Math.min（违反「不重算几何」）')
  else ok('canonicalPlacement.js 无 fit-scale Math.min 重算')

  if (CANONICAL_PLACEMENT_VERSION !== 1) fail(`CANONICAL_PLACEMENT_VERSION 应为 1，got ${CANONICAL_PLACEMENT_VERSION}`)
  else ok('CANONICAL_PLACEMENT_VERSION = 1')
}

console.log('')
if (failed > 0) {
  console.error(`\n❌ canonicalPlacement 测试失败：${failed} 项。`)
  process.exit(1)
} else {
  console.log('✅ canonicalPlacement 测试通过：CanonicalPlacement 无损复现 Golden 几何（R2.1 提炼完成，零行为变更）。')
  process.exit(0)
}
