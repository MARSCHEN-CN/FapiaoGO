'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolvePrintTarget } = require('./print-target');

// ── v2 OFD 守卫：OFD 不再在原生路径解析，必须清晰报错而非「尚未解析完成」 ──
test('v2-OFD-1: OFD 到达原生路径应抛清晰错误（不再误抛「尚未解析完成」）', async () => {
  await assert.rejects(
    () => resolvePrintTarget({ filePath: 'x.ofd', fileFormat: 'ofd', printer: 'P' }),
    /前端 Canvas 打印管线/,
    'OFD 必须引导回前端 Canvas 管线，而非误导性的「尚未解析完成」'
  );
});

test('v2-OFD-2: 非 OFD 格式仍直通源文件', async () => {
  const t = await resolvePrintTarget({ filePath: 'x.pdf', fileFormat: 'pdf', printer: 'P' });
  assert.strictEqual(t.fileFormat, 'pdf');
  assert.strictEqual(t.filePath, 'x.pdf');
});

test('v2-OFD-3: 缺少 filePath 抛参数错误', async () => {
  await assert.rejects(
    () => resolvePrintTarget({ fileFormat: 'pdf' }),
    /PrintTarget\.filePath is required/
  );
});
