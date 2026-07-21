// 发票身份（invoice identity）
//
// 用于三处必须完全一致的逻辑：
//   1. 预览表「序号」分组赋 1..N
//   2. computeTotals 合计行的发票级去重
//   3. 「共 X 张发票」统计
//
// 必须与后端 _invoice_identity 规则严格对齐，否则会出现：
//   预览显示 5 张、导出合计却按 4 张计算 这类隐蔽错位。
//
// 规则（稳定字符串，禁止 Symbol）：
//   发票号 → 原文件名 → __ANON_{index}
//
// ⚠️ 为什么不能用 Symbol('anon')：
//   每次调用都生成一个全新的 Symbol，Symbol('anon') !== Symbol('anon')，
//   导致 identity Set 的 seen.has(id) 永远为 false —— 合计去重与「共 X 张」
//   会全部错乱。所以空号兜底必须用稳定字符串 __ANON_{index}。
export function getInvoiceIdentity(row, index = 0) {
  return (
    row.invoiceNumber ||
    row.originalFilename ||
    `__ANON_${index}`
  )
}
