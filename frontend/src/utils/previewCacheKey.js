/**
 * previewCacheKey.js — 预览 Canvas 缓存 Key（单一真相来源）
 *
 * 缓存命中必须对应"完全相同的渲染输出"。任何影响最终 Canvas 像素的参数
 * 都必须进入 key，否则会出现：命中陈旧缓存 → skipRenderRef 跳过纠正渲染
 * → 显示错误预览（正确性 Bug）。
 *
 * 拆成两个维度，便于维护与防止遗漏：
 *   documentKey: 文档身份（fileKey + rotation）— 与布局无关
 *   layoutKey:   所有影响渲染结果的布局参数
 *
 * ⚠️ 仅放入真正改变 Canvas 的字段（paperSize / isLandscape / margins /
 *    customPaper / mergeMode ...）。打印机选择、打印份数、静默打印、UI 状态
 *    等不改变预览结果的字段不得进入，否则无谓降低命中率。
 *    新增渲染维度时，只改本函数一处即可保证读写两侧一致。
 *
 * @param {{fileKey: string, rotation: number}} documentState
 * @param {{paperSize: string, isLandscape: boolean, mergeMode?: string,
 *          customPaper?: {widthMM:number, heightMM:number},
 *          margins?: {left:number, right:number, top:number, bottom:number}}} layoutState
 * @returns {string}
 */

import { resolvePaper, paperKeyFragment } from '../layout/resolvePaper.js'

export function buildPreviewCacheKey(documentState, layoutState) {
  const { fileKey, rotation } = documentState
  const {
    paperSize,
    isLandscape,
    mergeMode,
    customPaper,
    margins,
  } = layoutState

  const documentKey = `${fileKey}_r${Number(rotation) || 0}`

  const marginStr = margins
    ? `${margins.left}_${margins.right}_${margins.top}_${margins.bottom}`
    : '0_0_0_0'
  const customStr = paperKeyFragment(resolvePaper(paperSize, customPaper))
  const layoutKey = `p${paperSize}_l${isLandscape ? 1 : 0}_m${mergeMode || 'none'}_${customStr}_mg${marginStr}`

  return `${documentKey}@${layoutKey}`
}
