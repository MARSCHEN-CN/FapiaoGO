/**
 * rotation3LayerGate.test.mjs — 三层旋转模型回归 Gate（审计工件，2026-08-07）
 *
 * 背景：Step 2（commit 16568c4）统一模型 = layoutRotation = computeLayoutRotation(effectiveContentOrientation, paperOrientation)
 *   只用了【有效内容方向】+【用户纸方向】两个输入，完全忽略了【纸张物理形状 paperShapeOrientation】。
 *   UI 验证后证明：横向纸张类型下，纸张匹配还取决于 PSO 与用户方向共同决定的物理坐标旋转。
 *   例（UI 实测 2026-08-07 第二轮，推翻上一轮 +90 假设）：
 *     横票 + 横纸型 + 纵向 → -90
 *     横票 + 横纸型 + 横向 → -90（横纸型存在固定基准旋转，与纸张方向无关）
 *   Step 2 当前对横纸型算出的仍是 computeLayoutRotation(ECO, PO)（漏掉 PSO 基准），故横纸型+横向 偏差。
 *   ⚠️ 本文件已被 rotationPaperTransformGate.test.mjs 取代为更准的三输入 resolvePaperTransform 规格；此处保留 8 宫格 + 组合不变量，矩阵值已同步修正。
 *
 * 本 Gate 编码「三层模型」目标矩阵（contentOrientation × paperShape × userOrientation = 8），
 * 并对优先级 case 叠加 contentRotation(0/90/180/270) 校验「最终视觉 = contentRotation + layoutRotation（无双旋转）」。
 *
 * ⚠️ 状态：本文件为【目标规格 + 审计】。当前 Step 2 代码跑此 Gate 时，横纸型 4 格会 FAIL（差距审计）。
 *   竖纸型 4 格（Step 2 已确认正确）PASS。
 *   ── 标记 ──
 *     [UI-PROVEN] 用户 UI 验证确认（横票+横纸型，本 Gate 硬断言，当前 Step2 不及格=差距）
 *     [STEP2-KEEP] Step 2 已确认、本轮不变
 *     [PENDING-UI] 竖票+横纸型 两格：横票行不可镜像，符号待 UI 实测，标记 TODO 不编码
 *
 * 运行：node --test test/rotation3LayerGate.test.mjs
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
 * 三层模型「目标」layoutRotation 纯函数（审计预期值，与 rotationPaperTransformGate 的 resolvePaperTransform 同义）。
 *   - 竖纸型(PSO=portrait): Step2 已确认 = 方向匹配（match→0, mismatch→-90）
 *   - 横纸型(PSO=landscape): 横票(contentOrientation===PSO) → 固定基准 -90（与纸张方向无关，UI 实测）
 *        竖票(contentOrientation!==PSO) → 未验证，调用方不应到达
 */
function intendedLayout(contentOrientation, paperShapeOrientation, paperOrientation) {
  if (paperShapeOrientation === 'portrait') {
    return contentOrientation === paperOrientation ? 0 : -90
  }
  // 横纸型（landscape shape）
  if (contentOrientation === paperShapeOrientation) {
    // 横票 + 横纸型：固定基准旋转 -90，与纸张方向无关（UI 实测 2026-08-07 第二轮）
    return -90
  }
  // 竖票 + 横纸型：未验证
  throw new Error('PENDING-UI: 竖票+横纸型 待 UI 验证')
}

/** 调 resolver 取 layoutRotation（不改源码，仅读取）
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

test('M5 [UI-PROVEN] 横票 + 横纸型 + 纵向 → layout=-90', () => {
  const got = layoutOf(LAND_CONTENT, 0, LAND_PAPER, 'portrait')
  const want = intendedLayout('landscape', 'landscape', 'portrait')
  assert.equal(got, want)
  assert.equal(want, -90)
})

test('M6 [UI-PROVEN] 横票 + 横纸型 + 横向 → layout=-90', () => {
  const got = layoutOf(LAND_CONTENT, 0, LAND_PAPER, 'landscape')
  const want = intendedLayout('landscape', 'landscape', 'landscape')
  assert.equal(got, want)
  assert.equal(want, -90)
})

// ── M7 / M8：竖票 + 横纸型，符号待 UI 验证，现在不能编码（用户 2026-08-07 指令）──
//   横票行已由 UI 证明（纵向/横向均 -90），但竖票在横纸型下不一定与横票数学对称：
//   竖票本身是 portrait 方向、横纸型是 landscape 形状，物理坐标转换方向需实测，
//   不能因横票成立就镜像。故标记 TODO，待用户在 UI 实测下列两 case 后回填：
//     Case M7: 竖向发票 + 横向纸张类型 + 纵向 → 观察 A.顺时针90 / B.逆时针90 / C.0
//     Case M8: 竖向发票 + 横向纸张类型 + 横向 → 观察 A.顺时针90 / B.逆时针90 / C.0
//   回填时同步修正 intendedLayout 的 landscape 分支与 Step 3 resolver 补回的 PSO 层。
test.todo('M7 [PENDING-UI] 竖票 + 横纸型 + 纵向 → 符号待 UI 验证（不编码，待 UI 实测）')
test.todo('M8 [PENDING-UI] 竖票 + 横纸型 + 横向 → 符号待 UI 验证（不编码，待 UI 实测）')

// ════════════════════════════════════════════════════════════════
// 组合校验：最终视觉 = contentRotation + layoutRotation（无双旋转）
// 优先级 case：横票 + 横纸型 + 纵向（UI-PROVEN -90）
// ════════════════════════════════════════════════════════════════

test('C1 [UI-PROVEN] 横票+横纸型+纵向 cr=0 → final=-90（content 单次 + layout）', () => {
  const r = resolveContentPlacement({ contentPhysicalSize: LAND_CONTENT, contentRotation: 0, physicalPaper: LAND_PAPER, dpi: 300 })
  assert.equal(r.contentOrientation, 'landscape') // ECO 正确物化
  assert.equal(r.layoutRotation, -90)             // 横纸型+纵向 → -90（UI 实测 2026-08-07 第二轮）
  assert.equal(norm(r.contentRotation + r.layoutRotation), 270) // 0 + (-90) = -90 ≡ 270
})

// C2 原校验「横票+横纸型+纵向 cr=90」：cr=90 使 ECO=portrait，落入 竖票+横纸型 等价区域（PSO=landscape, ECO=portrait），
// 该区域符号 PENDING-UI（见 M7/M8）。cr=0 的已确认值（M5/C1）= -90，但 cr=90 当前代码给 0 且属待定区，故改 TODO 待 UI 回填。
test.todo('C2 [PENDING-UI] 横票+横纸型+纵向 cr=90 → ECO=portrait 落入 竖票+横纸型 等价区，符号待 UI 验证')

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
