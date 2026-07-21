import { getInvoiceIdentity } from './invoiceIdentity.js'

// 计算合计行数值。
//
// @param {Array<Object>} rows        预览行（来自 /api/export-excel-rows 同源数据）
// @param {Array<Object>} visibleCols 当前勾选列定义（EXCEL_COLUMNS 过滤后的子集）
// @returns {Object} key→数值，仅含带 total 标记的列；其余列合计留空（不在返回中）
//
// 规则（须与后端 write_summary_sheet 合计严格一致）：
//   total: 'invoice' → 按发票身份去重，同一发票只在首次出现时累加一次
//                      （税前金额 / 税额合计 / 价税合计，这些是发票级字段，多明细行值相同）
//   total: 'line'    → 每一行明细都累加（金额 / 税额，这些是行级字段）
export function computeTotals(rows, visibleCols) {
  const acc = {}
  for (const c of visibleCols) {
    if (c.total) acc[c.key] = 0
  }

  const seen = new Set()
  for (const [i, r] of rows.entries()) {
    const id = getInvoiceIdentity(r, i)
    const first = !seen.has(id)
    for (const c of visibleCols) {
      if (!c.total) continue
      const v = Number(r[c.key]) || 0
      if (c.total === 'invoice' && first) acc[c.key] += v
      else if (c.total === 'line') acc[c.key] += v
    }
    seen.add(id)
  }
  return acc
}

// 唯一发票数（「共 X 张发票」）。
// 与 computeTotals 共用同一身份函数，保证统计口径完全一致。
export function countInvoices(rows) {
  const seen = new Set()
  rows.forEach((r, i) => seen.add(getInvoiceIdentity(r, i)))
  return seen.size
}
