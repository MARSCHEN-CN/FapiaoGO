import { strict as assert } from 'node:assert'
import { mergePendingUpdate } from '../../src/utils/pendingUpdate.js'

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('  PASS', name)
}

// T1: reproduce original data-chain bug - empty extra must not wipe rich fields
check('T1 rich fields survive a later empty-extra update', () => {
  const a = mergePendingUpdate(undefined, 'parsed', { invoiceType: 'A', amount: 100 })
  assert.deepStrictEqual(a, { newStatus: 'parsed', extra: { invoiceType: 'A', amount: 100 } })
  const b = mergePendingUpdate(a, 'parsed', {})
  assert.deepStrictEqual(b.extra, { invoiceType: 'A', amount: 100 }, 'empty extra wiped rich fields')
  assert.strictEqual(b.newStatus, 'parsed')
})

// T2: later top-level field overrides earlier; new keys added
check('T2 later top-level field overrides + merge', () => {
  const a = mergePendingUpdate(undefined, 'parsed', { a: 1, keep: 'x' })
  const b = mergePendingUpdate(a, 'parsed', { a: 2, b: 3 })
  assert.deepStrictEqual(b.extra, { a: 2, keep: 'x', b: 3 })
})

// T3: status transitions update; payload retained
check('T3 status updates while payload retained', () => {
  const a = mergePendingUpdate(undefined, 'parsing', {})
  const b = mergePendingUpdate(a, 'parsed', { x: 1 })
  assert.strictEqual(b.newStatus, 'parsed')
  assert.deepStrictEqual(b.extra, { x: 1 })
})

// T4: nested object REPLACES (not deep-merge) - critical semantic
check('T4 nested object replaced, not deep-merged', () => {
  const a = mergePendingUpdate(undefined, 'parsed', { meta: { a: 1 } })
  const b = mergePendingUpdate(a, 'parsed', { meta: { b: 2 } })
  assert.deepStrictEqual(b.extra, { meta: { b: 2 } }, 'nested object should replace wholesale')
})

// T5: fresh init (no previous)
check('T5 fresh init no previous', () => {
  const a = mergePendingUpdate(undefined, 'parsing', {})
  assert.deepStrictEqual(a, { newStatus: 'parsing', extra: {} })
  const c = mergePendingUpdate(undefined, 'parsed', { only: 1 })
  assert.deepStrictEqual(c, { newStatus: 'parsed', extra: { only: 1 } })
})

// T6: missing status keeps previous status; extra merges
check('T6 missing status keeps previous', () => {
  const a = mergePendingUpdate({ newStatus: 'parsing', extra: {} }, undefined, { y: 2 })
  assert.strictEqual(a.newStatus, 'parsing', 'status lost when not provided')
  assert.deepStrictEqual(a.extra, { y: 2 })
})

console.log('\nALL ' + passed + ' MERGE TESTS PASSED')
