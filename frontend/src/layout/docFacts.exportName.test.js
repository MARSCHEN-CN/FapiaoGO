/**
 * Commit 1b 验收矩阵 —— Rename / Pack 命名一致性
 *
 * 核心不变式：
 *   1. 同一份 document + 同一个 baseName，Rename 域与 Pack 域必须产出同一组名字
 *   2. 一个 document 内不得出现重名（否则 archive 层会被迫去重，页序丢失）
 *   3. 页面数量守恒：展开后的页数 == 文档实际页数（不丢页）
 *
 * fixture 纪律（前两轮踩过的坑）：
 *   不得拼造上游不产出的字段形状。生产态是——
 *     · 每页 docId 各不相同（hydrateChunk 逐页改写为物理内容哈希）
 *     · 首页 pageNum 常为 null，后续页为 1-based 之外的 0-based 数值
 *     · 每页携带自己的 amount
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPageSuffix,
  buildDocumentExportName,
  buildDocumentPageNames,
  getDocumentPages,
  extractExt,
  dedupeExportNames,
} from './docFacts.js'

// ── fixture：复刻生产态形状 ──────────────────────────────────────────────

const singlePageDoc = {
  key: 'k-single',
  name: 'invoice_single.pdf',
  docId: 'HASH_SINGLE',
  pageNum: null,
  status: 'parsed',
  invoiceNumber: '11111111',
  amount: '500.00',
  printPath: 'D:\\in\\invoice_single.pdf',
}

function makeGroupDoc(invoiceNumber, pageCount, amounts) {
  const pages = []
  for (let i = 0; i < pageCount; i++) {
    pages.push({
      key: `k-${invoiceNumber}-p${i}`,
      name: `src_p${i + 1}.pdf`,
      docId: `HASH_${invoiceNumber}_PAGE_${i}`,   // 生产态：逐页不同
      pageNum: i === 0 ? null : i,                 // 生产态：首页 null，其余 0-based
      status: 'parsed',
      invoiceNumber,
      amount: amounts[i],
      printPath: `D:\\in\\src_p${i + 1}.pdf`,
    })
  }
  return {
    ...pages[0],
    name: 'src.pdf',
    _pages: pages,
    _pageCount: pageCount,
    _isDocumentGroup: true,
  }
}

const twoPageDoc = makeGroupDoc('12345678', 2, ['1000.00', '300.00'])
const threePageDoc = makeGroupDoc('88888888', 3, ['1000.00', '300.00', '50.00'])

// ── 验收矩阵 ─────────────────────────────────────────────────────────────

test('矩阵1 单页发票 → 无页码后缀', () => {
  const names = buildDocumentPageNames(singlePageDoc, '11111111')
  assert.equal(names.length, 1)
  assert.equal(names[0].targetName, '11111111.pdf')
  assert.equal(names[0].targetBaseName, '11111111')
})

test('矩阵2 同票2页 → invoice.pdf + invoice_p2.pdf', () => {
  const names = buildDocumentPageNames(twoPageDoc, '12345678')
  assert.equal(names.length, 2, '2 页必须展开为 2 个物理文件，不能丢页')
  assert.deepEqual(names.map(n => n.targetName), [
    '12345678.pdf',
    '12345678_p2.pdf',
  ])
})

test('矩阵3 两张不同票 → 各自独立命名，互不冲突', () => {
  const a = buildDocumentPageNames(singlePageDoc, 'A')
  const b = buildDocumentPageNames({ ...singlePageDoc, key: 'k2' }, 'B')
  assert.deepEqual([...a, ...b].map(n => n.targetName), ['A.pdf', 'B.pdf'])
})

test('矩阵4 同票3页 → invoice.pdf + _p2 + _p3', () => {
  const names = buildDocumentPageNames(threePageDoc, '88888888')
  assert.equal(names.length, 3)
  assert.deepEqual(names.map(n => n.targetName), [
    '88888888.pdf',
    '88888888_p2.pdf',
    '88888888_p3.pdf',
  ])
})

test('不变式：单个文档内名字唯一（archive 层无需去重）', () => {
  for (const [doc, base] of [[twoPageDoc, '12345678'], [threePageDoc, '88888888']]) {
    const names = buildDocumentPageNames(doc, base).map(n => n.targetName)
    assert.equal(new Set(names).size, names.length, `重名：${names.join(', ')}`)
  }
})

test('不变式：Rename 的 targetBaseName 与 Pack 的 targetName 同源', () => {
  // rename-invoices 收 targetBaseName（不含扩展名），pack-invoices 收 targetName（含）。
  // 两者必须只差一个扩展名，否则两域再次漂移。
  for (const pn of buildDocumentPageNames(threePageDoc, '88888888')) {
    assert.equal(pn.targetName, `${pn.targetBaseName}.pdf`)
  }
})

test('页序稳定：_pages 顺序被打乱时仍按 pageNum 归位', () => {
  const shuffled = {
    ...threePageDoc,
    _pages: [threePageDoc._pages[2], threePageDoc._pages[0], threePageDoc._pages[1]],
  }
  const names = buildDocumentPageNames(shuffled, '88888888')
  // 首页（pageNum=null → 0）必须拿到无后缀名，而不是取决于数组顺序
  assert.deepEqual(names.map(n => n.key), [
    'k-88888888-p0',
    'k-88888888-p1',
    'k-88888888-p2',
  ])
  assert.equal(names[0].targetName, '88888888.pdf')
})

test('回归锁：pageNum=0 不得被当作缺失（|| 陷阱）', () => {
  // 若实现用 `page.pageNum || 0` 或 `if (pageNum)`，pageNum=0 的首页会被误判。
  const doc = {
    ...twoPageDoc,
    _pages: [
      { ...twoPageDoc._pages[0], pageNum: 0 },
      { ...twoPageDoc._pages[1], pageNum: 1 },
    ],
  }
  const names = buildDocumentPageNames(doc, 'X')
  assert.deepEqual(names.map(n => n.targetName), ['X.pdf', 'X_p2.pdf'])
})

test('回归锁：单页文档即使 pageNum 有值也不加后缀', () => {
  // 旧模式 `if (pageNum) name += _p${pageNum}` 会给单页文件错误地加后缀。
  const names = buildDocumentPageNames({ ...singlePageDoc, pageNum: 3 }, 'Y')
  assert.equal(names[0].targetName, 'Y.pdf')
})

test('扩展名保留：非 PDF 页面沿用原扩展名', () => {
  const ofd = { ...singlePageDoc, name: 'invoice.ofd' }
  assert.equal(buildDocumentPageNames(ofd, 'Z')[0].targetName, 'Z.ofd')
  const jpg = { ...singlePageDoc, name: 'scan.JPG' }
  assert.equal(buildDocumentPageNames(jpg, 'Z')[0].targetName, 'Z.JPG')
})

// ── 底层函数 ─────────────────────────────────────────────────────────────

test('buildPageSuffix 规则表', () => {
  assert.equal(buildPageSuffix(0, 1), '', '单页无后缀')
  assert.equal(buildPageSuffix(0, 2), '', '多页首页无后缀')
  assert.equal(buildPageSuffix(1, 2), '_p2')
  assert.equal(buildPageSuffix(2, 3), '_p3')
})

test('buildDocumentExportName 容忍无点扩展名与空扩展名', () => {
  assert.equal(buildDocumentExportName('A', 'pdf'), 'A.pdf')
  assert.equal(buildDocumentExportName('A', '.pdf'), 'A.pdf')
  assert.equal(buildDocumentExportName('A', ''), 'A')
})

test('extractExt 回退 .pdf', () => {
  assert.equal(extractExt('a.ofd'), '.ofd')
  assert.equal(extractExt('noext'), '.pdf')
  assert.equal(extractExt(''), '.pdf')
  assert.equal(extractExt(undefined), '.pdf')
})

test('getDocumentPages 对裸 fileObj 返回自身单元素', () => {
  const pages = getDocumentPages(singlePageDoc)
  assert.equal(pages.length, 1)
  assert.equal(pages[0].key, 'k-single')
  assert.deepEqual(getDocumentPages(null), [])
})

// ── dedupeExportNames：业务层跨文档消歧（Commit 1b 补强） ──────────────────

test('跨文档撞名回退「未命名发票」→ 唯一化，不让严格模式误伤整批', () => {
  // 回归保护：命名规则字段全空时 buildNameParts 回退「未命名发票」，
  // 多张票会撞名；若不消歧，archive 严格模式会把整批打包判失败。
  const entries = [
    { key: 'k1', targetName: '未命名发票.pdf' },
    { key: 'k2', targetName: '未命名发票.pdf' },
    { key: 'k3', targetName: '未命名发票.pdf' },
  ]
  const out = dedupeExportNames(entries)
  assert.deepEqual(out.map(e => e.targetName), [
    '未命名发票.pdf',
    '未命名发票_1.pdf',
    '未命名发票_2.pdf',
  ])
})

test('跨文档消歧保留页码后缀语义：同文档 _p2/_p3 互不冲突', () => {
  // _p2 与 _p3 是同一文档的页序，是不同字符串，不应被消歧改写；
  // 只有完全相同的名字才算撞名。
  const out = dedupeExportNames([
    { key: 'a1', targetName: '123_p2.pdf' },
    { key: 'a2', targetName: '123_p3.pdf' },
  ])
  assert.deepEqual(out.map(e => e.targetName), ['123_p2.pdf', '123_p3.pdf'])
})

test('跨文档同名才触发 _1：两文档都叫 123.pdf → 第二个变 123_1.pdf', () => {
  const out = dedupeExportNames([
    { key: 'a', targetName: '123.pdf' },
    { key: 'b', targetName: '123.pdf' },
  ])
  assert.deepEqual(out.map(e => e.targetName), ['123.pdf', '123_1.pdf'])
})

test('大小写不敏感：A.pdf 与 a.pdf 跨平台会相互覆盖，须消歧', () => {
  const out = dedupeExportNames([
    { key: 'x', targetName: 'A.pdf' },
    { key: 'y', targetName: 'a.pdf' },
  ])
  assert.deepEqual(out.map(e => e.targetName), ['A.pdf', 'a_1.pdf'])
})

test('无冲突条目原样返回（不生成新对象，避免无谓变更）', () => {
  const entries = [{ key: 'k1', targetName: 'A.pdf' }]
  const out = dedupeExportNames(entries)
  assert.strictEqual(out[0], entries[0], '未冲突条目应被原样返回，保持引用同一性')
})

test('不同基名互不冲突', () => {
  const out = dedupeExportNames([
    { key: 'x', targetName: 'A.pdf' },
    { key: 'y', targetName: 'B.pdf' },
  ])
  assert.deepEqual(out.map(e => e.targetName), ['A.pdf', 'B.pdf'])
})

test('空输入安全', () => {
  assert.deepEqual(dedupeExportNames([]), [])
  assert.deepEqual(dedupeExportNames(null), [])
  assert.deepEqual(dedupeExportNames(undefined), [])
})
