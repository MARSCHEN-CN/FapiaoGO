/**
 * Gate 3-4B — Source Path Rotation Ownership Verification
 * =========================================================
 *
 * 非实现测试，是「架构纠偏 / 回归护栏」测试。
 *
 * 目的：用可复现脚本证明 Gate 3-4B 原迁移方案
 *     `resolveContentPlacement({ contentRotation: printGeometry.effectiveRotation })`
 * 在部分 userRotation 场景下会改变 source path 的净旋转输出（实测发散用例 B-2.4 / B-2.5，
 * 净旋转差 = 180° = 上下颠倒），因此「effectiveRotation → contentRotation」是非法迁移
 * （BLOCKER：双重纸面匹配旋转）。
 *
 * 实测矩阵（2026-08-19）：
 *   B-2.4 landscape×portrait user90 : srcCur 90 → srcNaive 270 （180° 翻转）
 *   B-2.5 portrait×landscape  user0  : srcCur 270 → srcNaive 90  （180° 翻转）
 *   B-2.1/2.2/2.3/2.6 迁移后等价（auto=0 时 merge===user；或对称抵消）——锁定为不退化。
 *
 * 同时锁定：source path 的 contentRotation 语义层 = 用户旋转(fileRotations)，
 * merge path 的 effectiveRotation 语义层 = 最终旋转(autoRotation + userRotation)，
 * 二者不可互换。
 *
 * 运行（单一文件，无需 env-shim；两被测模块均为纯函数、无 config 依赖）：
 *   node --test frontend/src/layout/Gate3-4B-SourceRotationOwnership.test.mjs
 *
 * 若有人实施 `contentRotation = printGeometry.effectiveRotation`，
 * 以下「diverges」断言将失败 —— 即本测试作为 Gate 3-4B 的 guard。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildPrintGeometry } from '../geometry/PrintGeometryBuilder.js'
import { resolveContentPlacement, normalizeRotation } from './RotationResolver.js'

// 物理尺寸（仅形状相关，量级不影响方向逻辑）
const PORTRAIT_CONTENT = { widthPx: 100, heightPx: 200 }   // w<h → portrait
const LANDSCAPE_CONTENT = { widthPx: 200, heightPx: 100 }  // w>h → landscape
const PORTRAIT_PAPER = { widthMM: 210, heightMM: 297 }      // A4 portrait
const LANDSCAPE_PAPER = { widthMM: 297, heightMM: 210 }     // A4 landscape

// 净旋转（source path 内容在纸面上的最终朝向）= 用户旋转(烤入缩略图) + 纸面适配
// ⚠️ resolveContentPlacement 的 contentPhysicalSize 契约是 {width,height}（px@dpi），
//    与 merge 层 rawDocumentGeometry 的 {widthPx,heightPx} 命名不同，这里显式映射。
function sourceNetRotation(contentPx, contentRotation, physicalPaper) {
  const p = resolveContentPlacement({
    contentPhysicalSize: { width: contentPx.widthPx, height: contentPx.heightPx },
    contentRotation,
    physicalPaper,
  })
  return normalizeRotation(p.contentRotation + p.layoutRotation)
}

// merge path 最终旋转（effectiveRotation）
function mergeEffectiveRotation(contentPx, paperOrientation, userDegrees) {
  const g = buildPrintGeometry({
    rawDocumentGeometry: { widthPx: contentPx.widthPx, heightPx: contentPx.heightPx },
    requestedPaperGeometry: { orientation: paperOrientation },
    userRotation: { degrees: userDegrees },
  })
  return g.effectiveRotation
}

// B-2 验收矩阵（userRotation 覆盖矩阵）
const CASES = [
  { id: 'B-2.1', content: PORTRAIT_CONTENT,  contentLabel: 'portrait',  paper: PORTRAIT_PAPER,  paperLabel: 'portrait',  user: 0 },
  { id: 'B-2.2', content: PORTRAIT_CONTENT,  contentLabel: 'portrait',  paper: PORTRAIT_PAPER,  paperLabel: 'portrait',  user: 90 },
  { id: 'B-2.3', content: LANDSCAPE_CONTENT, contentLabel: 'landscape', paper: PORTRAIT_PAPER,  paperLabel: 'portrait',  user: 0 },
  { id: 'B-2.4', content: LANDSCAPE_CONTENT, contentLabel: 'landscape', paper: PORTRAIT_PAPER,  paperLabel: 'portrait',  user: 90 },
  { id: 'B-2.5', content: PORTRAIT_CONTENT,  contentLabel: 'portrait',  paper: LANDSCAPE_PAPER, paperLabel: 'landscape', user: 0 },
  { id: 'B-2.6', content: PORTRAIT_CONTENT,  contentLabel: 'portrait',  paper: LANDSCAPE_PAPER, paperLabel: 'landscape', user: 90 },
]

function analyze(c) {
  const paperOrientation = c.paper.widthMM > c.paper.heightMM ? 'landscape' : 'portrait'
  const merge = mergeEffectiveRotation(c.content, paperOrientation, c.user)
  const srcCurrent = sourceNetRotation(c.content, c.user, c.paper)            // 当前：contentRotation = user
  const srcNaive = sourceNetRotation(c.content, merge, c.paper)              // 非法迁移：contentRotation = effectiveRotation
  return {
    ...c,
    merge,
    srcCurrent,
    srcNaive,
    // 非法迁移是否改变了 source 输出
    diverges: srcNaive !== srcCurrent,
    // effectiveRotation 是否 ≠ 用户旋转（即两层语义不同）
    layersDiffer: merge !== c.user,
  }
}

test('Gate 3-4B: 打印 B-2 验收矩阵 + 非法迁移护栏', () => {
  const rows = CASES.map(analyze)

  // 控制台表格（证据留痕）
  console.log('\n=== Gate 3-4B Rotation Ownership Verification Matrix (B-2) ===')
  console.log('case    content   paper     user  merge  srcCur  srcNaive  diverges  layersDiffer')
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(7)} ${r.contentLabel.padEnd(9)} ${r.paperLabel.padEnd(9)} ` +
      `${String(r.user).padEnd(5)} ${String(r.merge).padEnd(6)} ` +
      `${String(r.srcCurrent).padEnd(7)} ${String(r.srcNaive).padEnd(9)} ` +
      `${String(r.diverges).padEnd(9)} ${r.layersDiffer}`
    )
  }
  console.log('(merge = buildPrintGeometry.effectiveRotation; srcCur = 当前 source path 净旋转; ' +
              'srcNaive = 非法迁移 contentRotation=effectiveRotation 的净旋转)')

  // ---- 护栏 1（核心）：非法迁移不是 no-op ----
  // 至少存在一个用例，迁移后 source 净旋转改变（实测 B-2.4 / B-2.5）。
  const anyDiverge = rows.some((r) => r.diverges)
  assert.ok(anyDiverge, '非法迁移(contentRotation=effectiveRotation)必须至少在一个用例改变 source 输出；否则原迁移方案可能安全')

  // ---- 护栏 2（锁定当前正确行为）：具体用例断言 ----
  // 实测发散用例（净旋转差 180°，上下颠倒级回归）：
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.equal(byId['B-2.4'].diverges, true, 'B-2.4 (landscape×portrait, user90): 非法迁移必须改变输出')
  assert.equal(byId['B-2.5'].diverges, true, 'B-2.5 (portrait×landscape, user0): 非法迁移必须改变输出')

  // 严重度：B-2.4 / B-2.5 的净旋转差 = 180°（内容上下颠倒），不是微小偏差。
  const flip180 = (a, b) => ((normalizeRotation(a - b) + 360) % 360) === 180
  assert.ok(flip180(byId['B-2.4'].srcNaive, byId['B-2.4'].srcCurrent),
    'B-2.4: srcNaive(270) 与 srcCurrent(90) 必须相差 180°')
  assert.ok(flip180(byId['B-2.5'].srcNaive, byId['B-2.5'].srcCurrent),
    'B-2.5: srcNaive(90) 与 srcCurrent(270) 必须相差 180°')

  // 锁定不退化用例（迁移后等价，防止未来改动改变这些用例的当前行为）：
  assert.equal(byId['B-2.1'].diverges, false, 'B-2.1 (portrait×portrait, user0): 迁移应等价')
  assert.equal(byId['B-2.2'].diverges, false, 'B-2.2 (portrait×portrait, user90): 迁移应等价（merge===user）')
  assert.equal(byId['B-2.3'].diverges, false, 'B-2.3 (landscape×portrait, user0): 迁移应等价（对称抵消）')
  assert.equal(byId['B-2.6'].diverges, false, 'B-2.6 (portrait×landscape, user90): 迁移应等价（180° 不交换宽高）')

  // ---- 护栏 3：两层语义不可互换 ----
  // effectiveRotation 包含 autoRotation，已不是「用户旋转」输入层。
  const anyLayerDiff = rows.some((r) => r.layersDiffer)
  assert.ok(anyLayerDiff, 'effectiveRotation 必须至少在一个用例 ≠ 用户旋转，证明二者是不同语义层（禁止互换）')

  console.log('\nGate 3-4B guard: PASS — 非法迁移已证明会改变 source 输出，故「contentRotation = printGeometry.effectiveRotation」被禁止。')
})
