/**
 * composePagePlan.test.js — 13-E.1 B-lite 单元验证
 * 运行：node --loader ./env-shim.loader.mjs --test src/compose/composePagePlan.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileObjToComposePagePlan, documentStateToPlan } from './composePagePlan.js'

test('fileObjToComposePagePlan: derives docId from item.docId when present', () => {
  const item = { id: 'f1', docId: 'doc-abc', width: 100, height: 200, pageIndex: 0 }
  const plan = fileObjToComposePagePlan(item, 0, { width: 100, height: 200 }, 'portrait')
  assert.equal(plan.source.docId, 'doc-abc')
  assert.equal(plan.source.pageId, 'doc-abc#p1')
  assert.equal(plan.documentState.pageSize.w, 100)
  assert.equal(plan.documentState.pageOrientation, 'portrait') // 100<200
  assert.equal(plan.placement.slot, null)
})

test('fileObjToComposePagePlan: falls back to id when docId missing', () => {
  const item = { id: 'f9', key: 'k9', width: 300, height: 100 }
  const plan = fileObjToComposePagePlan(item, 2, null, 'landscape')
  assert.equal(plan.source.docId, 'f9')
  assert.equal(plan.source.pageId, 'f9#p3') // index 2 → +1 = 3
})

test('fileObjToComposePagePlan: honors rotations override from caller', () => {
  const item = { id: 'f1', docId: 'd1', width: 100, height: 100 }
  const plan = fileObjToComposePagePlan(item, 0, null, 'portrait', { f1: 90 })
  assert.equal(plan.documentState.rotation, 90)
})

test('fileObjToComposePagePlan: never throws on sparse item', () => {
  const plan = fileObjToComposePagePlan({}, 0, null, 'portrait')
  assert.ok(plan.source)
  assert.equal(plan.placement.slot, null)
})

test('documentStateToPlan: carries source only when docId+pageId present', () => {
  const withId = documentStateToPlan({ docId: 'd1', pageId: 'd1#p1', pageSize: { w: 1, h: 1 } }, 0)
  assert.deepEqual(withId.source, { docId: 'd1', pageId: 'd1#p1' })
  const without = documentStateToPlan({ pageSize: { w: 1, h: 1 } }, 0)
  assert.equal(without.source, null)
})
