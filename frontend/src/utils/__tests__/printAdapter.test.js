/**
 * 13-B.5.1b: printAdapter 单一 schema 守卫（Render Print Model Cleanup & Contract Freeze）。
 *
 * 背景（13-B.5.1a 建立 pages[] 模型 → 13-B.5.1b 删除 3 个死函数）：
 *   - buildPrintJobItem 现以 pages[] 富对象（{ index, url }）为唯一 Render Print schema。
 *   - needsPerPageRender / getPageUrlsForPrint / validatePrintJob 已在 13-B.5.1b 删除
 *     （确认零调用方），避免维护者误以为「全页 pages 已生效」或 reintroduce pageUrls 二次分叉。
 *
 * 本测试锁死：
 *   - buildPrintJobItem 产出 pages[]（每项含 0-based index + resolvePrintUrl 生成的 url）。
 *   - 无 docId / 无 Document 时 pages 为空数组（usePrint 走兜底）。
 *   - 模块**不再导出** 3 个死函数名（pages[] 已是唯一 schema）。
 *   - 全文无 pageUrls 残留（杜绝旧扁平 URL 列表二次分叉）。
 *   - fetchPrintRaster 仍导出（Render Contract 打印栅格入口）。
 *
 * 静态字符串断言（printAdapter 依赖 DocumentStore / previewResourceResolver，
 * 无法在 node --test 直接执行，故锁死符号接线即可）。
 *
 * @module utils/__tests__/printAdapter
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 本文件在 frontend/src/utils/__tests__/，上两级到 src/，再拼相对路径。
const src = (rel) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

test('13-B.5.1b: buildPrintJobItem 导出且产出 pages[] 富对象（index + url）', () => {
  const code = src('utils/printAdapter.js')
  assert.ok(code.includes('export function buildPrintJobItem'), '必须导出 buildPrintJobItem')
  assert.ok(/pages:\s*doc\.pages\.map/.test(code), 'buildPrintJobItem 必须基于 doc.pages 构建 pages[]')
  assert.ok(code.includes('index,'), 'pages[] 每项必须含 0-based index')
  assert.ok(
    code.includes('resolvePrintUrl(page, doc.docId)'),
    'pages[].url 必须经 resolvePrintUrl（Render Contract /print 端点）'
  )
})

test('13-B.5.1b: 无 docId / 无 Document 时 pages 为空数组（兜底分支不变）', () => {
  const code = src('utils/printAdapter.js')
  assert.ok(/pages:\s*\[\]/.test(code), 'buildPrintJobItem 无 Document 分支必须返回 pages: []（usePrint 走兜底）')
})

test('13-B.5.1b: 3 个死函数已删除，pages[] 为唯一 schema', () => {
  const code = src('utils/printAdapter.js')
  // 模块不得再导出这些函数（曾为 orphan，13-B.5.1b 收尾删除）
  assert.ok(
    !/export\s+function\s+needsPerPageRender/.test(code),
    'needsPerPageRender 必须已删除（不再导出）'
  )
  assert.ok(
    !/export\s+function\s+getPageUrlsForPrint/.test(code),
    'getPageUrlsForPrint 必须已删除（不再导出）'
  )
  assert.ok(
    !/export\s+function\s+validatePrintJob/.test(code),
    'validatePrintJob 必须已删除（不再导出）'
  )
  // 全文不得再出现 pageUrls 标识符（旧扁平 URL 列表模型已彻底迁移到 pages[]）
  assert.ok(!code.includes('pageUrls'), 'printAdapter.js 不得再出现 pageUrls（已迁移到 pages[]）')
})

test('13-B.5.1b: fetchPrintRaster 仍导出（Render Contract 打印栅格入口）', () => {
  const code = src('utils/printAdapter.js')
  assert.ok(
    /export\s+async\s+function\s+fetchPrintRaster/.test(code),
    'fetchPrintRaster 必须仍导出（docId → /print 取栅格）'
  )
})
