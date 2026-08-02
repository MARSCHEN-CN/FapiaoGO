/**
 * documentSelector.test.js — Commit 3: DocumentSelector 收敛点验证
 *
 * 锁定：
 *   - selectDocumentRows：装配结果优先、搜索态/无装配退回 groupFilesByDocument，
 *     且搜索态使用 filteredFiles。
 *   - selectParsedFiles：status === 'parsed' 单一判定入口（取代散落 files.filter）。
 *   - getDocumentFiles：按 docId 取成员页（取代散落 files.filter(docId)）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  selectDocumentRows,
  selectParsedFiles,
  getDocumentFiles,
} from './documentSelector.js'
import { groupFilesByDocument } from './groupDocuments.js'

function makeFile(over = {}) {
  return { key: over.key || `k_${Math.random()}`, name: 'f.pdf', status: 'parsed', docId: undefined, pageNum: null, ...over }
}

test('selectDocumentRows: 非搜索态 + 装配结果 → 直接返回 InvoiceDocument[]', () => {
  const invoiceDocs = [{ docId: 'd1', _pageKeys: ['a', 'b'] }, { docId: 'd2', _pageKeys: ['c'] }]
  const files = [makeFile({ key: 'a' }), makeFile({ key: 'b' }), makeFile({ key: 'c' })]
  const rows = selectDocumentRows({ invoiceDocs, files, filteredFiles: [], isSearching: false })
  assert.deepEqual(rows, invoiceDocs)
})

test('selectDocumentRows: 搜索态 → 无视装配结果，退回 groupFilesByDocument(filteredFiles)', () => {
  const invoiceDocs = [{ docId: 'd1', _pageKeys: ['a'] }]
  const files = [makeFile({ key: 'a', docId: 'd1' }), makeFile({ key: 'b', docId: 'd2' })]
  const filteredFiles = [makeFile({ key: 'a', docId: 'd1' })] // 搜索只命中 d1
  const rows = selectDocumentRows({ invoiceDocs, files, filteredFiles, isSearching: true })
  // 搜索态强制 page-level；不应返回 invoiceDocs
  assert.notDeepEqual(rows, invoiceDocs)
  assert.deepEqual(rows, groupFilesByDocument(filteredFiles))
})

test('selectDocumentRows: 无装配结果 → 退回 groupFilesByDocument(files)', () => {
  const files = [makeFile({ key: 'a', docId: 'd1' }), makeFile({ key: 'b', docId: 'd2' })]
  const rows = selectDocumentRows({ invoiceDocs: [], files, filteredFiles: [], isSearching: false })
  assert.deepEqual(rows, groupFilesByDocument(files))
})

test('selectDocumentRows: invoiceDocs 为 null/undefined → 安全退回', () => {
  const files = [makeFile({ key: 'a' })]
  assert.deepEqual(selectDocumentRows({ invoiceDocs: null, files, isSearching: false }), groupFilesByDocument(files))
  assert.deepEqual(selectDocumentRows({ files, isSearching: false }), groupFilesByDocument(files))
})

test('selectParsedFiles: 仅保留 status === "parsed"', () => {
  const files = [
    makeFile({ key: 'a', status: 'parsed' }),
    makeFile({ key: 'b', status: 'parsing' }),
    makeFile({ key: 'c', status: 'parsed' }),
    makeFile({ key: 'd', status: 'error' }),
  ]
  const parsed = selectParsedFiles(files)
  assert.deepEqual(parsed.map((f) => f.key), ['a', 'c'])
})

test('selectParsedFiles: 空/非数组安全', () => {
  assert.deepEqual(selectParsedFiles([]), [])
  assert.deepEqual(selectParsedFiles(null), [])
  assert.deepEqual(selectParsedFiles(undefined), [])
})

test('getDocumentFiles: 按 docId 取成员页', () => {
  const files = [
    makeFile({ key: 'a', docId: 'd1' }),
    makeFile({ key: 'b', docId: 'd1' }),
    makeFile({ key: 'c', docId: 'd2' }),
    makeFile({ key: 'e', docId: undefined }),
  ]
  const docs = getDocumentFiles('d1', files)
  assert.deepEqual(docs.map((f) => f.key), ['a', 'b'])
  // docId 缺失 / 非数组 → 安全返回空
  assert.deepEqual(getDocumentFiles('nope', files), [])
  assert.deepEqual(getDocumentFiles('d1', null), [])
  assert.deepEqual(getDocumentFiles(undefined, files), [])
})
