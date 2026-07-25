/**
 * 13-B.3 C0 回归守卫：Legacy `previewImage` 负向消费边界。
 *
 * 背景（13-B.3 C0 只读审计，2026-07-25）：
 *   - 旧链 `parse_ofd() → render_ofd_page_preview()` 产出 base64 JPEG 挂在 `ParseResult.previewImage`。
 *   - Viewer / OCR / Import 列表 UI 早已迁移到 Render Contract（docId → /preview → WebP），
 *     不再消费 `previewImage`。
 *   - 唯一活消费者是 **Print legacy pipeline**（`hooks/usePrint.js` + `FileContext.jsx:61`）。
 *
 * 本测试锁死「渲染链不得回退到 previewImage」：
 *   - Viewer/OCR/Resolver/ThumbnailStrip 渲染组件不得出现 `previewImage`（base64 字段）。
 *   - 反向锚点：Print 域（usePrint.js / FileContext.jsx）仍合法持有 `previewImage`，
 *     证明本守卫不是「字段被全局删除后真空通过」，而是真在约束渲染链。
 *
 * 注意区分：
 *   - `.previewImage` / `previewImage:`（base64 旧字段）—— 渲染链**禁止**。
 *   - `_previewImageUrl`（Render Engine 的 http/blob URL 持有者）—— **允许**，是 Render Contract 产物。
 *   故用负向后顾 `(?<!_)previewImage` 精确匹配 base64 字段，避开 `_previewImageUrl`。
 *
 * 与 ofdBranchCleanup.test.js 同源：字符串静态断言（项目无 DOM 测试运行器，无法对
 * React 组件渲染做单元断言；而 13-B.3 的核心交付是「渲染链不依赖 previewImage」，故锁死）。
 *
 * 13-B.5 C1 已将 Print 迁到 Render Contract（docId-first，previewImage 仅作 docId 缺失兜底）。
 * 本守卫反向锚点保留：usePrint/FileContext 仍合法持有 previewImage（兜底），并新增正向锚点
 * 确认 fetchPrintRaster(f.docId ...) 已就位。若 13-B.5 C2 删除旧链，兜底锚点会先变红。
 *
 * @module services/__tests__/previewImageBoundary
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 本文件在 frontend/src/services/__tests__/，上两级到 src/，再拼相对路径。
const src = (rel) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

// 精确匹配 base64 旧字段 `previewImage`，排除 `_previewImageUrl`（合法 Render Engine URL 持有者）。
const RE_BASE64_FIELD = /(?<!_)previewImage/

test('13-B.3: Viewer 渲染链（DocumentViewer/DisplayAdapter/OverlayLayer/Resolver）不依赖 previewImage', () => {
  for (const f of [
    'components/DocumentViewer.jsx',
    'components/DisplayAdapter.jsx',
    'components/OverlayLayer.jsx',
    'utils/previewResourceResolver.js',
  ]) {
    const code = src(f)
    assert.ok(
      !RE_BASE64_FIELD.test(code),
      `${f} 不应出现 base64 字段 previewImage（Viewer 已走 Render Contract：docId → /preview → WebP）`
    )
  }
})

test('13-B.3: ThumbnailStrip 走 resolveThumbnailUrl(docId)，不读 page.previewImage', () => {
  const code = src('components/ThumbnailStrip.jsx')
  assert.ok(
    !RE_BASE64_FIELD.test(code),
    'ThumbnailStrip 不应出现 previewImage（翻页缩略图必须 docId-first）'
  )
  assert.ok(
    code.includes('resolveThumbnailUrl'),
    'ThumbnailStrip 必须仍走 resolveThumbnailUrl（/thumbnail/{docId}?page=），确认未退化'
  )
})

test('13-B.3: OCR 详情不 fallback previewImage（OverlayLayer 只吃 DocumentViewer 栅格）', () => {
  const code = src('components/OverlayLayer.jsx')
  assert.ok(
    !RE_BASE64_FIELD.test(code),
    'OverlayLayer（OCR/字段框）不应引用 previewImage，只叠加在 DocumentViewer 栅格之上'
  )
})

test('13-B.5 C1: Print 域仍合法持有 previewImage（仅作 docId 缺失兜底，非主路径）', () => {
  // 反向锚点：Print 是 §4.1 允许的 previewImage 消费者（旧 session 兜底）。
  const print = src('hooks/usePrint.js')
  assert.ok(
    RE_BASE64_FIELD.test(print),
    'usePrint.js 仍含 previewImage（仅作 docId 缺失兜底，13-B.5 C1 已迁 docId-first）'
  )
  // 正向锚点：迁移后必须存在 docId-first 取栅格逻辑（证明不再是 previewImage 主路径）
  assert.ok(
    print.includes('fetchPrintRaster(f.docId'),
    'usePrint.js 必须存在 fetchPrintRaster(f.docId ...) —— Print 已 docId-first（Render Contract）'
  )
  const ctx = src('contexts/FileContext.jsx')
  assert.ok(
    RE_BASE64_FIELD.test(ctx),
    'FileContext.jsx OFD 可打印判定仍含 previewImage（docId 缺失兜底）'
  )
  assert.ok(
    ctx.includes('!f.docId && !f.previewImage'),
    'FileContext.jsx OFD gate 必须改为 !f.docId && !f.previewImage（兜底语义，非主路径）'
  )
})
