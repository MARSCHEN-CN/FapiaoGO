// 列模型：前端唯一真源
//
// 同一份模型同时驱动：
//   - 确认页可勾选字段列表
//   - 预览表表头（按勾选过滤，顺序 = 本数组顺序）
//   - 最终导出请求的 columns payload
//
// 顺序严格对齐现有 Excel 导出列序（write_summary_sheet / export_csv 旧路径）。
// 新增字段只改这里，后端 exporter 通过 columns 参数消费，避免两处列序漂移。
//
// 字段说明：
//   virtual: true  → 虚拟列，由后端写行序号计数器生成，不入 DB 行、不参与值 lookup
//                     （serialNo 必须标 virtual，否则后端按普通字段读 inv['serialNo'] 触发 KeyError）
//   money:  true   → 金额为数值列（预览/导出统一按数值处理）
//   total:  'invoice' → 合计行按发票身份去重，每个发票只累加一次（税前/税额合计/价税合计）
//   total:  'line'    → 合计行每行明细都累加（金额/税额）
//
// 共 23 项 = 用户原 20 字段 + 备注 + 原文件名 + 开票人（经确认补入可勾选清单）。
// 开票人 (issuer) 已加入后端 ALLOWED_EXPORT_KEYS 白名单，预览与导出同源。
export const EXCEL_COLUMNS = [
  { key: 'serialNo',           label: '序号',               width: 8,  virtual: true },
  { key: 'invoiceType',        label: '发票类型',           width: 12 },
  { key: 'invoiceDate',        label: '开票日期',           width: 12 },
  { key: 'invoiceNumber',      label: '发票号码',           width: 20 },
  { key: 'amountWithoutTax',   label: '税前金额',           width: 12, money: true, total: 'invoice' },
  { key: 'taxAmount',          label: '税额合计',           width: 12, money: true, total: 'invoice' },
  { key: 'totalAmount',        label: '价税合计',           width: 12, money: true, total: 'invoice' },
  { key: 'buyerName',          label: '购买方名称',         width: 25 },
  { key: 'buyerTaxNo',         label: '购买方纳税人识别号', width: 20 },
  { key: 'sellerName',         label: '销售方名称',         width: 25 },
  { key: 'sellerTaxNo',        label: '销售方纳税人识别号', width: 20 },
  { key: 'issuer',             label: '开票人',             width: 10 },
  { key: 'classificationCode', label: '分类编码',           width: 18 },
  { key: 'xmmc',               label: '项目名称',           width: 35 },
  { key: 'ggxh',               label: '规格型号',           width: 20 },
  { key: 'unit',               label: '单位',               width: 8 },
  { key: 'quantity',           label: '数量',               width: 10 },
  { key: 'unitPrice',          label: '单价',               width: 12, money: true },
  { key: 'lineAmount',         label: '金额',               width: 12, money: true, total: 'line' },
  { key: 'taxRate',            label: '税率/征收率',        width: 12 },
  { key: 'lineTax',            label: '税额',               width: 12, money: true, total: 'line' },
  { key: 'note',               label: '备注',               width: 30 },
  { key: 'originalFilename',   label: '原文件名',           width: 35 },
]

// 全部列 key（确认页默认全选时使用；持久化默认也用此）
export const ALL_KEYS = EXCEL_COLUMNS.map((c) => c.key)

// 虚拟列 key 集合（预览渲染 / columns payload 时需特殊处理）
export const VIRTUAL_KEYS = EXCEL_COLUMNS.filter((c) => c.virtual).map((c) => c.key)

// 便捷：返回当前勾选列对应的列定义（保持 EXCEL_COLUMNS 顺序）
export function visibleColumns(selectedKeys) {
  const set = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys)
  return EXCEL_COLUMNS.filter((c) => set.has(c.key))
}
