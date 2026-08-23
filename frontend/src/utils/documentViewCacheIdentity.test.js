/**
 * documentView 缓存签名回归测试（D6-D8）
 *
 * 根因（P1-P4 闭环审计）：docsSig 用 d.key，但 InvoiceDocument 无 key 字段 →
 * docsSig 恒 '' → 缓存永不失效 → 永远降级裸行 → Display 永久 Loading。
 *
 * 判定矩阵：
 *   D6  invoiceDocs=[] → [OFD InvoiceDocument] → docsSig 必须变化
 *   D7  两个不同 canonical document → docsSig 必须不同
 *   D8  同一 document 内容不变 → docsSig 稳定（不产生无意义失效）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDocument } from '../models/InvoiceDocument.js'
import { createPageMeta } from '../models/InvoiceDocument.js'
import { generateInvoiceDocumentId } from './invoiceIdentityResolver.js'
import {
  computeDocsSig,
  getDocumentCacheIdentity,
  legacyComputeDocsSig,
} from './documentViewCacheIdentity.js'

// ── 构造真实 OFD InvoiceDocument（复刻 useFileOps assembly 路径产出的结构）──
function makeOfdDocument({ fileKey = '26447000000943604784.ofd_1787479863361_cb93123a-...',
  instanceId = '26447000000943604784.ofd_1787479863361_84cae201-...',
  invoiceNumber = '26447000000943604784', docIdHash = 'ca82b1c6dabfc311f680155a' } = {}) {
  const invDocId = generateInvoiceDocumentId({
    sourceDocId: docIdHash,
    invoiceNumber,
    fileKey,
  })
  const doc = createDocument({
    docId: invDocId,
    instanceId,
    fileKey,
    sourceHash: docIdHash,
    pages: [createPageMeta({ docId: invDocId, index: 0, renderDocId: docIdHash, renderPage: 1 })],
  })
  doc.invoiceDocumentId = invDocId
  return doc
}

// ════════════════════════════════════════════════════════════════
// D6：invoiceDocs=[] → [OFD InvoiceDocument] → docsSig 必须变化（根因 Case）
// ════════════════════════════════════════════════════════════════
test('D6: invoiceDocs 0→1 时 docsSig 必须变化（旧协议恒空 → Red）', () => {
  const ofdDoc = makeOfdDocument()

  // 旧协议（当前 FileContext 缺陷）：d.key 恒 undefined → 两态签名相同
  const legacyEmpty = legacyComputeDocsSig([])
  const legacyOne = legacyComputeDocsSig([ofdDoc])
  assert.equal(legacyEmpty, legacyOne, '旧协议空/单文档签名相同（这正是根因）')
  assert.equal(legacyOne, '', '旧协议单文档签名恒空')

  // 新协议：必须区分
  const newEmpty = computeDocsSig([])
  const newOne = computeDocsSig([ofdDoc])
  assert.notEqual(newEmpty, newOne, '新协议空/单文档签名必须不同')
  assert.ok(newOne.length > 0, '新协议单文档签名非空')
  assert.ok(newOne.includes('::'), `新协议签名应含复合键 ::: ${newOne}`)
})

// ════════════════════════════════════════════════════════════════
// D7：两个不同 canonical document → docsSig 必须不同
// ════════════════════════════════════════════════════════════════
test('D7: 两个不同 canonical document → docsSig 不同', () => {
  const docA = makeOfdDocument({ invoiceNumber: '26447000000943604784', instanceId: 'inst-A-1111' })
  const docB = makeOfdDocument({ invoiceNumber: '26447000000943604785', instanceId: 'inst-B-2222' })

  const sigA = computeDocsSig([docA])
  const sigB = computeDocsSig([docB])
  assert.notEqual(sigA, sigB, '不同发票文档签名必须不同')
})

// ════════════════════════════════════════════════════════════════
// D8：同一 document 内容不变 → docsSig 稳定（不产生无意义失效）
// ════════════════════════════════════════════════════════════════
test('D8: 同一 document 重复计算 → docsSig 稳定', () => {
  const ofdDoc = makeOfdDocument()
  const sig1 = computeDocsSig([ofdDoc])
  const sig2 = computeDocsSig([ofdDoc])
  assert.equal(sig1, sig2, '同一文档签名必须稳定')
  // 内容相同的两个文档实例（同 canonical identity）→ 签名相同
  const clone = makeOfdDocument()
  assert.equal(computeDocsSig([ofdDoc]), computeDocsSig([clone]),
    '同 canonical identity 的不同实例 → 签名相同（幂等）')
})

// ════════════════════════════════════════════════════════════════
// D6b：getDocumentCacheIdentity 对真实 InvoiceDocument 返回复合键
// ════════════════════════════════════════════════════════════════
test('D6b: getDocumentCacheIdentity 返回 canonical 复合键（不依赖 d.key）', () => {
  const ofdDoc = makeOfdDocument()
  const id = getDocumentCacheIdentity(ofdDoc)
  assert.equal(id, `${ofdDoc.instanceId}::${ofdDoc.invoiceDocumentId}`,
    '缓存身份 = instanceId::invoiceDocumentId 复合键')
  assert.ok(id.length > 20, '复合键长度合理')
})

// ════════════════════════════════════════════════════════════════
// D6c：缺复合身份的 doc 仍能取到稳定身份（fallback，不返回空）
// ════════════════════════════════════════════════════════════════
test('D6c: 缺复合身份时 fallback 到 fileKey/docId，不返回空串', () => {
  const bare = { docId: 'hash_only', fileKey: 'file_key_only' }
  const id = getDocumentCacheIdentity(bare)
  assert.ok(id.length > 0, '缺复合身份也应返回稳定身份')
})
