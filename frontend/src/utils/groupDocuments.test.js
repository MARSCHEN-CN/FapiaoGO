import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupFilesByDocument, restoreOriginalName } from './groupDocuments.js'
import {
  buildDocumentViewModel,
  buildDocumentDuplicateInfo,
  documentIdentityKey,
} from './documentViewModel.js'

// ── 夹具：模拟 buildFileObj 产出的拆分页（docId + pageNum 1-based） ──
let seq = 0
function page(docId, pageNum, extra = {}) {
  seq += 1
  return {
    key: `key-${seq}`,
    name: extra.name ?? `invoice_p${pageNum}.pdf`,
    docId,
    pageNum,
    status: 'parsed',
    invoiceNumber: extra.invoiceNumber ?? '',
    amount: extra.amount ?? '',
    ...extra,
  }
}

// 单页文件（图片 / OFD / 单页 PDF：无 docId + pageNum）
function single(extra = {}) {
  seq += 1
  return {
    key: `key-${seq}`,
    name: extra.name ?? 'single.jpg',
    status: 'parsed',
    invoiceNumber: extra.invoiceNumber ?? '',
    amount: extra.amount ?? '',
    ...extra,
  }
}

// ───────────────────────── Case 1：一张 3 页发票 ─────────────────────────
test('Case 1: 同一 docId 的 3 页 → 聚合为 1 个 document（共3页）', () => {
  const files = [page('AAA', 1), page('AAA', 2), page('AAA', 3)]
  const docs = groupFilesByDocument(files)

  assert.equal(docs.length, 1)
  assert.equal(docs[0]._isDocumentGroup, true)
  assert.equal(docs[0]._pageCount, 3)
  assert.equal(docs[0].name, 'invoice.pdf') // 还原原始文件名
  assert.deepEqual(docs[0]._pages.map(p => p.pageNum), [1, 2, 3])
  assert.equal(docs[0].key, files[0].key) // representative = pageNum 最小页
})

// ───────────────────────── Case 2：两份相同内容的 2 页发票 ─────────────────────────
// docId 是内容哈希（sha256(bytes)[:24]）：相同内容重复导入 → 相同 docId。
// pageNum 重复（两个 p1、两个 p2）→ 必须拆分为两个独立 document。
test('Case 2: 相同 docId 的两份 2 页导入 → 2 个 document（各共2页，非共4页）', () => {
  const files = [
    page('AAA', 1, { name: 'A_p1.pdf' }),
    page('AAA', 2, { name: 'A_p2.pdf' }),
    page('AAA', 1, { name: 'B_p1.pdf' }),
    page('AAA', 2, { name: 'B_p2.pdf' }),
  ]
  const docs = groupFilesByDocument(files)

  assert.equal(docs.length, 2)
  assert.equal(docs[0]._pageCount, 2)
  assert.equal(docs[1]._pageCount, 2)
  assert.deepEqual(docs[0]._pages.map(p => p.pageNum), [1, 2])
  assert.deepEqual(docs[1]._pages.map(p => p.pageNum), [1, 2])
  // 两个实例相互独立：不共享页对象
  const keys0 = new Set(docs[0]._pages.map(p => p.key))
  assert.ok(docs[1]._pages.every(p => !keys0.has(p.key)))
})

test('Case 2b: 三份相同内容的 2 页导入 → 3 个 document', () => {
  const files = [
    page('AAA', 1), page('AAA', 2),
    page('AAA', 1), page('AAA', 2),
    page('AAA', 1), page('AAA', 2),
  ]
  const docs = groupFilesByDocument(files)
  assert.equal(docs.length, 3)
  assert.ok(docs.every(d => d._pageCount === 2))
})

test('Case 2c: 乱序到达（p1,p1,p2,p2）仍按 pageNum 唯一性正确分区', () => {
  const files = [
    page('AAA', 1, { name: 'A_p1.pdf' }),
    page('AAA', 1, { name: 'B_p1.pdf' }),
    page('AAA', 2, { name: 'A_p2.pdf' }),
    page('AAA', 2, { name: 'B_p2.pdf' }),
  ]
  const docs = groupFilesByDocument(files)
  assert.equal(docs.length, 2)
  assert.deepEqual(docs[0]._pages.map(p => p.pageNum), [1, 2])
  assert.deepEqual(docs[1]._pages.map(p => p.pageNum), [1, 2])
  // 实例 A 收 p1(A)+p2(A)：按 files[] 顺序分配，第一个不冲突实例
  assert.equal(docs[0]._pages[0].name, 'A_p1.pdf')
  assert.equal(docs[0]._pages[1].name, 'A_p2.pdf')
})

// ───────────────────────── Case 3：重复检测仍按 invoiceNumber（document 级） ─────────────────────────
test('Case 3: 两个不同 docId、同号发票 → 1 组重复', () => {
  const files = [
    page('AAA', 1, { invoiceNumber: '123' }),
    page('AAA', 2, { invoiceNumber: '123' }),
    page('BBB', 1, { invoiceNumber: '123' }),
    page('BBB', 2, { invoiceNumber: '123' }),
  ]
  const vm = buildDocumentViewModel(files)
  assert.equal(vm.documentCount, 2)
  assert.equal(vm.duplicateGroups.size, 1)
  const group = [...vm.duplicateGroups.values()][0]
  assert.equal(group.length, 2) // 两个 document 条目
})

test('Case 3b: 相同内容的两份同号发票（同 docId）→ 仍检出 1 组重复', () => {
  const files = [
    page('AAA', 1, { invoiceNumber: '123' }),
    page('AAA', 2, { invoiceNumber: '123' }),
    page('AAA', 1, { invoiceNumber: '123' }),
    page('AAA', 2, { invoiceNumber: '123' }),
  ]
  const vm = buildDocumentViewModel(files)
  assert.equal(vm.documentCount, 2)
  assert.equal(vm.duplicateGroups.size, 1)

  // 重复组 badge 信息：两个实例都在 Map 中（uiKey 唯一，不互相覆盖）
  const info = buildDocumentDuplicateInfo(vm.duplicateGroups)
  const docs = vm.documents
  assert.equal(info.size, 2)
  assert.equal(info.get(documentIdentityKey(docs[0])).isFirst, true)
  assert.equal(info.get(documentIdentityKey(docs[1])).isFirst, false)
  assert.notEqual(documentIdentityKey(docs[0]), documentIdentityKey(docs[1]))
})

test('Case 3c: 一张 3 页发票（同号页）→ 不构成重复', () => {
  const files = [
    page('AAA', 1, { invoiceNumber: '123' }),
    page('AAA', 2, { invoiceNumber: '123' }),
    page('AAA', 3, { invoiceNumber: '123' }),
  ]
  const vm = buildDocumentViewModel(files)
  assert.equal(vm.documentCount, 1)
  assert.equal(vm.duplicateGroups.size, 0)
})

// ───────────────────────── 统计：金额按 document 计一次 ─────────────────────────
test('统计: 3 页发票每页 amount=100 → totalAmount=100（非 300）', () => {
  const files = [
    page('AAA', 1, { amount: '100' }),
    page('AAA', 2, { amount: '100' }),
    page('AAA', 3, { amount: '100' }),
  ]
  const vm = buildDocumentViewModel(files)
  assert.equal(vm.totalAmount, 100)
})

test('统计: 相同内容两份（各 2 页、amount=100）→ totalAmount=200', () => {
  const files = [
    page('AAA', 1, { amount: '100' }),
    page('AAA', 2, { amount: '100' }),
    page('AAA', 1, { amount: '100' }),
    page('AAA', 2, { amount: '100' }),
  ]
  const vm = buildDocumentViewModel(files)
  assert.equal(vm.documentCount, 2)
  assert.equal(vm.totalAmount, 200)
})

// ───────────────────────── 非拆分页 passthrough 与混排 ─────────────────────────
test('passthrough: 无 docId 的单页文件原样保留（引用不变）', () => {
  const s = single()
  const docs = groupFilesByDocument([s])
  assert.equal(docs.length, 1)
  assert.equal(docs[0], s) // 同一引用
})

test('混排: 多页 document + 单页文件，顺序保持（document 出现在首页位置）', () => {
  const s1 = single({ name: 'x.jpg' })
  const p1 = page('AAA', 1)
  const p2 = page('AAA', 2)
  const s2 = single({ name: 'y.jpg' })
  const docs = groupFilesByDocument([s1, p1, p2, s2])
  assert.equal(docs.length, 3)
  assert.equal(docs[0], s1)
  assert.equal(docs[1]._isDocumentGroup, true)
  assert.equal(docs[1]._pageCount, 2)
  assert.equal(docs[2], s2)
})

// ───────────────────────── restoreOriginalName ─────────────────────────
test('restoreOriginalName: _pN 后缀还原', () => {
  assert.equal(restoreOriginalName('invoice_p1.pdf'), 'invoice.pdf')
  assert.equal(restoreOriginalName('report_2024_p12.pdf'), 'report_2024.pdf')
  assert.equal(restoreOriginalName('single.jpg'), 'single.jpg')
})
