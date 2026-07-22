// Commit 2 前端模型单测（Node 22 内置 node:test，零依赖，纯 ESM）
// 运行：node --test frontend/src/export/excelExport.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EXCEL_COLUMNS, ALL_KEYS, VIRTUAL_KEYS, visibleColumns } from './excelColumns.js'
import { getInvoiceIdentity, groupInvoiceRows } from './invoiceIdentity.js'
import { computeTotals, countInvoices } from './excelTotals.js'

// 后端 _db_record_to_export 实际产出的 row key 集合（Commit 1 已锁定，同源保证）
const BACKEND_ROW_KEYS = new Set([
  'serialNo', 'invoiceType', 'invoiceNumber', 'invoiceDate',
  'buyerName', 'buyerTaxNo', 'sellerName', 'sellerTaxNo',
  'amountWithoutTax', 'taxAmount', 'totalAmount', 'amountDx',
  'note', 'issuer', 'originalFilename',
  'xmmc', 'ggxh', 'unit', 'quantity', 'unitPrice',
  'lineAmount', 'taxRate', 'lineTax', 'classificationCode',
])

test('EXCEL_COLUMNS 共 23 项，ALL_KEYS 与数组长度一致', () => {
  assert.equal(EXCEL_COLUMNS.length, 23)
  assert.equal(ALL_KEYS.length, 23)
  assert.deepEqual(ALL_KEYS, EXCEL_COLUMNS.map((c) => c.key))
})

test('serialNo 为虚拟列，开票人已在清单（序号在销售方税号后、分类编码前）', () => {
  const serial = EXCEL_COLUMNS.find((c) => c.key === 'serialNo')
  assert.equal(serial.virtual, true)
  assert.deepEqual(VIRTUAL_KEYS, ['serialNo'])
  assert.ok(ALL_KEYS.includes('issuer'), '开票人应在可勾选清单')
  const keys = EXCEL_COLUMNS.map((c) => c.key)
  assert.ok(keys.indexOf('issuer') > keys.indexOf('sellerTaxNo'), '开票人应在销售方税号之后')
  assert.ok(keys.indexOf('issuer') < keys.indexOf('classificationCode'), '开票人应在分类编码之前')
})

test('所有列 key 必须与后端 row key 一致（同源保证，防止预览空白）', () => {
  for (const key of ALL_KEYS) {
    assert.ok(BACKEND_ROW_KEYS.has(key), `列 ${key} 不在后端 row key 集合中`)
  }
})

test('getInvoiceIdentity 三态：发票号 → 原文件名 → __ANON_{index}', () => {
  assert.equal(getInvoiceIdentity({ invoiceNumber: '123' }), '123')
  assert.equal(getInvoiceIdentity({ invoiceNumber: '', originalFilename: 'a.pdf' }), 'a.pdf')
  assert.equal(getInvoiceIdentity({}, 5), '__ANON_5')
  // 空号不同 index 必须不同（否则去重/共X张错乱）
  assert.notEqual(getInvoiceIdentity({}, 5), getInvoiceIdentity({}, 6))
})

test('computeTotals：发票级去重 + 行级全加', () => {
  const rows = [
    { invoiceNumber: 'A', amountWithoutTax: 100, taxAmount: 10, totalAmount: 110, lineAmount: 60, lineTax: 6 },
    { invoiceNumber: 'A', amountWithoutTax: 100, taxAmount: 10, totalAmount: 110, lineAmount: 40, lineTax: 4 },
    { invoiceNumber: 'B', amountWithoutTax: 200, taxAmount: 20, totalAmount: 220, lineAmount: 200, lineTax: 20 },
  ]
  const cols = EXCEL_COLUMNS.filter((c) =>
    ['amountWithoutTax', 'taxAmount', 'totalAmount', 'lineAmount', 'lineTax'].includes(c.key))
  const t = computeTotals(rows, cols)
  assert.equal(t.amountWithoutTax, 300) // A(100)+B(200)，A 第二行去重
  assert.equal(t.taxAmount, 30)
  assert.equal(t.totalAmount, 330)
  assert.equal(t.lineAmount, 300) // 60+40+200 全加
  assert.equal(t.lineTax, 30)
})

test('countInvoices 唯一发票数', () => {
  const rows = [
    { invoiceNumber: 'A' },
    { invoiceNumber: 'A' },
    { invoiceNumber: 'B' },
    { invoiceNumber: '', originalFilename: 'x.pdf' }, // 空号但有文件名 → 计 1 张
  ]
  assert.equal(countInvoices(rows), 3)
})

test('visibleColumns 保持规范顺序（A,B,D 勾 C → A,B,C,D）', () => {
  const vis = visibleColumns(new Set(['invoiceType', 'invoiceDate', 'invoiceNumber']))
  assert.deepEqual(vis.map((c) => c.key), ['invoiceType', 'invoiceDate', 'invoiceNumber'])
  // 乱序传入也应回到规范序
  const vis2 = visibleColumns(new Set(['invoiceNumber', 'serialNo', 'invoiceType']))
  assert.deepEqual(vis2.map((c) => c.key), ['serialNo', 'invoiceType', 'invoiceNumber'])
})

test('groupInvoiceRows：多行明细按发票身份分组，顺序与去重同 getInvoiceIdentity', () => {
  // 同发票 A 两行明细 → 1 组 2 行；发票 B 一行 → 1 组 1 行
  const rows = [
    { invoiceNumber: 'A', xmmc: 'a1' },
    { invoiceNumber: 'A', xmmc: 'a2' },
    { invoiceNumber: 'B', xmmc: 'b1' },
  ]
  const groups = groupInvoiceRows(rows)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].length, 2)
  assert.equal(groups[1].length, 1)
  assert.deepEqual(groups[0].map((r) => r.xmmc), ['a1', 'a2'])

  // 分组数必须与 countInvoices 一致（预览 rowspan 组数 = 导出分组数 = 共X张）
  assert.equal(groups.length, countInvoices(rows))

  // 首现顺序：B 在前也应保持 B 组的首现位置
  const rows2 = [
    { invoiceNumber: 'B' },
    { invoiceNumber: 'A' },
    { invoiceNumber: 'A' },
  ]
  const g2 = groupInvoiceRows(rows2)
  assert.equal(g2.length, 2)
  assert.deepEqual(g2[0].map((r) => r.invoiceNumber), ['B'])
  assert.deepEqual(g2[1].map((r) => r.invoiceNumber), ['A', 'A'])

  // 空号不同文件 → 不同组（不跨发票合并）
  const rows3 = [
    { originalFilename: 'x.pdf' },
    { originalFilename: 'y.pdf' },
  ]
  assert.equal(groupInvoiceRows(rows3).length, 2)
})
