/**
 * A3-3-1 paperLayout Contract 扩展（冻结 a3_design_spec §A3-3）
 *
 * 在 A3-1 产出的 computePaperLayout 结果上附加两个**声明性**字段：
 *   coordinateSpace: 声明坐标系统（paper 左上角原点，不引入 transform）
 *   sourceOrigin:    source 语义偏移（原始 PDF 内容相对扩展纸面的偏移，mm）
 *
 * ⚠️ 关键语义区分（用户定稿，冻结）：
 *   - margin = layout 可用区域约束（computePaperLayout 已有）
 *   - sourceOrigin = source 语义（原始 PDF 内容相对扩展纸面的偏移）
 *   二者数值可能相同（10mm），但语义不同——未来 A5/自定义票据/非对称扩边/裁切区域
 *   若混淆会导致回归。本模块只声明，**不消费**（A3-3-2 PlacementAdapter 才消费）。
 *
 * 纯函数，node 可直接测试。
 */

/**
 * @param {object} baseLayout computePaperLayout() 输出（paperRect/usableRect/contentRect...）
 * @param {object} opts
 * @param {number} [opts.sourceOriginXMM=0]  source 内容相对扩展纸面左偏移（mm）
 * @param {number} [opts.sourceOriginYMM=0]  source 内容相对扩展纸面上偏移（mm）
 * @returns {object} 扩展后的 paperLayout（含 coordinateSpace + sourceOrigin）
 */
export function extendPaperLayoutContract(baseLayout, opts = {}) {
  if (!baseLayout || typeof baseLayout !== 'object') {
    throw new Error('extendPaperLayoutContract: baseLayout (computePaperLayout 输出) 必填')
  }
  const x = Number(opts.sourceOriginXMM) || 0
  const y = Number(opts.sourceOriginYMM) || 0
  return {
    ...baseLayout,
    coordinateSpace: {
      name: 'paper',
      origin: 'top-left',
      unit: 'mm',
    },
    sourceOrigin: {
      x,
      y,
      unit: 'mm',
    },
  }
}

/**
 * contract 自检：coordinateSpace/sourceOrigin 存在且结构正确（Gate A3-3-1-01）
 * @param {object} paperLayout
 * @returns {{valid:boolean, errors:string[]}}
 */
export function validatePaperLayoutContract(paperLayout) {
  const errors = []
  if (!paperLayout?.coordinateSpace) errors.push('缺 coordinateSpace')
  else {
    if (paperLayout.coordinateSpace.name !== 'paper') errors.push('coordinateSpace.name 应为 "paper"')
    if (paperLayout.coordinateSpace.origin !== 'top-left') errors.push('coordinateSpace.origin 应为 "top-left"')
  }
  if (!paperLayout?.sourceOrigin) errors.push('缺 sourceOrigin')
  else {
    if (typeof paperLayout.sourceOrigin.x !== 'number') errors.push('sourceOrigin.x 应为 number')
    if (typeof paperLayout.sourceOrigin.y !== 'number') errors.push('sourceOrigin.y 应为 number')
    if (paperLayout.sourceOrigin.unit !== 'mm') errors.push('sourceOrigin.unit 应为 "mm"')
  }
  return { valid: errors.length === 0, errors }
}
