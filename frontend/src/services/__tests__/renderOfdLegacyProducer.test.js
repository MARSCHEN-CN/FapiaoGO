/**
 * 13-B.5 C2 门禁：OFD Legacy Render Producer 删除确认。
 *
 * 锁定 Render Print / Viewer 不再依赖后端旧链 render_ofd_page_preview：
 *   - 前端 print/preview 模块不得出现 render_ofd_page_preview 字符串（完全解耦旧 Producer）。
 *   - usePrint.js 的 OFD 取栅格必须 docId-first（fetchPrintRaster(f.docId ...)）。
 *   - buildPrintJobItem 产出 pages[] 富模型（docId+index 为身份），而非 pageUrls。
 *
 * 静态字符串断言（项目无 DOM 测试运行器，无法跑 hook 本体；C2 的核心是
 * “producer 已删、前端不再耦合旧 Producer 名称”，故锁死函数名解耦）。
 *
 * @module services/__tests__/renderOfdLegacyProducer
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 本文件在 frontend/src/services/__tests__/，上两级到 src/，再拼相对路径。
const src = (rel) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

const PRODUCER = 'render_ofd_page_preview'

test('13-B.5 C2: 前端 print/preview 模块不再引用旧 Producer render_ofd_page_preview', () => {
  for (const f of [
    'utils/printAdapter.js',
    'hooks/usePrint.js',
    'hooks/usePreview.js',
    'utils/printRenderer.js',
  ]) {
    const code = src(f)
    assert.ok(
      !code.includes(PRODUCER),
      `${f} 不得再引用 render_ofd_page_preview（旧链已于 C2 删除，改走 Render Contract）`
    )
  }
})

test('13-B.5 C2: usePrint.js OFD 取栅格 docId-first（fetchPrintRaster(f.docId ...)）', () => {
  const code = src('hooks/usePrint.js')
  assert.ok(
    code.includes('fetchPrintRaster(f.docId'),
    'usePrint.js OFD 分支必须 fetchPrintRaster(f.docId ...)（docId-first，previewImage 仅兜底）'
  )
})

test('13-B.5 C2: buildPrintJobItem 产出 pages[] 富模型（docId+index 为身份）', () => {
  const code = src('utils/printAdapter.js')
  assert.ok(
    code.includes('pages:') && code.includes('index') && code.includes('url'),
    'printAdapter.buildPrintJobItem 必须产出 pages:[{index,url}] 富对象（Render Print 唯一模型）'
  )
  assert.ok(
    !code.includes('pageUrls'),
    'printAdapter 不得再出现 pageUrls（13-B.5.1b 已清退，pages[] 为唯一 schema）'
  )
})
