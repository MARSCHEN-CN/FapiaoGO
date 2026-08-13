'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildPrintSettings } = require('./print-settings');

// ── G2-R2-2 @ command-string 层：FAIL case → "landscape,rotate=0,fit,paper=a4" ──
test('G2-R2-2: buildPrintSettings（注入 Truth）竖向纸+横向发票+0°+landscape → landscape,rotate=0,fit', () => {
  const out = buildPrintSettings({
    paper: 'A4',
    contentOrientation: 'landscape', // 横向发票
    paperOrientation: 'landscape', // 用户请求 landscape
    sourceRotation: 0,
    commandOrientation: 'landscape',
    commandRotate: 0,
  });
  // rotate=0 在 Sumatra 命令中被省略（仅 N≠0 时输出 rotate=N），故期望串不含 rotate=0
  assert.strictEqual(out, 'landscape,fit,paper=a4');
});

// ── G2-R2-4：buildPrintSettings 不把 sourceRotation 当命令旋转（兜底解析路径）──
// 竖向纸 + 横向发票 + userRotation=90 + landscape 请求：
//   旧 identity 映射 → rotate=sourceRotation=90（错误，20/32 结构性错误）
//   32-case Truth   → rotate=0（landscape,rotate=0,fit）
test('G2-R2-4: 未注入时按 32-case Truth 解析（非 sourceRotation 身份映射）', () => {
  const out = buildPrintSettings({
    paper: 'A4',
    contentOrientation: 'landscape',
    paperOrientation: 'landscape',
    sourceRotation: 90, // 若按 identity 会输出 rotate=90（错误）
    // 注意：未注入 commandOrientation/commandRotate → 走兜底解析
  });
  assert.strictEqual(out, 'landscape,fit,paper=a4');
});

// 横向纸张类型 + 横向发票 + 0° + landscape → landscape,rotate=90,fit
test('横向纸(PostScript) + 横向发票 + 0° + landscape → landscape,rotate=90,fit', () => {
  const out = buildPrintSettings({
    paper: 'PostScript',
    contentOrientation: 'landscape',
    paperOrientation: 'landscape',
    sourceRotation: 0,
    commandOrientation: 'landscape',
    commandRotate: 90,
  });
  assert.strictEqual(out, 'landscape,rotate=90,fit,paper=postscript');
});

// 兜底解析路径对横向纸张类型同样生效：PostScript + 横向发票 + 0° + landscape → rotate=90
test('兜底解析：PostScript + 横向发票 + 0° + landscape → landscape,rotate=90,fit', () => {
  const out = buildPrintSettings({
    paper: 'PostScript',
    contentOrientation: 'landscape',
    paperOrientation: 'landscape',
    sourceRotation: 0,
  });
  assert.strictEqual(out, 'landscape,rotate=90,fit,paper=postscript');
});
