/**
 * Commit 2 验收：invoiceDocumentViewModel 的 Document 字段覆盖 Page 字段
 *
 * 业务规则（用户两次强调「不要默认」）：
 *   多页发票的金额/日期应以 assemble 合并结果为准，而非首页 pageObj 的解析值。
 *   - amount  = 末页金额（multi_page_merge: merged['amount'] = last.get('amount')）
 *   - invoiceDate = 首页开票日期（_FIRST_PAGE_KEYS 含 kprq）
 *
 * 此处验证 invoiceDocumentToRow 的多页分支：
 *   amount:     invoiceDoc.amount ?? rep.amount
 *   invoiceDate: invoiceDoc.invoiceDate ?? rep.invoiceDate
 * 即 Document 字段优先，缺失时回退 Page 字段（旧数据/历史 session 不回归）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { invoiceDocumentToRow } from './invoiceDocumentViewModel.js'

function makePageFile(key, pageNum, { amount = '1000', invoiceDate = '2026-07-25' } = {}) {
  return {
    key,
    docId: 'doc-002',
    pageNum,
    name: `invoice_p${pageNum}.pdf`,
    status: 'parsed',
    invoiceNumber: '001',
    invoiceType: '专票',
    amount,
    invoiceDate,
  }
}

function makeInvoiceDocument(overrides = {}) {
  return {
    docId: 'doc-002',
    fileKey: '',
    sourceHash: '',
    pageCount: 2,
    pages: [
      { index: 0, pageId: 'doc-002:p0' },
      { index: 1, pageId: 'doc-002:p1' },
    ],
    // 来自后端 assembled_documents（Commit 2 补全的业务字段）
    amount: overrides.amount,
    invoiceDate: overrides.invoiceDate,
    // 强身份页成员
    _pageKeys: ['k2-p0', 'k2-p1'],
  }
}

test('多页文档：Document.amount 覆盖首页 rep.amount（末页金额优先）', () => {
  // 首页 rep.amount = '1000'（pageObj 解析值），
  // assembled.amount = 300（末页金额），row 应为 300。
  const doc = makeInvoiceDocument({ amount: 300, invoiceDate: '2026-07-25' })
  const files = [
    makePageFile('k2-p0', 1, { amount: '1000' }),
    makePageFile('k2-p1', 2, { amount: '300' }),
  ]
  const row = invoiceDocumentToRow(doc, files)
  assert.equal(row._isDocumentGroup, true)
  assert.equal(row.amount, 300, 'Document 字段（末页金额）应覆盖首页 pageObj 金额')
})

test('多页文档：invoiceDate 同理覆盖（首页开票日期优先）', () => {
  const doc = makeInvoiceDocument({ amount: 300, invoiceDate: '2026-01-01' })
  const files = [
    makePageFile('k2-p0', 1, { invoiceDate: '2026-01-01' }),
    makePageFile('k2-p1', 2, { invoiceDate: '' }),
  ]
  const row = invoiceDocumentToRow(doc, files)
  assert.equal(row.invoiceDate, '2026-01-01')
})

test('Document 字段缺失时回退 Page 字段（旧数据不回归）', () => {
  // assembled 未下发 amount（旧 session / 历史数据）→ 用 rep.amount（首页）
  const doc = makeInvoiceDocument({ amount: undefined, invoiceDate: undefined })
  const files = [
    makePageFile('k2-p0', 1, { amount: '1000', invoiceDate: '2026-07-25' }),
    makePageFile('k2-p1', 2, { amount: '300', invoiceDate: '2026-07-26' }),
  ]
  const row = invoiceDocumentToRow(doc, files)
  assert.equal(row.amount, '1000', '无 Document 金额时回退首页 rep.amount')
  assert.equal(row.invoiceDate, '2026-07-25', '无 Document 日期时回退首页 rep.invoiceDate')
})

test('amount=0 是有效值，不应被 ?? 回退覆盖', () => {
  // 0 不是 null/undefined，?? 不触发回退
  const doc = makeInvoiceDocument({ amount: 0, invoiceDate: '2026-01-01' })
  const files = [
    makePageFile('k2-p0', 1, { amount: '1000' }),
    makePageFile('k2-p1', 2, { amount: '300' }),
  ]
  const row = invoiceDocumentToRow(doc, files)
  assert.equal(row.amount, 0)
})

test('单页文档：直接返回 fileObj（金额已是该页金额，无需覆盖）', () => {
  const doc = makeInvoiceDocument({ amount: 500 })
  doc.pageCount = 1
  doc.pages = [{ index: 0, pageId: 'doc-002:p0' }]
  doc._pageKeys = ['k-single']
  const files = [makePageFile('k-single', 1, { amount: '500' })]
  const row = invoiceDocumentToRow(doc, files)
  assert.equal(row.key, 'k-single')
  assert.equal(row.amount, '500')
})
