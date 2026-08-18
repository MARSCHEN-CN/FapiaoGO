/**
 * Gate3RenderCommandSeam.test.js — Gate 3-4A RenderCommand Factory seam 验收
 * 运行（前端根目录）：node --loader ./env-shim.loader.mjs --test src/layout/Gate3RenderCommandSeam.test.js
 *
 * 验收重点（对齐 Gate 3-3 Final Verdict 表）：
 *   • RenderCommand rotation 来源 = PrintGeometry.effectiveRotation（单一来源，B-10）
 *   • Factory 不二次解释 / 不 re-normalize（B-10a）
 *   • 3-arg 调用（preview / compose() adapter）仍走 legacy shim = documentState.rotation（B-11 兼容）
 *   • paperLandscape 不变（D3）
 *   • RotationResolver 零 diff（结构性保证，不在此测；见 G3-B-12）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePaperLayout } from '../previewState.js'
import { buildRenderCommand } from './RenderLayoutFactory.js'
import { buildPrintGeometry } from '../geometry/PrintGeometryBuilder.js'
import { composePlans } from './MultiTicketComposer.js'
import { fileObjToComposePagePlan } from '../compose/composePagePlan.js'

function makePaperLayout() {
  return computePaperLayout({ paperSize: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } })
}

test('R-A1: buildRenderCommand 消费 printGeometry.effectiveRotation（不二次 normalize / 不回退 documentState）', () => {
  const paperLayout = makePaperLayout()
  // 横内容(3508×2480) + 竖纸(portrait) → autoRotation=270, effectiveRotation=270
  const printGeometry = buildPrintGeometry({
    rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 },
    requestedPaperGeometry: { orientation: 'portrait' },
    userRotation: { degrees: 0 },
  })
  assert.equal(printGeometry.effectiveRotation, 270)

  // documentState 故意带 user rotation=0，证明 Factory 取 effectiveRotation 而非 documentState
  const documentState = {
    pageSize: { w: 3508, h: 2480 },
    pageOrientation: 'portrait',
    rotation: 0,
  }
  const cmd = buildRenderCommand(paperLayout, documentState, null, printGeometry)
  assert.equal(cmd.contentRotation, 270, 'contentRotation === printGeometry.effectiveRotation')
  assert.equal(cmd.contentRotation, printGeometry.effectiveRotation, 'Factory 直接转发 canonical，不重新计算')
})

test('R-A2: 3-arg调用（无 printGeometry）走 legacy shim = documentState.rotation（preview 兼容 B-11）', () => {
  const paperLayout = makePaperLayout()
  const documentState = {
    pageSize: { w: 1240, h: 1754 },
    pageOrientation: 'portrait',
    rotation: 90,
  }
  // 不传第 4 参 → 旧 shim（生产路径不可达，但 preview / compose() 仍依赖）
  const cmd = buildRenderCommand(paperLayout, documentState)
  assert.equal(cmd.contentRotation, 90, 'legacy shim 使用 documentState.rotation，preview 行为不变')
})

test('R-A3: composePlans 经 fileObjToComposePagePlan 注入 printGeometry → 自动旋转进入 RenderCommand', () => {
  const paperLayout = makePaperLayout()
  // 横内容 + portrait 纸，无 user rotation → effectiveRotation=270 应进入打印 RenderCommand
  const plans = [fileObjToComposePagePlan(
    { id: 'f1', docId: 'doc-A', width: 3508, height: 2480 },
    0,
    { width: 3508, height: 2480 },
    'portrait',
  )]
  assert.ok(plans[0].printGeometry, 'plan 挂载了 printGeometry')
  assert.equal(plans[0].printGeometry.effectiveRotation, 270)

  const result = composePlans({ paperLayout, plans, ticketCount: 1 })
  assert.equal(result.length, 1)
  assert.equal(result[0].renderCommand.contentRotation, 270, '自动旋转经 seam 进入打印 RenderCommand')
})

test('R-A4: paperLandscape 不受 effectiveRotation 影响（D3 物理纸事实）', () => {
  const paperLayout = makePaperLayout()
  const printGeometry = buildPrintGeometry({
    rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 },
    requestedPaperGeometry: { orientation: 'portrait' },
    userRotation: { degrees: 0 },
  })
  const cmd = buildRenderCommand(paperLayout, { pageSize: { w: 3508, h: 2480 }, pageOrientation: 'portrait' }, null, printGeometry)
  // A4 portrait → paperLandscape=false，即便 effectiveRotation=270 也不翻转
  assert.equal(cmd.paperLandscape, false, 'paperLandscape 恒为物理纸方向，与 effectiveRotation 无关')
})
