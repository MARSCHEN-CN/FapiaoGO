/**
 * 13-F.1-lite PreviewImage Boundary Contract Test
 *
 * 锁定 Render 路径 previewImage 已剥离、Domain carrier 保留的边界：
 *   - 删除：app.py /split_pdf 内联 preview_image 生产者
 *          fileHelpers.js split_pdf→FileObj 载体入口
 *          usePreview.js b64toBlob(fObj.previewImage) 回退
 *   - 保留：ofd_parser / parsers / response_builder / invoice_service / useFileOps(OCR batch)
 *
 * 与 invoiceAssemblyContract.test.js 同构：源码正则断言（避免拉入 Vite-only config 链）。
 * 注意：buildFileObj 的 previewImage 默认 null 行为已由 fileHelpers.js 静态断言间接覆盖
 * （split_pdf 调用不再传 page.preview_image，buildFileObj 签名默认 null）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../../..') // frontend/src/utils -> print706

test('app.py /split_pdf：响应不再内联 preview_image', () => {
  const src = readFileSync(resolve(root, 'backend/app.py'), 'utf8')
  assert.ok(
    !/"preview_image":\s*preview_b64/.test(src),
    '/split_pdf 仍在产生 preview_image',
  )
  assert.ok(
    !/pages\.append\(\{[^}]*"preview_image"/.test(src),
    'split_pdf 的 pages.append 仍携带 preview_image 字段',
  )
})

test('fileHelpers.js：split_pdf 调用方不再透传 page.preview_image', () => {
  const src = readFileSync(resolve(__dirname, 'fileHelpers.js'), 'utf8')
  assert.ok(
    !/buildFileObj\([^)]*page\.preview_image/.test(src),
    'fileHelpers 仍把 page.preview_image 注入 FileObj',
  )
})

test('usePreview.js：无 b64toBlob(fObj.previewImage) 回退分支', () => {
  const src = readFileSync(resolve(root, 'frontend/src/hooks/usePreview.js'), 'utf8')
  assert.ok(
    !/b64toBlob\(fObj\.previewImage/.test(src),
    'usePreview 仍保留 previewImage base64 回退',
  )
})
