/**
 * parseRunner.test.js — Commit 5.0 (B3): 单文件多页 assembly transport 透传
 *
 * 锁定：
 *   - 多页 per-page fileObj（带 sourceDocId / pageNum(0-based) / totalPages）
 *     经 runParseTask 调 /parse_invoice 时，FormData 必须携带
 *     source_doc_id / page_num / total_pages（snake_case，匹配 Phase C）。
 *   - pageNum=0（首页）必须保真，不能因 truthy 判断被丢弃。
 *   - 单页 fileObj（无 sourceDocId）不携带上述字段 → 走 legacy（Phase C 条件 False）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 安装 fetch mock，捕获请求体（FormData）
let capturedFormData = null
let capturedUrl = null
global.fetch = async (url, opts) => {
  capturedUrl = String(url)
  capturedFormData = opts && opts.body ? opts.body : null
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      invoice_type: 'vat',
      invoice_number: 'INV1',
      amount: '100.00',
      invoice_date: '2026-01-01',
    }),
  }
}

const { runParseTask } = await import('./parseRunner.js')

function makeFileObj(over = {}) {
  return {
    name: 'test.pdf',
    file: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }),
    ...over,
  }
}

test('B3-多页: 透传 source_doc_id / page_num(含 0) / total_pages', async () => {
  capturedFormData = null
  const f = makeFileObj({ sourceDocId: 'doc-abc', pageNum: 0, totalPages: 2 })
  await runParseTask({ fileObj: f }, { ipc: {}, autoOrient: true })

  assert.ok(capturedFormData, 'fetch 应被调用且携带 FormData')
  assert.match(capturedUrl, /\/parse_invoice$/)
  assert.equal(capturedFormData.get('source_doc_id'), 'doc-abc')
  assert.equal(capturedFormData.get('page_num'), '0') // 首页 pageNum=0 必须保真
  assert.equal(capturedFormData.get('total_pages'), '2')
})

test('B3-单页: 不携带 source_doc_id（保持 legacy）', async () => {
  capturedFormData = null
  const f = makeFileObj() // 无 sourceDocId / totalPages
  await runParseTask({ fileObj: f }, { ipc: {}, autoOrient: true })

  assert.ok(capturedFormData)
  assert.equal(capturedFormData.get('source_doc_id'), null)
  assert.equal(capturedFormData.get('page_num'), null)
  assert.equal(capturedFormData.get('total_pages'), null)
})

test('B3-首页边界: pageNum=0 不被 truthy 判断丢弃', async () => {
  capturedFormData = null
  const f = makeFileObj({ sourceDocId: 'doc-x', pageNum: 0, totalPages: 3 })
  await runParseTask({ fileObj: f }, { ipc: {}, autoOrient: true })

  assert.equal(capturedFormData.get('page_num'), '0')
  assert.equal(capturedFormData.get('total_pages'), '3')
  assert.equal(capturedFormData.get('source_doc_id'), 'doc-x')
})
