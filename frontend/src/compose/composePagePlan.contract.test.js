/**
 * composePagePlan.contract.test.js — 13-E.1 边界冻结契约（对齐 13-D invoiceAssemblyContract）
 * 运行：node --loader ./env-shim.loader.mjs --test src/compose/composePagePlan.contract.test.js
 *
 * 锁死三件事：
 *  1. ComposePagePlan v1 不含 render/preview/canvas/blob 字段（不引入第三个事实源）
 *  2. source 携带 docId/pageId（身份不丢失）
 *  3. placement.slot 不被注入几何（身份层与几何层隔离；slot 不应知道来源）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileObjToComposePagePlan, documentStateToPlan } from './composePagePlan.js'

const FORBIDDEN = ['previewImage', 'preview_image', 'canvas', 'blob', 'render']

function assertNoForbidden(node, path = 'root') {
  if (node === null || node === undefined) return
  if (typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((n, i) => assertNoForbidden(n, `${path}[${i}]`))
    return
  }
  for (const key of Object.keys(node)) {
    assert.ok(!FORBIDDEN.includes(key), `ComposePagePlan 禁止字段 "${key}" @ ${path}`)
    assertNoForbidden(node[key], `${path}.${key}`)
  }
}

test('contract: ComposePagePlan v1 无 render/preview/canvas/blob 字段', () => {
  const plan = fileObjToComposePagePlan({ id: 'x', docId: 'd', width: 10, height: 20 }, 0, { width: 10, height: 20 }, 'portrait')
  assertNoForbidden(plan)
})

test('contract: source 携带 docId/pageId', () => {
  const plan = documentStateToPlan({ docId: 'd1', pageId: 'd1#p1' }, 0)
  assert.ok(plan.source, 'source 必须存在')
  assert.equal(plan.source.docId, 'd1')
  assert.equal(plan.source.pageId, 'd1#p1')
})

test('contract: placement.slot 不被注入几何（隔离身份层与几何层）', () => {
  const plan = fileObjToComposePagePlan({ id: 'x', docId: 'd' }, 0, null, 'portrait')
  assert.equal(plan.placement.slot, null, 'v1 不把 slot 几何塞进 plan')
})
