import { getInvoiceIdentity } from './invoiceIdentity.js'

// 货币 2 位取整（修复浮点累加误差，如 28.94 + 49513.01 = 49541.950000000004）。
// 采用「分币整数 + epsilon」而非 Math.round(x*100)，规避 1.005*100=100.4999… 的经典坑；
// 与后端 excel_exporter 的 float(round(Decimal, 2)) 在 2 位精度下结果一致，保证「预览 == 导出」。
export function roundMoney(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  const sign = v < 0 ? -1 : 1
  const cents = Math.round((Math.abs(v) + 1e-9) * 100)
  return sign * cents / 100
}

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
  // 货币字段 2 位取整，消除浮点累加误差（与后端合计 round 对齐）
  for (const k of Object.keys(acc)) {
    acc[k] = roundMoney(acc[k])
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
