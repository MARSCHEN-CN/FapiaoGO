/**
 * print-settings.js — PrintSettings → Sumatra -print-settings 参数字符串
 *
 * 纯 mapper，无副作用，可独立单元测试。
 *
 * 核心设计：
 *   - 方向命令 resolveOrientationCommands(contentOrient, paperOrient, desiredRotation)
 *     根据表格驱动生成正确的 baseFlag（landscape / disable-auto-rotation）和 rotate=N
 *   - contentOrientation + paperOrientation 可从 settings 传入，按需使用
 *   - 无方向信息时保持向后兼容（disable-auto-rotation 兜底）
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
 * 根据内容方向、纸张方向、目标旋转角度，解析正确的 Sumatra 命令参数。
 *
 * 适用场景：单文件 PDF 打印（通过 SumatraPDF 直通）。
 * 数据来源：验证表格
 *
 * @param {'portrait'|'landscape'} contentOrient - PDF 页面的自然方向（从 MediaBox 检测）
 * @param {'portrait'|'landscape'} paperOrient - 用户选择的纸张方向
 * @param {number} desiredRotation - 用户期望的最终旋转效果（0/90/180/270）
 * @returns {{ baseFlag: 'landscape'|'disable-auto-rotation', rotate: number }}
 */
function resolveOrientationCommands(contentOrient, paperOrient, desiredRotation) {
  // Step 1: base flag 只跟内容方向和旋转奇偶性有关
  //   content=横向: 偶数→landscape, 奇数→disable-auto-rotation
  //   content=竖向: 偶数→disable-auto-rotation, 奇数→landscape
  const steps = Math.round(desiredRotation / 90);
  const isEven = steps % 2 === 0;
  const baseFlag = (contentOrient === 'landscape') === isEven
    ? 'landscape'
    : 'disable-auto-rotation';

  // Step 2: rotate=N 值取决于内容方向 × 纸张方向（经表格验证）
  const ROTATE_LOOKUP = {
    'landscape|portrait':  { 0: 0,  90: 90,  180: 180, 270: 270 },
    'landscape|landscape': { 0: 90, 90: 180, 180: 270, 270: 0   },
    'portrait|portrait':   { 0: 0,  90: 0,   180: 180, 270: 180 },
    'portrait|landscape':  { 0: 90, 90: 90,  180: 270, 270: 270 },
  };
  const key = `${contentOrient}|${paperOrient}`;
  const rotate = ROTATE_LOOKUP[key]?.[desiredRotation] ?? desiredRotation;

  return { baseFlag, rotate };
}

/**
 * 根据纸张 ID 判断纸张固有方向（硬编码，无需检测）。
 *
 * 规则：
 *   - A4/A5/A3/A6/Letter/Legal 等标准纸张 → 竖向（高 > 宽）
 *   - 凭证纸 240×140mm → 横向（宽 > 高）
 *   - 自定义纸张 → 根据用户输入的宽高比判断
 *
 * @param {string} paperId - 纸张 ID（如 'A4', 'Voucher240x140', 'Custom'）
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
    'Voucher240x140',
    ' voucher', 'voucher',
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
 * 纯函数，返回副本，不修改输入。R1 红线：不碰 ROTATE_LOOKUP / resolveOrientationCommands。
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

  // ── scalePolicy：fit（legacy）→ scalePolicy（权威）。默认 contain（现状等价）──
  const scalePolicy = src.scalePolicy ?? src.fit ?? 'contain'

  const customPaper = src.customPaper || null
  const dims = _paperDimsMm(sizeName, customPaper)

  return {
    paper: {
      sizeName,
      orientation: getPaperShapeOrientation(sizeName, customPaper),
      widthMM: dims ? dims.widthMM : null,
      heightMM: dims ? dims.heightMM : null,
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

  // 1. 解析方向命令（仅在提供方向信息时激活，否则向后兼容）
  const sourceRotation = spec.contentRotation
  const hasOrient = spec.contentOrientation && spec.paperOrientation;
  if (hasOrient) {
    const orientResult = resolveOrientationCommands(
      spec.contentOrientation,
      spec.paperOrientation,
      sourceRotation
    );
    parts.push(orientResult.baseFlag);
    if (orientResult.rotate !== 0) {
      parts.push(`rotate=${orientResult.rotate}`);
    }
  } else {
    parts.push('disable-auto-rotation');
    if (sourceRotation && sourceRotation !== 0) {
      parts.push(`rotate=${sourceRotation}`);
    }
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
    // 标准纸张（A4/A5/A3等）用名字匹配（打印机普遍识别）
    // 特种纸（Voucher240x140等）用尺寸（避免名字不匹配回退A4）
    const A_SERIES = /^(A\d|Letter|Legal|Tabloid)$/i;
    if (A_SERIES.test(paper)) {
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
