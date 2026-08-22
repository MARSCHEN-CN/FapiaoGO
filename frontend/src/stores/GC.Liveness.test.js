/**
 * GC.Liveness.test.js — DocumentStore GC 存活判定与注册键同空间回归测试
 *
 * 背景（2026-08-22 展示区空白回归，Fix 1 = 1b2e4f0）：
 *   fba0face 将 DocumentStore 注册键升级为复合键 instanceId::invoiceDocumentId，
 *   但 App.jsx 自动 GC 的 referenced 仍只收集裸物理 docId + documentView.documentId，
 *   两个 namespace 永不匹配 → 刚注册的 InvoiceDocument 在 41ms 内被 GC 全删
 *   （R1 运行时：register 1→2 → GC registered=2/referenced=1/toRemove=2 → count=0）
 *   → activeDocument=null → 展示区空白。
 *
 * 本测试固化两条契约（与 App.jsx GC effect 逻辑一一对应）：
 *   Contract A：GC referenced 必须经 resolveDocumentIdentity(entity) 与注册键同空间，
 *               真实 InvoiceDocument retained、_unassembled placeholder 清理（模型 A）。
 *   Contract B：Display 解析需 canonical key（裸 docId 在复合键 store 中 miss；
 *               装配文档复合身份命中）。已由真实 UI 三链验证非实际断点，此处仅作契约文档化。
 *
 * 运行：node --test src/stores/GC.Liveness.test.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const {
  resolveDocumentIdentity,
  registerDocument,
  getDocument,
  getRegisteredDocIds,
  removeDocument,
  clearAllDocuments,
} = await import('../stores/DocumentStore.js')
const { createDocument, createPageMeta } = await import('../models/InvoiceDocument.js')

// ── 与 App.jsx GC effect（Fix 1 后）逐行一致的 referenced 构建 ──
function buildGcReferenced({ files, documentView }) {
  const referenced = new Set()
  for (const f of files) {
    const canonical = resolveDocumentIdentity(f)
    if (canonical) referenced.add(canonical)
    const physicalDocId = f?.identity?.docId || f?.docId
    if (physicalDocId) referenced.add(physicalDocId)
  }
  for (const doc of documentView?.documents || []) {
    const canonical = resolveDocumentIdentity(doc)
    if (canonical) referenced.add(canonical)
    const bizDocId = doc.documentId
    if (bizDocId) referenced.add(bizDocId)
    const physDocId = doc?.identity?.docId || doc?.docId
    if (physDocId) referenced.add(physDocId)
  }
  return referenced
}

function runGc({ files, documentView }) {
  const referenced = buildGcReferenced({ files, documentView })
  const registered = getRegisteredDocIds()
  const toRemove = registered.filter((id) => !referenced.has(id))
  return { referenced: [...referenced], registered, toRemove }
}

function makeRealDoc({ docId, instanceId, fileKey }) {
  const doc = createDocument({
    docId,
    instanceId,
    fileKey,
    sourceHash: 'H',
    pages: [createPageMeta({ docId, index: 0 })],
  })
  doc.invoiceDocumentId = docId // 装配路径：注册前设置（fba0face 时序）
  return doc
}

test('Contract A：GC 存活判定与注册键同空间（Fix 1 核心）', () => {
  clearAllDocuments()
  const invDocId = 'd64f1766_inv_2544'
  const composite = 'inst_9c97::d64f1766_inv_2544'

  // 注册真实装配文档（复合键）
  registerDocument(makeRealDoc({ docId: invDocId, instanceId: 'inst_9c97', fileKey: '2544.pdf_k1' }))
  assert.equal(getRegisteredDocIds().length, 1)

  // 装配后：fileObj 回写复合身份（assembly-synced 已证实）+ documentView 含装配文档
  const gc = runGc({
    files: [{ key: '2544.pdf_k1', docId: 'phys_d64f', instanceId: 'inst_9c97', invoiceDocumentId: invDocId }],
    documentView: {
      documents: [{ docId: invDocId, documentId: invDocId, instanceId: 'inst_9c97', invoiceDocumentId: invDocId, identity: { docId: invDocId } }],
    },
  })
  assert.ok(gc.referenced.includes(composite), `referenced 应含复合键: ${JSON.stringify(gc)}`)
  assert.ok(!gc.toRemove.includes(composite), `真实文档不应被 GC: ${JSON.stringify(gc)}`)
  assert.equal(getDocument(composite)?.docId, invDocId)
})

test('Contract A：_unassembled placeholder 被 GC 清理（模型 A）', () => {
  clearAllDocuments()
  const invDocId = 'x_inv_1'
  const composite = 'instX::x_inv_1'
  const placeholder = 'x.pdf_k1_unassembled'

  // 真实装配文档（复合键）+ placeholder（fallback 注册）
  registerDocument(makeRealDoc({ docId: invDocId, instanceId: 'instX', fileKey: 'x.pdf_k1' }))
  registerDocument(makeRealDoc({ docId: placeholder, instanceId: '', fileKey: 'x.pdf_k1' }))
  assert.equal(getRegisteredDocIds().length, 2)

  // placeholder 的 fileObj 已被装配结果替换（invoiceDocumentId 指向真实 invDocId）
  const gc = runGc({
    files: [{ key: 'x.pdf_k1', docId: 'phys_x', instanceId: 'instX', invoiceDocumentId: invDocId }],
    documentView: {
      documents: [{ docId: invDocId, documentId: invDocId, instanceId: 'instX', invoiceDocumentId: invDocId, identity: { docId: invDocId } }],
    },
  })
  assert.ok(gc.toRemove.includes(placeholder), `placeholder 应被清理: ${JSON.stringify(gc)}`)
  assert.ok(!gc.toRemove.includes(composite), `真实文档应保留: ${JSON.stringify(gc)}`)
})

test('Contract B（文档化）：裸 docId 在复合键 store 中 miss，装配文档复合身份命中', () => {
  clearAllDocuments()
  const invDocId = 'b_inv_2'
  const composite = 'instB::b_inv_2'

  registerDocument(makeRealDoc({ docId: invDocId, instanceId: 'instB', fileKey: 'b.pdf_k1' }))

  // B1：previewFile 只有裸物理 docId → miss（UI 中由装配同步规避，此处固化契约）
  const previewFile = { key: 'b.pdf_k1', docId: 'phys_b' }
  assert.equal(resolveDocumentIdentity(previewFile), 'phys_b')
  assert.equal(getDocument(resolveDocumentIdentity(previewFile)), null)

  // B2：装配文档（完整复合身份）→ 命中
  const assembled = { key: 'b.pdf_k1', docId: invDocId, instanceId: 'instB', invoiceDocumentId: invDocId }
  assert.equal(resolveDocumentIdentity(assembled), composite)
  assert.equal(getDocument(resolveDocumentIdentity(assembled))?.docId, invDocId)
})
