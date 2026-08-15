/**
 * getMergeArtifactInputSignature — Merge Final Artifact 输入矩阵签名（Freshness 判定用）
 *
 * 纯函数，零依赖（不 import config/utils/renderer），可被 node 直接单元测试。
 * 所有权只属于 usePrint；不污染 Preview UI，也不重新引入 PrintPreviewModel 作为 Merge 真值源。
 *
 * 覆盖字段（FRESH-4 冻结，仅真正影响像素的输入）：
 *   paperSize / customPaper / mergeMode / marginL/R/T/B / fileRotations
 * 不覆盖（明确排除）：
 *   landscape（已被 getForcedLandscape(mergeMode, landscape) 语义覆盖）
 *   grayscale / copies / printer / collate / extraSpecial（下游施加，不烤入 artifact）
 *
 * @param {Object} params
 * @param {Array}  [params.files=[]]            合并文件数组（顺序即渲染顺序，作为旋转签名的规范序）
 * @param {Object} [params.settings={}]         settings（含 paperSize/customPaper/mergeMode/margin*）
 * @param {Object} [params.fileRotations={}]    { [fileKey]: rotationDegrees }
 * @returns {string} 确定性签名；相同实际输入 → 相同字符串
 */
export function getMergeArtifactInputSignature({ files = [], settings = {}, fileRotations = {} } = {}) {
  const s = settings || {}
  const paperSize = s.paperSize || 'A4'
  const custom = s.customPaper
  const customPaper = custom ? `${custom.widthMM ?? 0}x${custom.heightMM ?? 0}` : 'none'
  const mergeMode = s.mergeMode || 'none'
  const marginLeft = s.marginLeft ?? 3
  const marginRight = s.marginRight ?? 3
  const marginTop = s.marginTop ?? 3
  const marginBottom = s.marginBottom ?? 3

  // FRESH-5：旋转签名必须以 files 数组（稳定顺序）为基准逐文件读取，
  // **严禁**直接 JSON.stringify(fileRotations)——其 key 插入顺序不可控
  // （取决于各文件首次 set 旋转的顺序），会产生虚假签名差异。
  // 取值时归一为整数（消除浮点噪声），缺省回退 0，与 renderer 消费一致。
  const rotations = (files || [])
    .map((f) => `${f.key}:${Math.round(Number(fileRotations?.[f.key]) || 0)}`)
    .join(',')

  return [
    `paper=${paperSize}`,
    `custom=${customPaper}`,
    `mode=${mergeMode}`,
    `margin=${marginLeft}/${marginRight}/${marginTop}/${marginBottom}`,
    `rot=${rotations}`,
  ].join('|')
}
