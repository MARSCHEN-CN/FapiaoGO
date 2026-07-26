/**
 * 13-A.3.5b-C3: renderDocument 契约测试
 *
 * 运行：node --test src/services/renderDocument.test.js
 * 不依赖 React / 真实网络：globalThis.fetch 在此 mock。
 * 不依赖 config.js / env-shim（renderDocument.js 本地安全解析 BACKEND_URL）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// ── mock fetch ──
let requests = []
let mockResponse = {
  ok: true,
  json: async () => ({ success: true, doc_id: 'doc_abc123', page_count: 2 }),
}
globalThis.fetch = async (url, opts) => {
  requests.push({ url, opts })
  return mockResponse
}

const { openRenderDocument, ensureRenderContract } = await import('../services/renderDocument.js')

function makeFile(name = 'test.ofd', bytes = 'dummy-ofd-bytes') {
  return new File([Buffer.from(bytes)], name, { type: 'application/octet-stream' })
}

test('openRenderDocument: POST multipart 到 /api/documents/open 并映射 doc_id', async () => {
  requests = []
  const { docId } = await openRenderDocument(makeFile(), 'test.ofd')
  assert.equal(docId, 'doc_abc123')
  assert.equal(requests.length, 1)
  assert.ok(requests[0].url.endsWith('/api/documents/open'), `url=${requests[0].url}`)
  assert.equal(requests[0].opts.method, 'POST')
  assert.ok(requests[0].opts.body instanceof FormData, 'body 必须是 FormData')
})

test('openRenderDocument: HTTP 失败 → { docId: null }（增强项，绝不抛出）', async () => {
  requests = []
  mockResponse = { ok: false, status: 500, json: async () => ({}) }
  const { docId } = await openRenderDocument(makeFile())
  assert.equal(docId, null)
  assert.equal(requests.length, 1)
  // 复原，避免影响后续 case
  mockResponse = { ok: true, json: async () => ({ success: true, doc_id: 'doc_abc123' }) }
})

test('openRenderDocument: 后端 success=false → { docId: null }', async () => {
  requests = []
  mockResponse = { ok: true, json: async () => ({ success: false, error: 'nope' }) }
  const { docId } = await openRenderDocument(makeFile())
  assert.equal(docId, null)
  mockResponse = { ok: true, json: async () => ({ success: true, doc_id: 'doc_abc123' }) }
})

test('ensureRenderContract: 已有 docId → 不发起请求，直接返回', async () => {
  requests = []
  const fileObj = { docId: 'existing', file: makeFile(), fileFormat: 'ofd' }
  const id = await ensureRenderContract(fileObj)
  assert.equal(id, 'existing')
  assert.equal(requests.length, 0, '已有 docId 不应调用 fetch')
})

test('ensureRenderContract: ofd + file → 注册并写回 docId', async () => {
  requests = []
  const fileObj = { file: makeFile('a.ofd'), fileFormat: 'ofd', name: 'a.ofd' }
  const id = await ensureRenderContract(fileObj)
  assert.equal(id, 'doc_abc123')
  assert.equal(fileObj.docId, 'doc_abc123', '必须把 docId 写回 fileObj')
  assert.equal(requests.length, 1)
})

test('ensureRenderContract: 非 ofd 格式 → 不请求，返回 null', async () => {
  requests = []
  const pdfObj = { file: makeFile('a.pdf', 'pdf-bytes'), fileFormat: 'pdf' }
  const id = await ensureRenderContract(pdfObj)
  assert.equal(id, null)
  assert.equal(requests.length, 0)
  assert.equal(pdfObj.docId, undefined, '非 ofd 不应写 docId')
})

test('ensureRenderContract: 缺 file → 返回 null', async () => {
  requests = []
  const noFile = { fileFormat: 'ofd' }
  assert.equal(await ensureRenderContract(noFile), null)
  assert.equal(requests.length, 0)
})

test('ensureRenderContract: open 失败时降级返回 null（不抛，不阻断导入）', async () => {
  requests = []
  mockResponse = { ok: false, status: 502, json: async () => ({}) }
  const fileObj = { file: makeFile('b.ofd'), fileFormat: 'ofd', name: 'b.ofd' }
  const id = await ensureRenderContract(fileObj)
  assert.equal(id, null)
  assert.equal(fileObj.docId, undefined, '失败不应写 docId')
  mockResponse = { ok: true, json: async () => ({ success: true, doc_id: 'doc_abc123' }) }
})
