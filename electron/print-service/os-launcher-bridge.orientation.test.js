'use strict';

/**
 * os-launcher-bridge.orientation.test.js — R2.3-A.2 Print Orientation Authority Precedence Fix
 *
 * 契约（用户冻结，2026-08-15）：
 *   「当 PrintJob 已明确提供合法 orientation 时，decidePrintSpec 必须尊重它；
 *     纸张固有方向（getPaperShapeOrientation）仅作为缺失/非法 orientation 的 fallback。」
 *
 * 合法值域：'portrait' | 'landscape'（normalize/DirectPrintHandler 恒产出其一）。
 * 影响面：print-merged-images（merge 打印）与 print-file-direct（直接打印）共用
 *   DirectPrintHandler → decidePrintSpec；本修复对两者均为「尊重上游 Real Paper 方向」。
 *
 * 运行：node --test electron/print-service/os-launcher-bridge.orientation.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { decidePrintSpec, toSumatraArgs } = require('./OsLauncherBridge');

// ── 验收矩阵（用户钉死）──
test('merge4 + A4 竖输入：job.orientation=landscape → 尊重 → landscape', () => {
  const spec = decidePrintSpec({ paperSize: 'A4', orientation: 'landscape', scale: 'fit' });
  assert.strictEqual(spec.orientation, 'landscape');
  assert.strictEqual(spec.paper, 'A4');
  assert.strictEqual(spec.scale, 'fit');
});

test('merge4 + A4 横输入：job.orientation=landscape → 尊重 → landscape', () => {
  const spec = decidePrintSpec({ paperSize: 'A4', orientation: 'landscape' });
  assert.strictEqual(spec.orientation, 'landscape');
});

test('merge3：job.orientation=portrait → 尊重 → portrait', () => {
  const spec = decidePrintSpec({ paperSize: 'A4', orientation: 'portrait' });
  assert.strictEqual(spec.orientation, 'portrait');
});

test('merge2：job.orientation=portrait → 尊重 → portrait', () => {
  const spec = decidePrintSpec({ paperSize: 'A4', orientation: 'portrait' });
  assert.strictEqual(spec.orientation, 'portrait');
});

test('Normal A4 direct（无 job.orientation）：fallback 纸型固有方向 → portrait（行为不变）', () => {
  const spec = decidePrintSpec({ paperSize: 'A4' });
  assert.strictEqual(spec.orientation, 'portrait'); // getPaperShapeOrientation('A4')
});

// ── 契约钉死：合法值域 / 缺失 / 非法 → 仅 fallback ──
test('契约：合法值域仅 portrait|landscape；非法值一律回退纸型固有方向', () => {
  const fallbackFor = (orientation) => decidePrintSpec({ paperSize: 'A4', orientation }).orientation;
  assert.strictEqual(fallbackFor(undefined), 'portrait');
  assert.strictEqual(fallbackFor(null), 'portrait');
  assert.strictEqual(fallbackFor(''), 'portrait');
  assert.strictEqual(fallbackFor('foo'), 'portrait');
  assert.strictEqual(fallbackFor(90), 'portrait');
  assert.strictEqual(fallbackFor('PORTRAIT'), 'portrait'); // 大小写不合法
});

test('契约：PostScript 无 orientation → fallback 纸型固有方向 landscape', () => {
  const spec = decidePrintSpec({ paperSize: 'PostScript' });
  assert.strictEqual(spec.orientation, 'landscape');
});

test('契约：custom paper + orientation=landscape → 尊重（不按宽高比覆盖）', () => {
  const spec = decidePrintSpec({
    paperSize: 'Custom',
    customPaper: { widthMM: 100, heightMM: 150 }, // 竖形自定义纸，但 authority=landscape
    orientation: 'landscape',
  });
  assert.strictEqual(spec.orientation, 'landscape');
});

test('契约：custom paper 无 orientation → fallback 宽高比（150×100 → landscape）', () => {
  const spec = decidePrintSpec({
    paperSize: 'Custom',
    customPaper: { widthMM: 150, heightMM: 100 },
  });
  assert.strictEqual(spec.orientation, 'landscape');
});

test('契约：custom paper 无 orientation（竖形 100×150）→ fallback portrait', () => {
  const spec = decidePrintSpec({
    paperSize: 'Custom',
    customPaper: { widthMM: 100, heightMM: 150 },
  });
  assert.strictEqual(spec.orientation, 'portrait');
});

// ── Sumatra command 静态验证（toSumatraArgs；缺文件仅诊断，安全）──
// toSumatraArgs parts 顺序：paper → orientation → scale → center（OsLauncherBridge.js:313-361）
function partsOf(spec, job) {
  const args = toSumatraArgs(spec, job);
  return args[args.indexOf('-print-settings') + 1].split(',');
}

test('command：merge4 landscape → parts 含 landscape（此前为 disable-auto-rotation）', () => {
  const spec = decidePrintSpec({ paperSize: 'A4', orientation: 'landscape', scale: 'fit' });
  const parts = partsOf(spec, { pdfPath: 'C:/nonexistent_orientation_test/x.pdf' });
  assert.ok(parts.includes('landscape'), `实际: ${parts.join(',')}`);
  assert.ok(!parts.includes('disable-auto-rotation'), `实际: ${parts.join(',')}`);
  assert.ok(parts.includes('fit'), `实际: ${parts.join(',')}`);
  assert.ok(parts.includes('paper=A4'), `实际: ${parts.join(',')}`);
});

test('command：merge3/2 portrait → parts 含 disable-auto-rotation（行为不变）', () => {
  const spec = decidePrintSpec({ paperSize: 'A4', orientation: 'portrait', scale: 'fit' });
  const parts = partsOf(spec, { pdfPath: 'C:/nonexistent_orientation_test/x.pdf' });
  assert.ok(parts.includes('disable-auto-rotation'), `实际: ${parts.join(',')}`);
  assert.ok(!parts.includes('landscape'), `实际: ${parts.join(',')}`);
});

test('command：无 orientation fallback portrait（Normal 语义不变）', () => {
  const spec = decidePrintSpec({ paperSize: 'A4', scale: 'fit' });
  const parts = partsOf(spec, { pdfPath: 'C:/nonexistent_orientation_test/x.pdf' });
  assert.ok(parts.includes('disable-auto-rotation'), `实际: ${parts.join(',')}`);
  assert.ok(!parts.includes('landscape'), `实际: ${parts.join(',')}`);
});
