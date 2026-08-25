/**
 * R-4.7 Fix-Y — raster 临时 PDF baked execution semantics 契约测试（源码级断言）
 *
 * 运行: node --test frontend/src/print/__tests__/rasterBakedExecutionContract.test.mjs
 *
 * 验证（用户裁决 2026-08-25）：
 *   R4.7-G1  printImageAsPdf 构建 settings 后显式声明 baked execution
 *            （ps.commandOrientation=paperOrient + ps.commandRotate=0，且在 print-source-file 调用前）
 *   R4.7-G2  main.js Truth isolation guard：commandOrientation 已设 → 跳过 injectExecutionTruth
 *   R4.7-G3  Truth 表权威未动：{portrait,portrait,0,landscape}=180 与 {portrait,landscape,0,landscape}=0 两行仍存在
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PrintServiceSrc = fs.readFileSync(path.resolve(HERE, '../../services/PrintService.js'), 'utf8')
const mainJsSrc = fs.readFileSync(path.resolve(HERE, '../../../../electron/main.js'), 'utf8')
const truthSrc = fs.readFileSync(path.resolve(HERE, '../../../../electron/print-service/execution-truth-resolver.js'), 'utf8')

test('R4.7-G1: printImageAsPdf 声明 baked execution（commandOrientation + commandRotate=0，先于 IPC）', () => {
  assert.match(PrintServiceSrc, /ps\.commandOrientation = paperOrient/,
    'printImageAsPdf 应预设 commandOrientation = requestedPaperOrientation（baked 声明）')
  assert.match(PrintServiceSrc, /ps\.commandRotate = 0/,
    'printImageAsPdf 应预设 commandRotate = 0（临时 PDF 已烘焙，禁止 Truth 二次介入）')
  // 顺序约束：baked 声明必须发生在 print-source-file 调用之前（同一 settings 构建段内）
  const step3 = PrintServiceSrc.slice(
    PrintServiceSrc.indexOf('// ── Step 3'),
    PrintServiceSrc.indexOf("ipc.invoke('print-source-file')")
  )
  assert.ok(step3.includes('ps.commandOrientation = paperOrient'),
    'baked 声明必须在 ipc.invoke(print-source-file) 之前')
})

test('R4.7-G2: main.js Truth isolation guard（commandOrientation 已设 → 跳过 injectExecutionTruth）', () => {
  // L697 guard：bake 成功路径 / raster baked 路径已设 commandOrientation → Truth 不再注入
  assert.match(mainJsSrc, /if \(!printSettings\.commandOrientation\) \{[\s\S]*?injectExecutionTruth\(/,
    'main.js 必须存在 !commandOrientation → 跳过 Truth 注入的 guard（Truth isolation）')
})

test('R4.7-G3: Truth 表权威未动（两关键行仍在，32-case 不因本修复改变）', () => {
  assert.match(truthSrc, /invoiceOrientation:\s*'portrait',\s*userRotation:\s*0,\s*requestedPaperOrientation:\s*'landscape',\s*rotate:\s*180/,
    '{portrait,portrait,0,landscape}=180 行必须仍在（Truth 权威）')
  assert.match(truthSrc, /invoiceOrientation:\s*'landscape',\s*userRotation:\s*0,\s*requestedPaperOrientation:\s*'landscape',\s*rotate:\s*0/,
    '{portrait,landscape,0,landscape}=0 行必须仍在（修正后的正确行）')
})
