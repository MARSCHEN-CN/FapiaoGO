/**
 * documentViewSignature 回归测试（Step S7 correlation 契约）
 *
 * 冻结（2026-08-23，Step S7）：
 *   1. 同内容同签名：相同 canonical identity 集合 → 相同 viewSig（跨组件、跨 render 稳定）
 *   2. 顺序无关：docs 数组顺序变化 → viewSig 不变（.sort()）
 *   3. 身份不同签名不同：任一 doc 的 canonical identity 变化 → viewSig 变化
 *   4. null / undefined / 空数组 → 'none'（无文档可配对）
 *   5. 字段缺失降级：缺 instanceId/invoiceDocumentId 时走 getDocumentCacheIdentity fallback，不崩溃
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { getDocumentViewSignature } from './documentViewSignature.js'
import { createDocument, createPageMeta } from '../models/InvoiceDocument.js'
import { generateInvoiceDocumentId } from './invoiceIdentityResolver.js'

function makeDoc({ instanceId = 'inst-1', invoiceNumber = '26447000000943604784', fileKey = 'f1.ofd', sourceDocId = 'ca82b1c6dabfc311f680155a' } = {}) {
  const invDocId = generateInvoiceDocumentId({ sourceDocId, invoiceNumber, fileKey })
  const doc = createDocument({
    docId: invDocId,
    instanceId,
    fileKey,
    sourceHash: sourceDocId,
    pages: [createPageMeta({ docId: invDocId, index: 0, renderDocId: sourceDocId, renderPage: 1 })],
  })
  doc.invoiceDocumentId = invDocId
  doc.sourceDocId = sourceDocId
  doc._pageKeys = [fileKey]
  return doc
}

test('S7-V1: 同内容同签名（不同实例、相同 identity → 同一 viewSig）', () => {
  const a = makeDoc()
  const b = makeDoc()  // 等价但不同的对象实例
  assert.equal(getDocumentViewSignature([a]), getDocumentViewSignature([b]),
    '同一 canonical identity 集合必须产生同一 viewSig')
})

test('S7-V2: 顺序无关（docs 顺序变化 → viewSig 不变）', () => {
  const a = makeDoc({ instanceId: 'inst-a' })
  const b = makeDoc({ instanceId: 'inst-b' })
  assert.equal(
    getDocumentViewSignature([a, b]),
    getDocumentViewSignature([b, a]),
    '签名必须与 docs 数组顺序无关'
  )
})

test('S7-V3: 身份不同签名不同（任一 doc 的 identity 变化 → viewSig 变化）', () => {
  const a = makeDoc({ instanceId: 'inst-a' })
  const a2 = makeDoc({ instanceId: 'inst-a2' })  // instanceId 不同
  assert.notEqual(getDocumentViewSignature([a]), getDocumentViewSignature([a2]),
    'instanceId 不同必须产生不同 viewSig')

  const b = makeDoc({ sourceDocId: 'deadbeef0000000000000000' })  // invoiceDocumentId 派生自 sourceDocId → 不同
  assert.notEqual(getDocumentViewSignature([a]), getDocumentViewSignature([b]),
    'invoiceDocumentId 不同必须产生不同 viewSig')
})

test('S7-V4: null / undefined / 空数组 → none（无文档可配对）', () => {
  assert.equal(getDocumentViewSignature(null), 'none')
  assert.equal(getDocumentViewSignature(undefined), 'none')
  assert.equal(getDocumentViewSignature([]), 'none')
})

test('S7-V5: 字段缺失降级（fallback 到 docId，不崩溃且可区分）', () => {
  const docA = makeDoc()
  delete docA.instanceId
  delete docA.invoiceDocumentId
  const docB = makeDoc()
  delete docB.instanceId
  delete docB.invoiceDocumentId
  docB.docId = 'another-docid'
  const sigA = getDocumentViewSignature([docA])
  const sigB = getDocumentViewSignature([docB])
  assert.notEqual(sigA, 'none', 'doc 存在时不得返回 none')
  assert.notEqual(sigA, sigB, 'fallback 后仍应可区分不同 doc')
})
