/**
 * M1-a 现状锁定 · 前端页码基数链路（FileObj → DocumentStore）
 *
 * ⚠️ 本文件锁定的是【当前真实行为】，**不是目标契约**。
 *    其中数条断言锁住的正是我们认为有问题的行为（分支相关的映射、与 JSDoc
 *    矛盾的命名基数、两套 pageId 方言）。先锁住，是为了让 M1-b/M1-c 改动时
 *    「到底影响了什么」可见。行为被修正时本文件【预期失败】——失败即信号，
 *    应显式更新断言，而不是悄悄放宽。
 *
 * 覆盖范围（对应 M1-a 清单 3/4/5）
 * ---------------------------------------------------------------
 *   #3  split_pdf.page_index → fileObj.pageNum 是否原样透传
 *   #4  DocumentStore: pageNum → pages[].index / renderPage
 *   #5  跨层链路 1 → 1 → 0 → 1 与 2 → 2 → 1 → 2
 *
 * 跨层接缝说明（#5 为何能在纯前端进程内验证）
 * ---------------------------------------------------------------
 * 本文件用 SPLIT_PDF_RESPONSE 作为 `/split_pdf` 的响应替身，并通过 stub
 * `globalThis.fetch` 驱动**真实的 processPdfFile**（而非重建一份逻辑）。
 * 该 fixture 的 page_index 序列（1-based）与 page_id 后缀（0-based）由后端
 * 侧测试独立锁定：
 *
 *     backend/tests/test_m1a_split_pdf_page_base.py
 *       ::test_fact_page_index_sequence_is_1_to_n
 *       ::test_fact_page_id_suffix_is_zero_based_while_page_index_is_one_based
 *
 * 即：后端 base 一旦改变，先在后端测试炸；本文件的 fixture 自检
 * （assertFixtureMirrorsBackend）则保证 fixture 不会被单方面改成 0-based
 * 而使前端「假绿」。两端合起来构成完整的跨层链路锁。
 *
 * 运行：
 *   cd frontend && node --loader ./test/resolve-js-loader.mjs --test test/pageBaseContract.m1a.test.mjs
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFileObj,
  processPdfFile,
  buildSplitPageName,
} from '../src/utils/fileHelpers.js'
import {
  ensureDocumentFromFileObj,
  clearAllDocuments,
} from '../src/stores/DocumentStore.js'

// ---------------------------------------------------------------------------
// 后端响应替身：形状与 app.py:986-990 的真实产物一致
// ---------------------------------------------------------------------------
const PARENT_DOC_ID = 'parent-content-hash-24'
const FILE_HASH = 'abcdef0123456789'

const SPLIT_PDF_RESPONSE = {
  success: true,
  total_pages: 3,
  doc_id: PARENT_DOC_ID,
  pages: [
    // page_index 1-based / page_id 后缀 0-based —— 与后端现状一致
    { page_index: 1, page_id: `${FILE_HASH}_0`, page_bytes: btoa('page-one') },
    { page_index: 2, page_id: `${FILE_HASH}_1`, page_bytes: btoa('page-two') },
    { page_index: 3, page_id: `${FILE_HASH}_2`, page_bytes: btoa('page-three') },
  ],
}

/** fixture 自检：防止有人把 fixture 单方面改成 0-based 造成前端假绿。 */
function assertFixtureMirrorsBackend() {
  const indexes = SPLIT_PDF_RESPONSE.pages.map((p) => p.page_index)
  assert.deepEqual(indexes, [1, 2, 3], 'fixture 的 page_index 必须是 1-based（镜像后端现状）')
  SPLIT_PDF_RESPONSE.pages.forEach((p, i) => {
    assert.equal(p.page_id, `${FILE_HASH}_${i}`, 'fixture 的 page_id 后缀必须是 0-based')
  })
}

function makeSourceFile(name = 'invoice.pdf') {
  return {
    name,
    file: new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, {
      type: 'application/pdf',
    }),
  }
}

/** 构造一个最小 fileObj（不经 processPdfFile），用于 DocumentStore 单点验证。 */
function makePageFileObj({ docId, sourceDocId = null, pageNum }) {
  const f = buildFileObj(
    new File([new Uint8Array([1])], 'p.pdf', { type: 'application/pdf' }),
    'p.pdf',
    'C:/tmp/p.pdf',
    null,
    docId,
    pageNum,
  )
  if (sourceDocId) f.sourceDocId = sourceDocId
  return f
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  clearAllDocuments()
  globalThis.fetch = async () => ({ json: async () => SPLIT_PDF_RESPONSE })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  clearAllDocuments()
})

// ===========================================================================
// #3  split_pdf.page_index → fileObj.pageNum（驱动真实 processPdfFile）
// ===========================================================================
describe('M1-a #3 · FileObj 层：page_index → pageNum 原样透传', () => {
  it('fixture 自检：镜像后端 1-based page_index / 0-based page_id 后缀', () => {
    assertFixtureMirrorsBackend()
  })

  it('现状：fileObj.pageNum === page.page_index，无任何 ±1 变换', async () => {
    const { toAdd, isMultiPage } = await processPdfFile(makeSourceFile(), (f) => `C:/in/${f.name}`)

    assert.equal(isMultiPage, true)
    assert.equal(toAdd.length, 3)
    assert.deepEqual(
      toAdd.map((f) => f.pageNum),
      [1, 2, 3],
      '现状锁定：pageNum 直接取自 page_index（fileHelpers.js:133），故运行时为 1-based',
    )
    // 与 fixture 逐项恒等 —— 明确「透传」而非「巧合相等」
    SPLIT_PDF_RESPONSE.pages.forEach((p, i) => {
      assert.equal(toAdd[i].pageNum, p.page_index, `第 ${i} 项应与 page_index 恒等`)
    })
  })

  it('现状：拆分页共享父 docId 与 sourceDocId（均为后端 data.doc_id）', async () => {
    const { toAdd } = await processPdfFile(makeSourceFile(), (f) => `C:/in/${f.name}`)
    for (const f of toAdd) {
      assert.equal(f.docId, PARENT_DOC_ID, '现状：docId = 父 PDF 内容哈希')
      assert.equal(f.sourceDocId, PARENT_DOC_ID, '现状：sourceDocId 同样是父哈希')
      assert.equal(f.totalPages, 3)
    }
    const instanceIds = new Set(toAdd.map((f) => f.instanceId))
    assert.equal(instanceIds.size, 1, '现状：同批拆分页共享同一 instanceId')
  })

  it('现状：拆分页文件名后缀用 1-based 的 page_index（与其 JSDoc 声称的 0-based 相反）', async () => {
    const { toAdd } = await processPdfFile(makeSourceFile('invoice.pdf'), (f) => `C:/in/${f.name}`)
    assert.deepEqual(
      toAdd.map((f) => f.name),
      ['invoice_p1.pdf', 'invoice_p2.pdf', 'invoice_p3.pdf'],
      '现状锁定：fileHelpers.js:130 传入 page.page_index(1-based)，故首页是 _p1 而非 _p0',
    )
    // buildSplitPageName 本身是纯函数，基数完全由调用方决定：
    assert.equal(buildSplitPageName('invoice.pdf', 0), 'invoice_p0.pdf')
    assert.equal(buildSplitPageName('invoice.pdf', 1), 'invoice_p1.pdf')
  })
})

// ===========================================================================
// #3b buildFileObj 自身不做任何页码变换
// ===========================================================================
describe('M1-a #3b · buildFileObj：pageNum 纯透传，pageCount 恒为 1', () => {
  const f = () => new File([new Uint8Array([1])], 'x.pdf', { type: 'application/pdf' })

  it('现状：未传 pageNum → null（不默认 0，也不默认 1）', () => {
    const o = buildFileObj(f(), 'x.pdf', 'C:/x.pdf')
    assert.equal(o.pageNum, null)
  })

  it('现状：pageNum=0 被保留为 0（?? 而非 ||）', () => {
    const o = buildFileObj(f(), 'x.pdf', 'C:/x.pdf', null, 'D', 0)
    assert.equal(o.pageNum, 0, '现状锁定：0 是合法值，不会被 || 吞成 null')
  })

  it('现状：pageNum=1 原样保留', () => {
    const o = buildFileObj(f(), 'x.pdf', 'C:/x.pdf', null, 'D', 1)
    assert.equal(o.pageNum, 1)
  })

  it('现状：pageCount 硬编码 1、pages 恒为单元素 index=0（与真实页数无关）', () => {
    const o = buildFileObj(f(), 'x.pdf', 'C:/x.pdf', null, 'D', 3)
    assert.equal(o.pageCount, 1, '现状锁定：fileHelpers.js:56 硬编码，OFD 多页也是 1')
    assert.deepEqual(o.pages.map((p) => p.index), [0])
  })
})

// ===========================================================================
// #4  DocumentStore：pageNum → pages[].index / renderPage
// ===========================================================================
describe('M1-a #4 · DocumentStore：映射是【分支相关】的', () => {
  it('现状 · 多页分支（pageNums.length > 1）：index = pageNum-1，renderPage = pageNum', () => {
    const siblings = [1, 2, 3].map((n) =>
      makePageFileObj({ docId: 'DOC-MULTI', sourceDocId: 'DOC-MULTI', pageNum: n }),
    )
    const doc = ensureDocumentFromFileObj(siblings[0], siblings)

    assert.ok(doc, '应成功注册 Document')
    assert.deepEqual(doc.pages.map((p) => p.index), [0, 1, 2], 'index 为 0-based')
    assert.deepEqual(doc.pages.map((p) => p.renderPage), [1, 2, 3], 'renderPage 为 1-based')
    // 该分支下 renderPage === index + 1 成立
    doc.pages.forEach((p) => {
      assert.equal(p.renderPage, p.index + 1, '多页分支：renderPage === index + 1')
    })
  })

  it('现状 · 单页分支（pageNums.length === 1）：pageNum 被丢弃，恒 index=0 / renderPage=1', () => {
    // 关键反例：pageNum=2 但未传 siblings → 走单页分支
    const solo = makePageFileObj({ docId: 'DOC-SOLO', pageNum: 2 })
    const doc = ensureDocumentFromFileObj(solo)

    assert.deepEqual(doc.pages.map((p) => p.index), [0])
    assert.deepEqual(doc.pages.map((p) => p.renderPage), [1])
    assert.notEqual(
      doc.pages[0].index,
      solo.pageNum - 1,
      '现状锁定：单页分支不做 pageNum-1，「index = pageNum-1」并非全局规律',
    )
  })

  it('现状：pageNum=null 被视为 1（?? 1），落入单页分支', () => {
    const nullPage = makePageFileObj({ docId: 'DOC-NULL', pageNum: null })
    const doc = ensureDocumentFromFileObj(nullPage)
    assert.deepEqual(doc.pages.map((p) => p.index), [0])
    assert.deepEqual(doc.pages.map((p) => p.renderPage), [1])
  })

  it('现状：siblings 靠 sourceDocId 匹配也能聚合（docId 已各自解析时）', () => {
    const sibs = [1, 2].map((n) =>
      makePageFileObj({ docId: `PER-PAGE-${n}`, sourceDocId: 'SHARED-SRC', pageNum: n }),
    )
    const doc = ensureDocumentFromFileObj(sibs[0], sibs)
    assert.deepEqual(doc.pages.map((p) => p.index), [0, 1], '现状：sharesSource 分支同样进入多页聚合')
  })

  it('现状：PageMeta.pageId 使用 0-based index（`docId:p{index}` 方言）', () => {
    const siblings = [1, 2].map((n) =>
      makePageFileObj({ docId: 'DOC-PID', sourceDocId: 'DOC-PID', pageNum: n }),
    )
    const doc = ensureDocumentFromFileObj(siblings[0], siblings)
    assert.deepEqual(
      doc.pages.map((p) => p.pageId),
      ['DOC-PID:p0', 'DOC-PID:p1'],
      '现状锁定：InvoiceDocument.js:56 的 `:p{index}` 是 0-based；'
        + '注意 utils/identity.js 另有一套 1-based 的 `:p{n}` 方言，二者形状相同、含义相反（M2）',
    )
  })
})

// ===========================================================================
// #5  跨层链路：backend page_index → fileObj.pageNum → index → renderPage
// ===========================================================================
describe('M1-a #5 · 跨层链路锁（前提：siblings 聚合的多页分支）', () => {
  it('现状：1 → 1 → 0 → 1 且 2 → 2 → 1 → 2', async () => {
    assertFixtureMirrorsBackend()

    // 第 1 跳：backend page_index → fileObj.pageNum（真实 processPdfFile）
    const { toAdd } = await processPdfFile(makeSourceFile(), (f) => `C:/in/${f.name}`)

    // 第 2 跳：fileObj 群 → DocumentStore（真实 ensureDocumentFromFileObj）
    const doc = ensureDocumentFromFileObj(toAdd[0], toAdd)
    assert.ok(doc, '应成功注册 Document')
    assert.equal(doc.pages.length, 3, '3 个拆分页应聚合为 3 页 Document')

    const CHAIN = [
      { backendPageIndex: 1, pageNum: 1, storeIndex: 0, renderPage: 1 },
      { backendPageIndex: 2, pageNum: 2, storeIndex: 1, renderPage: 2 },
      { backendPageIndex: 3, pageNum: 3, storeIndex: 2, renderPage: 3 },
    ]

    CHAIN.forEach((expected, i) => {
      assert.equal(
        SPLIT_PDF_RESPONSE.pages[i].page_index,
        expected.backendPageIndex,
        `链路[${i}] backend.page_index`,
      )
      assert.equal(toAdd[i].pageNum, expected.pageNum, `链路[${i}] fileObj.pageNum`)
      assert.equal(doc.pages[i].index, expected.storeIndex, `链路[${i}] DocumentStore.pages[].index`)
      assert.equal(doc.pages[i].renderPage, expected.renderPage, `链路[${i}] renderPage`)
    })
  })

  it('现状事实表（可执行版）：各层基数一览', async () => {
    const { toAdd } = await processPdfFile(makeSourceFile(), (f) => `C:/in/${f.name}`)
    const doc = ensureDocumentFromFileObj(toAdd[0], toAdd)

    const facts = {
      'split_pdf.page_index': SPLIT_PDF_RESPONSE.pages[0].page_index, // 1-based
      'fileObj.pageNum': toAdd[0].pageNum,                            // 1-based
      'DocumentStore.pages[].index': doc.pages[0].index,              // 0-based
      'DocumentStore.renderPage': doc.pages[0].renderPage,            // 1-based
    }

    assert.deepEqual(facts, {
      'split_pdf.page_index': 1,
      'fileObj.pageNum': 1,
      'DocumentStore.pages[].index': 0,
      'DocumentStore.renderPage': 1,
    }, '现状锁定：首页在四层的取值。SourcePageIdentity.sourcePageIndex 的目标 0-based 尚未接入任何一层')
  })
})
