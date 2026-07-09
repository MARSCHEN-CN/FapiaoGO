import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPreviewCacheKey } from './previewCacheKey.js'

const doc = { fileKey: 'file1', rotation: 0 }

// 同一文档 + 同一布局 → key 稳定（可命中）
test('stable key for identical document+layout', () => {
  const layout = { paperSize: 'A4', isLandscape: false, mergeMode: 'none',
    customPaper: null, margins: { left: 3, right: 3, top: 3, bottom: 3 } }
  assert.equal(
    buildPreviewCacheKey(doc, layout),
    buildPreviewCacheKey(doc, layout)
  )
})

// 🔴 回归护栏：同文件在 A4 与 A3 下必须产生不同 key
// （这是真实 Bug 的根因——旧 key 仅含 fileKey+rotation，A4/A3 碰撞）
test('different paperSize => different key', () => {
  const base = { isLandscape: false, mergeMode: 'none', customPaper: null,
    margins: { left: 3, right: 3, top: 3, bottom: 3 } }
  const a4 = buildPreviewCacheKey(doc, { ...base, paperSize: 'A4' })
  const a3 = buildPreviewCacheKey(doc, { ...base, paperSize: 'A3' })
  assert.notEqual(a4, a3)
})

test('different margins => different key', () => {
  const base = { paperSize: 'A4', isLandscape: false, mergeMode: 'none', customPaper: null }
  const wide = buildPreviewCacheKey(doc, { ...base, margins: { left: 10, right: 10, top: 10, bottom: 10 } })
  const narrow = buildPreviewCacheKey(doc, { ...base, margins: { left: 3, right: 3, top: 3, bottom: 3 } })
  assert.notEqual(wide, narrow)
})

test('different rotation => different key', () => {
  const base = { paperSize: 'A4', isLandscape: false, mergeMode: 'none', customPaper: null,
    margins: { left: 3, right: 3, top: 3, bottom: 3 } }
  const r0 = buildPreviewCacheKey({ fileKey: 'file1', rotation: 0 }, base)
  const r90 = buildPreviewCacheKey({ fileKey: 'file1', rotation: 90 }, base)
  assert.notEqual(r0, r90)
})

test('different mergeMode => different key', () => {
  const base = { paperSize: 'A4', isLandscape: false, customPaper: null,
    margins: { left: 3, right: 3, top: 3, bottom: 3 } }
  const none = buildPreviewCacheKey(doc, { ...base, mergeMode: 'none' })
  const merge2 = buildPreviewCacheKey(doc, { ...base, mergeMode: 'merge2' })
  assert.notEqual(none, merge2)
})

test('different customPaper => different key', () => {
  const base = { paperSize: 'A4', isLandscape: false, mergeMode: 'none',
    margins: { left: 3, right: 3, top: 3, bottom: 3 } }
  const a4 = buildPreviewCacheKey(doc, { ...base, customPaper: { widthMM: 210, heightMM: 297 } })
  const custom = buildPreviewCacheKey(doc, { ...base, customPaper: { widthMM: 200, heightMM: 300 } })
  assert.notEqual(a4, custom)
})

// 布局字段缺失也不应抛错（兜底 0_0_0_0 / 空 customStr）
test('tolerates missing optional layout fields', () => {
  const key = buildPreviewCacheKey(doc, { paperSize: 'A4', isLandscape: false, mergeMode: 'none' })
  assert.match(key, /mg0_0_0_0/)
  assert.match(key, /c_/)
})
