/**
 * invoiceAssemblyContract.test.js — 13-D.1 防护测试
 *
 * 锁定的契约：
 *   PageParseResult[] → InvoiceDocument → FileCardRow
 *   产出的对象图中 MUST NOT 携带 previewImage / preview_image / canvas / blob。
 *
 * 目的：任何把旧 preview_image / canvas 渲染链路 merge 回来的提交，
 *       这个测试会立即报警（递归扫描整个对象图）。
 *
 * 这是 node:test 版本（会硬失败），区别于 branch 里的 console.assert 风格
 * invoiceDocumentViewModel.test.js（只打印不抛错）。
 *
 * @module utils/invoiceAssemblyContract.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDocument, createPageMeta } from '../models/InvoiceDocument.js'
import { invoiceDocumentToRow, invoiceDocumentsToRows } from './invoiceDocumentViewModel.js'

// 禁止字段：旧 preview_image / canvas / blob 渲染链路的残留痕迹
const FORBIDDEN = ['previewImage', 'preview_image', 'canvas', 'blob']

/**
 * 递归扫描对象图，命中禁止字段即抛错。
 * @param {*} obj
 * @param {string} path
 */
function assertNoForbidden(obj, path = '$') {
  if (obj === null || typeof obj !== 'object') return
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNoForbidden(v, `${path}[${i}]`))
    return
  }
  for (const key of Object.keys(obj)) {
    assert.ok(
      !FORBIDDEN.includes(key),
      `禁止字段 "${key}" 出现在 ${path} —— 应为 docId-first 模型，禁止 preview_image/canvas/blob 回退`,
    )
    assertNoForbidden(obj[key], `${path}.${key}`)
  }
}

/**
 * 模拟后端 assemble(PageParseResult[]) 产出的前端 InvoiceDocument。
 * 形状对齐 invoiceDocumentViewModel 的期望：docId / sourceDocId / pages[] / _pageKeys。
 */
function fakeAssembledDocument(docId, sourceDocId, pageKeys) {
  const pages = pageKeys.map((_, i) =>
    createPageMeta({ docId, index: i, width: 2480, height: 3508, sourceRotation: 0 }),
  )
  return {
    docId,
    sourceDocId,
    invoiceNumber: '001',
    pages,
    _pageKeys: pageKeys,
  }
}

function makeFile(key, docId, pageNum) {
  return { key, docId, pageNum, name: `invoice_p${pageNum}.pdf`, status: 'parsed' }
}

test('InvoiceDocument 模型本身不含预览/画布字段', () => {
  const doc = createDocument({
    docId: 'd1',
    pages: [createPageMeta({ docId: 'd1', index: 0 })],
  })
  assertNoForbidden(doc)
  assert.equal(doc.docId, 'd1')
  assert.equal(doc.pages.length, 1)
})

test('多页 InvoiceDocument → group 行，且行内无 previewImage/canvas/blob', () => {
  const doc = fakeAssembledDocument('doc-002', 'src-002', ['k2-p0', 'k2-p1'])
  const files = [makeFile('k2-p0', 'src-002', 1), makeFile('k2-p1', 'src-002', 2)]
  const row = invoiceDocumentToRow(doc, files)
  assert.ok(row, '应返回条目')
  assert.equal(row._isDocumentGroup, true)
  assert.equal(row._pageCount, 2)
  // 核心契约断言：整个行对象图禁止预览/画布字段
  assertNoForbidden(row)
  assertNoForbidden(row._pages)
})

test('PageParseResult[] 组装后的文档经 viewModel 不产生 preview_image 回退', () => {
  const docs = [
    fakeAssembledDocument('doc-a', 'src-a', ['ka']),
    fakeAssembledDocument('doc-b', 'src-b', ['kb-p0', 'kb-p1']),
  ]
  const files = [
    makeFile('ka', 'src-a', 1),
    makeFile('kb-p0', 'src-b', 1),
    makeFile('kb-p1', 'src-b', 2),
  ]
  const rows = invoiceDocumentsToRows(docs, files)
  assert.equal(rows.length, 2)
  rows.forEach((r) => assertNoForbidden(r))
})

test('无匹配文件 → 返回 null（异常态不污染 UI）', () => {
  const doc = fakeAssembledDocument('doc-x', 'src-x', ['kx'])
  const row = invoiceDocumentToRow(doc, [])
  assert.equal(row, null)
})

test('契约合约字段齐备：InvoiceDocument 持有组装身份+业务号，row 保留文件身份', () => {
  const doc = fakeAssembledDocument('doc-c', 'src-c', ['kc'])
  // InvoiceDocument（assemble 产出）持有组装 identity + 业务号 + pages[]
  assert.equal(doc.docId, 'doc-c')
  assert.equal(doc.invoiceNumber, '001')
  assert.ok(Array.isArray(doc.pages) && doc.pages.length === 1)

  const files = [makeFile('kc', 'src-c', 1)]
  const row = invoiceDocumentToRow(doc, files)
  assert.ok(row, '应返回条目')
  // FileCardRow 保留的是文件（source）身份 docId，而非组装 identity —— 设计意图
  assert.equal(row.docId, 'src-c')
  // 单页 document → row 直接是 fileObj（无 _isDocumentGroup，无 pages 包装）
  assert.equal(row._isDocumentGroup, undefined)
})
