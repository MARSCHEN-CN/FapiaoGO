'use strict';

/**
 * execution-truth-resolver.js
 *
 * 32-case Execution Truth Resolver —— G2-R2 唯一旋转权威（Execution Command 层）。
 *
 * 背景（G2-R2 冻结裁决，用户终审）：
 *   - 32 条「物理真机实测」矩阵（竖向纸张 16 + 横向纸张 16）是唯一 Rotation Authority，
 *     优先级高于任何抽象 Translator 公式（用户裁决：32 条实测 > 抽象推导）。
 *   - 这是 Execution Command（Sumatra 直打命令）层，与 Geometry Translator（apply_pdf
 *     几何层）是两语义层，互不消费对方中间变量。fit/noscale 属 Margin Contract 独立决策
 *     （G2-R2 本轮不触碰 Geometry Translator / bake 几何）。
 *   - sourceRotation / userRotation 只作为「真值输入」进入本 Resolver，绝不作为「命令旋转」
 *     输出（旧 main.js 把 sourceRotation 当命令旋转 = 旧规则污染，G2-R2-3 已断）。
 *
 * 输入（4 个真值输入，全部来自上游；本模块无副作用、无外部依赖、无 import cycle）：
 *   @param {object} input
 *   @param {'portrait'|'landscape'} input.paperType                 物理纸张类型（竖向/横向纸，
 *                                                                    = getPaperShapeOrientation(paper)）
 *   @param {'portrait'|'landscape'} input.invoiceOrientation       发票固有方向（竖向/横向发票，
 *                                                                    = contentOrientation）
 *   @param {0|90|180|270}          input.userRotation              用户文档旋转（= sourceRotation）
 *   @param {'portrait'|'landscape'} input.requestedPaperOrientation 用户请求纸向（= paperOrientation）
 *
 * 输出（Execution Command，直接喂给 Sumatra 直打 / 几何 apply_pdf）：
 *   @returns {{ paperOrientation: 'portrait'|'landscape', rotate: 0|90|180|270 }}
 *
 * 不变量：commandOrientation 恒等于 requestedPaperOrientation（32 条实测全部验证）；
 *   rotate 由 4 输入查表唯一确定，禁止任何 +90 / swap / normalize / natural-orient 推导。
 */

function _normOrient(v) {
  if (v === 'landscape' || v === 'l' || v === '横向') return 'landscape';
  if (v === 'portrait' || v === 'p' || v === '竖向') return 'portrait';
  return null;
}

function _normRot(r) {
  const n = Number(r);
  if (Number.isNaN(n)) return null;
  const mod = ((Math.round(n) % 360) + 360) % 360;
  if (mod !== 0 && mod !== 90 && mod !== 180 && mod !== 270) return null;
  return mod;
}

// ── 32 条实测 Truth（竖向纸张 16 + 横向纸张 16）──
// 顺序：invoiceOrientation, userRotation, requestedPaperOrientation → rotate
// （paperOrientation 输出恒等于 requestedPaperOrientation，单独逐格列出以忠实记录 Truth）
const TRUTH_ROWS = [
  // ── 竖向纸张类型 (paperType='portrait') ──
  { paperType: 'portrait', invoiceOrientation: 'landscape', userRotation: 0,   requestedPaperOrientation: 'landscape', rotate: 0 },
  { paperType: 'portrait', invoiceOrientation: 'landscape', userRotation: 0,   requestedPaperOrientation: 'portrait',  rotate: 0 },
  { paperType: 'portrait', invoiceOrientation: 'landscape', userRotation: 90,  requestedPaperOrientation: 'landscape', rotate: 0 },
  { paperType: 'portrait', invoiceOrientation: 'landscape', userRotation: 90,  requestedPaperOrientation: 'portrait',  rotate: 180 },
  { paperType: 'portrait', invoiceOrientation: 'landscape', userRotation: 180, requestedPaperOrientation: 'landscape', rotate: 180 },
  { paperType: 'portrait', invoiceOrientation: 'landscape', userRotation: 180, requestedPaperOrientation: 'portrait',  rotate: 180 },
  { paperType: 'portrait', invoiceOrientation: 'landscape', userRotation: 270, requestedPaperOrientation: 'landscape', rotate: 180 },
  { paperType: 'portrait', invoiceOrientation: 'landscape', userRotation: 270, requestedPaperOrientation: 'portrait',  rotate: 0 },
  { paperType: 'portrait', invoiceOrientation: 'portrait',  userRotation: 0,   requestedPaperOrientation: 'landscape', rotate: 180 },
  { paperType: 'portrait', invoiceOrientation: 'portrait',  userRotation: 0,   requestedPaperOrientation: 'portrait',  rotate: 0 },
  { paperType: 'portrait', invoiceOrientation: 'portrait',  userRotation: 90,  requestedPaperOrientation: 'landscape', rotate: 0 },
  { paperType: 'portrait', invoiceOrientation: 'portrait',  userRotation: 90,  requestedPaperOrientation: 'portrait',  rotate: 0 },
  { paperType: 'portrait', invoiceOrientation: 'portrait',  userRotation: 180, requestedPaperOrientation: 'landscape', rotate: 0 },
  { paperType: 'portrait', invoiceOrientation: 'portrait',  userRotation: 180, requestedPaperOrientation: 'portrait',  rotate: 180 },
  { paperType: 'portrait', invoiceOrientation: 'portrait',  userRotation: 270, requestedPaperOrientation: 'landscape', rotate: 180 },
  { paperType: 'portrait', invoiceOrientation: 'portrait',  userRotation: 270, requestedPaperOrientation: 'portrait',  rotate: 180 },

  // ── 横向纸张类型 (paperType='landscape') ──
  { paperType: 'landscape', invoiceOrientation: 'landscape', userRotation: 0,   requestedPaperOrientation: 'landscape', rotate: 90 },
  { paperType: 'landscape', invoiceOrientation: 'landscape', userRotation: 0,   requestedPaperOrientation: 'portrait',  rotate: 90 },
  { paperType: 'landscape', invoiceOrientation: 'landscape', userRotation: 90,  requestedPaperOrientation: 'landscape', rotate: 90 },
  { paperType: 'landscape', invoiceOrientation: 'landscape', userRotation: 90,  requestedPaperOrientation: 'portrait',  rotate: 270 },
  { paperType: 'landscape', invoiceOrientation: 'landscape', userRotation: 180, requestedPaperOrientation: 'landscape', rotate: 270 },
  { paperType: 'landscape', invoiceOrientation: 'landscape', userRotation: 180, requestedPaperOrientation: 'portrait',  rotate: 270 },
  { paperType: 'landscape', invoiceOrientation: 'landscape', userRotation: 270, requestedPaperOrientation: 'landscape', rotate: 270 },
  { paperType: 'landscape', invoiceOrientation: 'landscape', userRotation: 270, requestedPaperOrientation: 'portrait',  rotate: 90 },
  { paperType: 'landscape', invoiceOrientation: 'portrait',  userRotation: 0,   requestedPaperOrientation: 'landscape', rotate: 270 },
  { paperType: 'landscape', invoiceOrientation: 'portrait',  userRotation: 0,   requestedPaperOrientation: 'portrait',  rotate: 90 },
  { paperType: 'landscape', invoiceOrientation: 'portrait',  userRotation: 90,  requestedPaperOrientation: 'landscape', rotate: 90 },
  { paperType: 'landscape', invoiceOrientation: 'portrait',  userRotation: 90,  requestedPaperOrientation: 'portrait',  rotate: 90 },
  { paperType: 'landscape', invoiceOrientation: 'portrait',  userRotation: 180, requestedPaperOrientation: 'landscape', rotate: 90 },
  { paperType: 'landscape', invoiceOrientation: 'portrait',  userRotation: 180, requestedPaperOrientation: 'portrait',  rotate: 270 },
  { paperType: 'landscape', invoiceOrientation: 'portrait',  userRotation: 270, requestedPaperOrientation: 'landscape', rotate: 270 },
  { paperType: 'landscape', invoiceOrientation: 'portrait',  userRotation: 270, requestedPaperOrientation: 'portrait',  rotate: 270 },
];

// O(1) 查表 Map
const TRUTH_MAP = new Map(
  TRUTH_ROWS.map((r) => [`${r.paperType}|${r.invoiceOrientation}|${r.userRotation}|${r.requestedPaperOrientation}`, r.rotate])
);

/**
 * 解析 Execution Truth（32-case 唯一权威）。
 *
 * @param {object} input
 * @param {'portrait'|'landscape'} input.paperType
 * @param {'portrait'|'landscape'} input.invoiceOrientation
 * @param {0|90|180|270}          input.userRotation
 * @param {'portrait'|'landscape'} input.requestedPaperOrientation
 * @returns {{ paperOrientation: 'portrait'|'landscape', rotate: 0|90|180|270 }}
 * @throws {Error} 输入缺失或无法匹配 Truth 单元格时（应上游保证 4 输入齐备）
 */
function resolveExecutionTruth(input) {
  const paperType = _normOrient(input && input.paperType);
  const invoiceOrientation = _normOrient(input && input.invoiceOrientation);
  const requestedPaperOrientation = _normOrient(input && input.requestedPaperOrientation);
  const userRotation = _normRot(input && input.userRotation);

  if (!paperType || !invoiceOrientation || !requestedPaperOrientation) {
    throw new Error(
      `resolveExecutionTruth: 缺少必要真值输入 paperType/invoiceOrientation/requestedPaperOrientation ` +
      `(收到 paperType=${input && input.paperType}, invoiceOrientation=${input && input.invoiceOrientation}, ` +
      `requestedPaperOrientation=${input && input.requestedPaperOrientation})`
    );
  }
  if (userRotation === null) {
    throw new Error(`resolveExecutionTruth: userRotation 非法（必须为 0/90/180/270），收到 ${input && input.userRotation}`);
  }

  const key = `${paperType}|${invoiceOrientation}|${userRotation}|${requestedPaperOrientation}`;
  const rotate = TRUTH_MAP.get(key);
  if (rotate === undefined) {
    throw new Error(`resolveExecutionTruth: 无匹配 Truth 单元格 key=${key}`);
  }

  // 不变量：commandOrientation 恒等于 requestedPaperOrientation（32 条实测全部验证）
  return { paperOrientation: requestedPaperOrientation, rotate };
}

module.exports = { resolveExecutionTruth, TRUTH_ROWS };
