import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractInvoiceYear,
  isPreviousYearFile,
  getPreviousYearInfo,
  FILE_ALERT_PRIORITY,
  resolveStatsMode,
  applySort,
  detectDuplicateInvoices,
} from '../utils.js'

// 固定当前年，避免系统时钟影响断言（测试运行于 2026 上下文）
const YEAR = 2026

// ───────────────────────── extractInvoiceYear ─────────────────────────
test('extractInvoiceYear: ISO 日期', () => {
  assert.equal(extractInvoiceYear('2024-01-01'), 2024)
})
test('extractInvoiceYear: 中文日期', () => {
  assert.equal(extractInvoiceYear('2024年01月01日'), 2024)
})
test('extractInvoiceYear: 斜杠日期', () => {
  assert.equal(extractInvoiceYear('2024/1/1'), 2024)
})
test('extractInvoiceYear: 点分隔日期', () => {
  assert.equal(extractInvoiceYear('2024.1.1'), 2024)
})
test('extractInvoiceYear: 未知日期 → null', () => {
  assert.equal(extractInvoiceYear('未知日期'), null)
})
test('extractInvoiceYear: 空 / undefined / null → null', () => {
  assert.equal(extractInvoiceYear(''), null)
  assert.equal(extractInvoiceYear(undefined), null)
  assert.equal(extractInvoiceYear(null), null)
})

// ───────────────────────── isPreviousYearFile ─────────────────────────
test('isPreviousYearFile: parsed + 2025-12-31 → true（跨年边界）', () => {
  assert.equal(isPreviousYearFile({ status: 'parsed', invoiceDate: '2025-12-31', key: 'a' }, YEAR), true)
})
test('isPreviousYearFile: parsed + 2026-01-01 → false（当年边界）', () => {
  assert.equal(isPreviousYearFile({ status: 'parsed', invoiceDate: '2026-01-01', key: 'a' }, YEAR), false)
})
test('isPreviousYearFile: parsed + 2027-01-01 → false（未来日期，防时钟错误）', () => {
  assert.equal(isPreviousYearFile({ status: 'parsed', invoiceDate: '2027-01-01', key: 'a' }, YEAR), false)
})
test('isPreviousYearFile: failed → false（未解析不参与判定）', () => {
  assert.equal(isPreviousYearFile({ status: 'failed', invoiceDate: '2024-01-01', key: 'a' }, YEAR), false)
})
test('isPreviousYearFile: 无日期 → false', () => {
  assert.equal(isPreviousYearFile({ status: 'parsed', invoiceDate: '未知日期', key: 'a' }, YEAR), false)
})

// ───────────────────────── getPreviousYearInfo ─────────────────────────
test('getPreviousYearInfo: 未解析文件 year=null, isPreviousYear=false（语义干净）', () => {
  const map = getPreviousYearInfo([
    { key: 'a', status: 'failed', invoiceDate: '2024-01-01' },
    { key: 'b', status: 'parsing', invoiceDate: '2023-05-05' },
  ], YEAR)
  assert.deepEqual(map.get('a'), { year: null, isPreviousYear: false })
  assert.deepEqual(map.get('b'), { year: null, isPreviousYear: false })
})
test('getPreviousYearInfo: 计数正确（仅已解析往年计入）', () => {
  const files = [
    { key: 'a', status: 'parsed', invoiceDate: '2025-01-01' }, // 往年
    { key: 'b', status: 'parsed', invoiceDate: '2026-01-01' }, // 当年
    { key: 'c', status: 'parsed', invoiceDate: '2024-03-03' }, // 往年
    { key: 'd', status: 'failed', invoiceDate: '2022-02-02' }, // 失败，不计入
    { key: 'e', status: 'parsed', invoiceDate: '未知日期' },   // 无年份
  ]
  const map = getPreviousYearInfo(files, YEAR)
  let count = 0
  map.forEach(v => { if (v.isPreviousYear) count++ })
  assert.equal(count, 2)
  assert.equal(map.get('a').isPreviousYear, true)
  assert.equal(map.get('c').isPreviousYear, true)
  assert.equal(map.get('e').year, null)
  assert.equal(map.get('e').isPreviousYear, false)
})

// ─────────────── FILE_ALERT_PRIORITY / resolveStatsMode ───────────────
test('FILE_ALERT_PRIORITY 顺序: failed > duplicate > previousYear', () => {
  assert.deepEqual(FILE_ALERT_PRIORITY, ['failed', 'duplicate', 'previousYear'])
})
test('resolveStatsMode: 有失败优先返回 failed', () => {
  assert.equal(resolveStatsMode({ hasFailed: true, previousYearCount: 3, duplicateCount: 2 }), 'failed')
})
test('resolveStatsMode: 无失败时 duplicate 优先于 previousYear', () => {
  assert.equal(resolveStatsMode({ hasFailed: false, previousYearCount: 2, duplicateCount: 5 }), 'duplicate')
})
test('resolveStatsMode: 仅有 previousYear 时返回 previousYear', () => {
  assert.equal(resolveStatsMode({ hasFailed: false, previousYearCount: 5, duplicateCount: 0 }), 'previousYear')
})
test('resolveStatsMode: 无告警返回 normal', () => {
  assert.equal(resolveStatsMode({ hasFailed: false, previousYearCount: 0, duplicateCount: 0 }), 'normal')
})

// ───────────────────────── applySort 分区置顶 ─────────────────────────
// 复刻调用点构建 info 的方式：detectDuplicateInvoices → Map，getPreviousYearInfo → Map
function buildInfos(files, year = YEAR) {
  const duplicates = detectDuplicateInvoices(files)
  const duplicateInfo = new Map()
  duplicates.forEach((dupFiles, groupIndex) => {
    dupFiles.forEach((file, idx) => {
      duplicateInfo.set(file.key, { groupIndex, isFirst: idx === 0 })
    })
  })
  const previousYearInfo = getPreviousYearInfo(files, year)
  return { duplicateInfo, previousYearInfo }
}

test('applySort: 分区顺序 失败 > 重复 > 往年 > 正常（置顶）', () => {
  const files = [
    { key: 'n1', name: 'n-zzz', status: 'parsed', invoiceDate: '2026-03-03', invoiceNumber: 'N1' },
    { key: 'f1', name: 'f-aaa', status: 'error', invoiceDate: '2026-01-01', invoiceNumber: 'F1' },
    { key: 'py1', name: 'py-bbb', status: 'parsed', invoiceDate: '2025-12-31', invoiceNumber: 'PY1' },
    { key: 'py2', name: 'py-ccc', status: 'parsed', invoiceDate: '2024-05-05', invoiceNumber: 'PY2' },
    { key: 'd1a', name: 'd-ddd', status: 'parsed', invoiceDate: '2026-06-06', invoiceNumber: 'DUP' },
    { key: 'd1b', name: 'd-eee', status: 'parsed', invoiceDate: '2026-07-07', invoiceNumber: 'DUP' },
    { key: 'n2', name: 'n-yyy', status: 'parsed', invoiceDate: '2026-08-08', invoiceNumber: 'N2' },
  ]
  const { duplicateInfo, previousYearInfo } = buildInfos(files)
  const sorted = applySort(files, 'fileName', 'asc', duplicateInfo, previousYearInfo)
  const keys = sorted.map(f => f.key)
  // 失败在最前，重复组次之，往年再次，正常最后；段内按 fileName 升序
  // 正常段 n1(n-zzz) 与 n2(n-yyy) 按名称升序 → n2 在前
  assert.deepEqual(keys, ['f1', 'd1a', 'd1b', 'py1', 'py2', 'n2', 'n1'])
})

test('applySort: 往年+重复 同体文件归入「重复」段（优先于往年段）', () => {
  const files = [
    { key: 'py_dup', name: 'a-pydup', status: 'parsed', invoiceDate: '2025-01-01', invoiceNumber: 'DUP' },
    { key: 'd2', name: 'b-dup', status: 'parsed', invoiceDate: '2026-02-02', invoiceNumber: 'DUP' },
    { key: 'n1', name: 'c-norm', status: 'parsed', invoiceDate: '2026-09-09', invoiceNumber: 'N1' },
  ]
  const { duplicateInfo, previousYearInfo } = buildInfos(files)
  const sorted = applySort(files, 'fileName', 'asc', duplicateInfo, previousYearInfo)
  const keys = sorted.map(f => f.key)
  // py_dup 同时满足往年与重复，按优先级落在重复段（最前），重复段 d2 随后，正常 n1 最后
  assert.deepEqual(keys, ['py_dup', 'd2', 'n1'])
})

test('applySort: 不传 previousYearInfo 时不破坏既有分区（向后兼容）', () => {
  const files = [
    { key: 'py1', name: 'a-py', status: 'parsed', invoiceDate: '2025-01-01', invoiceNumber: 'PY1' },
    { key: 'd1a', name: 'b-dup', status: 'parsed', invoiceDate: '2026-02-02', invoiceNumber: 'DUP' },
    { key: 'd1b', name: 'c-dup', status: 'parsed', invoiceDate: '2026-03-03', invoiceNumber: 'DUP' },
    { key: 'n1', name: 'd-norm', status: 'parsed', invoiceDate: '2026-04-04', invoiceNumber: 'N1' },
  ]
  const { duplicateInfo } = buildInfos(files)
  const sorted = applySort(files, 'fileName', 'asc', duplicateInfo)
  const keys = sorted.map(f => f.key)
  // 未传 previousYearInfo 时，往年文件回到正常段；重复组仍置顶
  // 重复段 d1a(b-dup)/d1b(c-dup) 按名称 → d1a, d1b；正常段 py1(a-py)/n1(d-norm) → py1, n1
  assert.deepEqual(keys, ['d1a', 'd1b', 'py1', 'n1'])
})
