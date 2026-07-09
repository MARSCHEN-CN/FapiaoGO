import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripIdentity, IDENTITY_FIELDS } from './identity.js'

// 1) 剥离身份字段（key），保留业务字段
test('strips key but keeps business fields', () => {
  const input = { key: 'abc', docId: '123', amount: 100 }
  const out = stripIdentity(input)
  assert.deepEqual(out, { docId: '123', amount: 100 })
  // 不修改入参
  assert.equal(input.key, 'abc')
})

// 2) null / undefined 原样返回（避免后续消费方崩溃）
test('returns null/undefined as-is', () => {
  assert.equal(stripIdentity(null), null)
  assert.equal(stripIdentity(undefined), undefined)
})

// 3) 空对象安全
test('handles empty object', () => {
  assert.deepEqual(stripIdentity({}), {})
})

// 4) 身份字段集合一旦扩展，所有调用方自动受益（无需改调用点）
test('honors IDENTITY_FIELDS set', () => {
  const input = { key: 'k', id: 'i', docId: 'd' }
  const out = stripIdentity(input)
  assert.equal(out.key, undefined)   // key 是身份字段 → 剥离
  assert.equal(out.id, 'i')          // id 当前非身份字段 → 保留
  assert.equal(out.docId, 'd')       // docId 是业务字段 → 保留
  // 回归护栏：若有人误删 key，这里会先报警
  assert.ok(IDENTITY_FIELDS.includes('key'))
})
