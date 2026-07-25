/**
 * MultiTicketComposer.composePlans.test.js — 13-E.1 composePlans 验收
 * 运行：node --loader ./env-shim.loader.mjs --test src/layout/MultiTicketComposer.composePlans.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePaperLayout } from '../previewState.js'
import { composePlans, compose } from './MultiTicketComposer.js'
import { fileObjToComposePagePlan } from '../compose/composePagePlan.js'

function makePaperLayout() {
  return computePaperLayout({ paperSize: 'A4', margins: { top: 0, right: 0, bottom: 0, left: 0 } })
}

test('composePlans: RenderCommand 携带 meta 来源身份', () => {
  const paperLayout = makePaperLayout()
  const items = [
    { id: 'f1', docId: 'doc-A', width: 1240, height: 1754 },
    { id: 'f2', docId: 'doc-B', width: 1240, height: 1754 },
  ]
  const plans = items.map((it, i) =>
    fileObjToComposePagePlan(it, i, { width: it.width, height: it.height }, 'portrait'))
  const result = composePlans({ paperLayout, plans, ticketCount: 2 })
  assert.equal(result.length, 2)
  assert.equal(result[0].renderCommand.meta.docId, 'doc-A')
  assert.equal(result[0].renderCommand.meta.pageId, 'doc-A#p1') // index 0 → #p1
  assert.equal(result[1].renderCommand.meta.docId, 'doc-B')
  assert.equal(result[1].renderCommand.meta.pageId, 'doc-B#p2') // index 1 → #p2（pageIndex 缺失时退化为 index+1）
})

test('composePlans: 几何同构保持（clip/scale 与旧 compose 一致）', () => {
  const paperLayout = makePaperLayout()
  const plans = [{ source: null, placement: { slot: null }, documentState: { pageSize: { w: 1240, h: 1754 }, pageOrientation: 'portrait', rotation: 0 } }]
  const result = composePlans({ paperLayout, plans, ticketCount: 1 })
  assert.equal(result.length, 1)
  const cmd = result[0].renderCommand
  assert.ok(cmd.placement.scale > 0)
  assert.equal(cmd.clip.width, paperLayout.usableRect.w)
})

test('compose: 兼容入口仍返回 {documentState, renderCommand} 且 meta 为 null（无 identity）', () => {
  const paperLayout = makePaperLayout()
  const documents = [{ pageSize: { w: 1240, h: 1754 }, rotation: 0 }]
  const result = compose({ paperLayout, documents })
  assert.equal(result.length, 1)
  assert.ok(result[0].documentState, '保留 documentState 字段（旧消费方兼容）')
  assert.equal(result[0].renderCommand.meta, null, '无 identity 时 meta 为 null')
})

test('composePlans: 空 plans → 空数组', () => {
  const paperLayout = makePaperLayout()
  assert.deepEqual(composePlans({ paperLayout, plans: [] }), [])
  assert.deepEqual(composePlans({ paperLayout, plans: null }), [])
})
