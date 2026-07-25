/**
 * 13-B.5 C1 回归守卫：Print 渲染源已迁到 Render Contract（docId-first）。
 *
 * 背景（13-B.5 C0 审计 + C1 实施，2026-07-25）：
 *   - Print legacy V2 canvas 路径（usePrint.js）原以 `b64toBlob(f.previewImage)` 作为
 *     OFD/Image 打印源栅格，是旧链 `render_ofd_page_preview` 的唯一活消费者。
 *   - C1 把 OFD 改为 docId-first：经由 `printAdapter.fetchPrintRaster(docId)` →
 *     `GET /print/{docId}?page=1`（200dpi WebP，Render Contract）。
 *   - `previewImage` 仅保留为「docId 缺失的旧 session」兜底，不再是主路径。
 *
 * 本测试锁死「C1 迁移已落地」：
 *   - printAdapter.js 导出 fetchPrintRaster（Render Contract 入口）。
 *   - usePrint.js 从 ../utils/printAdapter 引入 fetchPrintRaster。
 *   - usePrint.js OFD 分支以 `fetchPrintRaster(f.docId ...)` 取栅格（docId-first）。
 *   - FileContext.jsx OFD 可打印 gate 已放宽为 `!f.docId && !f.previewImage`（兜底语义）。
 *
 * 与 previewImageBoundary.test.js 互补：那边锁「previewImage 不再进入渲染链主路径」，
 * 这边锁「docId-first 的 Render Contract 路径已就位」。两个守卫合起来证明 C1 迁移完成。
 *
 * 静态字符串断言（项目无 DOM 测试运行器，无法对 React/hook 做单元断言；而 C1 的核心
 * 交付是「Print 改走 docId 渲染」，故锁死符号接线即可）。
 *
 * @module services/__tests__/printRasterMigration
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 本文件在 frontend/src/services/__tests__/，上两级到 src/，再拼相对路径。
const src = (rel) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

test('13-B.5 C1: printAdapter.js 导出 fetchPrintRaster（Render Contract 打印栅格入口）', () => {
  const code = src('utils/printAdapter.js')
  assert.ok(
    /export\s+async\s+function\s+fetchPrintRaster/.test(code),
    'printAdapter.js 必须导出 fetchPrintRaster（docId → /print 取栅格）'
  )
  assert.ok(
    code.includes('resolvePrintUrl'),
    'printAdapter.js 必须使用 resolvePrintUrl（/print 端点），而非旧的 resolvePreviewUrl'
  )
})

test('13-B.5 C1: usePrint.js 从 ../utils/printAdapter 引入 fetchPrintRaster', () => {
  const code = src('hooks/usePrint.js')
  assert.ok(
    code.includes("import { fetchPrintRaster } from '../utils/printAdapter'"),
    'usePrint.js 必须 import fetchPrintRaster from ../utils/printAdapter（接线到 Render Contract）'
  )
})

test('13-B.5 C1: usePrint.js OFD 分支以 docId-first 取 Render Contract 栅格', () => {
  const code = src('hooks/usePrint.js')
  assert.ok(
    code.includes('fetchPrintRaster(f.docId'),
    'usePrint.js OFD 分支必须先尝试 fetchPrintRaster(f.docId ...)（docId-first），previewImage 仅作兜底'
  )
})

test('13-B.5 C1: FileContext.jsx OFD gate 已放宽为 docId OR previewImage 兜底', () => {
  const code = src('contexts/FileContext.jsx')
  assert.ok(
    code.includes('!f.docId && !f.previewImage'),
    'FileContext.jsx OFD 可打印判定必须改为 !f.docId && !f.previewImage（docId 优先，previewImage 兜底）'
  )
})
