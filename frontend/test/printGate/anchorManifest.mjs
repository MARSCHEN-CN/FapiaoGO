/**
 * A2 Gate 锚样本清单（冻结 §11.3/§11.4）
 *
 * status:
 *   available — 文件已存在（gitignored 目录），G1 可直接引用
 *   missing   — 工作区无样本，需用户提供真实发票
 *   derived   — 不独立成文件（复用其他锚 + 打印参数派生）
 *   tbd       — 现有样本中待标定（G1 测量后确认是否满足规格）
 *
 * 真实发票不入库（.gitignore:15 test_fixtures/；:16 双星号 tests 目录规则，忽略其下所有文件），
 * 本 manifest 只登记路径与规格，不含内容。
 */
export const anchorManifest = Object.freeze([
  {
    id: 'A1',
    spec: '普通 PDF 单页',
    format: 'pdf',
    source: 'test_fixtures/25952000000127675627.pdf',
    status: 'available',
    notes: '真实发票，已存在（gitignored）',
  },
  {
    id: 'A2',
    spec: 'OFD 单页',
    format: 'ofd',
    source: null,
    status: 'missing',
    notes: '工作区无任何 .ofd 文件 → 需用户提供真实样本；OFD 在 source 模式无安全边距（main.js imgExts 不含 .ofd），Gate 须验证 Canvas 轨补边距',
  },
  {
    id: 'A3',
    spec: 'PDF 多页',
    format: 'pdf',
    source: 'frontend/public/test.pdf',
    status: 'available',
    notes: '已存在；页数待 G1 标定（多页 → 每页边距一致）',
  },
  {
    id: 'A4',
    spec: '旋转 90°',
    format: 'pdf',
    source: 'derived: A1 + rotation=90',
    status: 'derived',
    notes: 'rotation 是打印参数（slot.rotation），非文件属性 → 无需独立文件；G1 用 A1 文件 + rotation=90 验证',
  },
  {
    id: 'A5',
    spec: '二维码票',
    format: 'pdf',
    source: 'tbd: 现有 4 个 PDF 中筛选',
    status: 'tbd',
    notes: 'G1 标定现有样本是否含二维码；缺失则需用户提供',
  },
  {
    id: 'A6',
    spec: '小字体票',
    format: 'pdf',
    source: 'tbd: 现有 4 个 PDF 中筛选',
    status: 'tbd',
    notes: '同 A5，G1 标定',
  },
])

/** manifest 自检：id 唯一、A1-A6 齐全、derived 锚必须有引用 */
export function validateAnchorManifest(manifest = anchorManifest) {
  const ids = manifest.map(a => a.id)
  const expected = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']
  const missing = expected.filter(id => !ids.includes(id))
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
  const errors = []
  if (missing.length) errors.push(`缺少锚: ${missing.join(',')}`)
  if (dup.length) errors.push(`重复锚: ${dup.join(',')}`)
  const derived = manifest.find(a => a.status === 'derived')
  if (derived && !derived.source.startsWith('derived:')) errors.push(`derived 锚 ${derived.id} 缺少派生来源`)
  return { valid: errors.length === 0, errors }
}
