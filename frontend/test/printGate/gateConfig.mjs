/**
 * A2-G0 Gate 配置（冻结于 print_preview_simulator_freeze_2026-08-03.md §11）
 *
 * 只含常量与路径约定，不含任何打印/渲染逻辑——G0 红线：不改任何打印代码。
 * 供 G1..G6 与 gateFramework.test.mjs 复用。
 */

/** 安全边距对齐容差（mm）：abs(canvasMargin - sourceMargin) <= 0.5mm（用户定稿 §11.2） */
export const SAFE_MARGIN_TOLERANCE_MM = 0.5

/** Gate 测量标准 DPI：与 Canvas 轨 PREVIEW_DPI(300) 一致（MEMORY 冻结事实） */
export const GATE_DPI = 300

/** 标准纸张尺寸（mm），供 G1 换算与断言 */
export const PAPER_SIZES_MM = Object.freeze({
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
  B5: { width: 176, height: 250 },
  LETTER: { width: 215.9, height: 279.4 },
})

/**
 * 锚样本路径约定（冻结 §11.4）：
 * - 真实发票不入库（.gitignore:15 test_fixtures/；:16 双星号 tests 目录规则，忽略其下所有文件）
 * - 锚样本留在 gitignored 目录，框架只引用路径，不复制文件
 * - 工作区根 = E:/print706（仓库根）
 */
export const ANCHOR_DIR = 'test_fixtures/print-gate-anchors/'

/**
 * 现有可复用样本（gitignored，来源盘点见 anchorManifest.mjs）
 * 路径相对仓库根。复用时不移动、不复制——G1 实测时直接引用。
 */
export const EXISTING_SAMPLES = Object.freeze({
  PDF_SINGLE_1: 'test_fixtures/25952000000127675627.pdf',
  PDF_SINGLE_2: 'test_fixtures/25312000000184209689.pdf',
  PDF_MAYBE_MULTI: 'frontend/public/test.pdf',
  PDF_MAYBE_MULTI_2: 'dist/test.pdf',
})
