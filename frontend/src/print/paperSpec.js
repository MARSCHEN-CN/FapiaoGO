/**
 * paperSpec.js — frontend 侧纸张几何解析点（Phase 1-C-2 Step 1-A）
 *
 * 角色（对齐 C-1 的 PrintSpec.normalize 模式）：
 *   electron 侧 print-settings.normalize 是打印契约的唯一解释层（缺纸 throw）；
 *   本文件是 frontend 侧 Plan/Preview 构造链的纸张解析点（UI 默认 A4 允许）——
 *   两处共用同一张尺寸表语义，未来可合并为共享模块。
 *
 * 输入：legacy settings（paperSize/customPaper/landscape/mergeMode）
 * 输出：plan.paper 几何（G-C2-1：builder 不再直接读 settings.paperSize/landscape）
 *
 *   {
 *     size,            // 'A4' | 'Voucher240x140' | ...
 *     orientation,     // 请求打印方向（needSwap 后物理方向）：getForcedLandscape(mergeMode, landscape)
 *     widthMM, heightMM, // needSwap 后 physicalPaper（用户请求方向下的物理尺寸）
 *     customPaper,     // {widthMM, heightMM} | null
 *     paperkind,       // number | undefined
 *   }
 *
 * 语义（C-1-b 三分离冻结）：
 *   paper.orientation = physical paper orientation（决定 W/H、usableRect、margin placement）
 *   与 contentRotation（内容变换）、Sumatra rotate=（external authority）互不复用。
 *
 * ⚠️ 表与 PrintPreviewModel.js PAPER_MM（L65-71）同值同步（守卫测试锁定两处）；
 * 后续合并为单一纸张表（C-2 Step 2 候选）。
 */

import { getForcedLandscape } from '../utils/mergeMode.js'

// 与 config.js PAPER_REGISTRY / PrintPreviewModel.PAPER_MM 同步的内联纸张表（mm）
export const PAPER_MM = {
  A4: { widthMM: 210, heightMM: 297 },
  A5: { widthMM: 148, heightMM: 210 },
  A3: { widthMM: 297, heightMM: 420 },
  Letter: { widthMM: 215.9, heightMM: 279.4 },
  Voucher240x140: { widthMM: 240, heightMM: 140 },
}

/**
 * 纸型自然方向（几何派生，与 RotationResolver.detectPaperOrientation 同构）
 * @param {string} size
 * @param {{widthMM?:number,heightMM?:number}|null} [customPaper]
 * @returns {'portrait'|'landscape'}
 */
export function paperShapeOrientation(size, customPaper = null) {
  const p = customPaper && Number(customPaper.widthMM) > 0 && Number(customPaper.heightMM) > 0
    ? customPaper
    : PAPER_MM[size]
  if (!p) return 'portrait'
  return p.widthMM > p.heightMM ? 'landscape' : 'portrait'
}

/**
 * 请求打印方向（merge 强制 + 用户配置，唯一解析点）
 * @param {object} settings - { mergeMode, landscape }
 * @returns {'portrait'|'landscape'}
 */
export function requestedPaperOrientation(settings = {}) {
  return getForcedLandscape(settings.mergeMode, !!settings.landscape) ? 'landscape' : 'portrait'
}

/**
 * 解析纸张几何（legacy settings → plan.paper）
 *
 * widthMM/heightMM = needSwap 后的 physicalPaper：
 *   请求方向 ≠ 自然纸型方向 → 宽高交换（与 PrintPreviewModel.pageToModel L180-196 同构）。
 *
 * @param {object} settings - { paperSize, paper, customPaper, paperkind, mergeMode, landscape }
 * @returns {{
 *   size: string,
 *   orientation: 'portrait'|'landscape',
 *   widthMM: number, heightMM: number,
 *   customPaper: object|null,
 *   paperkind: number|undefined,
 * }}
 */
export function resolvePaperSpec(settings = {}) {
  // UI 层允许缺省 A4（与 buildPrintPreviewModel L133 现状一致）；
  // 打印契约侧的缺纸 throw 由 electron print-settings.normalize（G-C1-2）负责。
  const size = settings.paper || settings.paperSize || 'A4'
  const customPaper = settings.customPaper && Number(settings.customPaper.widthMM) > 0 &&
    Number(settings.customPaper.heightMM) > 0
    ? { widthMM: Number(settings.customPaper.widthMM), heightMM: Number(settings.customPaper.heightMM) }
    : null
  const natural = paperShapeOrientation(size, customPaper)
  const orientation = requestedPaperOrientation(settings)
  // needSwap：请求方向 ≠ 自然方向 → 宽高交换（physicalPaper）
  const needSwap = orientation !== natural
  const base = customPaper || PAPER_MM[size] || { widthMM: 210, heightMM: 297 }
  const widthMM = needSwap ? base.heightMM : base.widthMM
  const heightMM = needSwap ? base.widthMM : base.heightMM

  return {
    size,
    orientation,
    widthMM,
    heightMM,
    customPaper,
    paperkind: settings.paperkind != null ? settings.paperkind : undefined,
  }
}
