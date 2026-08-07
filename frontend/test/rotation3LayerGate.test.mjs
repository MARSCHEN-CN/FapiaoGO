/**
 * rotation3LayerGate.test.mjs — 三层旋转模型回归 Gate（审计工件，2026-08-07）
 *
 * 背景：Step 2（commit 16568c4）统一模型 = layoutRotation = computeLayoutRotation(effectiveContentOrientation, paperOrientation)
 *   只用了【有效内容方向】+【用户纸方向】两个输入，完全忽略了【纸张物理形状 paperShapeOrientation】。
 *   UI 验证后证明：横向纸张类型下，纸张匹配还取决于 PSO 与用户方向共同决定的物理坐标旋转。
 *   例（UI 已证明）：
 *     横票 + 横纸型 + 纵向 → +90
 *     横票 + 横纸型 + 横向 → -90
 *   而 Step 2 当前对横纸型算出的仍是 computeLayoutRotation(ECO, PO)（与竖纸型同值），故这两个 case 偏差。
 *
 * 本 Gate 编码「三层模型」目标矩阵（contentOrientation × paperShape × userOrientation = 8），
 * 并对优先级 case 叠加 contentRotation(0/90/180/270) 校验「最终视觉 = contentRotation + layoutRotation（无双旋转）」。
 *
 * ⚠️ 状态：本文件为【目标规格 + 审计】。当前 Step 2 代码跑此 Gate 时，横纸型 4 格会 FAIL（差距审计）。
 *   竖纸型 4 格（Step 2 已确认正确）PASS。
 *   ── 标记 ──
 *     [UI-PROVEN] 用户 UI 验证确认
 *     [STEP2-KEEP] Step 2 已确认、本轮不变
 *     [DERIVED]   由横票行对称推导，待 UI 验证（Step 3 修码前需用户确认）
 *
 * 运行：node --test test/rotation3LayerGate.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveContentPlacement, computeLayoutRotation } from '../src/layout/RotationResolver.js'

// ── 测试数据 ──
const LAND_CONTENT = { width: 1400, height: 1000 } // 横票（原始 landscape，cr=0 → ECO=landscape）
const PORT_CONTENT = { width: 1000, height: 1400 } // 竖票（原始 portrait，cr=0 → ECO=portrait）
const A4_PORTRAIT = { widthMM: 210, heightMM: 297 } // 竖纸型（portrait shape）
const LAND_PAPER = { widthMM: 297, heightMM: 210 } // 横纸型（landscape shape）

const norm = (d) => ((d % 360) + 360) % 360

/**
 * 三层模型「目标」layoutRotation 纯函数（审计预期值）。
 *   - 竖纸型(PSO=portrait): Step2 已确认 = computeLayoutRotation(ECO, PO)（match→0, mismatch→-90）
 *   - 横纸型(PSO=landscape): UI 证明(横票行) + 对称推导(竖票行)
 *       统一式: -computeLayoutRotation(ECO, PO) - 90*(ECO===PO ? 1 : 0)
 */
function intendedLayout(effectiveContentOrientation, paperShapeOrientation, paperOrientation) {
  if (paperShapeOrientation === 'portrait') {
    return computeLayoutRotation(effectiveContentOrientation, paperOrientation)
  }
  // 横纸型 — 见文件头 [UI-PROVEN] / [DERIVED] 标注
  return -computeLayoutRotation(effectiveContentOrientation, paperOrientation)
    - (effectiveContentOrientation === paperOrientation ? 90 : 0)
}

/** 调 resolver 取 layoutRotation（不改源码，仅读取） */
function layoutOf(contentPhysicalSize, contentRotation, paperSize, paperOrientation) {
  const r = resolveContentPlacement({
    contentPhysicalSize,
    contentRotation,
    paperSize,
    paperOrientation,
    dpi: 300,
  })
  return r.layoutRotation
}

// ════════════════════════════════════════════════════════════════
// 8 宫格矩阵（contentRotation = 0，仅验证纸张匹配层）
// ════════════════════════════════════════════════════════════════

test('M1 [STEP2-KEEP] 横票 + 竖纸型(A4) + 纵向 → layout=-90', () => {
  const got = layoutOf(LAND_CONTENT, 0, A4_PORTRAIT, 'portrait')
  const want = intendedLayout('landscape', 'portrait', 'portrait')
  assert.equal(got, want)
  assert.equal(want, -90)
})

test('M2 [STEP2-KEEP] 横票 + 竖纸型(A4) + 横向 → layout=0', () => {
  const got = layoutOf(LAND_CONTENT, 0, A4_PORTRAIT, 'landscape')
  const want = intendedLayout('landscape', 'portrait', 'landscape')
  assert.equal(got, want)
  assert.equal(want, 0)
})

test('M3 [STEP2-KEEP] 竖票 + 竖纸型(A4) + 纵向 → layout=0', () => {
  const got = layoutOf(PORT_CONTENT, 0, A4_PORTRAIT, 'portrait')
  const want = intendedLayout('portrait', 'portrait', 'portrait')
  assert.equal(got, want)
  assert.equal(want, 0)
})

test('M4 [STEP2-KEEP] 竖票 + 竖纸型(A4) + 横向 → layout=-90', () => {
  const got = layoutOf(PORT_CONTENT, 0, A4_PORTRAIT, 'landscape')
  const want = intendedLayout('portrait', 'portrait', 'landscape')
  assert.equal(got, want)
  assert.equal(want, -90)
})

test('M5 [UI-PROVEN] 横票 + 横纸型 + 纵向 → layout=+90', () => {
  const got = layoutOf(LAND_CONTENT, 0, LAND_PAPER, 'portrait')
  const want = intendedLayout('landscape', 'landscape', 'portrait')
  assert.equal(got, want)
  assert.equal(want, 90)
})

test('M6 [UI-PROVEN] 横票 + 横纸型 + 横向 → layout=-90', () => {
  const got = layoutOf(LAND_CONTENT, 0, LAND_PAPER, 'landscape')
  const want = intendedLayout('landscape', 'landscape', 'landscape')
  assert.equal(got, want)
  assert.equal(want, -90)
})

test('M7 [DERIVED] 竖票 + 横纸型 + 纵向 → layout=-90（待 UI 确认）', () => {
  const got = layoutOf(PORT_CONTENT, 0, LAND_PAPER, 'portrait')
  const want = intendedLayout('portrait', 'landscape', 'portrait')
  assert.equal(got, want)
  assert.equal(want, -90)
})

test('M8 [DERIVED] 竖票 + 横纸型 + 横向 → layout=+90（待 UI 确认）', () => {
  const got = layoutOf(PORT_CONTENT, 0, LAND_PAPER, 'landscape')
  const want = intendedLayout('portrait', 'landscape', 'landscape')
  assert.equal(got, want)
  assert.equal(want, 90)
})

// ════════════════════════════════════════════════════════════════
// 组合校验：最终视觉 = contentRotation + layoutRotation（无双旋转）
// 优先级 case：横票 + 横纸型 + 纵向（UI-PROVEN +90）
// ════════════════════════════════════════════════════════════════

test('C1 [UI-PROVEN] 横票+横纸型+纵向 cr=0 → final=+90（content 单次 + layout）', () => {
  const r = resolveContentPlacement({ contentPhysicalSize: LAND_CONTENT, contentRotation: 0, paperSize: LAND_PAPER, paperOrientation: 'portrait', dpi: 300 })
  assert.equal(r.contentOrientation, 'landscape') // ECO 正确物化
  assert.equal(r.layoutRotation, 90)              // 横纸型+纵向 → +90
  assert.equal(norm(r.contentRotation + r.layoutRotation), 90) // 最终视觉
})

test('C2 [UI-PROVEN] 横票+横纸型+纵向 cr=90 → final=0（用户转90已并入 ECO，layout 自适应，无双旋转）', () => {
  const r = resolveContentPlacement({ contentPhysicalSize: LAND_CONTENT, contentRotation: 90, paperSize: LAND_PAPER, paperOrientation: 'portrait', dpi: 300 })
  assert.equal(r.contentOrientation, 'portrait')  // 横票+cr90 → ECO=portrait
  assert.equal(r.layoutRotation, -90)             // portrait+横纸型+纵向 → 适配 -90（见 M7 DERIVED）
  assert.equal(norm(r.contentRotation + r.layoutRotation), norm(90 + (-90))) // = 0
})

test('C3 [INVARIANT] 防双旋转：cr=90 与 cr=270 同得 ECO=portrait → layoutRotation 必须相同', () => {
  const a = layoutOf(LAND_CONTENT, 90, LAND_PAPER, 'portrait')
  const b = layoutOf(LAND_CONTENT, 270, LAND_PAPER, 'portrait')
  assert.equal(a, b, 'cr=90/270 都使 ECO=portrait，layout 仅取决于 ECO，不二次施加 contentRotation')
})

test('C4 [INVARIANT] 防双旋转：cr=0 与 cr=180 同得 ECO=landscape → layoutRotation 必须相同', () => {
  const a = layoutOf(LAND_CONTENT, 0, LAND_PAPER, 'portrait')
  const b = layoutOf(LAND_CONTENT, 180, LAND_PAPER, 'portrait')
  assert.equal(a, b, 'cr=0/180 都使 ECO=landscape，layout 仅取决于 ECO')
})
