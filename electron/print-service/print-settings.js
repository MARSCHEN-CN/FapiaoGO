/**
 * print-settings.js — PrintSettings → Sumatra -print-settings 参数字符串
 *
 * 纯 mapper，无副作用，可独立单元测试。
 *
 * 核心设计（RG-3 起，Rotation Authority Transfer）：
 *   - 方向命令 resolveOrientationCommands({ paperOrientation, contentRotation })
 *     两通道分离：纸向（Plan authority，唯一来自 paper.orientation）
 *     与内容旋转（content transform executor，rotate=N）
 *   - paperOrientation 可从 settings 透传（legacy paperOrientation / landscape 请求）
 *   - 无方向信息时按纸型固有方向（getPaperShapeOrientation）兜底
 *   - 纸张尺寸三层策略：
 *     ① paperkind 存在 → 输出 paperkind=<num>（可附带 paper=<name>）
 *     ② 标准纸张 → 输出 paper=<name>
 *     ③ 自定义纸张 → 输出 paper=<w>mm x <h>mm
 *   - paperkind 优先于 paper name（与驱动对齐更精准）
 *   - 无 paperkind 时行为与旧版完全一致
 *
 * PrintSettings → "landscape,fit,paperkind=9,paper=a4"
 *                "disable-auto-rotation,rotate=90,fit,paper=a4"
 *                "disable-auto-rotation,fit,paper=100mm x 150mm"
 */

/**
 * RG-3：旋转语义两通道分离（Rotation Authority Transfer，2026-08-10）
 *
 * 旧模型（A3-V2 证实语义混淆）：
 *   resolveOrientationCommands(contentOrient, paperOrient, desiredRotation)
 *   → baseFlag 由 contentOrient 决定（内容方向劫持纸向决定权 → A3-03 SELF_ORIENT 根源）
 *   → rotate=N 由 content×paper×desired 三查表（ROTATE_LOOKUP 混合计算副产物）
 *
 * 新模型（RG-3 冻结）：
 *   resolveOrientationCommands({ paperOrientation, contentRotation })
 *   → { paperOrientation, contentRotation }
 *     - paperOrientation：纸向唯一来源（Plan.paper.orientation / spec.orientation）
 *     - contentRotation：内容变换（content transform executor，rotate=N 直接 = 该值）
 *   两个通道完全分离，互不复用同一字段（G-RG3-1/2/3）。
 *
 * @param {object} opts
 * @param {'portrait'|'landscape'} [opts.paperOrientation='portrait'] - 纸向（Plan authority）
 * @param {number} [opts.contentRotation=0] - 内容旋转（0/90/180/270）
 * @returns {{ paperOrientation: 'portrait'|'landscape', contentRotation: number }}
 */
const { resolveExecutionTruth } = require('./execution-truth-resolver');

function resolveOrientationCommands({ paperOrientation = 'portrait', contentRotation = 0 } = {}) {
  const steps = ((Math.round(contentRotation / 90) % 4) + 4) % 4;
  return {
    paperOrientation: paperOrientation === 'landscape' ? 'landscape' : 'portrait',
    contentRotation: steps * 90,
  };
}

/**
 * 根据纸张 ID 判断纸张固有方向（硬编码，无需检测）。
 *
 * 规则：
 *   - A4/A5/A3/A6/Letter/Legal 等标准纸张 → 竖向（高 > 宽）
 *   - PostScript 240×140mm → 横向（宽 > 高）
 *   - 自定义纸张 → 根据用户输入的宽高比判断
 *
 * @param {string} paperId - 纸张 ID（如 'A4', 'PostScript', 'Custom'）
 * @param {object} [customPaper] - 自定义纸张尺寸（paperId='Custom' 时使用）
 * @param {number} [customPaper.widthMM]
 * @param {number} [customPaper.heightMM]
 * @returns {'portrait'|'landscape'}
 */
function getPaperShapeOrientation(paperId, customPaper) {
  if (!paperId || paperId === 'Custom') {
    // 自定义纸张：根据用户输入的宽高比判断
    if (customPaper && customPaper.widthMM > 0 && customPaper.heightMM > 0) {
      return customPaper.widthMM > customPaper.heightMM ? 'landscape' : 'portrait';
    }
    return 'portrait';
  }

  // 已知横向纸张
  const LANDSCAPE_PAPERS = new Set([
    'PostScript',
    'postscript',
    'invoice', 'Invoice',
  ]);

  if (LANDSCAPE_PAPERS.has(paperId)) return 'landscape';

  // 所有标准系列纸张（A/B/C/Letter/Legal 等）默认竖向
  // 宽 > 高才是横向，而标准纸都是高 > 宽
  return 'portrait';
}

/**
 * PrintSpec 缺失纸张尺寸错误（Phase 1-C-1 G-C1-2）
 *
 * 契约裁决：禁止隐式 A4 fallback（P2）。打印设置缺少纸张尺寸时
 * 直接拒绝进入打印 pipeline，而不是默默按 A4 处理。
 */
class MissingPrintSpecPaperError extends Error {
  constructor(detail) {
    super(`Missing PrintSpec.paper: ${detail || '打印设置缺少纸张尺寸（paperSize/paper）'}`)
    this.name = 'MissingPrintSpecPaperError'
  }
}

/**
 * 纸张物理尺寸（mm）—— PaperRegistry → customPaper → A 系列内置表
 * @param {string} sizeName
 * @param {object} [customPaper]
 * @returns {{widthMM: number, heightMM: number}|null}
 */
function _paperDimsMm(sizeName, customPaper) {
  if (customPaper && Number(customPaper.widthMM) > 0 && Number(customPaper.heightMM) > 0) {
    return { widthMM: Number(customPaper.widthMM), heightMM: Number(customPaper.heightMM) }
  }
  try {
    const { PaperRegistryProvider } = require('../shared/PaperRegistryProvider')
    const dims = PaperRegistryProvider.getEffectivePaperMap()[sizeName]
    if (dims && Number(dims.widthMM) > 0 && Number(dims.heightMM) > 0) {
      return { widthMM: Number(dims.widthMM), heightMM: Number(dims.heightMM) }
    }
  } catch (e) {
    // PaperRegistry 不可用 → 内置表
  }
  const A_SERIES_MM = {
    A4: [210, 297], A3: [297, 420], A5: [148, 210], A2: [420, 594], A6: [105, 148],
    LETTER: [215.9, 279.4], LEGAL: [215.9, 355.6], TABLOID: [279.4, 431.8],
    STATEMENT: [139.7, 215.9],
  }
  const dims = A_SERIES_MM[String(sizeName || '').toUpperCase()]
  return dims ? { widthMM: dims[0], heightMM: dims[1] } : null
}

/**
 * PrintSpec.normalize — 唯一解释层（Phase 1-C-1）
 *
 * 把 legacy settings（renderer 直传字段：paperSize/fit/rotation/sourceRotation/
 * marginLeft...）归一化为权威 PrintSpec：
 *
 *   PrintSpec {
 *     paper: {
 *       sizeName,            ← paperSize(legacy)
 *       orientation,         ← getPaperShapeOrientation（纸张方向 ≠ 内容旋转）
 *       widthMM, heightMM,   ← 物理尺寸（PaperRegistry/customPaper/A 系列）
 *       paperkind, customPaper,
 *     },
 *     margins:      { left, right, top, bottom },   ← marginLeft...(legacy) 单位 mm
 *     contentRotation: number,                      ← sourceRotation ?? rotation(legacy)
 *     scalePolicy:  'none'|'contain'|'fill',        ← fit(legacy)
 *     contentOrientation, paperOrientation,         ← 透传（rotate 决策域，C-1-a 不改）
 *     grayscale, duplex, copies,
 *   }
 *
 * 语义分离（Phase 1-C-1-b 冻结，用户裁决）：
 *   paper.orientation  → 决定 paper W/H、usableRect、margin placement
 *   contentRotation    → 决定 invoice content transform
 *   Sumatra rotate=    → external rotation authority（C-1-b 不动，A3-V2 移交）
 *   三者互不复用同一字段。
 *
 * 纪律（G-C1-1）：consumer 只许读 PrintSpec 字段；本函数是唯一允许读
 * legacy 字段（paperSize/fit/rotation/sourceRotation/landscape）的地方。
 *
 * 纯函数，返回副本，不修改输入。RG-3：纸向/内容旋转两通道分离（rotationAuthorityGuard）。
 *
 * @param {object} ps - legacy PrintSettings
 * @param {number} [ps.sourceRotation=0] - 内容旋转角度（回退 ps.rotation）
 * @param {number} [ps.paperkind] - Windows DMPAPER_* ID
 * @param {string} [ps.paper] - 纸张尺寸名称（已有管线用；print-backend 已改为传 paperSize）
 * @param {string} [ps.paperSize] - 纸张尺寸名称（renderer 直传）
 * @param {object} [ps.customPaper] - 自定义纸张尺寸
 * @param {number} [ps.customPaper.widthMM]
 * @param {number} [ps.customPaper.heightMM]
 * @returns {object} 权威 PrintSpec
 * @throws {MissingPrintSpecPaperError} paper/paperSize 均缺失（G-C1-2）
 */
function normalize(ps) {
  const src = { ...(ps || {}) }

  // ── paper：paperSize（legacy）→ sizeName（权威）。缺失 fail-fast（G-C1-2）──
  const sizeName = src.paper ?? src.paperSize
  if (!sizeName) {
    throw new MissingPrintSpecPaperError(
      '打印设置缺少纸张尺寸（paperSize/paper）。禁止隐式 A4 fallback（契约 §4 / Phase 1-C-1 P2 裁决）')
  }

  // ── rotation：sourceRotation（legacy）→ contentRotation（权威）──
  const contentRotation = src.sourceRotation ?? src.rotation ?? 0

  // ── scalePolicy：fit（legacy）→ scalePolicy（权威）──
  // 现阶段默认 'contain'（Sumatra fit 语义）；【禁止】在此做 if(margin) noscale——
  // noscale 迁移属 C-2 PrintExecutionPlan 闭环（用户裁决：不提前触碰 margin contract）。
  const scalePolicy = src.scalePolicy ?? src.fit ?? 'contain'

  const customPaper = src.customPaper || null
  const dims = _paperDimsMm(sizeName, customPaper)

  // ── paper.orientation：RG-3 纸向权移交（Plan authority）──
  // 纸向 = 用户请求方向（needSwap 后物理方向），与 frontend paperSpec.resolvePaperSpec 对齐：
  //   - legacy `landscape`（用户横打请求 / 前端自动检测内容方向）→ 请求方向 landscape
  //   - legacy `paperOrientation` 显式方向 → 优先
  //   - 均未传 → 纸型固有方向（getPaperShapeOrientation：A4 竖 / PostScript 横）
  // needSwap：请求方向 ≠ 纸型固有方向 → 宽高交换（physicalPaper）
  const naturalOrient = getPaperShapeOrientation(sizeName, customPaper)
  const requestedOrient = src.landscape
    ? 'landscape'
    : (src.paperOrientation === 'landscape' || src.paperOrientation === 'portrait'
      ? src.paperOrientation
      : naturalOrient)
  const needSwap = requestedOrient !== naturalOrient
  const baseDims = dims || { widthMM: null, heightMM: null }

  return {
    paper: {
      sizeName,
      orientation: requestedOrient,               // needSwap 后物理方向（Plan authority）
      widthMM: needSwap ? baseDims.heightMM : baseDims.widthMM,
      heightMM: needSwap ? baseDims.widthMM : baseDims.heightMM,
      paperkind: src.paperkind != null ? src.paperkind : undefined,
      customPaper,
    },
    margins: {
      left: Number(src.marginLeft) || 0,
      right: Number(src.marginRight) || 0,
      top: Number(src.marginTop) || 0,
      bottom: Number(src.marginBottom) || 0,
    },
    scalePolicy,
    contentRotation,
    contentOrientation: src.contentOrientation,
    paperOrientation: src.paperOrientation,
    grayscale: src.grayscale || false,
    duplex: src.duplex || false,
    copies: Number(src.copies) || 1,
  }
}

/**
 * 将 PrintSettings 映射为 Sumatra -print-settings 参数字符串
 *
 * 参数顺序规则：
 *   1. baseFlag（landscape / disable-auto-rotation，由方向解析决定）
 *   2. rotate=N（内容旋转，0 值时省略）
 *   3. fit（缩放）
 *   4. paper / paperkind（纸张尺寸）
 *   5. 其余（duplex/grayscale/copies）
 *
 * 纸张尺寸策略（三层）：
 *   ① paperkind 存在 → paperkind=<num>，如果同时有 paper 也输出 paper=<name>
 *   ② paper === 'Custom' 且 customPaper 存在 → paper=<w>mm x <h>mm
 *   ③ paper 存在且无 paperkind → paper=<name>（旧版兼容）
 *
 * @param {object} ps - PrintSettings
 * @param {number} [ps.sourceRotation=0] - 旋转角度: 0 | 90 | 180 | 270（回退 ps.rotation）
 * @param {string} [ps.fit='contain'] - 适应方式: 'none' | 'contain' | 'fill'
 * @param {number} [ps.paperkind] - Windows DMPAPER_* ID
 * @param {string} [ps.paper] - 纸张尺寸名称（A4/A5/Letter/Custom）
 * @param {object} [ps.customPaper] - 自定义纸张
 * @param {boolean} [ps.duplex=false] - 双面打印
 * @param {boolean} [ps.grayscale=false] - 灰度打印
 * @param {number} [ps.copies=1] - 打印份数
 * @returns {string} Sumatra -print-settings 参数字符串
 *
 * @example
 * // 横向内容→竖向纸→不旋转
 * buildPrintSettings({ paper: 'A4', contentOrientation: 'landscape', paperOrientation: 'portrait' })
 * // → "landscape,fit,paper=a4"
 *
 * @example
 * // 横向内容→竖向纸→旋转90°
 * buildPrintSettings({ sourceRotation: 90, paper: 'A4', contentOrientation: 'landscape', paperOrientation: 'portrait' })
 * // → "disable-auto-rotation,rotate=90,fit,paper=a4"
 *
 * @example
 * // 无方向信息时向后兼容
 * buildPrintSettings({ paper: 'A4' })
 * // → "disable-auto-rotation,fit,paper=a4"
 */
function buildPrintSettings(ps) {
  // Phase 1-C-1：唯一解释层。legacy settings → 权威 PrintSpec（paper 缺失 throw，G-C1-2）。
  // 本函数及下游只读 PrintSpec 字段（G-C1-1）；R1 红线：resolveOrientationCommands 不变。
  const spec = normalize(ps);
  const parts = [];

  // 1. G2-R2：Execution Truth Resolver 为唯一旋转权威（Execution Command 层）。
  //    上游（main.js）解析 32-case Truth 后注入 commandOrientation/commandRotate；
  //    此处直接消费，不再把 sourceRotation 当命令旋转（G2-R2-4 已断该身份映射）。
  //    仅当未注入时，从 legacy 输入解析
  //    （兜底路径；生产路径恒由 main.js 注入，故兜底在生产中不会被命中）。
  let commandOrientation;
  let commandRotate;
  const injectedOrient =
    ps.commandOrientation === 'landscape' || ps.commandOrientation === 'portrait'
      ? ps.commandOrientation
      : null;
  if (injectedOrient) {
    commandOrientation = injectedOrient;
    const r = Number(ps.commandRotate);
    commandRotate = (r === 0 || r === 90 || r === 180 || r === 270) ? r : 0;
  } else {
    const naturalOrient = getPaperShapeOrientation(spec.paper.sizeName, spec.paper.customPaper);
    const truth = resolveExecutionTruth({
      paperType: naturalOrient,
      // invoiceOrientation：发票固有方向（= contentOrientation）；缺失时回退物理纸型（兜底）
      invoiceOrientation: spec.contentOrientation || naturalOrient,
      // userRotation：用户文档旋转（= legacy contentRotation = sourceRotation ?? rotation ?? 0）
      userRotation: spec.contentRotation,
      // requestedPaperOrientation：用户请求纸向（raw，不取 needSwap 后的物理方向）
      requestedPaperOrientation: ps.paperOrientation ?? (ps.landscape ? 'landscape' : naturalOrient),
    });
    commandOrientation = truth.paperOrientation;
    commandRotate = truth.rotate;
  }

  parts.push(commandOrientation === 'landscape' ? 'landscape' : 'disable-auto-rotation');
  if (commandRotate !== 0) {
    parts.push(`rotate=${commandRotate}`);
  }

  // 2. 适应方式（scalePolicy：'none'→noscale / 'contain'→fit / 'fill'→stretch）
  switch (spec.scalePolicy) {
    case 'fill':
      parts.push('stretch');
      break;
    case 'none':
      parts.push('noscale');
      break;
    case 'contain':
    default:
      parts.push('fit');
      break;
  }

  // 3. 纸张尺寸（三层策略）
  const paper = spec.paper.sizeName;
  const paperkind = spec.paper.paperkind;

  if (paperkind != null) {
    parts.push(`paperkind=${paperkind}`);
    if (paper && paper !== 'Custom') {
      parts.push(`paper=${paper.toLowerCase()}`);
    }
  } else if (paper) {
    // 标准纸张（A4/A5/A3等）及命名自定义纸（PostScript等）用名字匹配（打印机普遍识别）
    const KNOWN_NAMED = /^(A\d|Letter|Legal|Tabloid|PostScript)$/i;
    if (KNOWN_NAMED.test(paper)) {
      parts.push(`paper=${paper.toLowerCase()}`);
    } else {
      // 优先从 PaperRegistry 取尺寸，失败则从 customPaper 取
      let w = 0, h = 0;
      const { PaperRegistryProvider } = require('../shared/PaperRegistryProvider');
      const paperMap = PaperRegistryProvider.getEffectivePaperMap();
      const dims = paperMap[paper];
      if (dims && dims.widthMM > 0 && dims.heightMM > 0) {
        w = dims.widthMM; h = dims.heightMM;
      } else if (spec.paper.customPaper?.widthMM && spec.paper.customPaper?.heightMM) {
        w = spec.paper.customPaper.widthMM; h = spec.paper.customPaper.heightMM;
      }
      if (w > 0 && h > 0) {
        parts.push(`paper=${w}mm x ${h}mm`);
      } else {
        parts.push(`paper=${paper.toLowerCase()}`);
      }
    }
  }

  // 4. 双面打印
  if (spec.duplex) {
    parts.push('duplexlong');
  }

  // 5. 灰度打印
  if (spec.grayscale) {
    parts.push('monochrome');
  }

  // 6. 份数
  if (spec.copies && spec.copies > 1) {
    parts.push(`${spec.copies}x`);
  }

  return parts.join(',');
}

module.exports = { buildPrintSettings, normalize, MissingPrintSpecPaperError, resolveOrientationCommands, getPaperShapeOrientation };
