/**
 * selectRenameDocuments — Rename 域文档选择契约测试
 *
 * 背景（2026-08-02 重命名链路审计）：
 *   同票多页在文件列表显示 1 条，但重命名预览显示 2 条且金额不同（1000 / 300）。
 *   根因：Rename 域自行调 groupFilesByDocument(files) 按 f.docId 归组，
 *   而 hydrateChunk 会把每页 docId 改写成各自的物理内容哈希 → 分组裂开。
 *
 * ⚠️ fixture 纪律（本项目已两次因违反它而产生假绿测试）：
 *   本文件的 fixture 必须复刻**生产态**数据形状，不得拼造上游不产出的字段：
 *     - 每页 docId 互不相同（hydrateChunk:720-724 的真实行为）
 *     - 首页 pageNum 为 null（buildFileObj 将 page_index=0 转为 null）
 *     - 每页携带自己的 amount（parse 结果就是页级的）
 *   前两次事故：backend/tests/test_invoice_assembly.py 手工注入了上游不存在的
 *   page_num；groupDocuments.test.js 假设多页共享父 docId。两者都恒绿。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { selectRenameDocuments } from './useRenamePack.js'
import { invoiceDocumentsToRows } from '../utils/invoiceDocumentViewModel.js'

/** 生产态：两页同票，docId 已被逐页改写，各自带页级 amount */
function makeProductionFiles() {
  return [
    {
      key: 'k1',
      name: 'invoice_p1.pdf',
      docId: 'HASH_PAGE_1',
      pageNum: null, // 首页：page_index=0 → null
      status: 'parsed',
      invoiceNumber: '12345678',
      amount: '1000.00',
      printPath: 'C:\\inv\\invoice_p1.pdf',
    },
    {
      key: 'k2',
      name: 'invoice_p2.pdf',
      docId: 'HASH_PAGE_2',
      pageNum: 1,
      status: 'parsed',
      invoiceNumber: '12345678',
      amount: '300.00',
      printPath: 'C:\\inv\\invoice_p2.pdf',
    },
  ]
}

/** 装配产出：_pageKeys 是页成员的强身份记录 */
function makeInvoiceDocs() {
  return [
    {
      docId: 'SRC_inv_12345678',
      sourceDocId: 'SRC',
      invoiceNumber: '12345678',
      pageCount: 2,
      _pageKeys: ['k1', 'k2'],
    },
  ]
}

test('装配结果可用时：同票两页 → 1 个重命名条目', () => {
  const files = makeProductionFiles()
  const rows = invoiceDocumentsToRows(makeInvoiceDocs(), files)

  const docs = selectRenameDocuments(rows, files)

  assert.equal(docs.length, 1, '同票多页必须聚合为一条重命名记录')
  assert.equal(docs[0]._isDocumentGroup, true)
  assert.equal(docs[0]._pageCount, 2)
  assert.equal(docs[0].name, 'invoice.pdf', '展示名应还原为原始文件名（去 _pN 后缀）')
})

test('装配结果可用时：条目携带完整 _pages，供 handleRenameConfirm 逐页改名', () => {
  const files = makeProductionFiles()
  const rows = invoiceDocumentsToRows(makeInvoiceDocs(), files)

  const [doc] = selectRenameDocuments(rows, files)

  // handleRenameConfirm 的多页分支依赖 _pages 才能给非首页加 _pN 后缀；
  // 缺了它会退化成只重命名首页 → 第二页物理文件被遗留。
  assert.ok(Array.isArray(doc._pages), '_pages 必须存在')
  assert.equal(doc._pages.length, 2)
  assert.deepEqual(
    doc._pages.map((p) => p.key),
    ['k1', 'k2'],
    '_pages 必须按 pageNum 升序（首页 pageNum=null 视为 0，不能被 || 1 排到后面）',
  )
  assert.ok(doc._pages.every((p) => p.printPath), '每页都要有物理路径才能重命名')
})

test('回归锁：旧路径（自行 group）在生产态数据下会裂成 2 条', () => {
  const files = makeProductionFiles()

  // 不传 documentRows → 退回 groupFilesByDocument，复现审计中的缺陷现象。
  // 这条断言不是「期望的正确行为」，而是锁住「为什么它只能当 fallback」：
  // 一旦有人把它改回主流程，上面两个用例会红。
  const docs = selectRenameDocuments(null, files)

  assert.equal(docs.length, 2, '旧分组按 docId 归组，逐页 docId 下必然裂开')
  assert.deepEqual(
    docs.map((d) => d.amount),
    ['1000.00', '300.00'],
    '裂开后每条带各自页的金额——这正是用户看到的两条不同金额',
  )
})

test('fallback：documentRows 为空数组时退回旧分组，不返回空结果', () => {
  const files = makeProductionFiles()

  // 历史 session / 装配尚未完成时 documentView.documents 可能为 []，
  // 此时必须降级而不是让重命名功能整体失效。
  assert.equal(selectRenameDocuments([], files).length, 2)
  assert.equal(selectRenameDocuments(undefined, files).length, 2)
})

test('只选取 status === parsed 的条目', () => {
  const files = [
    { key: 'a', name: 'ok.pdf', status: 'parsed', invoiceNumber: '1' },
    { key: 'b', name: 'bad.pdf', status: 'error', invoiceNumber: '2' },
    { key: 'c', name: 'wait.pdf', status: 'parsing', invoiceNumber: '3' },
  ]

  const docs = selectRenameDocuments(files, files)

  assert.equal(docs.length, 1)
  assert.equal(docs[0].key, 'a')
})

test('空输入不抛异常', () => {
  assert.deepEqual(selectRenameDocuments(null, []), [])
  assert.deepEqual(selectRenameDocuments(null, null), [])
  assert.deepEqual(selectRenameDocuments([], undefined), [])
})
