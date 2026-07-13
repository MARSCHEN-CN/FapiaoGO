/**
 * ============================================================================
 *  resolvePaper — 纸张选择「唯一事实来源 / Single Source of Truth」
 * ============================================================================
 *
 *  ⛔ CONTRACT — 消费者 MUST NOT 直接由 paperSize / customPaper 推导纸张尺寸。
 *     所有纸张规则（Custom 生效条件、默认值回退、未来新增的 VirtualPaper /
 *     PrinterProfile Paper / Template Paper / 自动宽高交换 等）都 ONLY 属于本文件。
 *     任何模块需要「有效纸张尺寸」，都必须消费 resolvePaper() 的结果（Value Object），
 *     不得重新解释输入、不得各自写 `if (paperSize === 'Custom')` 守卫。
 *     重新解释输入 = 制造第二个决策点 = 本次 Bug 的根因（guard 漂移）。
 *
 * 设计原则：非法状态不可表示（Illegal states should be unrepresentable）。
 * settings 本不应表达 `paperSize !== 'Custom'` 却带 `customPaper` 的非法组合；
 * 但为兼容历史持久化数据（可能残留 100×340 之类），此处统一在读取侧归一化：
 *   • paperSize==='Custom' 且 customPaper 有效 → 采用自定义尺寸
 *     （有效 = widthMM / heightMM 均为 > 0 的数字）
 *   • 其它情况 → 回退 PAPER_SIZE_MAP[paperSize]，再回退 A4
 *
 * 适用边界：仅 Preview 链路（computePaperLayout / previewCacheKey / renderKey）。
 *   打印链路（usePrint / usePrintIntent / Sumatra）不在此范围内，保持独立守卫，
 *   不共享本 Read Boundary —— Preview 修 Preview，不借机扩大改动范围。
 *
 * 纯函数纪律：resolvePaper 只读入参、返回新对象，绝不修改 paperSize /
 *   customPaper / settings（无副作用），调用方不得依赖任何隐式写入。
 *
 * @param {string} paperSize  如 'A4' / 'A5' / 'Letter' / 'Custom'
 * @param {?{widthMM:number, heightMM:number}} customPaper
 * @returns {{widthMM:number, heightMM:number, isCustom:boolean}}
 */
import { PAPER_SIZE_MAP } from '../config.js'

export function resolvePaper(paperSize, customPaper) {
  const isCustom = paperSize === 'Custom'
  const customValid =
    customPaper && customPaper.widthMM > 0 && customPaper.heightMM > 0
  const dims = isCustom && customValid
    ? { widthMM: customPaper.widthMM, heightMM: customPaper.heightMM }
    : PAPER_SIZE_MAP[paperSize] || PAPER_SIZE_MAP.A4

  // 开发期不变量告警：非 Custom 却携带 customPaper → 说明写边界未收口（L2/L3）
  // 这样以后任何地方写出非法状态，都会在 Console 第一时间报警，而非等 UI 出 Bug。
  if (
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV !== 'production' &&
    !isCustom &&
    customPaper &&
    (customPaper.widthMM > 0 || customPaper.heightMM > 0)
  ) {
    console.warn('[PaperInvariant]', {
      reason: 'customPaper present while paperSize != Custom',
      paperSize,
      customPaper,
    })
  }

  return { widthMM: dims.widthMM, heightMM: dims.heightMM, isCustom }
}

/**
 * 将 resolvePaper 结果序列化为缓存键片段。
 * Custom → `c{widthMM}x{heightMM}`；其它 → ''（空串）。
 * 所有缓存键（PreviewKey / RenderKey / L2Key）统一调用本函数，禁止各自拼 `c...`。
 * @param {{widthMM:number, heightMM:number, isCustom:boolean}} paper
 * @returns {string}
 */
export function paperKeyFragment(paper) {
  return paper.isCustom ? `c${paper.widthMM}x${paper.heightMM}` : ''
}
