/**
 * exportRenderCommand.plan.test.js — 13-E.1 plan-native Export 入口验收
 * 运行：node --loader ./env-shim.loader.mjs --test src/layout/exportRenderCommand.plan.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildExportRenderCommandFromPlan } from './exportRenderCommand.js'

test('buildExportRenderCommandFromPlan: 附加 meta 来源身份', () => {
  const plan = {
    documentState: { sourceWidth: 1240, sourceHeight: 1754, contentRect: { x: 0, y: 0, width: 1240, height: 1754 }, rotation: 0 },
    source: { docId: 'doc-A', pageId: 'doc-A#p1' },
  }
  const rc = buildExportRenderCommandFromPlan(plan)
  assert.equal(rc.meta.docId, 'doc-A')
  assert.equal(rc.meta.pageId, 'doc-A#p1')
  assert.ok(rc.placement && typeof rc.placement.scale === 'number', 'RenderCommand 几何同构保持')
})

test('buildExportRenderCommandFromPlan: 无 source 时 meta 为 null', () => {
  const rc = buildExportRenderCommandFromPlan({
    documentState: { sourceWidth: 10, sourceHeight: 20, contentRect: { x: 0, y: 0, width: 10, height: 20 } },
  })
  assert.equal(rc.meta, null)
})
