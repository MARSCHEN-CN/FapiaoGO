/**
 * 13-B.5.1a: buildPrintJobItem 升级为 pages[] 富对象模型（Render Print 子系统）。
 *
 * 背景（13-B.5.1 C0 审计 → 13-B.5.1a）：
 *   - 旧模型 pageUrls: string[] 只是 URL 列表，丢失了「页面身份 = docId + index」语义。
 *   - 新模型 pages[]：每项 { index, url }，下游经 fetchPrintRaster(docId, page.index+1)
 *     取栅格（url 仅作人类可读定位，不作为取数事实来源）。
 *
 * 本测试锁死 pages[] 模型已落地：
 *   - buildPrintJobItem 导出且基于 doc.pages 构建 pages[]（每项含 0-based index + url）。
 *   - 无 docId / 无 Document 时 pages 为空数组（usePrint 走兜底）。
 *   - 三个死函数（needsPerPageRender / getPageUrlsForPrint / validatePrintJob）已适配
 *     pages 模型，且全文不再出现 pageUrls（删除留待 13-B.5.1b）。
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

test('13-B.5.1a: buildPrintJobItem 导出且产出 pages[] 富对象（index + url）', () => {
  const code = src('utils/printAdapter.js')
  assert.ok(code.includes('export function buildPrintJobItem'), '必须导出 buildPrintJobItem')
  assert.ok(/pages:\s*doc\.pages\.map/.test(code), 'buildPrintJobItem 必须基于 doc.pages 构建 pages[]')
  assert.ok(code.includes('index,'), 'pages[] 每项必须含 0-based index')
  assert.ok(
    code.includes('resolvePrintUrl(page, doc.docId)'),
    'pages[].url 必须经 resolvePrintUrl（Render Contract /print 端点）'
  )
})

test('13-B.5.1a: 无 docId / 无 Document 时 pages 为空数组（兜底分支不变）', () => {
  const code = src('utils/printAdapter.js')
  assert.ok(/pages:\s*\[\]/.test(code), 'buildPrintJobItem 无 Document 分支必须返回 pages: []（usePrint 走兜底）')
})

test('13-B.5.1a: 死函数已适配 pages 模型，且不再引用 pageUrls', () => {
  const code = src('utils/printAdapter.js')
  assert.ok(!code.includes('pageUrls'), 'printAdapter.js 不得再出现 pageUrls（已迁移到 pages[]）')
  assert.ok(code.includes('item.pages'), 'needsPerPageRender / validatePrintJob 必须消费 item.pages')
  assert.ok(
    code.includes('(item.pages || []).map((p) => p.url)'),
    'getPageUrlsForPrint 必须 map pages → url（为遗留调用方保留）'
  )
})

test('13-B.5.1a: fetchPrintRaster 仍导出（Render Contract 打印栅格入口）', () => {
  const code = src('utils/printAdapter.js')
  assert.ok(
    /export\s+async\s+function\s+fetchPrintRaster/.test(code),
    'fetchPrintRaster 必须仍导出（docId → /print 取栅格）'
  )
})
