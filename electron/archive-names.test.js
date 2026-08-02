'use strict'

/**
 * Commit 1b —— 压缩包命名冲突策略
 *
 * 背景：此前 resolveArchiveFileNames 无条件静默去重，同票多页在压缩包里变成
 * `12345678.pdf` / `12345678_1.pdf`，而重命名域产出的是 `_p2`。两域名字不一致，
 * 且 `_1` 落在哪一页取决于输入数组顺序，用户无法判断页序。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resolveArchiveFileNames } = require('./archive-names')

const f = (originalPath, targetName) => ({ originalPath, targetName })

test('宽松模式：保持历史行为，重名自动加 _1/_2', () => {
  const { resolved } = resolveArchiveFileNames([
    f('p1.pdf', '888.pdf'),
    f('p2.pdf', '888.pdf'),
    f('p3.pdf', '888.pdf'),
  ])
  assert.deepEqual(resolved.map(r => r.finalName), ['888.pdf', '888_1.pdf', '888_2.pdf'])
})

test('宽松模式：去重行为被上报，不再静默', () => {
  const { collisions } = resolveArchiveFileNames([
    f('p1.pdf', '888.pdf'),
    f('p2.pdf', '888.pdf'),
  ])
  assert.equal(collisions.length, 1)
  assert.deepEqual(collisions[0], { targetName: '888.pdf', finalName: '888_1.pdf' })
})

test('宽松模式：无冲突时 collisions 为空', () => {
  const { resolved, collisions } = resolveArchiveFileNames([
    f('p1.pdf', 'A.pdf'),
    f('p2.pdf', 'B.pdf'),
  ])
  assert.deepEqual(resolved.map(r => r.finalName), ['A.pdf', 'B.pdf'])
  assert.equal(collisions.length, 0)
})

test('严格模式：重名直接抛错，不产出语义错误的压缩包', () => {
  assert.throws(
    () => resolveArchiveFileNames(
      [f('p1.pdf', '888.pdf'), f('p2.pdf', '888.pdf')],
      { strict: true }
    ),
    /重复文件名/
  )
})

test('严格模式：错误信息指向上游命名规则，而非 archive 层', () => {
  try {
    resolveArchiveFileNames([f('a', 'X.pdf'), f('b', 'X.pdf')], { strict: true })
    assert.fail('应当抛错')
  } catch (e) {
    assert.match(e.message, /_p2/, '应提示多页发票需带页码后缀')
    assert.match(e.message, /命名规则/)
  }
})

test('严格模式：Document 域正确命名时顺利通过', () => {
  // buildDocumentPageNames 的产物形态
  const { resolved, collisions } = resolveArchiveFileNames(
    [f('p1.pdf', '12345678.pdf'), f('p2.pdf', '12345678_p2.pdf')],
    { strict: true }
  )
  assert.deepEqual(resolved.map(r => r.finalName), ['12345678.pdf', '12345678_p2.pdf'])
  assert.equal(collisions.length, 0)
})

test('页序无关性：宽松模式下 _1 归属取决于数组顺序（正是严格模式要消灭的现象）', () => {
  const forward = resolveArchiveFileNames([f('p1', '8.pdf'), f('p2', '8.pdf')]).resolved
  const reverse = resolveArchiveFileNames([f('p2', '8.pdf'), f('p1', '8.pdf')]).resolved
  assert.equal(forward.find(r => r.originalPath === 'p1').finalName, '8.pdf')
  assert.equal(reverse.find(r => r.originalPath === 'p1').finalName, '8_1.pdf')
  // 同一份物理页，两次结果不同 → 压缩包内页序不可辨。这是宽松模式的固有缺陷，
  // 因此业务层必须自行保证唯一并启用严格模式。
})

test('已占用名的连锁冲突：不会覆盖已存在的 _1', () => {
  const { resolved } = resolveArchiveFileNames([
    f('a', '8.pdf'),
    f('b', '8_1.pdf'),
    f('c', '8.pdf'),
  ])
  assert.deepEqual(resolved.map(r => r.finalName), ['8.pdf', '8_1.pdf', '8_2.pdf'])
  assert.equal(new Set(resolved.map(r => r.finalName)).size, 3, '不得出现重复 entry')
})

test('无扩展名文件也能正确去重', () => {
  const { resolved } = resolveArchiveFileNames([f('a', 'README'), f('b', 'README')])
  assert.deepEqual(resolved.map(r => r.finalName), ['README', 'README_1'])
})

test('空输入安全', () => {
  const { resolved, collisions } = resolveArchiveFileNames([])
  assert.deepEqual(resolved, [])
  assert.deepEqual(collisions, [])
})
