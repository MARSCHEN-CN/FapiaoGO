/**
 * rotationPaperTransformGate.test.mjs — 三层模型「纸张坐标转换」回归 Gate（审计工件，2026-08-07 第二轮）
 *
 * 背景：Step 2（commit 16568c4）layoutRotation = computeLayoutRotation(effectiveContentOrientation, paperOrientation)
 *   只用了【有效内容方向】+【用户纸方向】两个输入，漏掉【纸张物理形状 paperShapeOrientation】这一关键维度。
 *
 *   UI 实测（2026-08-07 第二轮）推翻了上一轮对「横票 + 横纸型」的假设：
 *     旧假设（已证伪）：横票+横纸型 纵向→+90 / 横向→-90（二维镜像表）
 *     新实测（已确认）：横票+横纸型 纵向→-90 / 横向→-90（横纸型存在固定基准旋转，与纸张方向无关）
 *
 *   这证明真正规则不是 contentOrientation → paperOrientation 的简单匹配，而是：
 *     contentOrientation × paperShapeOrientation × paperOrientation 三者共同决定。
 *
 * 新函数 resolvePaperTransform({ contentOrientation, paperShapeOrientation, paperOrientation })：
 *   把【发票坐标系】转换到【纸张物理坐标系】。
 *   ⚠️ 本文件为【目标规格 + 审计】，该函数仅为审计预期值，尚未落地到 RotationResolver.js（暂不改码）。
 *
 * 已确认矩阵（本 Gate 硬锁）：
 *                 竖纸型           横纸型
 *   横票
 *     纵向        -90              -90
 *     横向         0               -90
 *   竖票
 *     纵向         0                ?  (PENDING-UI)
 *     横向        -90              ?  (PENDING-UI)
 *
 * ⚠️ 本 Gate 运行当前 Step 2 代码，暴露差距：
 *   - 竖纸型 4 格：当前代码已正确（PASS）
 *   - 横票+横纸型+纵向：当前代码巧合给 -90（PASS，但靠的是「方向不匹配」而非正确的 PSO 基准）
 *   - 横票+横纸型+横向：当前代码给 0（FAIL，真实差距，待 Step 3 补回 PSO 层）
 *   - 竖票+横纸型 2 格：TODO（待 UI 验证）
 *
 * 运行：node --test test/rotationPaperTransformGate.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveContentPlacement } from '../src/layout/RotationResolver.js'

// ── 测试数据 ──
const LAND_CONTENT = { width: 1400, height: 1000 } // 横票（原始 landscape，cr=0 → ECO=landscape）
const PORT_CONTENT = { width: 1000, height: 1400 } // 竖票（原始 portrait，cr=0 → ECO=portrait）
const A4_PORTRAIT = { widthMM: 210, heightMM: 297 } // 竖纸型（portrait shape）
const LAND_PAPER = { widthMM: 297, heightMM: 210 } // 横纸型（landscape shape）

const norm = (d) => ((d % 360) + 360) % 360

/**
 * 目标函数 resolvePaperTransform（审计预期值，暂未落地到 RotationResolver）。
 * 把【发票坐标系】转换到【纸张物理坐标系】，三个变量共同决定：
 *   - contentOrientation:      用户旋转后的有效内容方向（横/竖）
 *   - paperShapeOrientation:   纸张物理形状（A4→portrait，297×210→landscape）
 *   - paperOrientation:        用户选择的纸张方向（横/竖）
 *
 * 规则（仅编码 UI 已确认部分）：
 *   - 竖纸型(PSO=portrait)：方向匹配模型（Step 2 已确认正确，无双旋转）
 *       match → 0；mismatch → -90
 *   - 横纸型(PSO=landscape)：
 *       横票(contentOrientation===PSO) → 固定基准旋转 -90，与纸张方向无关（UI 实测 2026-08-07）
 *       竖票(contentOrientation!==PSO) → 未验证，调用方不应到达（本 Gate 以 test.todo 覆盖）
 */
function resolvePaperTransform({ contentOrientation, paperShapeOrientation, paperOrientation }) {
  if (paperShapeOrientation === 'portrait') {
    return contentOrientation === paperOrientation ? 0 : -90
  }
  // 横纸型（landscape shape）
  if (contentOrientation === paperShapeOrientation) {
    // 横票 + 横纸型：固定基准旋转 -90，与纸张方向无关
    return -90
  }
  // 竖票 + 横纸型：未验证，不应被调用
  throw new Error('PENDING-UI: 竖票+横纸型 符号待 UI 验证')
}

/** 调当前 resolver 取 layoutRotation（不改源码，仅读取）
 *  Commit 3：Resolver 只收 physicalPaper，方向自几何派生。
 *  第 4 参 _paperOrientation 保留仅为不改调用方位置实参——它在 Commit 1-A 改名后
 *  就已被 Resolver 静默忽略（本 Gate 实际一直是纯几何驱动），故此处行为零变化。 */
function layoutOf(contentPhysicalSize, contentRotation, physicalPaper, _paperOrientation) {
  const r = resolveContentPlacement({
    contentPhysicalSize,
    contentRotation,
    physicalPaper,
    dpi: 300,
  })
  return r.layoutRotation
}

// ════════════════════════════════════════════════════════════════
// 8 宫格矩阵（contentRotation = 0，仅验证纸张坐标转换层）
// ════════════════════════════════════════════════════════════════

test('M1 [STEP2-KEEP] 横票 + 竖纸型(A4) + 纵向 → layout=-90', () => {
  const got = layoutOf(LAND_CONTENT, 0, A4_PORTRAIT, 'portrait')
  const want = resolvePaperTransform({ contentOrientation: 'landscape', paperShapeOrientation: 'portrait', paperOrientation: 'portrait' })
  assert.equal(got, want)
  assert.equal(want, -90)
})

test('M2 [STEP2-KEEP] 横票 + 竖纸型(A4) + 横向 → layout=0', () => {
  const got = layoutOf(LAND_CONTENT, 0, A4_PORTRAIT, 'landscape')
  const want = resolvePaperTransform({ contentOrientation: 'landscape', paperShapeOrientation: 'portrait', paperOrientation: 'landscape' })
  assert.equal(got, want)
  assert.equal(want, 0)
})

test('M3 [STEP2-KEEP] 竖票 + 竖纸型(A4) + 纵向 → layout=0', () => {
  const got = layoutOf(PORT_CONTENT, 0, A4_PORTRAIT, 'portrait')
  const want = resolvePaperTransform({ contentOrientation: 'portrait', paperShapeOrientation: 'portrait', paperOrientation: 'portrait' })
  assert.equal(got, want)
  assert.equal(want, 0)
})

test('M4 [STEP2-KEEP] 竖票 + 竖纸型(A4) + 横向 → layout=-90', () => {
  const got = layoutOf(PORT_CONTENT, 0, A4_PORTRAIT, 'landscape')
  const want = resolvePaperTransform({ contentOrientation: 'portrait', paperShapeOrientation: 'portrait', paperOrientation: 'landscape' })
  assert.equal(got, want)
  assert.equal(want, -90)
})

test('M5 [UI-PROVEN] 横票 + 横纸型 + 纵向 → layout=-90', () => {
  const got = layoutOf(LAND_CONTENT, 0, LAND_PAPER, 'portrait')
  const want = resolvePaperTransform({ contentOrientation: 'landscape', paperShapeOrientation: 'landscape', paperOrientation: 'portrait' })
  assert.equal(got, want)
  assert.equal(want, -90)
})

test('M6 [UI-PROVEN / GAP] 横票 + 横纸型 + 横向 → layout=-90（当前 Step 2 代码给 0，真实差距，待 Step 3 补 PSO 层）', () => {
  const got = layoutOf(LAND_CONTENT, 0, LAND_PAPER, 'landscape')
  const want = resolvePaperTransform({ contentOrientation: 'landscape', paperShapeOrientation: 'landscape', paperOrientation: 'landscape' })
  assert.equal(got, want)
  assert.equal(want, -90)
})

// ── M7 / M8：竖票 + 横纸型，符号待 UI 验证，不能编码（用户 2026-08-07 指令）──
//   横票行已由 UI 证明（纵向/横向均 -90），但竖票在横纸型下不一定与横票数学对称：
//   竖票本身是 portrait 方向、横纸型是 landscape 形状，物理坐标转换方向需实测，不可靠推导。
//   回填时同步修正 resolvePaperTransform 的 landscape 分支与 Step 3 resolver 补回的 PSO 层。
test.todo('M7 [PENDING-UI] 竖票 + 横纸型 + 纵向 → 符号待 UI 验证')
test.todo('M8 [PENDING-UI] 竖票 + 横纸型 + 横向 → 符号待 UI 验证')

// ════════════════════════════════════════════════════════════════
// 架构不变量：最终视觉 = contentRotation + layoutRotation（无双旋转）
// 仅在已确认格（横票 + 横纸型）上校验 cr=0 与 cr=180 同得 ECO=landscape → layout 必须相同
// ════════════════════════════════════════════════════════════════
test('C1 [INVARIANT] 防双旋转：横票+横纸型+纵向 cr=0 与 cr=180 同得 ECO=landscape → layoutRotation 必须相同', () => {
  const a = layoutOf(LAND_CONTENT, 0, LAND_PAPER, 'portrait')
  const b = layoutOf(LAND_CONTENT, 180, LAND_PAPER, 'portrait')
  assert.equal(a, b, 'cr=0/180 都使 ECO=landscape，layout 仅取决于 ECO，不二次施加 contentRotation')
})

test('C2 [INVARIANT] 横票+横纸型 最终视觉 = contentRotation(bake 缩略图) + layoutRotation（串行不修正）', () => {
  const r = resolveContentPlacement({ contentPhysicalSize: LAND_CONTENT, contentRotation: 0, physicalPaper: LAND_PAPER, dpi: 300 })
  assert.equal(r.contentOrientation, 'landscape') // ECO 正确物化
  assert.equal(r.layoutRotation, -90)              // 横纸型+纵向 → -90（UI-PROVEN）
  assert.equal(norm(r.contentRotation + r.layoutRotation), 270) // 0 + (-90) = -90 ≡ 270
})
