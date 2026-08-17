/**
 * PreviewImage Format Gate（Gate A 轻量验证）
 *
 * 锁死「previewImage 是 Raster（PNG / JPEG / WEBP 任一），消费端必须嗅探真实
 * MIME」，防止再次硬编码 image/png 导致 WebP 解码失败 → contentSource 缺失
 * → canvas 跳过绘制 → 白纸打印（Gate A 根因）。
 *
 * 与 previewImageBoundary.contract.test.js 同构：源码正则契约 + 纯函数行为测试，
 * 不拉入 Vite-only config 链（utils.js 为零 import 纯函数模块，可安全导入）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { detectImageMime } from '../utils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../../..') // frontend/src/utils -> print706

// --- 纯函数行为：detectImageMime 魔数识别 ---
const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64')

test('detectImageMime：PNG 魔数 89 50 4E 47 → image/png', () => {
  assert.equal(detectImageMime(b64('89504E470D0A1A0A') + 'AAAA'), 'image/png')
})

test('detectImageMime：JPEG 魔数 FF D8 FF → image/jpeg', () => {
  assert.equal(detectImageMime(b64('FFD8FF') + 'AAAA'), 'image/jpeg')
})

test('detectImageMime：WEBP（RIFF....WEBP）→ image/webp', () => {
  // RIFF <4-byte size> WEBP
  assert.equal(detectImageMime(b64('524946461200000057454250') + 'AAAA'), 'image/webp')
})

test('detectImageMime：空 / 不可识别 → 回退 image/png（旧行为兼容）', () => {
  assert.equal(detectImageMime(''), 'image/png')
  assert.equal(detectImageMime('not-a-real-image'), 'image/png')
})

test('detectImageMime：带 data: 前缀仍正确识别', () => {
  const png = 'data:image/png;base64,' + b64('89504E470D0A1A0A')
  assert.equal(detectImageMime(png), 'image/png')
  const webp = 'data:image/webp;base64,' + b64('524946461200000057454250')
  assert.equal(detectImageMime(webp), 'image/webp')
})

// --- 消费端契约：不得硬编码 image/png ---
test('usePrint.js：previewImage 兜底改用 previewImageToBlob（嗅探 MIME）', () => {
  const src = readFileSync(resolve(root, 'frontend/src/hooks/usePrint.js'), 'utf8')
  assert.ok(
    !/b64toBlob\(\s*f\.previewImage\s*,\s*'image\/png'/.test(src),
    'usePrint.js 仍硬编码 b64toBlob(f.previewImage, "image/png")',
  )
  assert.ok(
    /previewImageToBlob\(\s*f\.previewImage\s*\)/.test(src),
    'usePrint.js 未切换到 previewImageToBlob(f.previewImage)',
  )
})

test('mergeFinalArtifact.js：previewImage 兜底改用 previewImageToBlob（嗅探 MIME）', () => {
  const src = readFileSync(resolve(root, 'frontend/src/print/mergeFinalArtifact.js'), 'utf8')
  assert.ok(
    !/b64toBlob\(\s*f\.previewImage\s*,\s*'image\/png'/.test(src),
    'mergeFinalArtifact.js 仍硬编码 b64toBlob(f.previewImage, "image/png")',
  )
  assert.ok(
    /previewImageToBlob\(\s*f\.previewImage\s*\)/.test(src),
    'mergeFinalArtifact.js 未切换到 previewImageToBlob(f.previewImage)',
  )
})

test('utils.js：导出 detectImageMime + previewImageToBlob 且覆盖三种魔数', () => {
  const src = readFileSync(resolve(root, 'frontend/src/utils.js'), 'utf8')
  assert.ok(/export function detectImageMime/.test(src), 'utils.js 缺少 detectImageMime')
  assert.ok(/export function previewImageToBlob/.test(src), 'utils.js 缺少 previewImageToBlob')
  assert.ok(/0x89 && .*0x50 && .*0x4E && .*0x47/.test(src), 'detectImageMime 未覆盖 PNG 魔数')
  assert.ok(/0xFF && .*0xD8 && .*0xFF/.test(src), 'detectImageMime 未覆盖 JPEG 魔数')
  assert.ok(/0x57 && .*0x45 && .*0x42 && .*0x50/.test(src), 'detectImageMime 未覆盖 WEBP 魔数')
})
