/**
 * OrientationFit Gate（Step 2 统一模型，2026-08-07）
 *
 * 用户旋转与纸张匹配严格分层：
 *   - Stage 1（用户旋转）：effectiveContentOrientation = detectContentOrientation(rotate(content, contentRotation))
 *   - Stage 2（纸张匹配）：layoutRotation = computeLayoutRotation(effectiveContentOrientation, requestedPaperOrientation)
 *       方向匹配 → 0；方向不匹配 → -90（统一逆时针 90°）
 *   - renderRotation = normalize(layoutRotation)（SVG 施加；thumbnail 已 bake contentRotation，故不含 content）
 *   - 最终视觉 = contentRotation(烤入缩略图) + layoutRotation(SVG)，二者串行、不互相修正。
 *
 * 关键约束：
 *   1. 物理纸型（A4 竖形 / 297×210 横形）不参与旋转决策，只影响画布尺寸；
 *      横纸型不再有任何特殊表，layoutRotation 仅由 effectiveContentOrientation vs requestedPaperOrientation 决定。
 *   2. 竖向纸型（用户方向 portrait）行为与上轮修复前完全一致——
 *      旧 orientationFit 在竖纸型恒为 0，故 fit = shapeFit = computeLayoutRotation(effOrientation, portrait) = 新模型。
 *   3. 横纸方向错误（0da69e1 / 2-H v2 反复修补）根因是「纸张匹配没看用户旋转后方向」；
 *      本模型天然修复：横票 cr90 + 横纸 → 有效竖内容 → layout=-90（视觉 0，不再误补）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveContentPlacement,
  computeLayoutRotation,
  detectContentOrientation,
  isRotated,
  normalizeRotation,
} from '../src/layout/RotationResolver.js'

const A4 = { widthMM: 210, heightMM: 297 }    // portrait 物理形状
const LAND = { widthMM: 297, heightMM: 210 }  // landscape 物理形状
const LAND_CONTENT = { width: 1500, height: 1000 } // 横票
const PORT_CONTENT = { width: 1000, height: 1500 } // 竖票

/**
 * Commit 3（B2 修复）：needSwap 归一化 —— 「纸型原生形状 + 用户请求方向」→ 最终 physical paper。
 * 以前这一步藏在 Resolver 内部（同时相信几何 paperSize 与标签 paperOrientation，二者在横形纸型下恒相反）；
 * 现在明确成为调用方职责，Resolver 只收一个可信的纸张物理坐标系。
 * 归一化后 detectPaperOrientation(physicalPaper) 恒 === orient，故本文件的 layout/render 期望值全部不变。
 */
function toPhysicalPaper(paperShape, orient) {
  const shapeOrientation = paperShape.widthMM > paperShape.heightMM ? 'landscape' : 'portrait'
  return orient !== shapeOrientation
    ? { widthMM: paperShape.heightMM, heightMM: paperShape.widthMM }
    : { widthMM: paperShape.widthMM, heightMM: paperShape.heightMM }
}

function resolve(content, paper, orient, contentRotation = 0) {
  return resolveContentPlacement({
    contentPhysicalSize: content,
    contentRotation,
    physicalPaper: toPhysicalPaper(paper, orient),
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
    dpi: 300,
  })
}

// 用户旋转后的有效内容方向（与 Resolver 内部一致）
function effectiveOrientation(content, contentRotation) {
  const r = normalizeRotation(contentRotation)
  const w = isRotated(r) ? content.height : content.width
  const h = isRotated(r) ? content.width : content.height
  return detectContentOrientation({ width: w, height: h })
}

// ─────────────────────────────────────────────
// 8 宫格（contentRotation=0 基线 + 关键 cr90 翻转）
//   列 = requestedPaperOrientation（用户方向）；行 = 有效内容方向
// ─────────────────────────────────────────────
const GRID = [
  // [label, content, cr, paper, orient, expLayout, expRender]
  ['A 横票 cr0  横纸', LAND_CONTENT, 0, LAND, 'landscape', 0, 0],
  ['B 横票 cr0  纵纸', LAND_CONTENT, 0, A4, 'portrait', -90, 270],
  ['C 横票 cr90 横纸', LAND_CONTENT, 90, LAND, 'landscape', -90, 270],
  ['D 横票 cr90 纵纸', LAND_CONTENT, 90, A4, 'portrait', 0, 0],
  ['E 竖票 cr0  横纸', PORT_CONTENT, 0, LAND, 'landscape', -90, 270],
  ['F 竖票 cr0  纵纸', PORT_CONTENT, 0, A4, 'portrait', 0, 0],
  ['G 竖票 cr90 横纸', PORT_CONTENT, 90, LAND, 'landscape', 0, 0],
  ['H 竖票 cr90 纵纸', PORT_CONTENT, 90, A4, 'portrait', -90, 270],
]

for (const [label, content, cr, paper, orient, expLayout, expRender] of GRID) {
  test(`8格 ${label} → layout=${expLayout} render=${expRender}`, () => {
    const r = resolve(content, paper, orient, cr)
    assert.equal(r.contentOrientation, effectiveOrientation(content, cr), 'contentOrientation=有效内容方向(用户旋转后)')
    // Commit 3：Resolver 输出改为 physicalPaperOrientation（仅从 physicalPaper 几何派生）。
    // needSwap 归一化保证它恒 === 用户请求方向 orient，故断言语义等价。
    assert.equal(r.physicalPaperOrientation, orient)
    assert.equal(r.layoutRotation, expLayout, 'layoutRotation 单一适配旋转')
    assert.equal(r.renderRotation, expRender, 'renderRotation 归一化')
    // 无双旋转：renderRotation 仅承载 layoutRotation（contentRotation 由 thumbnail 烤入）
    assert.equal(r.renderRotation, normalizeRotation(expLayout))
  })
}

// ─────────────────────────────────────────────
// 用户显式推导 4 案例（语义锁死）
// ─────────────────────────────────────────────
test('用户推导 Case 1：横票+用户0+横纸 → layout=0', () => {
  const r = resolve(LAND_CONTENT, LAND, 'landscape')
  assert.equal(r.layoutRotation, 0)
  assert.equal(r.renderRotation, 0)
})

test('用户推导 Case 2：横票+用户0+纵纸 → layout=-90', () => {
  const r = resolve(LAND_CONTENT, A4, 'portrait')
  assert.equal(r.layoutRotation, -90)
  assert.equal(r.renderRotation, 270)
})

test('用户推导 Case 3：横票+用户90+横纸 → 有效竖内容 → layout=-90（视觉 90+(-90)=0，不再误补）', () => {
  const r = resolve(LAND_CONTENT, LAND, 'landscape', 90)
  assert.equal(r.contentOrientation, 'portrait', '用户旋转后内容变竖')
  assert.equal(r.layoutRotation, -90)
  assert.equal(r.renderRotation, 270)
  // 视觉最终 = contentRotation(bake) + layoutRotation(SVG)
  assert.equal(normalizeRotation(r.contentRotation + r.layoutRotation), 0)
})

test('用户推导 Case 4：横票+用户90+纵纸 → 有效竖内容 → layout=0（视觉=90）', () => {
  const r = resolve(LAND_CONTENT, A4, 'portrait', 90)
  assert.equal(r.contentOrientation, 'portrait')
  assert.equal(r.layoutRotation, 0)
  assert.equal(normalizeRotation(r.contentRotation + r.layoutRotation), 90)
})

// ─────────────────────────────────────────────
// 守卫 1：横纸型无任何特殊表——layoutRotation 仅由 (有效内容方向, 用户方向) 决定
//
// Commit 3 备注：needSwap 归一化后，LAND+orient 与 A4+orient 会收敛到同一个 physicalPaper，
// 因此 rA/rB 相等这一条在 Resolver 层面变得平凡。本守卫的有效断言范围已上移为
// 「纸型原生形状 + 用户方向 → 归一化 → 旋转」整条链路：不同原生形状 + 同一用户方向 ⇒ 同一旋转。
// ─────────────────────────────────────────────
test('守卫1：横纸型 layoutRotation 与物理纸型无关（A4 横形 == LAND 横形 == 公式计算）', () => {
  for (const content of [LAND_CONTENT, PORT_CONTENT]) {
    for (const cr of [0, 90, 180, 270]) {
      const eff = effectiveOrientation(content, cr)
      for (const orient of ['landscape', 'portrait']) {
        const rA = resolve(content, LAND, orient, cr)
        const rB = resolve(content, A4, orient, cr) // 物理形状不同，但旋转决策只看 orient
        assert.equal(rA.layoutRotation, computeLayoutRotation(eff, orient), '横纸型=公式')
        assert.equal(rB.layoutRotation, computeLayoutRotation(eff, orient), '竖纸型物理形状但同 orient=同公式')
        assert.equal(rA.layoutRotation, rB.layoutRotation, '物理纸型不影响旋转')
      }
    }
  }
})

// ─────────────────────────────────────────────
// 守卫 2：竖向纸型（用户方向 portrait）行为与上轮修复前一致
//   旧 orientationFit 在竖纸型恒 0 → fit = shapeFit = computeLayoutRotation(effOri, portrait) = 新模型
// ─────────────────────────────────────────────
test('守卫2：竖向纸型(用户 portrait) layoutRotation == computeLayoutRotation(有效方向, portrait)', () => {
  for (const content of [LAND_CONTENT, PORT_CONTENT]) {
    for (const cr of [0, 90, 180, 270]) {
      const eff = effectiveOrientation(content, cr)
      const r = resolve(content, A4, 'portrait', cr)
      assert.equal(r.layoutRotation, computeLayoutRotation(eff, 'portrait'))
      assert.equal(r.renderRotation, normalizeRotation(computeLayoutRotation(eff, 'portrait')))
    }
  }
})

// ─────────────────────────────────────────────
// 守卫 3：用户旋转只出现一次——renderRotation 不含 contentRotation（防双旋转）
// ─────────────────────────────────────────────
test('守卫3：renderRotation 仅承载 layoutRotation，contentRotation 由缩略图烤入（防双旋转）', () => {
  const r = resolve(LAND_CONTENT, A4, 'portrait', 90)
  // 旧 bug 会 renderRotation = content+fit；正确为 renderRotation = layoutRotation
  assert.equal(r.renderRotation, r.layoutRotation, 'SVG 旋转 ≠ content+fit')
  assert.notEqual(r.renderRotation, normalizeRotation(r.contentRotation + r.layoutRotation),
    'renderRotation 不应再叠加 contentRotation（thumbnail 已烤入）')
})
