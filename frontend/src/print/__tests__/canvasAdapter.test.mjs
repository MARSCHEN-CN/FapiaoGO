/**
 * canvasAdapter.test.mjs — R2.2 旁路 Canvas 投影器回归（几何对照 + 可执行停止条件）
 *
 * 验证目标（R2.2 第一刀，完全旁路）：
 *   ✅ 同一 CanonicalPlacement → Canvas 操作序列 → 投影 bbox == Golden placedRect（逐字段，容差 2px）
 *   ✅ 操作序列形状 = [translate, scale, translate, rotate, translate, drawImage]
 *   ✅ 可执行停止条件：Stage1（单 Virtual Paper）任一差异 → exit(1)，绝不进入 Stage2/3
 *   ✅ Stage2：多 Virtual Paper（computeSlots 2/3/4）每 slot 独立投影 + slot 偏移落在各自 contentRect
 *   ✅ 静态契约：adapter 只读 renderTransform，黑名单零命中（无 fit/margin/rotation 判断/slot/scale/placement 重算）
 *   ❌ 不碰 PrintPreviewCanvas / renderMultipleItemsToCanvas / Preview / Print / Raster
 *
 * 运行：node frontend/src/print/__tests__/canvasAdapter.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildCanonicalPlacement } from '../canonicalPlacement.js'
import { buildCanvasDrawOps, applyDrawOps, CANVAS_ADAPTER_VERSION } from '../canvasAdapter.js'
import { computeSlots } from '../../layout/SlotLayout.js'

const DPI = 300
const A4 = { widthMM: 210, heightMM: 297 }
const A4_L = { widthMM: 297, heightMM: 210 }
const CUSTOM = { widthMM: 100, heightMM: 150 }
const CUSTOM_L = { widthMM: 150, heightMM: 100 }
const CONTENT = { width: 1400, height: 1980 } // 发票内容 px@300，旋转前
const TOL = 2 // 像素容差（rounding，与 R2.1 一致）

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

// ── 测试侧 2D 仿射矩阵（仅用于验证投影；adapter 本身零计算）──
function matMul(a, b) {
  // a 与 b 均为 3x3 行主序 [ [a,b,c],[d,e,f],[0,0,1] ]，返回 a·b
  return [
    [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1], a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
    [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1], a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]],
    [0, 0, 1],
  ]
}
function T(dx, dy) { return [[1, 0, dx], [0, 1, dy], [0, 0, 1]] }
function S(k) { return [[k, 0, 0], [0, k, 0], [0, 0, 1]] }
function R(deg) {
  const rad = (deg * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]]
}

// ops → 合成矩阵（与 canvas 调用顺序一致：按序后乘）
function opsToMatrix(ops) {
  let m = T(0, 0)
  for (const op of ops) {
    if (op.type === 'translate') m = matMul(m, T(op.x, op.y))
    else if (op.type === 'scale') m = matMul(m, S(op.s))
    else if (op.type === 'rotate') m = matMul(m, R(op.rotationDeg))
    else if (op.type === 'drawImage') { /* 无几何作用 */ }
    else throw new Error(`未知 op: ${op.type}`)
  }
  return m
}

// 把源矩形（自然尺寸）经矩阵映射后的包围盒
function mapRectBBox(m, w, h) {
  const corners = [[0, 0], [w, 0], [0, h], [w, h]]
  const pts = corners.map(([x, y]) => [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]])
  const xs = pts.map(p => p[0])
  const ys = pts.map(p => p[1])
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

function near(a, b, tol) {
  return Math.abs(a - b) <= tol
}

let failed = 0
const fail = (m) => { failed++; console.error('  ✗ ' + m) }
const ok = (m) => console.log('  ✓ ' + m)

// 断言单条用例的投影等价（bbox ≈ placedRect，容差 TOL）
function assertProjection(canon, label) {
  const ops = buildCanvasDrawOps(canon)
  const rt = canon.renderTransform
  const m = opsToMatrix(ops)
  const bbox = mapRectBBox(m, rt.imageWidth, rt.imageHeight)
  const pr = canon.placedRect
  const d = {
    x: Math.abs(bbox.x - pr.x),
    y: Math.abs(bbox.y - pr.y),
    w: Math.abs(bbox.w - pr.w),
    h: Math.abs(bbox.h - pr.h),
  }
  if (!(near(bbox.x, pr.x, TOL) && near(bbox.y, pr.y, TOL) && near(bbox.w, pr.w, TOL) && near(bbox.h, pr.h, TOL))) {
    fail(`${label}: 投影 bbox ${JSON.stringify(bbox)} ≠ placedRect ${JSON.stringify(pr)} (Δ=${JSON.stringify(d)}, tol=${TOL})`)
    return false
  }
  ok(`${label}: bbox≈placedRect (Δ=${Math.max(d.x, d.y, d.w, d.h).toFixed(2)}px)`)
  return true
}

// ───────────── Stage 1：单 Virtual Paper 矩阵（任何失败 → 立即 exit(1)）─────────────
console.log('\n[Stage1] 单 Virtual Paper：CanonicalPlacement → Canvas 投影 == Golden placedRect')
const STAGE1 = [
  { name: 'Normal A4 竖 rot0 margin3', req: mk({}) },
  { name: 'Normal A4 竖 rot90', req: mk({ contentRotation: 90 }) },
  { name: 'Normal A4 竖 rot180', req: mk({ contentRotation: 180 }) },
  { name: 'Normal A4 竖 rot270', req: mk({ contentRotation: 270 }) },
  { name: 'A4 横 rot0（竖内容 vs 横纸 → layout-90）', req: mk({ physicalPaper: A4_L }) },
  { name: 'A4 横 rot90（横内容 vs 横纸 → layout0）', req: mk({ physicalPaper: A4_L, contentRotation: 90 }) },
  { name: 'margin 0', req: mk({ margins: { left: 0, right: 0, top: 0, bottom: 0 } }) },
  { name: 'custom 100x150 rot0', req: mk({ physicalPaper: CUSTOM }) },
  { name: 'custom 横 150x100 rot90', req: mk({ physicalPaper: CUSTOM_L, contentRotation: 90 }) },
  { name: '无 source', req: mk({ source: undefined }) },
]

let stage1Fail = 0
for (const c of STAGE1) {
  const canon = buildCanonicalPlacement(c.req)
  // 1a. 操作序列形状（只读 renderTransform，6 步固定顺序）
  const ops = buildCanvasDrawOps(canon)
  const types = ops.map(o => o.type)
  const want = ['translate', 'scale', 'translate', 'rotate', 'translate', 'drawImage']
  if (JSON.stringify(types) !== JSON.stringify(want)) {
    fail(`${c.name}: 操作序列形状 ${JSON.stringify(types)} ≠ ${JSON.stringify(want)}`)
    stage1Fail++
    continue
  }
  const draw = ops[5]
  if (draw.width !== canon.renderTransform.imageWidth || draw.height !== canon.renderTransform.imageHeight) {
    fail(`${c.name}: drawImage 未使用 renderTransform.imageWidth/Height 自然尺寸`)
    stage1Fail++
    continue
  }
  ok(`${c.name}: 操作序列形状正确（6 步，drawImage=自然尺寸）`)
  // 1b. 投影等价
  if (!assertProjection(canon, c.name)) stage1Fail++
}

if (stage1Fail > 0) {
  console.error(`\n⛔ 停止条件触发：Stage1 出现 ${stage1Fail} 项差异 → 不进入 2VP/3VP/4VP，不接 Print。`)
  console.error('   问题仍在 CanonicalPlacement → Canvas projection 这一层，回 R2.1 查契约。')
  process.exit(1)
}
console.log('✅ Stage1 全 PASS（单 Virtual Paper 投影无损）→ 才有资格扩展多 VP。')

// ───────────── Stage 2：多 Virtual Paper（computeSlots 2/3/4）─────────────
console.log('\n[Stage2] 多 Virtual Paper：computeSlots 切分 + 每 slot 独立投影 + 偏移落在各自 contentRect')
const pxPerMm = DPI / 25.4
const A4_USABLE = { x: 35, y: 35, w: 2410, h: 3438 } // A4 @300 扣 3mm 外纸边距
const SLOT_MARGIN = 3 // mm

function paperLayoutFor() {
  return { usableRect: A4_USABLE, slotMarginPx: SLOT_MARGIN * pxPerMm }
}
function slotPaperMM(slot) {
  return { widthMM: (slot.paperRect.width / pxPerMm), heightMM: (slot.paperRect.height / pxPerMm) }
}

const MERGE_PLANS = [
  { name: 'Merge2 vertical', opts: { count: 2, strategy: 'vertical' }, rotations: [0, 90] },
  { name: 'Merge3 vertical', opts: { count: 3, strategy: 'vertical' }, rotations: [0, 90, 180] },
  { name: 'Merge4 grid 2x2', opts: { count: 4, strategy: 'grid', gridCols: 2, gridRows: 2 }, rotations: [0, 90, 180, 270] },
]

let stage2Fail = 0
for (const plan of MERGE_PLANS) {
  const slots = computeSlots(paperLayoutFor(), plan.opts)
  assert.ok(slots.length === plan.opts.count, `${plan.name} 应产生 ${plan.opts.count} 个 slot`)
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const req = mk({
      physicalPaper: slotPaperMM(slot),
      margins: { left: SLOT_MARGIN, right: SLOT_MARGIN, top: SLOT_MARGIN, bottom: SLOT_MARGIN },
      contentRotation: plan.rotations[i % plan.rotations.length],
      source: { docId: 'merge', slot: i },
    })
    const canon = buildCanonicalPlacement(req)
    // 2a. slot-local 投影 bbox ≈ placedRect
    const ops = buildCanvasDrawOps(canon)
    const m = opsToMatrix(ops)
    const bbox = mapRectBBox(m, canon.renderTransform.imageWidth, canon.renderTransform.imageHeight)
    const pr = canon.placedRect
    if (!(near(bbox.x, pr.x, TOL) && near(bbox.y, pr.y, TOL) && near(bbox.w, pr.w, TOL) && near(bbox.h, pr.h, TOL))) {
      fail(`${plan.name} slot${i}: 投影 bbox ≠ placedRect`)
      stage2Fail++
      continue
    }
    // 2b. 加 slot 偏移（slot-local → paper-absolute，原点 = slot.paperRect 左上角）后，
    //     bbox 落在该 slot 的 contentRect 内（Virtual Paper 独立排版不越界）
    const absX = slot.paperRect.x + bbox.x
    const absY = slot.paperRect.y + bbox.y
    const absW = bbox.w
    const absH = bbox.h
    const cr = slot.contentRect
    const inside = absX >= cr.x - TOL && absY >= cr.y - TOL && (absX + absW) <= (cr.x + cr.width) + TOL && (absY + absH) <= (cr.y + cr.height) + TOL
    if (!inside) {
      fail(`${plan.name} slot${i}: 偏移后 bbox (${absX},${absY},${absW},${absH}) 越出 slot contentRect ${JSON.stringify(cr)}`)
      stage2Fail++
      continue
    }
    ok(`${plan.name} slot${i} (rot${req.contentRotation}): 独立投影正确 + 落在本 slot contentRect 内`)
  }
}

if (stage2Fail > 0) {
  console.error(`\n⛔ 停止条件触发：Stage2 出现 ${stage2Fail} 项差异 → 不接 Print / Artifact。`)
  process.exit(1)
}
console.log('✅ Stage2 全 PASS（多 Virtual Paper 独立排版 + 合成不越界）。')

// ───────────── Stage 3：静态契约（adapter 黑名单零命中）─────────────
console.log('\n[Stage3] 静态契约 — canvasAdapter 只读 renderTransform，黑名单零命中')
{
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../canvasAdapter.js')
  const raw = readFileSync(path, 'utf8')
  // 剥离注释后再审计：黑名单只针对真实代码，文档性说明（如"不读取 placedRect/margins"）不得误伤
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/\/\/[^\n]*/g, '')          // 行注释

  // 必须存在：只消费 renderTransform
  if (!/renderTransform/.test(src)) fail('canvasAdapter.js 未引用 renderTransform（唯一投影输入）')
  else ok('canvasAdapter.js 引用 renderTransform')
  if (!/export function buildCanvasDrawOps/.test(src)) fail('未导出 buildCanvasDrawOps')
  else ok('导出 buildCanvasDrawOps')
  if (!/export function applyDrawOps/.test(src)) fail('未导出 applyDrawOps')
  else ok('导出 applyDrawOps')
  if (CANVAS_ADAPTER_VERSION !== 1) fail(`CANVAS_ADAPTER_VERSION 应为 1，got ${CANVAS_ADAPTER_VERSION}`)
  else ok('CANVAS_ADAPTER_VERSION = 1')

  // 黑名单：不得出现任何几何决策/重算
  const banned = [
    ['placedRect（不读决策结果）', /placedRect/],
    ['contentRect（不读安全区）', /contentRect/],
    ['availableRect（不读可用区）', /availableRect/],
    ['Math.min（fit-scale 重算）', /Math\.min/],
    ['computeSlots（slot 划分）', /computeSlots/],
    ['computeLayoutRotation（rotation 判断）', /computeLayoutRotation/],
    ['detectContentOrientation（orientation 判断）', /detectContentOrientation/],
    ['pxPerMm / dpi（margin 计算）', /pxPerMm|dpi/],
    ['margins（margin 消费）', /margins/],
    ['scale 重算（除法派生）', /availableW\s*\/\s*placedContentW|placedContentW/],
  ]
  for (const [label, re] of banned) {
    if (re.test(src)) fail(`黑名单命中: ${label}`)
    else ok(`黑名单干净: ${label}`)
  }
}

console.log('')
if (failed > 0) {
  console.error(`\n❌ canvasAdapter 测试失败：${failed} 项。`)
  process.exit(1)
} else {
  console.log('✅ canvasAdapter 测试通过：Canvas 能 100% 消费 CanonicalPlacement（renderTransform）并无损投影为 Golden 几何（R2.2 Stage1+2，完全旁路，零波及）。')
  process.exit(0)
}
