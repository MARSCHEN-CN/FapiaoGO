'use strict';

/**
 * baked-rotate.test.js — R2.3-A.3 Baked → Sumatra rotate 映射单测
 *
 * ⚠️ 状态变更（2026-08-15）：本测试当前只测**纯函数 resolveBakedRotate** + 验证
 *   **OsLauncherBridge.toSumatraArgs 已回滚**（不消费 baked-rotate，contentRotation=0
 *   无论 baked 与否）。
 *
 *   baked-rotate mapping 的"landscape × landscape → 90"假设被 E3 PostScript 实机
 *   证据击穿（"横向纸型"二值抽象不足以决定 Sumatra rotate）。详见：
 *     - .workbuddy/R2.3-A.3-Content-Rotation-vs-C2-Command-Mapping-Forensics.md §E3
 *     - _r22_e1/README-E3.md（PostScript 实机取证材料，待用户执行）
 *
 *   E3 取证完成后，按更精确的实机 command semantics 重写映射（per-paper-type），
 *   再恢复 toSumatraArgs 集成测试。当前**禁止**在未获新实机证据前重新接入。
 *
 * 运行：node --test electron/print-service/baked-rotate.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveBakedRotate } = require('./baked-rotate-resolver');
const { decidePrintSpec, toSumatraArgs } = require('./OsLauncherBridge');

// ── fixture：临时最小 PDF（MediaBox 决定 detectPdfOrientation）──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baked-rotate-test-'));
const LANDSCAPE_PDF = path.join(tmpDir, 'landscape.pdf');
const PORTRAIT_PDF = path.join(tmpDir, 'portrait.pdf');

function writeMinPdf(filePath, mediaBox) {
  const body = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox}] >>
endobj
xref
0 4
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
trailer
<< /Root 1 0 R /Size 4 >>
%%EOF
`;
  fs.writeFileSync(filePath, body);
}
writeMinPdf(LANDSCAPE_PDF, '0 0 842 595');
writeMinPdf(PORTRAIT_PDF, '0 0 595 842');

test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// 解析 -print-settings 的 settings 子串
function settingsOf(spec, job) {
  const args = toSumatraArgs(spec, job);
  const idx = args.indexOf('-print-settings');
  assert.ok(idx >= 0, `args 应含 -print-settings: ${JSON.stringify(args)}`);
  return args[idx + 1];
}

// ── 1. resolveBakedRotate 纯函数（**未验证** — E3 后将按实机结果重写）──
test('纯函数：landscape × portrait → 0（E1 A4 行1 实证）', () => {
  assert.strictEqual(resolveBakedRotate('landscape', 'portrait'), 0);
});

test('纯函数：landscape × landscape → 90（⚠️ 实验性：E3 PostScript 实机击穿，未验证为普适规则）', () => {
  assert.strictEqual(resolveBakedRotate('landscape', 'landscape'), 90);
});

test('纯函数：portrait × * → 0（未实机，保持现状，不宣称）', () => {
  assert.strictEqual(resolveBakedRotate('portrait', 'portrait'), 0);
  assert.strictEqual(resolveBakedRotate('portrait', 'landscape'), 0);
});

test('纯函数：非法输入归一化（未知一律 0）', () => {
  assert.strictEqual(resolveBakedRotate(undefined, 'portrait'), 0);
  assert.strictEqual(resolveBakedRotate(null, 'landscape'), 0);
  assert.strictEqual(resolveBakedRotate('foo', 'portrait'), 0);
  assert.strictEqual(resolveBakedRotate('landscape', undefined), 0);
  assert.strictEqual(resolveBakedRotate('landscape', 'foo'), 0);
});

// ── 2. toSumatraArgs 回滚验证（**当前生产路径**）：contentRotation=0 无论 baked ──
test('回滚验证：baked + A4 + landscape PDF → landscape 且无 rotate（与 E1 行1 一致）', () => {
  const spec = decidePrintSpec({ paperSize: 'A4', orientation: 'landscape', scale: 'fit' });
  const s = settingsOf(spec, { pdfPath: LANDSCAPE_PDF, paperSize: 'A4', baked: true });
  assert.ok(s.includes('landscape'), `应含 landscape: ${s}`);
  assert.ok(!s.includes('rotate='), `不应含 rotate=: ${s}`);
  assert.ok(s.includes('fit'), `应含 fit: ${s}`);
});

test('回滚验证：baked + PostScript + landscape PDF → 无 rotate（E3 击穿后回滚，baked-rotate 不接入）', () => {
  const spec = decidePrintSpec({ paperSize: 'PostScript', orientation: 'landscape', scale: 'fit' });
  const s = settingsOf(spec, { pdfPath: LANDSCAPE_PDF, paperSize: 'PostScript', baked: true });
  assert.ok(s.includes('landscape'), `应含 landscape: ${s}`);
  assert.ok(!s.includes('rotate='), `回滚后 baked-rotate 不接入，无 rotate=: ${s}`);
});

test('回滚验证：baked + custom 横向纸 + landscape PDF → 无 rotate（同上）', () => {
  const customPaper = { widthMM: 297, heightMM: 210 };
  const spec = decidePrintSpec({ paperSize: 'Custom', customPaper, orientation: 'landscape', scale: 'fit' });
  const s = settingsOf(spec, { pdfPath: LANDSCAPE_PDF, paperSize: 'Custom', customPaper, baked: true });
  assert.ok(!s.includes('rotate='), `回滚后 baked-rotate 不接入，无 rotate=: ${s}`);
});

test('回滚验证：baked + portrait PDF × portrait 纸型 → 无 rotate（现状）', () => {
  const spec = decidePrintSpec({ paperSize: 'A4', orientation: 'portrait', scale: 'fit' });
  const s = settingsOf(spec, { pdfPath: PORTRAIT_PDF, paperSize: 'A4', baked: true });
  assert.ok(!s.includes('rotate='), `不应含 rotate=: ${s}`);
  assert.ok(s.includes('disable-auto-rotation'), `应含 disable-auto-rotation: ${s}`);
});

// ── 3. 隔离约束：source 链不受影响（两通道语义保持） ──
test('隔离：print-file-direct（无 baked）即使 landscape PDF 也无 rotate', () => {
  const spec = decidePrintSpec({ paperSize: 'A4', orientation: 'landscape', scale: 'fit' });
  const s = settingsOf(spec, { pdfPath: LANDSCAPE_PDF, paperSize: 'A4' });
  assert.ok(s.includes('landscape'), `应含 landscape: ${s}`);
  assert.ok(!s.includes('rotate='), `source 链不应含 rotate=: ${s}`);
});

test('隔离：print-file-direct（baked:false 显式）也无 rotate', () => {
  const spec = decidePrintSpec({ paperSize: 'A4', orientation: 'portrait', scale: 'fit' });
  const s = settingsOf(spec, { pdfPath: LANDSCAPE_PDF, paperSize: 'A4', baked: false });
  assert.ok(!s.includes('rotate='), `不应含 rotate=: ${s}`);
});

// ── 4. A.2 回归：orientation authority 不受影响 ──
test('回归：job.orientation 仍是 authority（merge3/2 portrait → disable-auto-rotation）', () => {
  const spec = decidePrintSpec({ paperSize: 'A4', orientation: 'portrait', scale: 'fit' });
  const s = settingsOf(spec, { pdfPath: PORTRAIT_PDF, paperSize: 'A4', baked: true });
  assert.ok(s.includes('disable-auto-rotation'), `应含 disable-auto-rotation: ${s}`);
  assert.ok(!s.includes('landscape'), `不应含 landscape: ${s}`);
});