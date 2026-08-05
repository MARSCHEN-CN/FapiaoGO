import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupFilesByDocument, restoreOriginalName } from './groupDocuments.js'
import {
  buildDocumentViewModel,
  buildDocumentDuplicateInfo,
  documentIdentityKey,
} from './documentViewModel.js'

// ── 夹具：模拟 buildFileObj 产出的拆分页 ──
// IS-4.3 严格约束：拆分页必须同时具备 sourceDocId + totalPages + pageNum
// 才能被视为多页文档的一部分。
let seq = 0
function page(sourceDocId, pageNum, extra = {}) {
  seq += 1
  return {
    key: `key-${seq}`,
    name: extra.name ?? `invoice_p${pageNum}.pdf`,
    docId: extra.docId ?? sourceDocId,
    sourceDocId,
    totalPages: extra.totalPages ?? null,
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
test('Case 1: 同一 sourceDocId 的 3 页 → 聚合为 1 个 document（共3页）', () => {
  const files = [page('AAA', 1, { totalPages: 3 }), page('AAA', 2, { totalPages: 3 }), page('AAA', 3, { totalPages: 3 })]
  const docs = groupFilesByDocument(files)

  assert.equal(docs.length, 1)
  assert.equal(docs[0]._isDocumentGroup, true)
  assert.equal(docs[0]._pageCount, 3)
  assert.equal(docs[0].name, 'invoice.pdf') // 还原原始文件名
  assert.deepEqual(docs[0]._pages.map(p => p.pageNum), [1, 2, 3])
  assert.equal(docs[0].key, files[0].key) // representative = pageNum 最小页
})

// ───────────────────────── Case 2：两份相同内容的 2 页发票 ─────────────────────────
// 相同 sourceDocId 但 pageNum 重复（两个 p1、两个 p2）→ 必须拆分为两个独立 document。
test('Case 2: 相同 sourceDocId 的两份 2 页导入 → 2 个 document（各共2页，非共4页）', () => {
  const files = [
    page('AAA', 1, { name: 'A_p1.pdf', totalPages: 2 }),
    page('AAA', 2, { name: 'A_p2.pdf', totalPages: 2 }),
    page('AAA', 1, { name: 'B_p1.pdf', totalPages: 2 }),
    page('AAA', 2, { name: 'B_p2.pdf', totalPages: 2 }),
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
    page('AAA', 1, { totalPages: 2 }), page('AAA', 2, { totalPages: 2 }),
    page('AAA', 1, { totalPages: 2 }), page('AAA', 2, { totalPages: 2 }),
    page('AAA', 1, { totalPages: 2 }), page('AAA', 2, { totalPages: 2 }),
  ]
  const docs = groupFilesByDocument(files)
  assert.equal(docs.length, 3)
  assert.ok(docs.every(d => d._pageCount === 2))
})

test('Case 2c: 乱序到达（p1,p1,p2,p2）仍按 pageNum 唯一性正确分区', () => {
  const files = [
    page('AAA', 1, { name: 'A_p1.pdf', totalPages: 2 }),
    page('AAA', 1, { name: 'B_p1.pdf', totalPages: 2 }),
    page('AAA', 2, { name: 'A_p2.pdf', totalPages: 2 }),
    page('AAA', 2, { name: 'B_p2.pdf', totalPages: 2 }),
  ]
  const docs = groupFilesByDocument(files)
  assert.equal(docs.length, 2)
  assert.deepEqual(docs[0]._pages.map(p => p.pageNum), [1, 2])
  assert.deepEqual(docs[1]._pages.map(p => p.pageNum), [1, 2])
  // 实例 A 收 p1(A)+p2(A)：按 files[] 顺序分配，第一个不冲突实例
  assert.equal(docs[0]._pages[0].name, 'A_p1.pdf')
  assert.equal(docs[0]._pages[1].name, 'A_p2.pdf')
})

// ───────────────────────── Case 3：重复检测（无 invoiceDocs 时不聚合，按页检测） ─────────────────────────
test('Case 3: 无 invoiceDocs 时每页独立 → 4 页同号 = 4 个文档', () => {
  const files = [
    page('AAA', 1, { invoiceNumber: '123', totalPages: 2 }),
    page('AAA', 2, { invoiceNumber: '123', totalPages: 2 }),
    page('BBB', 1, { invoiceNumber: '123', totalPages: 2 }),
    page('BBB', 2, { invoiceNumber: '123', totalPages: 2 }),
  ]
  const vm = buildDocumentViewModel(files)
  assert.equal(vm.documentCount, 4, '无 invoiceDocs 时每页独立')
  // 4 页同号 → 重复检测按 invoiceNumber 分组 → 1 组重复，4 个条目
  assert.equal(vm.duplicateGroups.size, 1)
})

test('Case 3b: 无 invoiceDocs 时每页独立 → 同源 4 页仍为 4 个文档', () => {
  const files = [
    page('AAA', 1, { invoiceNumber: '123', totalPages: 2 }),
    page('AAA', 2, { invoiceNumber: '123', totalPages: 2 }),
    page('AAA', 1, { invoiceNumber: '123', totalPages: 2 }),
    page('AAA', 2, { invoiceNumber: '123', totalPages: 2 }),
  ]
  const vm = buildDocumentViewModel(files)
  assert.equal(vm.documentCount, 4, '无 invoiceDocs 不聚合')
})

test('Case 3c: 无 invoiceDocs 时 3 页同号发票 → 3 个独立文档', () => {
  const files = [
    page('AAA', 1, { invoiceNumber: '123', totalPages: 3 }),
    page('AAA', 2, { invoiceNumber: '123', totalPages: 3 }),
    page('AAA', 3, { invoiceNumber: '123', totalPages: 3 }),
  ]
  const vm = buildDocumentViewModel(files)
  assert.equal(vm.documentCount, 3, '无 invoiceDocs 不聚合为 1')
})

// ───────────────────────── 统计：金额按文档（无 invoiceDocs 时按页） ─────────────────────────
test('统计: 无 invoiceDocs 时 3 页各 amount=100 → totalAmount=300（按页累加）', () => {
  const files = [
    page('AAA', 1, { amount: '100', totalPages: 3 }),
    page('AAA', 2, { amount: '100', totalPages: 3 }),
    page('AAA', 3, { amount: '100', totalPages: 3 }),
  ]
  const vm = buildDocumentViewModel(files)
  assert.equal(vm.totalAmount, 300, '无 invoiceDocs 不聚合，按页累加')
})

test('统计: 无 invoiceDocs 时 4 页各 amount=100 → totalAmount=400', () => {
  const files = [
    page('AAA', 1, { amount: '100', totalPages: 2 }),
    page('AAA', 2, { amount: '100', totalPages: 2 }),
    page('AAA', 1, { amount: '100', totalPages: 2 }),
    page('AAA', 2, { amount: '100', totalPages: 2 }),
  ]
  const vm = buildDocumentViewModel(files)
  assert.equal(vm.documentCount, 4, '无 invoiceDocs 不聚合')
  assert.equal(vm.totalAmount, 400, '无 invoiceDocs 按页累加')
})

// ───────────────────────── 非拆分页 passthrough 与混排 ─────────────────────────
// 非拆分页路径：补齐 identity contract（originalName + documentId），
// 为此需要创建新对象（与分组路径行为一致）。不再保证引用透传。
test('非拆分页: 补齐 originalName/documentId identity contract', () => {
  const s = single()
  const docs = groupFilesByDocument([s])
  assert.equal(docs.length, 1)
  // identity contract：originalName 必须存在（导出主键）
  assert.equal(docs[0].originalName, s.name)
  // documentId 来自 f.docId（无 docId 的单页文件为 undefined，属允许状态）
  assert.equal(docs[0].documentId, s.docId)
  assert.equal(docs[0].status, 'parsed')
  assert.equal(docs[0].name, s.name)
})

test('非拆分页: 已有 originalName 的文件保持不变（reference pass-through）', () => {
  const s = single({ name: 'pre_named.pdf' })
  s.originalName = 'pre_named.pdf'
  s.documentId = 'DOC-X'
  const docs = groupFilesByDocument([s])
  // 已有完整 identity contract → 透传原引用（不意外 clone）
  assert.equal(docs[0], s)
})

test('混排: 多页 document + 单页文件，顺序保持（document 出现在首页位置）', () => {
  const s1 = single({ name: 'x.jpg' })
  const p1 = page('AAA', 1, { totalPages: 2 })
  const p2 = page('AAA', 2, { totalPages: 2 })
  const s2 = single({ name: 'y.jpg' })
  const docs = groupFilesByDocument([s1, p1, p2, s2])
  assert.equal(docs.length, 3)
  assert.equal(docs[0].originalName, 'x.jpg')
  assert.equal(docs[1]._isDocumentGroup, true)
  assert.equal(docs[1]._pageCount, 2)
  assert.equal(docs[1].originalName, 'invoice_p1.pdf') // rep.name
  assert.equal(docs[1].documentId, 'AAA')
  assert.equal(docs[2].originalName, 'y.jpg')
})

// ───────────────────────── restoreOriginalName ─────────────────────────
test('restoreOriginalName: _pN 后缀还原', () => {
  assert.equal(restoreOriginalName('invoice_p1.pdf'), 'invoice.pdf')
  assert.equal(restoreOriginalName('report_2024_p12.pdf'), 'report_2024.pdf')
  assert.equal(restoreOriginalName('single.jpg'), 'single.jpg')
})

// ───────────────────────── 0-based pageNum（buildFileObj 保留 page_index=0） ─────────────────────────
test('0-based pageNum: pageNum=0,1,2 正确聚合为 3 页 document', () => {
  const files = [
    page('BBB', 0, { name: 'first.pdf', totalPages: 3 }),
    page('BBB', 1, { name: 'second.pdf', totalPages: 3 }),
    page('BBB', 2, { name: 'third.pdf', totalPages: 3 })
  ]
  const docs = groupFilesByDocument(files)

  assert.equal(docs.length, 1)
  assert.equal(docs[0]._isDocumentGroup, true)
  assert.equal(docs[0]._pageCount, 3)
  // 排序按 pageNum 升序，0-based: 0, 1, 2
  assert.deepEqual(docs[0]._pages.map(p => p.pageNum), [0, 1, 2])
  assert.equal(docs[0]._pages[0].name, 'first.pdf')
  assert.equal(docs[0].key, files[0].key)
})

test('0-based pageNum: pageNum=0 的首页不被过滤（非 null 合法）', () => {
  // IS-4.3 严格约束：pageNum=0 是合法页码，应参与分组
  const files = [
    page('CCC', 0, { name: 'p1.pdf', totalPages: 2 }),
    page('CCC', 1, { name: 'p2.pdf', totalPages: 2 }),
  ]
  const docs = groupFilesByDocument(files)

  assert.equal(docs.length, 1)
  assert.equal(docs[0]._pageCount, 2)
  assert.equal(docs[0]._pages[0].name, 'p1.pdf')
  assert.equal(docs[0]._pages[1].name, 'p2.pdf')
})

// ───────────────────────── 合并模式：InvoiceDocument 覆盖 + 剩余文件补全 ─────────────────────────
// 场景：先前 session 留下的 page-level 文件仍在 FileContext.files 中，
// 但当前 session.documents（InvoiceDocument）只覆盖最近一次导入的文件。
// buildDocumentViewModel 必须合并两路来源，保证旧文件仍可见。
function makeInvoiceDoc(docId, pageKeys, amount = '', invoiceDate = '') {
  return {
    docId,
    instanceId: docId,
    _pageKeys: pageKeys,
    pages: pageKeys.map((_, i) => ({ index: i })),
    amount,
    invoiceDate,
  }
}

test('合并模式：invoiceDocs 覆盖 A，files 中 B 被补全返回（单页）', () => {
  // A 由 InvoiceDocument 覆盖；B 只有 page-level 记录（旧 session 遗留）
  const fileA = single({ name: 'A.pdf', invoiceNumber: '001', amount: '100' })
  const fileB = single({ name: 'B.pdf', invoiceNumber: '002', amount: '200' })
  const files = [fileA, fileB]
  const invoiceDocs = [makeInvoiceDoc('inv-A', [fileA.key], '100')]

  const vm = buildDocumentViewModel(files, invoiceDocs)

  assert.equal(vm.documents.length, 2, 'A 与 B 均应出现在列表中')
  assert.equal(vm.documentCount, 2)
  const names = vm.documents.map((d) => d.name)
  assert.ok(names.includes('A.pdf'), 'A 应在列表中')
  assert.ok(names.includes('B.pdf'), 'B 应在列表中（补全路径）')
})

test('合并模式：invoiceDocs 覆盖多页组，未覆盖的单页文件仍显示', () => {
  const p1 = page('AAA', 1, { name: 'multi_p1.pdf', invoiceNumber: 'N1', amount: '300', totalPages: 2 })
  const p2 = page('AAA', 2, { name: 'multi_p2.pdf', invoiceNumber: 'N1', amount: '300', totalPages: 2 })
  const lone = single({ name: 'lone.pdf', invoiceNumber: 'N2', amount: '50' })
  const files = [p1, p2, lone]
  const invoiceDocs = [makeInvoiceDoc('inv-multi', [p1.key, p2.key], '300')]

  const vm = buildDocumentViewModel(files, invoiceDocs)

  assert.equal(vm.documents.length, 2)
  const group = vm.documents.find((d) => d._isDocumentGroup)
  assert.ok(group, '多页 InvoiceDocument 应为分组条目')
  assert.equal(group._pageCount, 2)
  assert.ok(vm.documents.some((d) => d.name === 'lone.pdf'), '未覆盖的 lone.pdf 应通过补全路径显示')
})

test('合并模式：无 invoiceDocs 时每页独立展示（不再退回 groupFilesByDocument）', () => {
  const files = [
    page('AAA', 1, { totalPages: 2 }), page('AAA', 2, { totalPages: 2 }),
    single({ name: 's.pdf' }),
  ]
  const vm = buildDocumentViewModel(files)

  assert.equal(vm.documents.length, 3, '无 invoiceDocs 每页独立 → 3 个条目')
  assert.ok(!vm.documents.some((d) => d._isDocumentGroup), '无 invoiceDocs 不产生 _isDocumentGroup 条目')
})

test('合并模式：invoiceDocs 覆盖所有文件时，补全路径产出 0 条（无重复）', () => {
  const p1 = page('AAA', 1, { name: 'p1.pdf', totalPages: 2 })
  const p2 = page('AAA', 2, { name: 'p2.pdf', totalPages: 2 })
  const files = [p1, p2]
  const invoiceDocs = [makeInvoiceDoc('inv-A', [p1.key, p2.key], '100')]

  const vm = buildDocumentViewModel(files, invoiceDocs)

  assert.equal(vm.documents.length, 1, '全部被 InvoiceDocument 覆盖时不应出现重复条目')
})

// ───────────────────────── Export Identity Regression Tests ─────────────────────────
// These tests lock down the fix for: multi-page different invoices → Excel export
// must produce distinct backend lookup keys (originalName), not display names.
//
// BEFORE the fix:
//   groupFilesByDocument output had name="invoice.pdf" (restored) but NO originalName.
//   extractExportFileNames fell back to name → ["invoice.pdf", "invoice.pdf"].
//   Backend _resolve_invoice_with_fallback matched both to the same DB record → duplicates.
//
// AFTER the fix:
//   groupFilesByDocument output has name="invoice.pdf" AND originalName="invoice_p1.pdf".
//   extractExportFileNames uses originalName → ["invoice_p1_A.pdf", "invoice_p1_B.pdf"].
//   Backend lookup finds two distinct records → correct export.

test('回归: 两张不同多页发票导出不合并（同 displayName 不同 originalName）', () => {
  // 两张不同发票：displayName 都为 "invoice.pdf"，但原始文件名不同
  const invA_p1 = page('DOC-A', 1, { name: 'A_invoice_p1.pdf', totalPages: 2 })
  const invA_p2 = page('DOC-A', 2, { name: 'A_invoice_p2.pdf', totalPages: 2 })
  const invB_p1 = page('DOC-B', 1, { name: 'B_invoice_p1.pdf', totalPages: 2 })
  const invB_p2 = page('DOC-B', 2, { name: 'B_invoice_p2.pdf', totalPages: 2 })
  const files = [invA_p1, invA_p2, invB_p1, invB_p2]

  const docs = groupFilesByDocument(files)

  // Step 1: 两个独立 document 条目
  assert.equal(docs.length, 2, '应有 2 个独立 document 条目')

  // Step 2: 每条都有 originalName（导出身份），且互不相同
  assert.ok(docs[0].originalName, '第一个文档应有 originalName')
  assert.ok(docs[1].originalName, '第二个文档应有 originalName')
  assert.notEqual(
    docs[0].originalName,
    docs[1].originalName,
    '两个文档的 originalName 必须不同（否则后端会误命中同一记录）',
  )

  // Step 3: originalName 是代表页的原始文件名（不是还原后的显示名）
  assert.equal(docs[0].originalName, 'A_invoice_p1.pdf')
  assert.equal(docs[1].originalName, 'B_invoice_p1.pdf')

  // Step 4: name 字段已还原为显示名（不含 _p 后缀）
  assert.equal(docs[0].name, 'A_invoice.pdf')
  assert.equal(docs[1].name, 'B_invoice.pdf')

// Step 5: 验证导出身份提取逻辑（与 ExportService.extractExportFileNames 一致）
  const exportNames = docs
    .map((d) => d.originalName || d.name || '')
    .filter(Boolean)
  assert.equal(exportNames.length, 2, '应导出 2 个文件')
  assert.deepEqual(
    exportNames.sort(),
    ['A_invoice_p1.pdf', 'B_invoice_p1.pdf'],
    '导出文件名必须是原始页文件名（非还原后的显示名）',
  )
})

test('回归: 两张发票 displayName 完全相同时，originalName 仍可区分', () => {
  // 极端场景：两份文件 basename 相同（如从不同目录导入的 invoice.pdf）
  const invA_p1 = page('DOC-A', 1, { name: 'invoice_p1.pdf', totalPages: 2 })
  const invA_p2 = page('DOC-A', 2, { name: 'invoice_p2.pdf', totalPages: 2 })
  const invB_p1 = page('DOC-B', 1, { name: 'invoice_p1.pdf', totalPages: 2 })
  const invB_p2 = page('DOC-B', 2, { name: 'invoice_p2.pdf', totalPages: 2 })
  const files = [invA_p1, invA_p2, invB_p1, invB_p2]

  const docs = groupFilesByDocument(files)
  assert.equal(docs.length, 2)

  // displayName 相同（都还原为 "invoice.pdf"）
  assert.equal(docs[0].name, 'invoice.pdf')
  assert.equal(docs[1].name, 'invoice.pdf')

  // 但 originalName 也相同（因为代表页文件名相同）——这暴露了 filename-based
  // 导出 identity 的天花板：相同物理文件名的不同文档无法仅靠文件名区分。
  // 此测试记录该限制，作为 P2（documentId 持久化）的输入。
  console.log('[Export Regression] 相同文件名场景:', {
    docA_originalName: docs[0].originalName,
    docB_originalName: docs[1].originalName,
    note: '当物理文件名完全相同时，filename 导出 identity 无法区分，需 P2 documentId 方案解决',
  })

  // P2 TODO: 未来应断言 extractExportTargets 返回 [{documentId: 'DOC-A'}, {documentId: 'DOC-B'}]
})
