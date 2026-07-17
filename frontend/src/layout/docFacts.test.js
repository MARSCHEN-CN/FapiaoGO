import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeInitialDocFacts, normalizeRotation, shouldAppendPageSuffix } from './docFacts.js'

test('normalizeRotation: 归一化到 0/90/180/270', () => {
  assert.equal(normalizeRotation(0), 0)
  assert.equal(normalizeRotation(90), 90)
  assert.equal(normalizeRotation(360), 0)
  assert.equal(normalizeRotation(450), 90)
  assert.equal(normalizeRotation(-90), 270)
  assert.equal(normalizeRotation('invalid'), 0)
})

test('无记录 → 推导天然方向，isAuto=true，shouldPersist=true（Initialize Once 写回）', () => {
  const r = computeInitialDocFacts(null, 'landscape')
  assert.equal(r.paperOrientation, 'landscape')
  assert.equal(r.contentRotation, 0)
  assert.equal(r.isAuto, true)
  assert.equal(r.shouldPersist, true)
})

test('无记录且天然方向为 null → 回落 portrait', () => {
  const r = computeInitialDocFacts(null, null)
  assert.equal(r.paperOrientation, 'portrait')
  assert.equal(r.isAuto, true)
})

test('有记录(portrait) → 返回记录，isAuto=false', () => {
  const r = computeInitialDocFacts({ paperOrientation: 'portrait', contentRotation: 0 }, 'landscape')
  assert.equal(r.paperOrientation, 'portrait')
  assert.equal(r.contentRotation, 0)
  assert.equal(r.isAuto, false)
  assert.equal(r.shouldPersist, false)
})

test('shouldAppendPageSuffix: pageCount>1 => true', () => {
  assert.equal(shouldAppendPageSuffix({ pageCount: 2 }), true)
  assert.equal(shouldAppendPageSuffix({ pageCount: 10 }), true)
})

test('shouldAppendPageSuffix: pageCount<=1 => false', () => {
  assert.equal(shouldAppendPageSuffix({ pageCount: 1 }), false)
  assert.equal(shouldAppendPageSuffix({ pageCount: 0 }), false)
})

test('shouldAppendPageSuffix: null/undefined/missing => false', () => {
  assert.equal(shouldAppendPageSuffix(null), false)
  assert.equal(shouldAppendPageSuffix(undefined), false)
  assert.equal(shouldAppendPageSuffix({}), false)
})

test('有记录(landscape) + contentRotation=90 → 原样返回', () => {
  const r = computeInitialDocFacts({ paperOrientation: 'landscape', contentRotation: 90 }, 'portrait')
  assert.equal(r.paperOrientation, 'landscape')
  assert.equal(r.contentRotation, 90)
  assert.equal(r.isAuto, false)
})

test('记录 paperOrientation 非法 → 视为无记录，回落天然方向', () => {
  const r = computeInitialDocFacts({ paperOrientation: 'auto' }, 'landscape')
  assert.equal(r.paperOrientation, 'landscape')
  assert.equal(r.isAuto, true)
  assert.equal(r.shouldPersist, true)
})
