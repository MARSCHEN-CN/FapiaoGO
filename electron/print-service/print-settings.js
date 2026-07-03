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
function getPaperOrientation(paperId, customPaper) {
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
 * 归一化 PrintSettings（纯函数，返回副本，不修改输入）
 *
 * @param {object} ps - 原始 PrintSettings
 * @param {number} [ps.rotation=0] - 内容旋转角度: 0 | 90 | 180 | 270
 * @param {number} [ps.paperkind] - Windows DMPAPER_* ID（优先级高于 paper name）
 * @param {string} [ps.paper] - 纸张尺寸名称（A4/A5/Letter/Custom）
 * @param {object} [ps.customPaper] - 自定义纸张尺寸
 * @param {number} [ps.customPaper.widthMM]
 * @param {number} [ps.customPaper.heightMM]
 * @returns {object} 归一化后的副本
 */
function normalize(ps) {
  return { ...ps };
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
 * @param {number} [ps.rotation=0] - 旋转角度: 0 | 90 | 180 | 270
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
 * buildPrintSettings({ rotation: 90, paper: 'A4', contentOrientation: 'landscape', paperOrientation: 'portrait' })
 * // → "disable-auto-rotation,rotate=90,fit,paper=a4"
 *
 * @example
 * // 无方向信息时向后兼容
 * buildPrintSettings({ paper: 'A4' })
 * // → "disable-auto-rotation,fit,paper=a4"
 */
function buildPrintSettings(ps) {
  const normalized = normalize(ps);
  const parts = [];

  // 1. 解析方向命令（仅在提供方向信息时激活，否则向后兼容）
  const hasOrient = normalized.contentOrientation && normalized.paperOrientation;
  if (hasOrient) {
    const orientResult = resolveOrientationCommands(
      normalized.contentOrientation,
      normalized.paperOrientation,
      normalized.rotation || 0
    );
    parts.push(orientResult.baseFlag);
    if (orientResult.rotate !== 0) {
      parts.push(`rotate=${orientResult.rotate}`);
    }
  } else {
    parts.push('disable-auto-rotation');
    if (normalized.rotation && normalized.rotation !== 0) {
      parts.push(`rotate=${normalized.rotation}`);
    }
  }

  // 2. 适应方式
  switch (normalized.fit || 'contain') {
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
  const paper = normalized.paper;
  const paperkind = normalized.paperkind;

  if (paperkind != null) {
    parts.push(`paperkind=${paperkind}`);
    if (paper && paper !== 'Custom') {
      parts.push(`paper=${paper.toLowerCase()}`);
    }
  } else if (paper === 'Custom' && normalized.customPaper?.widthMM && normalized.customPaper?.heightMM) {
    const w = normalized.customPaper.widthMM;
    const h = normalized.customPaper.heightMM;
    parts.push(`paper=${w}mm x ${h}mm`);
  } else if (paper) {
    parts.push(`paper=${paper.toLowerCase()}`);
  }

  // 4. 双面打印
  if (normalized.duplex) {
    parts.push('duplexlong');
  }

  // 5. 灰度打印
  if (normalized.grayscale) {
    parts.push('monochrome');
  }

  // 6. 份数
  if (normalized.copies && normalized.copies > 1) {
    parts.push(`${normalized.copies}x`);
  }

  return parts.join(',');
}

module.exports = { buildPrintSettings, normalize, resolveOrientationCommands, getPaperOrientation };
