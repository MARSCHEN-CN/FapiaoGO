/**
 * 13-A.3.5c: metadata 驱动 DocumentStore 注册 — 验收测试
 *
 * 运行：node --test src/stores/DocumentStore.metadata.test.js
 * 不依赖 React / 真实网络：globalThis.fetch 在此 mock。
 * 覆盖用户冻结的 3 个核心 case：OFD 2 页 / PNG 1 页 / PDF siblings 不破。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// ── mock fetch（/metadata/{docId}）──
// 默认成功返回 metadataResponses 中预设的 pages[]；可被单测临时覆盖为 404。
const metadataResponses = new Map()
globalThis.fetch = async (url) => {
  const m = String(url).match(/\/metadata\/(.+)$/) || String(url).match(/\/api\/metadata\/(.+)$/)
  const docId = m ? decodeURIComponent(m[1]) : null
  const pages = metadataResponses.get(docId) || []
  return {
    ok: true,
    json: async () => ({ success: true, doc_id: docId, page_count: pages.length, pages }),
  }
}

const {
  ensureDocumentFromMetadata,
  ensureDocumentFromFileObj,
  patchPageMeta,
  getDocument,
  clearAllDocuments,
} = await import('../stores/DocumentStore.js')
const { ensureDocumentMetadata } = await import('../services/renderDocument.js')

function makeSiblings(docId, count) {
  return Array.from({ length: count }, (_, i) => ({
    key: `${docId}-p${i}`,
    docId,
    pageNum: i + 1,
    name: `page${i}.pdf`,
  }))
}

test('Case 1: OFD → metadata 驱动注册 2 页（rotation 映射 sourceRotation）', async () => {
  clearAllDocuments()
  metadataResponses.set('ofd1', [
    { index: 0, width: 2480, height: 3508, rotation: 0 },
    { index: 1, width: 2480, height: 3508, rotation: 90 },
  ])
  const doc = await ensureDocumentMetadata({ docId: 'ofd1', name: 'inv.ofd', fileFormat: 'ofd' })
  assert.ok(doc, '应注册成功')
  assert.equal(doc.pageCount, 2, 'OFD 应为 2 页（纠正 siblings 压成的 1 页）')
  assert.equal(doc.pages[0].sourceRotation, 0, 'API rotation=0 → sourceRotation=0')
  assert.equal(doc.pages[1].sourceRotation, 90, 'API rotation=90 → sourceRotation=90')
  assert.equal(doc.pages[0].width, 2480)
  assert.equal(getDocument('ofd1').pageCount, 2)
})

test('Case 2: PNG → 单页（直接调用 ensureDocumentFromMetadata，PNG 不走 ensureDocumentMetadata 守卫）', async () => {
  clearAllDocuments()
  const doc = ensureDocumentFromMetadata({
    docId: 'png1',
    pages: [{ index: 0, width: 1582, height: 1024, rotation: 0 }],
    filename: 'scan.png',
  })
  assert.ok(doc)
  assert.equal(doc.pageCount, 1, 'PNG 应为 1 页')
  assert.equal(doc.pages[0].width, 1582)
})

test('Case 3: PDF siblings 注册不被 metadata 破坏（仍 3 页 + 真实尺寸补全，直接调用 ensureDocumentFromMetadata）', async () => {
  clearAllDocuments()
  const siblings = makeSiblings('pdf1', 3)
  const fromSiblings = ensureDocumentFromFileObj(siblings[0], siblings)
  assert.equal(fromSiblings.pageCount, 3, 'siblings 聚合应为 3 页')

  const doc = ensureDocumentFromMetadata({
    docId: 'pdf1',
    pages: [
      { index: 0, width: 595, height: 842, rotation: 0 },
      { index: 1, width: 595, height: 842, rotation: 0 },
      { index: 2, width: 595, height: 842, rotation: 0 },
    ],
    filename: 'doc.pdf',
  })
  assert.equal(doc.pageCount, 3, 'metadata 不应破坏 PDF 3 页')
  assert.equal(doc.pages[0].width, 595, 'metadata 真实尺寸应补全（siblings 注册时为 0）')
  assert.equal(doc.pages[2].index, 2, '页索引应保持')
})

test('Case 3b: PDF 未注册 render registry → /metadata 404 静默降级，siblings 注册保留', async () => {
  clearAllDocuments()
  const siblings = makeSiblings('pdf2', 2)
  ensureDocumentFromFileObj(siblings[0], siblings)
  // 临时覆盖为 404（模拟 PDF/Image 未走 /api/documents/open）
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
  const doc = await ensureDocumentMetadata({ docId: 'pdf2', name: 'doc2.pdf' })
  assert.equal(doc, null, '404 应降级返回 null（增强项绝不抛）')
  assert.equal(getDocument('pdf2').pageCount, 2, 'siblings 2 页注册应保留')
})

test('确保：metadata 缺维时回退保留既有真实尺寸（防御性）', async () => {
  clearAllDocuments()
  ensureDocumentFromFileObj({ key: 'img1', docId: 'img1', pageNum: 1 }, null)
  patchPageMeta('img1', 0, { width: 1000, height: 800, sourceRotation: 0 })
  // metadata 返回缺维（width/height=0）→ 应保留既有 1000x800
  const doc = ensureDocumentFromMetadata({ docId: 'img1', pages: [{ index: 0, width: 0, height: 0, rotation: 0 }] })
  assert.equal(doc.pages[0].width, 1000, '缺维应回退保留既有真实尺寸')
  assert.equal(doc.pages[0].height, 800)
})
