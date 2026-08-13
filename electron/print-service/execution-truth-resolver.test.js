'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolveExecutionTruth, TRUTH_ROWS } = require('./execution-truth-resolver');

// ── G2-R2-1: 32/32 Execution Truth 单测 PASS ──
test('G2-R2-1: 32-case Truth 全部命中，rotate 与实测一致，paperOrientation==requested', () => {
  assert.strictEqual(TRUTH_ROWS.length, 32, 'Truth 必须为 32 单元格（竖向 16 + 横向 16）');
  for (const row of TRUTH_ROWS) {
    const out = resolveExecutionTruth({
      paperType: row.paperType,
      invoiceOrientation: row.invoiceOrientation,
      userRotation: row.userRotation,
      requestedPaperOrientation: row.requestedPaperOrientation,
    });
    assert.strictEqual(
      out.paperOrientation,
      row.requestedPaperOrientation,
      `paperOrientation 必须等于 requestedPaperOrientation @ ${JSON.stringify(row)}`
    );
    assert.strictEqual(out.rotate, row.rotate, `rotate 不匹配 @ ${JSON.stringify(row)}`);
  }
});

// ── G2-R2-2: FAIL case → landscape,rotate=0 ──
test('G2-R2-2: FAIL case 竖向纸 + 横向发票 + 0° + landscape → {landscape, rotate:0}', () => {
  const out = resolveExecutionTruth({
    paperType: 'portrait',
    invoiceOrientation: 'landscape',
    userRotation: 0,
    requestedPaperOrientation: 'landscape',
  });
  assert.deepStrictEqual(out, { paperOrientation: 'landscape', rotate: 0 });
});

// 横向纸张类型对称校验：横向纸 + 横向发票 + 0° + landscape → {landscape, rotate:90}
test('横向纸 + 横向发票 + 0° + landscape → {landscape, rotate:90}', () => {
  const out = resolveExecutionTruth({
    paperType: 'landscape',
    invoiceOrientation: 'landscape',
    userRotation: 0,
    requestedPaperOrientation: 'landscape',
  });
  assert.deepStrictEqual(out, { paperOrientation: 'landscape', rotate: 90 });
});

// 横向纸张类型 = 竖向纸张类型 +90° 恒定偏移（用户冻结跨验证规则）
test('横向纸张类型 rotate == 同格竖向纸张类型 rotate + 90°（mod 360）', () => {
  const portraitRows = TRUTH_ROWS.filter((r) => r.paperType === 'portrait');
  const landscapeRows = TRUTH_ROWS.filter((r) => r.paperType === 'landscape');
  assert.strictEqual(portraitRows.length, 16);
  assert.strictEqual(landscapeRows.length, 16);
  for (const p of portraitRows) {
    const l = landscapeRows.find(
      (r) =>
        r.invoiceOrientation === p.invoiceOrientation &&
        r.userRotation === p.userRotation &&
        r.requestedPaperOrientation === p.requestedPaperOrientation
    );
    assert.ok(l, `横向表缺对应格 ${JSON.stringify(p)}`);
    const expected = (p.rotate + 90) % 360;
    assert.strictEqual(l.rotate, expected, `跨矩阵 +90° 偏移不符 @ ${JSON.stringify(p)}`);
  }
});

// 输入校验：缺失 invoiceOrientation 抛错
test('缺失 invoiceOrientation 抛错', () => {
  assert.throws(
    () =>
      resolveExecutionTruth({
        paperType: 'portrait',
        userRotation: 0,
        requestedPaperOrientation: 'landscape',
      }),
    /缺少必要真值输入/
  );
});

// 输入校验：非法 userRotation 抛错
test('非法 userRotation (45) 抛错', () => {
  assert.throws(
    () =>
      resolveExecutionTruth({
        paperType: 'portrait',
        invoiceOrientation: 'landscape',
        userRotation: 45,
        requestedPaperOrientation: 'landscape',
      }),
    /userRotation 非法/
  );
});

// 接受中文别名（横向/竖向）与英文枚举等价
test('中文别名 横向/竖向 与英文枚举等价', () => {
  const en = resolveExecutionTruth({
    paperType: 'portrait',
    invoiceOrientation: 'landscape',
    userRotation: 90,
    requestedPaperOrientation: 'portrait',
  });
  const zh = resolveExecutionTruth({
    paperType: '竖向',
    invoiceOrientation: '横向',
    userRotation: 90,
    requestedPaperOrientation: '竖向',
  });
  assert.deepStrictEqual(en, zh);
  assert.strictEqual(en.rotate, 180);
});
