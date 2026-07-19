/**
 * D4-2 验收测试：Export 双路径接线（render 主路径 + legacy fallback 目标）。
 *
 * 运行方式：`node --test --loader ./env-shim.loader.mjs src/services/exportPaths.test.js`
 * （config.js 依赖 import.meta.env，需 shim；验证后删除 shim，不进 VCS）
 *
 * 不依赖 React / fetch 网络 / EventSource：均在此 mock。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// ── mock EventSource（consumeEventStream 仅用构造 + onmessage/onerror/close）──
globalThis.EventSource = class {
  constructor(url) { this.url = url }
  set onmessage(_) {}
  set onerror(_) {}
  close() {}
}

// ── 捕获 fetch 调用 ──
let lastRequest = null
globalThis.fetch = async (url, opts) => {
  lastRequest = { url, opts }
  return {
    ok: true,
    json: async () => ({ taskId: 'fake-task' }),
  }
}

const { startRenderExport, startPdfExport } = await import('../services/ExportService.js')

const SAMPLE_COMMAND = {
  version: 1,
  paper: { widthMm: 210, heightMm: 297, dpi: 300 },
  placement: { scale: 1.374, offsetX: 35, offsetY: 902.12 },
  rotatedBounds: { width: 1754, height: 1240 },
  contentRotation: 90,
  rotation: 90,
  clip: { x: 0, y: 0, width: 210, height: 297 },
  sourceRef: { path: 'invoice.pdf', page: 0 },
}

test('render path: POST { commands: [] } to /api/export-render', async () => {
  await startRenderExport([SAMPLE_COMMAND], {})
  assert.ok(lastRequest.url.endsWith('/api/export-render'), `endpoint = ${lastRequest.url}`)
  const body = JSON.parse(lastRequest.opts.body)
  assert.ok(Array.isArray(body.commands), 'body.commands must be an array')
  assert.equal(body.commands.length, 1)
  assert.deepEqual(body.commands[0], SAMPLE_COMMAND)
})

test('legacy fallback path: POST { mode, files } to /api/export-pdf', async () => {
  await startPdfExport({ mode: 'single', files: [{ name: 'a', path: '/a.pdf' }] }, {})
  assert.ok(lastRequest.url.endsWith('/api/export-pdf'), `endpoint = ${lastRequest.url}`)
  const body = JSON.parse(lastRequest.opts.body)
  assert.equal(body.mode, 'single')
  assert.ok(Array.isArray(body.files))
  assert.equal(body.files[0].path, '/a.pdf')
})

test('kill-switch: EXPORT_RENDER_ENABLED=false forces flag off (safety valve)', async () => {
  process.env.EXPORT_RENDER_ENABLED = 'false'
  const { EXPORT_RENDER_ENABLED } = await import('../layout/exportConstants.js')
  assert.equal(EXPORT_RENDER_ENABLED, false)
  delete process.env.EXPORT_RENDER_ENABLED
})
