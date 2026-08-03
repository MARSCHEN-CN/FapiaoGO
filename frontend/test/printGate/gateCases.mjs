/**
 * A2-G1 Gate Case 定义（冻结 §12.4 第一批 3 组）
 *
 * 只描述「采集什么」：锚文件 + 打印参数。不含任何渲染/执行逻辑。
 * 路径相对仓库根（真实发票 gitignored，仅引用）。
 */
export const GATE_CASES = Object.freeze([
  {
    id: 'A1-rot0',
    anchor: 'A1',
    purpose: 'baseline（PDF 基准）',
    file: 'test_fixtures/25952000000127675627.pdf',
    format: 'pdf',
    rotation: 0,
    settings: { paperSize: 'A4', landscape: false, marginLeft: 10, marginRight: 10, marginTop: 10, marginBottom: 10 },
  },
  {
    id: 'A2-rot0',
    anchor: 'A2',
    purpose: 'OFD semantic gap（Canvas 补足边距语义）',
    file: 'test_fixtures/print-gate-anchors/26447000000943604784.ofd',
    format: 'ofd',
    rotation: 0,
    settings: { paperSize: 'A4', landscape: false, marginLeft: 10, marginRight: 10, marginTop: 10, marginBottom: 10 },
  },
  {
    id: 'A1-rot90',
    anchor: 'A1',
    purpose: 'rotation direction（旋转后边距方向）',
    file: 'test_fixtures/25952000000127675627.pdf',
    format: 'pdf',
    rotation: 90,
    settings: { paperSize: 'A4', landscape: false, marginLeft: 10, marginRight: 10, marginTop: 10, marginBottom: 10 },
  },
  {
    id: 'A1-customPaper',
    anchor: 'A1',
    purpose: '同纸张实验（G1-CANVAS-2）：canvas 用专用发票纸 230×160mm，验证与 source 边距对齐',
    file: 'test_fixtures/25952000000127675627.pdf',
    format: 'pdf',
    rotation: 0,
    settings: {
      paperSize: 'Custom',   // layout.js:25 要求 paperKey==='Custom' 才走 customPaper
      landscape: false,
      marginLeft: 10, marginRight: 10, marginTop: 10, marginBottom: 10,
      customPaper: { widthMM: 230, heightMM: 160 },  // 与 source 实测纸面 2717×1890@300dpi(230×160mm) 对齐
    },
  },
])

/** case 自检：id 唯一、文件存在（路径 gitignored 但物理存在） */
export function validateGateCases(cases = GATE_CASES, fs) {
  const ids = cases.map(c => c.id)
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
  const errors = []
  if (dup.length) errors.push(`重复 case id: ${dup.join(',')}`)
  if (fs) {
    for (const c of cases) {
      if (!fs.existsSync(c.file)) errors.push(`文件不存在: ${c.id} → ${c.file}`)
    }
  }
  return { valid: errors.length === 0, errors }
}

/**
 * case scope（变量隔离，冻结 §13.1）：
 * - CANVAS_G1_CASES：G1-CANVAS-1 只跑 PDF 主链（A1 rot0 / rot90），OFD 不并行
 * - CANVAS_G1_2_CASES：G1-CANVAS-2 同纸张实验（A1 customPaper 230×160mm）
 * - OFD_G1_CASES：G1-B 单独做（OFD 语义补足，需 DocumentStore docId 运行时上下文）
 */
export const CANVAS_G1_CASES = Object.freeze(['A1-rot0', 'A1-rot90'])
export const CANVAS_G1_2_CASES = Object.freeze(['A1-customPaper'])
export const OFD_G1_CASES = Object.freeze(['A2-rot0'])

