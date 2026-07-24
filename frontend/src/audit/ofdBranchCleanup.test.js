/**
 * 13-A.3.7 回归守卫：前端不再对 OFD 做 viewer/preview 特判。
 *
 * 背景：13A-3 将 OFD 接入后端 Render Contract（registry→metadata→preview），
 * OFD 与 PDF/Image 在 DocumentViewer 中同级。前端不知道 fileFormat==='ofd'，
 * 统一由 docId + pageCount 驱动渲染路由。
 *
 * 本测试是「字符串不得存在」型回归守卫（类似 eslint no-restricted-syntax），
 * 因为 DisplayAdapter/App 是 React 组件、项目无 DOM 测试运行器，无法对组件渲染做
 * 单元断言；而 13-A.3.7 的核心交付就是「删除这些特判分支」，故用源码静态断言锁死。
 *
 * 允许的残留 ofd 引用（不在本测试范围内，刻意保留）：
 *   - renderDocument.js 的 open 网关（13-A.3.5b 契约入口，非渲染派发分支）
 *   - FileContext/usePrint/exportCapabilities 的 print/export 能力矩阵
 *   - utils.js 格式识别 / mime 映射
 *   - 类型定义与测试 fixture
 *
 * @module audit/ofdBranchCleanup
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8')

test('13-A.3.7: DisplayAdapter 不再对 OFD 特判（统一走 DocumentViewer）', () => {
  const code = src('components/DisplayAdapter.jsx')
  assert.ok(
    !code.includes("fileFormat !== 'ofd'"),
    'DisplayAdapter 路由不应含 fileFormat !== \'ofd\' 分叉'
  )
  assert.ok(
    !code.includes("fileFormat === 'ofd'"),
    'DisplayAdapter 不应含 fileFormat === \'ofd\' 分叉'
  )
})

test('13-A.3.7: App.jsx 不再含 OFD 预览硬拦截 / ZoomToolbar 激活特判', () => {
  const code = src('App.jsx')
  assert.ok(
    !code.includes("previewFile?.fileFormat !== 'ofd'"),
    'documentViewerActive 不应排除 ofd（OFD 应激活新 ZoomToolbar）'
  )
  assert.ok(
    !code.includes("_fileFormat === 'ofd' && !previewFile._previewImageUrl"),
    '不应再有 OFD 预览硬拦截分支'
  )
  assert.ok(
    !code.includes('OFD 不支持预览'),
    '不应再有 "OFD 不支持预览" 文案'
  )
})

test('13-A.3.7: previewResourceResolver 无格式分支（OFD 与 PDF/Image 同级）', () => {
  const code = src('utils/previewResourceResolver.js')
  assert.ok(!/ofd/i.test(code), 'previewResourceResolver 不应含任何 ofd 分支')
})
