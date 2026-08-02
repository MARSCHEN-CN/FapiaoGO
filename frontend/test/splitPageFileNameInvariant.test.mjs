/**
 * 拆分页文件名端到端一致不变式测试（5.1c 收尾补充）
 *
 * 背景：5.1c 阶段修复了多页 PDF 拆分后的文件名/哈希提取逻辑（invoice_document_to_db_record
 * 的 fallback_hash 实为 hash_sha256 唯一来源，DB 按 hash_sha256 去重）。修复前，一个多页 PDF
 * 拆出的 N 张发票共享源文件 hash → 在 upsert 时相互被判重复（潜在数据丢失）；修复后各自按
 * per-page 文件名/哈希落库。
 *
 * 用户关注点：修复后，导出的另一个拆分文件会不会在 Excel 里提取不到？
 * 链路答案：不会。不变式为
 *   拆分页 name = "invoice_pX.pdf"（distinct）
 *     → DB 按同名存储（不再撞 hash 合并）
 *     → 导出 ExportService 用同名精确匹配后端
 *   → N 页全部可导出。
 *
 * 本测试锁定该不变式的四个环节：
 *   Case 1  buildSplitPageName 生成规则（不变式核心）
 *   Case 2  processPdfFile 真拆（mock fetch）：toAdd 含 N 条且 name 各异
 *   Case 3  extractExportFileNames 映射：N 条拆分页 → N 个 distinct 名（"导出能全中"）
 *   Case 4  ImportSessionStore.replaceFileItems：1 个占位被替换为 N 条 session.files
 *
 * 运行（frontend/ 目录）：
 *   node --loader ./test/resolve-js-loader.mjs --test test/splitPageFileNameInvariant.test.mjs
 *
 * 红基线验证：若把 fileHelpers.js:111 改回内联 `file.name.replace('.pdf',...)` 之外的行为、
 * 或把 ExportService 映射改回只取单一名，Case 1/3 必红，证明本测试锁的是机制。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

// ── 被测模块 ───────────────────────────────────────────────
import { buildSplitPageName, processPdfFile, buildFileObj } from '../src/utils/fileHelpers.js'
import { extractExportFileNames } from '../src/services/ExportService.js'
import { createImportSession, replaceFileItems } from '../src/stores/ImportSessionStore.js'

const SOURCE = 'invoice.pdf'
const PAGE_NAMES = ['invoice_p0.pdf', 'invoice_p1.pdf', 'invoice_p2.pdf']

// 伪造一页最小可解码的 PDF 字节（processPdfFile 只 atob 不校验内容）
function fakePageBytes() {
  return Buffer.from('%PDF-1.4 fake').toString('base64')
}
function makeSplitResponse(totalPages) {
  const pages = Array.from({ length: totalPages }, (_, i) => ({
    page_index: i,
    page_bytes: fakePageBytes(),
  }))
  return {
    success: true,
    total_pages: totalPages,
    pages,
  }
}

// ── Case 1: buildSplitPageName 生成规则（不变式核心） ──────────
test('Case 1a buildSplitPageName: 单页下标生成页码后缀名', () => {
  assert.equal(buildSplitPageName(SOURCE, 0), 'invoice_p0.pdf')
  assert.equal(buildSplitPageName(SOURCE, 2), 'invoice_p2.pdf')
})

test('Case 1b buildSplitPageName: 多页生成 N 个全部 distinct 的页码名', () => {
  const names = [0, 1, 2].map(i => buildSplitPageName(SOURCE, i))
  assert.deepEqual(names, PAGE_NAMES)
  assert.equal(new Set(names).size, names.length, '拆分页名必须互不重复')
})

test('Case 1c buildSplitPageName: 仅替换首个小写 .pdf（记录既有行为，不强制改）', () => {
  // 名含多个 .pdf：只替第一个；大写 .PDF 不替（与历史 String.replace 行为一致）
  assert.equal(buildSplitPageName('a.pdf.bak.pdf', 0), 'a_p0.pdf.bak.pdf')
  assert.equal(buildSplitPageName('INVOICE.PDF', 0), 'INVOICE.PDF')
})

// ── Case 2: processPdfFile 真拆（mock fetch） ────────────────
test('Case 2 processPdfFile: 3 页 PDF 拆分为 3 条独立文件，name 带页码后缀', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    json: async () => makeSplitResponse(3),
  })
  try {
    const file = new File([Buffer.from('%PDF-1.4')], SOURCE, { type: 'application/pdf' })
    const { toAdd } = await processPdfFile({ name: SOURCE, file }, () => '/tmp/x')
    const names = toAdd.map(f => f.name)

    assert.equal(toAdd.length, 3, '应拆出 3 条')
    assert.deepEqual(names, PAGE_NAMES, '每条 name 应为 invoice_pX.pdf')
    assert.equal(new Set(names).size, names.length, '拆分页名必须 distinct')
    // 校验每个拆分项确实带各自 pageNum，供后续精确匹配/预览
    assert.deepEqual(toAdd.map(f => f.pageNum), [0, 1, 2])
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── Case 3: extractExportFileNames 映射（导出选材） ──────────
test('Case 3a extractExportFileNames: 拆分页（无 originalName）产出 N 个 distinct 名 → 导出全中', () => {
  // 模拟 processPdfFile 输出的拆分页对象：只带 name，无 originalName
  const splitFiles = PAGE_NAMES.map(n => buildFileObj(new File([], n), n, '/tmp/x'))
  const names = extractExportFileNames(splitFiles)

  assert.equal(names.length, 3, '3 页应全部进入导出名列表')
  assert.deepEqual(names, PAGE_NAMES, '导出名应与 DB 存储名精确一致')
  assert.equal(new Set(names).size, names.length, '导出名必须 distinct（无丢失/无合并）')
})

test('Case 3b extractExportFileNames: 仅传父名时只产出 1 条（记录 _p 回退边界，不强制改）', () => {
  // 已知限制：若 UI 只把整个多页 PDF 当 1 个源文件条目导出（name="invoice.pdf"），
  // 映射只产出 1 个名；后端 _resolve_invoice_with_fallback 的 _p 回退仅捞回 1 页。
  // 这条断言锁定「当前行为」，防止有人误以为会一次带出全部页。
  const parentOnly = [{ name: SOURCE }]
  assert.deepEqual(extractExportFileNames(parentOnly), [SOURCE])
})

test('Case 3c extractExportFileNames: 优先 originalName（重命名场景）', () => {
  const renamed = [{ name: '2026-发票.pdf', originalName: 'invoice_p1.pdf' }]
  assert.deepEqual(extractExportFileNames(renamed), ['invoice_p1.pdf'])
})

// ── Case 4: ImportSessionStore.replaceFileItems 替换占位 → N 条 ──
test('Case 4 replaceFileItems: 1 个占位项被替换为 N 条拆分页，session.files 含 N 条 invoice_pX.pdf', () => {
  const session = createImportSession([])
  const placeholder = buildFileObj(new File([], SOURCE), SOURCE, '/tmp/x')
  session.files.push(placeholder) // 模拟拆分前占位的单文件

  const newItems = PAGE_NAMES.map(n => buildFileObj(new File([], n), n, '/tmp/x'))
  replaceFileItems(session.id, placeholder.key, newItems)

  const names = session.files.map(f => f.name)
  assert.equal(session.files.length, 3, '占位应被替换为 3 条')
  assert.deepEqual(names, PAGE_NAMES, '拆分后文件列表应含 N 条 invoice_pX.pdf')
  assert.equal(new Set(names).size, names.length, '列表中文件名必须 distinct')
})
