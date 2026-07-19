/**
 * D2-1 单源锁：RenderLayoutFactory.buildRenderCommand 必须委托 createPlacement 产出 placement，
 * 消除 Preview 侧第二套 fit 源（calculateFitScale / calculateCenteredPosition）。
 *
 * 目标（对齐用户 D2-1 验收）：
 *  1. 静态守卫：production caller 不再引用 calculateFitScale / calculateCenteredPosition。
 *  2. Preview ≡ Export：buildRenderCommand 的 placement 与 buildSingleFileRenderCommand
 *     （Export/单文件预览同 producer，已由其 D1 同构锁证明 == createPlacement）逐字段相等。
 *  3. 回归锁：buildRenderCommand.placement 直连 createPlacement 输出，覆盖
 *     portrait image / landscape image / rotated PDF(90·270) / A4 / A5 / 带边距。
 *
 * 说明：calculateFitScale 与 createPlacement 在数学上逐值等价，因此“值相等”测试无法区分
 * 两种实现——真正证明 D2-1（ownership 收敛）的是【静态守卫】。值测试负责兜住未来任何一端
 * 对 createPlacement 或 buildRenderCommand 的静默改动，是回归网而非迁移判别。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computePaperLayout } from '../previewState.js'
import { buildRenderCommand } from './RenderLayoutFactory.js'
import { buildSingleFileRenderCommand } from './singleFileRenderCommand.js'
import { createPlacement } from '../compose/composePlacement.js'

// ── 静态守卫：D2-1 的真正判别 ──
test('D2-1 static: buildRenderCommand 收敛到 createPlacement，旧 fit 源彻底消失', () => {
  const src = readFileSync(new URL('./RenderLayoutFactory.js', import.meta.url), 'utf8')
  assert.ok(src.includes("from '../compose/composePlacement.js'"), '应 import createPlacement')
  assert.ok(src.includes('createPlacement('), '应调用 createPlacement 委托几何')
  // 关键：production caller 不得再持有第二套 fit/居中实现
  assert.equal(src.includes('calculateFitScale'), false, 'fit 必须消除第二套源（calculateFitScale 不应再出现）')
  assert.equal(src.includes('calculateCenteredPosition'), false, '居中必须消除第二套源（calculateCenteredPosition 不应再出现）')
})

// 复用 renderSpec.test.js 的构造方式，确保 paperLayout 与真实 Preview 同构
function makeCommand({ paperSize = 'A4', margins = { top: 0, right: 0, bottom: 0, left: 0 }, pageSize = { w: 1240, h: 1754 }, pageOrientation = 'portrait', rotation = 0 } = {}) {
  const paperLayout = computePaperLayout({ paperSize, customPaper: null, margins })
  const documentState = { pageSize, pageOrientation, rotation }
  return { paperLayout, documentState, cmd: buildRenderCommand(paperLayout, documentState) }
}

// 把 buildRenderCommand 返回的 usableRect({x,y,w,h}) 转成 createPlacement 期望的 {x,y,width,height}
function usableToContentRect(usableRect) {
  return { x: usableRect.x, y: usableRect.y, width: usableRect.w, height: usableRect.h }
}

const SCENARIOS = [
  { name: 'A4 portrait image', paperSize: 'A4', pageSize: { w: 1240, h: 1754 }, pageOrientation: 'portrait', rotation: 0 },
  { name: 'A4 landscape image (content drives landscape paper)', paperSize: 'A4', pageSize: { w: 1754, h: 1240 }, pageOrientation: 'landscape', rotation: 0 },
  { name: 'A4 rotated 90 (PDF)', paperSize: 'A4', pageSize: { w: 1240, h: 1754 }, pageOrientation: 'portrait', rotation: 90 },
  { name: 'A4 rotated 270 (PDF)', paperSize: 'A4', pageSize: { w: 1240, h: 1754 }, pageOrientation: 'portrait', rotation: 270 },
  { name: 'A4 rotated 180', paperSize: 'A4', pageSize: { w: 1240, h: 1754 }, pageOrientation: 'portrait', rotation: 180 },
  { name: 'A5 portrait image', paperSize: 'A5', pageSize: { w: 1240, h: 1754 }, pageOrientation: 'portrait', rotation: 0 },
  { name: 'A4 portrait with 10mm margins', paperSize: 'A4', margins: { top: 10, right: 10, bottom: 10, left: 10 }, pageSize: { w: 1240, h: 1754 }, pageOrientation: 'portrait', rotation: 0 },
  { name: 'A4 landscape rotated 90', paperSize: 'A4', pageSize: { w: 1754, h: 1240 }, pageOrientation: 'landscape', rotation: 90 },
]

for (const s of SCENARIOS) {
  test(`D2-1 placement 单源锁: ${s.name}`, () => {
    const { cmd } = makeCommand(s)
    // 就绪态：有效 pageSize 必须产出 scale>0 的 placement
    assert.ok(cmd.placement.scale > 0, `[${s.name}] placement.scale 应 > 0（已就绪），实得 ${cmd.placement.scale}`)

    const contentRect = usableToContentRect(cmd.usableRect)
    const sourceWidth = s.pageSize.w
    const sourceHeight = s.pageSize.h
    const rotation = cmd.contentRotation

    // (a) 直连 createPlacement：buildRenderCommand 必须 == createPlacement 输出（无额外几何）
    const direct = createPlacement({ contentRect, sourceWidth, sourceHeight, rotation })
    assert.deepEqual(
      cmd.placement,
      { scale: direct.scale, offsetX: direct.offsetX, offsetY: direct.offsetY },
      `[${s.name}] placement 必须 == createPlacement 直组（buildRenderCommand 不得引入独立 fit/居中）`
    )

    // (b) 经 buildSingleFileRenderCommand（Export/单文件预览同 producer）：
    //     Preview placement 必须 == Export producer placement（D2 终态：Preview≡Export）
    const viaExport = buildSingleFileRenderCommand({ sourceWidth, sourceHeight, contentRect, rotation, paper: null })
    assert.deepEqual(
      cmd.placement,
      viaExport.placement,
      `[${s.name}] Preview placement 必须 == Export producer (buildSingleFileRenderCommand)`
    )
  })
}

// 额外：rotatedBounds 也应由 createPlacement 统一产出（90/270 交换 natW/natH）
test('D2-1 rotatedBounds 单源锁: 90/270 交换 natW/natH', () => {
  for (const rotation of [0, 90, 180, 270]) {
    const { cmd } = makeCommand({ pageSize: { w: 1240, h: 1754 }, rotation })
    const expected = createPlacement({ contentRect: usableToContentRect(cmd.usableRect), sourceWidth: 1240, sourceHeight: 1754, rotation })
    assert.deepEqual(cmd.rotatedBounds, expected.rotatedBounds, `rotation=${rotation} rotatedBounds 必须 == createPlacement`)
  }
})
