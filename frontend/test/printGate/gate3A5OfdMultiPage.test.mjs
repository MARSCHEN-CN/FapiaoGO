// gate3A5OfdMultiPage.test.mjs — PPC-OFD Gate 3-A.5: OFD Multi-Page Page Contract
//
// 验证命题：OFD 文档 pages[0..N] 的 page contract（render order / per-page size /
// per-page identity / file rotation isolation / no page collapse）是否稳定。
//
// 取证结论（docs/ppc-ofd-integration-gate3-a5-multipage-evidence.md）：
//   · 多页 OFD 打印 = N 次单页渲染循环（usePrint.js:202-248）：逐页 fetchPrintRaster(docId, index+1)
//     → pageItem={...f, _previewImageUrl: blobUrl}（**key 不变**）→ renderMultipleItemsToCanvas([pageItem], slotCount=1)
//     → buffers.push → N 物理页。
//   · 页映射：page.index(0-based) → renderPage=index+1(1-based) → /print/{docId}?page=N。
//   · rotation 是文件级共享（fileRotations[f.key]），N 页同一角度、每页独立施加一次。
//
// ⚠️ 风险验证（A5.5 render isolation）：每页 pageItem.key 相同（f.key）且 buildCacheKey
// （renderers.js:1013）只含 items key、不含页标识 → 多页循环可能命中 L2/L1 缓存返回第一页。
// 本 harness 如实模拟（同 f.key + 每页不同 _previewImageUrl），若 buffers 出现对象复用即暴露真实缺陷。
//
// 纪律：test-only；零生产码修改；复用 nodePolyfill.mjs / env-shim.loader.mjs。
//
// 运行：
//   cd frontend
//   node --loader ./test/printGate/env-shim.loader.mjs --test ./test/printGate/gate3A5OfdMultiPage.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installNodePolyfills, MOCK_IMAGE_SIZES } from './nodePolyfill.mjs'

installNodePolyfills()

// ─────────────────────────────────────────────────────────────
// 1. 加载真实生产链（动态 import：先 polyfill 后加载）
// ─────────────────────────────────────────────────────────────
const { renderMultipleItemsToCanvas } = await import('../../src/renderers.js')
const { getPaperPixels } = await import('../../src/layout.js')

const PREVIEW_DPI = 300
const PAPER_PX = getPaperPixels('A4', PREVIEW_DPI, false) // {2480, 3508}

// ─────────────────────────────────────────────────────────────
// 2. Fixture：3 页 OFD（页尺寸/identity marker 各异，模拟真实多页文档）
// ─────────────────────────────────────────────────────────────
const PAGE_FIXTURES = [
  { pageNum: 1, url: 'mock://ofd/mp/1', marker: 'PAGE_0', width: 2100, height: 2970 },
  { pageNum: 2, url: 'mock://ofd/mp/2', marker: 'PAGE_1', width: 2480, height: 3508 },
  { pageNum: 3, url: 'mock://ofd/mp/3', marker: 'PAGE_2', width: 2100, height: 2970 },
]
for (const p of PAGE_FIXTURES) {
  MOCK_IMAGE_SIZES.set(p.url, { width: p.width, height: p.height })
}

// 多页文件（同 key 语义 = 真实 usePrint：每页 pageItem 只换 _previewImageUrl，key 不变）
const OFD_MP = { key: 'ofd-mp', fileFormat: 'ofd', docId: 'doc-ofd-mp' }
const JOB_PAGES = [{ index: 0 }, { index: 1 }, { index: 2 }] // 模拟 printAdapter job.pages

// mock fetchPrintRaster：记录 (docId, pageNum) 调用序列，返回该页 mock raster URL
// （模拟 blob → createAndTrackBlobUrl → blobUrl 层；保留每页 URL 独立）
const fetchCalls = []
async function mockFetchPrintRaster(docId, pageNum) {
  fetchCalls.push({ docId, pageNum })
  const page = PAGE_FIXTURES[pageNum - 1]
  return { url: page.url }
}

// 模拟 usePrint.js:202-248 OFD 多页打印循环
async function simulateOfdMultiPagePrint(fileObj, pages, rotation) {
  const buffers = []
  const invocations = []
  for (const page of pages) {
    const blob = await mockFetchPrintRaster(fileObj.docId, page.index + 1) // 1-based pageNum
    const pageItem = { ...fileObj, _previewImageUrl: blob.url } // 同 key（真实语义），URL 每页独立
    const canvas = await renderMultipleItemsToCanvas(
      [pageItem], 'A4', PREVIEW_DPI, false,
      { [fileObj.key]: rotation },
      1, false, false,
      { strategy: 'vertical', customPaper: undefined },
    )
    invocations.push({ page: page.index, key: pageItem.key, url: blob.url, canvas })
    buffers.push(canvas)
  }
  return { buffers, invocations }
}

function drawSourceUrl(canvas) {
  const src = canvas?.ctx?.drawImages?.[0]?.source
  return src ? src._src : null // MockImage 记录其加载的 URL
}

// ─────────────────────────────────────────────────────────────
// A5.1 page index mapping：request pageNum = index+1
// ─────────────────────────────────────────────────────────────
test('A5.1 page index mapping: fetchPrintRaster 调用序列 = [(docId,1),(docId,2),(docId,3)]', async () => {
  fetchCalls.length = 0
  await simulateOfdMultiPagePrint(OFD_MP, JOB_PAGES, 0)
  assert.deepEqual(
    fetchCalls.map(c => c.pageNum),
    [1, 2, 3],
    'request pageNum = page.index+1（1-based，无 off-by-one）',
  )
  assert.ok(fetchCalls.every(c => c.docId === 'doc-ofd-mp'), 'docId 稳定')
})

// ─────────────────────────────────────────────────────────────
// A5.2 per-page raster identity：page i source → canvas i
// ─────────────────────────────────────────────────────────────
test('A5.2 per-page raster identity: 第 i 页 canvas 使用第 i 页 raster（drawImage source URL 逐页匹配）', async () => {
  fetchCalls.length = 0
  const { invocations } = await simulateOfdMultiPagePrint(OFD_MP, JOB_PAGES, 0)
  for (let i = 0; i < invocations.length; i++) {
    const expectedUrl = PAGE_FIXTURES[i].url
    const actualUrl = drawSourceUrl(invocations[i].canvas)
    assert.equal(actualUrl, expectedUrl,
      `page${i} canvas 应使用 ${PAGE_FIXTURES[i].marker}（实际 ${actualUrl}）——page i source → canvas i`)
  }
})

// ─────────────────────────────────────────────────────────────
// A5.3 no dimension collapse：每页使用自身 width/height
// ─────────────────────────────────────────────────────────────
test('A5.3 no dimension collapse: 不同尺寸页各自落盘（page0 2100×2970 vs page1 2480×3508）', async () => {
  fetchCalls.length = 0
  const { invocations } = await simulateOfdMultiPagePrint(OFD_MP, JOB_PAGES, 0)
  const r0 = invocations[0].canvas.ctx.drawImages[0]
  const r1 = invocations[1].canvas.ctx.drawImages[0]
  // 两页尺寸不同 → contain-fit 落盘比例不同（page1 满版，page0 竖向留边）
  assert.notDeepEqual(
    { w: r0.dw, h: r0.dh }, { w: r1.dw, h: r1.dh },
    'page0 与 page1 落盘尺寸不同（无 page[0] 复用 page[1]）',
  )
})

// ─────────────────────────────────────────────────────────────
// A5.4 file rotation isolation：文件级 rotation 逐页独立施加（N 页 = N 次）
// ─────────────────────────────────────────────────────────────
test('A5.4 file rotation isolation: rotation=90, 2 页 → 每页 canvas 独立 rotate 一次（总数=页数）', async () => {
  fetchCalls.length = 0
  const twoPages = JOB_PAGES.slice(0, 2)
  const { buffers } = await simulateOfdMultiPagePrint(OFD_MP, twoPages, 90)
  assert.equal(buffers.length, 2, '2 页')
  // 每页独立 canvas（对象不同）且各自 rotate 90° 一次
  assert.ok(buffers[0] !== buffers[1], '两页 canvas 独立（非共享对象）')
  for (let i = 0; i < 2; i++) {
    assert.equal(buffers[i].ctx.rotates.length, 1, `page${i} rotate 恰 1 次`)
    assert.equal(Math.round(buffers[i].ctx.rotates[0].degrees), 90, `page${i} rotate 角度 90°（文件级共享角度）`)
  }
})

// ─────────────────────────────────────────────────────────────
// A5.5 render isolation：N 页 = N 独立 canvas / N buffer（防内部缓存复用）
// ─────────────────────────────────────────────────────────────
test('A5.5 render isolation: 3 页 → 3 独立 canvas/buffer（对象不共享；顺序 page0→page1→page2）', async () => {
  fetchCalls.length = 0
  const { buffers, invocations } = await simulateOfdMultiPagePrint(OFD_MP, JOB_PAGES, 0)
  assert.equal(buffers.length, JOB_PAGES.length, 'buffers 数 = 页数（每页一物理页）')
  assert.ok(buffers[0] !== buffers[1], 'canvas0 ≠ canvas1（对象独立）')
  assert.ok(buffers[1] !== buffers[2], 'canvas1 ≠ canvas2（对象独立）')
  assert.deepEqual(
    invocations.map(inv => inv.page),
    [0, 1, 2],
    '渲染调用顺序 = page.index 升序',
  )
})

// ─────────────────────────────────────────────────────────────
// A5.6 cache identity sentinel（PPC-OFD-3A5-C1 结构性保护）
// ─────────────────────────────────────────────────────────────
test('A5.6 cache identity sentinel: 同 key + renderPage 区分 → canvas 独立（防未来改回 items.map(i=>i.key)）', async () => {
  // 用户裁决输入：同 file key，renderPage 1/2 区分（_previewImageUrl 相同——仅验证 renderPage 维度本身，
  // 不依赖 blob URL 差异，防止「未来移除 URL 维度」时此 sentinel 失效）
  MOCK_IMAGE_SIZES.set('mock://a56/same', { width: 2100, height: 2970 })
  const base = { key: 'ofd-file', fileFormat: 'ofd', docId: 'doc-ofd-file' }
  const c1 = await renderMultipleItemsToCanvas(
    [{ ...base, renderPage: 1, _previewImageUrl: 'mock://a56/same' }],
    'A4', PREVIEW_DPI, false, { 'ofd-file': 0 }, 1, false, false, { strategy: 'vertical' })
  const c2 = await renderMultipleItemsToCanvas(
    [{ ...base, renderPage: 2, _previewImageUrl: 'mock://a56/same' }],
    'A4', PREVIEW_DPI, false, { 'ofd-file': 0 }, 1, false, false, { strategy: 'vertical' })
  assert.ok(c1 !== c2,
    'cacheKey(renderPage:1) ≠ cacheKey(renderPage:2)——page identity 维度生效（结构性保护）')
})
