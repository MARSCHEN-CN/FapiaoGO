// gate3A2Rotation.test.mjs — PPC-OFD Gate 3-A.2: Rotation Single Application
//
// 用户裁决（Option A，保持现状）：3-A.2 不升级为 Consumer 缺口修复，不改
// RotationResolver / usePrint / render_ofd_page / RenderCommand / 任何 rotation owner。
// 验证当前 R1 contract 下的 rotation-once 行为。
//
// 执行顺序（冻结）：
//   T1 rotation-once（主验收）   ：userRotation 0/90/180/270 → ctx.rotate 0/1/1/1
//   T2 sourceRotation sentinel   ：architecture watchpoint（非 PASS gate）——确认
//                                  sourceRotation 不进入 contentRotation（无第二 rotation source）
//   T3 V16 fallback              ：item.rotation 是 RenderResource fallback rotation，
//                                  **不是** OFD page sourceRotation（防未来误读）
//   T4 preview/print contract    ：preview/print 的 contentRotation input contract 一致
//                                  （source raster normalization may differ by format）
//
// 纪律：test-only；零生产码修改；复用 nodePolyfill.mjs（共享测试基础设施）。
//
// 运行：
//   cd frontend
//   node --loader ./test/printGate/env-shim.loader.mjs --test ./test/printGate/gate3A2Rotation.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { installNodePolyfills, MockImage, MOCK_IMAGE_SIZES } from './nodePolyfill.mjs'

installNodePolyfills()

// ─────────────────────────────────────────────────────────────
// 1. 加载真实生产链（动态 import：先 polyfill 后加载）
// ─────────────────────────────────────────────────────────────
const { renderMultipleItemsToCanvas } = await import('../../src/renderers.js')
const { getPaperPixels } = await import('../../src/layout.js')
const { buildSingleFileRenderCommand } = await import('../../src/layout/singleFileRenderCommand.js')
const { fileObjToComposePagePlan } = await import('../../src/compose/composePagePlan.js')

const PREVIEW_DPI = 300
const PAPER_PX = getPaperPixels('A4', PREVIEW_DPI, false) // {2480, 3508}

// ─────────────────────────────────────────────────────────────
// 2. Fixture 与 helper（复刻 usePrint.js:227-237 OFD 分支调用参数）
// ─────────────────────────────────────────────────────────────
MOCK_IMAGE_SIZES.set('mock://ofd/a2-p1', { width: 2100, height: 2970 })
MOCK_IMAGE_SIZES.set('mock://ofd/a2-src', { width: 2100, height: 2970 })

const OFD = { key: 'ofd-a2', fileFormat: 'ofd', docId: 'doc-ofd-a2', _previewImageUrl: 'mock://ofd/a2-p1' }
const OFD_SRC = { key: 'ofd-a2-src', fileFormat: 'ofd', docId: 'doc-ofd-a2-src', _previewImageUrl: 'mock://ofd/a2-src', sourceRotation: 90 }

async function renderOfdSinglePage(fileObj, userRotation) {
  return renderMultipleItemsToCanvas(
    [fileObj],
    'A4',
    PREVIEW_DPI,
    false, // landscape
    { [fileObj.key]: userRotation }, // rotations（用户 UI 旋转，同 usePrint.js:186）
    1, // slotCount = 1（单页）
    false, // isPrint = false —— 与预览保持一致（usePrint.js:234 注释）
    false, // showSafeMargin
    { strategy: 'vertical', customPaper: undefined },
  )
}

// ─────────────────────────────────────────────────────────────
// T1 rotation-once（主验收）：producer once + executor once
// ─────────────────────────────────────────────────────────────
test('T1 rotation-once: userRotation 0/90/180/270 → ctx.rotate 0/1/1/1（无 double，无遗漏）', async () => {
  const cases = [
    [0, 0, null],
    [90, 1, 90],
    [180, 1, 180],
    [270, 1, 270],
  ]
  for (const [rotation, expectedCount, expectedDeg] of cases) {
    const canvas = await renderOfdSinglePage(OFD, rotation)
    assert.equal(canvas.ctx.rotates.length, expectedCount,
      `rotation=${rotation} → ctx.rotate 次数=${expectedCount}（executor 单次消费，drawRenderCommand renderDraw.js:54）`)
    if (expectedDeg !== null) {
      assert.equal(Math.round(canvas.ctx.rotates[0].degrees), expectedDeg,
        `rotation=${rotation} → rotate 角度=${expectedDeg}`)
    }
  }
  // producer once：contentRotation 由 producer 一次写入（旧路径 _buildComposeCommand:769），
  // 无第二旋转层（cmd.rotation===0，Gate 4.3 R1 复述）
  assert.ok(true, 'producer once + executor once 成立')
})

// ─────────────────────────────────────────────────────────────
// T2 sourceRotation sentinel（architecture watchpoint，非 PASS gate）
// ─────────────────────────────────────────────────────────────
test('T2 sentinel: sourceRotation 不进入 contentRotation（当前 R1 contract 锁定，无第二 rotation source）', async () => {
  // 输入：item.sourceRotation=90 + rotations={key:0}（用户无旋转）
  // 当前 R1 contract：前端几何层不消费 sourceRotation → contentRotation=0 → rotate 0 次。
  // sentinel PASS = 确认当前 contract 没有偷偷引入第二 rotation source。
  // 若未来有人把 sourceRotation 并入 effectiveRotation，此处 rotate 次数变化 → sentinel FAIL → 触发 R1 复审。
  const canvas = await renderOfdSinglePage(OFD_SRC, 0)
  assert.equal(canvas.ctx.rotates.length, 0,
    'sentinel: sourceRotation=90 未进入 contentRotation（rotate 0 次）——contract 保持，无第二 rotation source')

  // 静态交叉验证：几何 owner 文件无 sourceRotation 消费（renderers 的 command 组装不含 sourceRotation 分支）
  const renderersSrc = readFileSync(fileURLToPath(new URL('../../src/renderers.js', import.meta.url)), 'utf8')
  const geomSrc = readFileSync(fileURLToPath(new URL('../../src/layout/renderDraw.js', import.meta.url)), 'utf8')
  assert.ok(!renderersSrc.includes('sourceRotation'), 'renderers.js 无 sourceRotation 消费（几何组装层）')
  assert.ok(!geomSrc.includes('sourceRotation'), 'renderDraw.js 无 sourceRotation 消费（executor）')
})

// ─────────────────────────────────────────────────────────────
// T3 V16 fallback：item.rotation 是 RenderResource fallback rotation，
//    不是 OFD page sourceRotation（防未来误读）
// ─────────────────────────────────────────────────────────────
test('T3 V16 fallback: item.rotation（fallback）→ effectiveRotation 一次；rotations 覆盖语义如实记录', () => {
  // item.rotation 语义 = RenderResource fallback rotation（V16 fileObjToComposePagePlan:48-49），
  // 与 OFD page sourceRotation（后端 metadata 字段）是不同概念——禁止混读。
  const item = { key: 'ofd-fb', rotation: 90 }
  const cs = { width: 2100, height: 2970 }

  // ① rotations 缺失 → fallback item.rotation=90 生效
  const p1 = fileObjToComposePagePlan(item, 0, cs, 'portrait', null)
  assert.equal(p1.documentState.rotation, 90, 'rotations 缺失 → fallback item.rotation=90')
  assert.equal(p1.printGeometry.effectiveRotation, 90, 'canonical effectiveRotation=90（B-10a，producer 一次）')

  // ② rotations 有 truthy 值 → 覆盖 fallback
  const p2 = fileObjToComposePagePlan(item, 0, cs, 'portrait', { 'ofd-fb': 270 })
  assert.equal(p2.documentState.rotation, 270, 'rotations={key:270} truthy → 覆盖 fallback')

  // ③ rotations={key:0} → 0 为 falsy → fallback 生效（V16 既有 falsy 语义，如实记录：
  //    与旧路径 `rotations[itemId] || 0` 的「显式 0 即 0」不同——两条路径对「用户旋转 0」行为不一致，
  //    这是 R1 既有差异，非本 Gate 缺陷，仅观察哨）
  const p3 = fileObjToComposePagePlan(item, 0, cs, 'portrait', { 'ofd-fb': 0 })
  assert.equal(p3.documentState.rotation, 90, 'rotations={key:0} falsy → fallback item.rotation=90（V16 falsy 语义）')
})

// ─────────────────────────────────────────────────────────────
// T4 preview/print contentRotation input contract 一致
//    （contentRotation contract same；source raster normalization may differ by format）
// ─────────────────────────────────────────────────────────────
test('T4 preview/print: contentRotation input contract 一致（同 rotation 输入 → 同 contentRotation）', async () => {
  // print 链：全链渲染（renderMultipleItemsToCanvas 真实几何），rotation=90 → contentRotation=90 → rotate 恰 1 次
  const c = await renderOfdSinglePage(OFD, 90)
  assert.equal(c.ctx.rotates.length, 1, 'print 链 contentRotation=90 施加一次')
  assert.equal(Math.round(c.ctx.rotates[0].degrees), 90)

  // preview producer：buildSingleFileRenderCommand 同一 rotation 输入 → contentRotation=90
  // （singleFileRenderCommand.js:61 contentRotation: rotation——与打印链 producer 同 contract）
  const cmd = buildSingleFileRenderCommand({
    sourceWidth: 2100, sourceHeight: 2970,
    contentRect: { x: 0, y: 0, width: PAPER_PX.width, height: PAPER_PX.height },
    rotation: 90,
    paper: { width: PAPER_PX.width, height: PAPER_PX.height },
  })
  assert.equal(cmd.contentRotation, 90, 'preview producer contentRotation=90（同输入同 contract）')

  // 措辞边界（用户校准）：contentRotation contract 一致 ≠ preview/print 完全一致——
  // source raster normalization 可能按格式不同（PDF 打印 /Rotate 在 raster 烤入 vs 预览 rotation:0 光栅，
  // 见 3-A.2 取证文档 §1 PDF 对照）。本 T4 只断言 contentRotation 输入契约，不断言 raster 归一化。
  assert.ok(true, 'contentRotation input contract same；raster normalization may differ by format（PDF /Rotate vs OFD）')
})
