import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyFileUpdate, canTransition, VALID_TRANSITION } from './fileStateTransitions.js'

// ── 核心回归：解析数据不应因状态机中间态竞争而丢失 ──────────────
// 场景：缓存命中时 ready->parsed 跨过 parsing，迁移非法但 payload 必须保留
test('ready + parsed payload + invalid transition preserves payload', () => {
  const file = { key: 'k1', name: 'a.pdf', status: 'ready', invoiceDate: '' }
  const update = {
    newStatus: 'parsed',
    extra: { invoiceDate: '2024-03-28', amount: '71.71', invoiceNumber: '2444' },
  }
  const out = applyFileUpdate(file, update)

  // payload 全部落地（这是修复前会丢失的部分）
  assert.equal(out.invoiceDate, '2024-03-28')
  assert.equal(out.amount, '71.71')
  assert.equal(out.invoiceNumber, '2444')
  // 状态机非法迁移：保留旧 status，不向前跳
  assert.equal(out.status, 'ready')
})

// ── 合法迁移：payload 合并且 status 推进 ───────────────────
test('parsing + parsed valid transition updates status and merges payload', () => {
  const file = { key: 'k1', name: 'a.pdf', status: 'parsing' }
  const update = { newStatus: 'parsed', extra: { invoiceDate: '2024-03-28' } }
  const out = applyFileUpdate(file, update)
  assert.equal(out.status, 'parsed')
  assert.equal(out.invoiceDate, '2024-03-28')
})

// ── 正常路径：ready -> parsing 合法 ───────────────────────
test('ready + parsing valid transition', () => {
  const file = { key: 'k1', status: 'ready' }
  const out = applyFileUpdate(file, { newStatus: 'parsing', extra: {} })
  assert.equal(out.status, 'parsing')
})

// ── 上传初始态 -> ready 合法 ─────────────────────────────
test('uploading + ready valid transition', () => {
  const file = { key: 'k1', status: 'uploading' }
  const out = applyFileUpdate(file, { newStatus: 'ready', extra: { docId: 'd1' } })
  assert.equal(out.status, 'ready')
  assert.equal(out.docId, 'd1')
})

// ── 回退应被阻止（且不丢 payload）─────────────────────────
test('parsed + uploading rollback rejected but payload still merged', () => {
  const file = { key: 'k1', status: 'parsed', invoiceDate: '2024-03-28' }
  const out = applyFileUpdate(file, { newStatus: 'uploading', extra: { amount: '10' } })
  assert.equal(out.status, 'parsed') // 阻止回退
  assert.equal(out.amount, '10')     // payload 仍合并
})

// ── 无 update 原样返回 ───────────────────────────────────
test('no update returns file unchanged', () => {
  const file = { key: 'k1', status: 'ready' }
  assert.equal(applyFileUpdate(file, null), file)
  assert.equal(applyFileUpdate(file, undefined), file)
})

// ── canTransition 白名单 ─────────────────────────────────
test('canTransition honors VALID_TRANSITION whitelist', () => {
  assert.equal(canTransition('ready', 'parsing'), true)
  assert.equal(canTransition('ready', 'parsed'), false)
  assert.equal(canTransition('parsing', 'parsed'), true)
  assert.equal(canTransition('parsed', 'uploading'), false)
  assert.equal(canTransition('uploading', 'ready'), true)
  // 未知源状态视为允许（不阻断新状态接入）
  assert.equal(canTransition('unknown-state', 'parsed'), true)
  // 契约不变量：VALID_TRANSITION 必须存在且为对象
  assert.ok(typeof VALID_TRANSITION === 'object' && VALID_TRANSITION !== null)
})
