/**
 * InvoiceDocumentViewModel 单元测试
 *
 * 验收 3 个 Case：
 *   Case 1: 单页 document → 1 条非 group 条目
 *   Case 2: 多页 document → 1 条 group 条目（_isDocumentGroup=true, _pageCount=2）
 *   Case 3: 多 document → 多条对应条目
 */

import { invoiceDocumentToRow, invoiceDocumentsToRows } from './invoiceDocumentViewModel.js'

// ── 测试夹具 ──────────────────────────────────────────

function makePageFile(key, docId, pageNum) {
  return {
    key,
    docId,
    pageNum,
    name: `invoice_p${pageNum}.pdf`,
    status: 'parsed',
    invoiceNumber: '001',
    invoiceType: '专票',
    amount: '1000',
    invoiceDate: '2026-07-25',
  }
}

function makeInvoiceDocument(docId, pageCount) {
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    index: i,
    pageId: `${docId}:p${i}`,
    width: 2480,
    height: 3508,
    sourceRotation: 0,
  }))
  return {
    docId,
    fileKey: '',
    sourceHash: '',
    pageCount,
    pages,
  }
}

// ── Case 1: 单页 document ────────────────────────────

console.log('=== Case 1: 单页 document → 1 条非 group 条目 ===')

const doc1 = makeInvoiceDocument('doc-001', 1)
const files1 = [makePageFile('k1', 'doc-001', 1)]

const row1 = invoiceDocumentToRow(doc1, files1)
console.assert(row1 !== null, '[Case 1] 应返回条目')
console.assert(row1.key === 'k1', '[Case 1] key 匹配')
console.assert(!row1._isDocumentGroup, '[Case 1] 不应是 group')
console.assert(row1.invoiceNumber === '001', '[Case 1] invoiceNumber 透出')
console.log('  ✅ 单页 → 1 条非 group: pass')

// ── Case 2: 多页同 document ──────────────────────────

console.log('\n=== Case 2: 两页同票 → 1 条 group 条目 ===')

const doc2 = makeInvoiceDocument('doc-002', 2)
const files2 = [
  makePageFile('k2-p0', 'doc-002', 1),
  makePageFile('k2-p1', 'doc-002', 2),
]

const row2 = invoiceDocumentToRow(doc2, files2)
console.assert(row2 !== null, '[Case 2] 应返回条目')
console.assert(row2._isDocumentGroup === true, '[Case 2] 应是 group')
console.assert(row2._pageCount === 2, '[Case 2] _pageCount=2')
console.assert(Array.isArray(row2._pages), '[Case 2] _pages 是数组')
console.assert(row2._pages.length === 2, '[Case 2] _pages 长度=2')
console.assert(row2._pages[0].key === 'k2-p0', '[Case 2] 第一页 key 匹配')
console.assert(row2._pages[1].key === 'k2-p1', '[Case 2] 第二页 key 匹配')
console.assert(row2.name === 'invoice.pdf', '[Case 2] name 已还原（无 _p1 后缀）')
console.log('  ✅ 多页 → 1 条 group: pass')

// ── Case 3: 多 document ──────────────────────────────

console.log('\n=== Case 3: 多个 document → 多条条目 ===')

const doc3a = makeInvoiceDocument('doc-003a', 1)
const doc3b = makeInvoiceDocument('doc-003b', 1)
const doc3c = makeInvoiceDocument('doc-003c', 2)
const files3 = [
  makePageFile('k3a', 'doc-003a', 1),
  makePageFile('k3b', 'doc-003b', 1),
  makePageFile('k3c-p0', 'doc-003c', 1),
  makePageFile('k3c-p1', 'doc-003c', 2),
]

const rows3 = invoiceDocumentsToRows([doc3a, doc3b, doc3c], files3)
console.assert(rows3.length === 3, '[Case 3] 应返回 3 条')
console.assert(rows3[0].key === 'k3a', '[Case 3] 第 1 条 key')
console.assert(!rows3[0]._isDocumentGroup, '[Case 3] 第 1 条非 group')
console.assert(rows3[1].key === 'k3b', '[Case 3] 第 2 条 key')
console.assert(!rows3[1]._isDocumentGroup, '[Case 3] 第 2 条非 group')
console.assert(rows3[2]._isDocumentGroup === true, '[Case 3] 第 3 条是 group')
console.assert(rows3[2]._pageCount === 2, '[Case 3] 第 3 条 _pageCount=2')
console.assert(rows3[2]._pages.length === 2, '[Case 3] 第 3 条 _pages 长度')
console.log('  ✅ 多 document → 多条条目: pass')

// ── 边界: 无匹配文件 ──────────────────────────────────

console.log('\n=== 边界: 无匹配 fileObj ===')

const docOrphan = makeInvoiceDocument('doc-orphan', 1)
const rowOrphan = invoiceDocumentToRow(docOrphan, [makePageFile('k-other', 'doc-other', 1)])
console.assert(rowOrphan === null, '[边界] 无匹配应返回 null')
console.log('  ✅ 无匹配 → null: pass')

// ── 边界: 空输入 ─────────────────────────────────────

console.log('\n=== 边界: 空输入 ===')

const empty1 = invoiceDocumentsToRows([], [])
console.assert(empty1.length === 0, '[边界] 空输入 → []')

const empty2 = invoiceDocumentsToRows(null, [])
console.assert(empty2.length === 0, '[边界] null → []')

const empty3 = invoiceDocumentsToRows([doc1], null)
console.assert(empty3.length === 0, '[边界] allFiles null → 0 条（无匹配文件）')
console.log('  ✅ 空输入 → 正确处理: pass')

console.log('\n=== 全部测试通过 ===')
