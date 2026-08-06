# 输出链（hydration）回归比对：`left-thumbnail-layout` vs `master`

> 只读调查，未改动任何代码。结论：两个新现象（同票多页仍拆多文件 + 统计异常）的根因在**前端 hydration 输出链**，不在输入字段。master 相对 golden path（left-thumbnail）在 `hydrateChunk` **删除了 `if (!hasAssembledDocs)` fallback 块**，且 per-file 循环只写全局 `DocumentStore`、不写 `session.documents`，导致 `session.documents` 在后端未返 `documents` 时为空 → `buildDocumentViewModel` 退回 `groupFilesByDocument(files)` → 多页拆多行 + 统计按行计数异常。

---

## 一、三个嫌疑点核查结果

| 嫌疑点 | 结论 | 证据 |
|---|---|---|
| ① 后端 `/import/batch/{id}/results` 返回结构 | **形状正确**（两分支一致），但 `documents` 内容依赖输入字段 | `app.py:1695-1699` 返回 `{items, documents: batch.assembled_documents or []}`；`assembled_documents` 仅在 `src_doc_id` 且 `page_num/total_pages` 合法时 append（`import_batch_manager.py:632-671`） |
| ② `ImportBatchClient.getBatchResults` | **已清白**（两分支都返回 `{items, documents}`） | master `ImportBatchClient.js:227` `return { items: data.items || [], documents: data.documents || [] }`；left-thumbnail `:210-211` 同 |
| ③ `useFileOps.hydrateChunk` / `FileContext` 输入 | **真凶** | 见下 |

> 修正原假设：不是「前端同时消费 items + documents 造成重复条目」。master 的 per-file 循环**不调 `addDocument`**，所以不会把每页塞进 `session.documents`；真正的失败模式是**「documents 缺失时，没有 fallback 补 `session.documents`」**。

---

## 二、`hydrateChunk` 逐行对比（核心证据）

### master（`frontend/src/hooks/useFileOps.js:481-603`）
```js
481  hydrateChunk: async ({ batchId, chunk, signal, client, terminalFileKeys }) => {
482    const HYDRATION_CHUNK = 100
484    const _batchResults = await client.getBatchResults(batchId, signal)
485    const items = Array.isArray(_batchResults) ? _batchResults : (_batchResults?.items || [])
486    const documents = (!Array.isArray(_batchResults) && Array.isArray(_batchResults?.documents)) ? _batchResults.documents : []
        // ↑ 解构是对的，没丢 documents
...
492    for (let j = 0; j < chunk.length; j += HYDRATION_CHUNK) {
494      for (const fileObj of chunkFiles) {
...
520        queueUpdate(fileObj.key, 'parsed', update)
526        const effectiveDocId = (item && item.docId) || fileObj.docId
527        if (effectiveDocId) {
532          const doc = ensureDocumentFromFileObj(docFileObj, readyFiles, { silent: true })
534          const metaDoc = await ensureDocumentMetadata({ ...docFileObj, docId: effectiveDocId }, { silent: true })
538          if ((doc && doc !== prev) || (metaDoc && metaDoc !== prev)) docsTouched = true
        // ↑ 仅写全局 DocumentStore（见第三节）。此处没有 addDocument → 不进 session.documents
541          if (docsTouched) { flushDocumentNotifications(); docsTouched = false }
        }
...
553    const hasAssembledDocs = Array.isArray(documents) && documents.length > 0
556    if (hasAssembledDocs) {
557      for (const assembled of documents) {
... // 按 invoiceNumber 匹配 items → matchingFiles；匹配不到则 continue（见第四节陷阱）
594        addDocument(session.id, doc)   // ← 唯一能进 session.documents 的路径
597      }
    }
    // ❌ 没有 `if (!hasAssembledDocs)` fallback 块
603  }
```

### left-thumbnail（`useFileOps.js:453-569`，golden path）
```js
453  hydrateChunk: async ({ batchId, chunk, signal, client, terminalFileKeys }) => {
455    const { items, documents } = await client.getBatchResults(batchId, signal)
        // ↑ 直接解构，等价
463    for (const fileObj of chunkFiles) {
...
489      queueUpdate(fileObj.key, 'parsed', update)   // 循环里只更新文件状态，不创建 Document
490      terminalFileKeys.add(fileObj.key)
        // ↑ 没有 ensureDocumentFromFileObj / ensureDocumentMetadata
    }
503    const hasAssembledDocs = Array.isArray(documents) && documents.length > 0
504    if (hasAssembledDocs) {
...
541      addDocument(session.id, doc)   // 组装成功 → 进 session.documents
543      assembledDocIds.add(invDocId)
    }
548    // ✅ Fallback：无 assembly 结果时用旧 per-file Document 创建路径
549    if (!hasAssembledDocs) {
550      for (const fileObj of chunk) {
557        const doc = ensureDocumentFromFileObj(docFileObj, readyFiles, { silent: true })
560        if (doc && session?.id) {
561          addDocument(session.id, doc)   // ← 保证 session.documents 永远被填充
562        }
563      }
564    }
565    if (docsTouched) { flushDocumentNotifications(); docsTouched = false }
569  }
```

**差异一句话**：left-thumbnail 无论后端是否返 `documents`，`session.documents` 一定被填充（走 assembled 块或 fallback 块）；master 只在 `documents` 非空时才填充，**缺 documents 时 `session.documents` 为空**。

---

## 三、`session.documents` 才是视图模型唯一数据源（关键机制）

`buildDocumentViewModel`（`frontend/src/utils/documentViewModel.js:90-94`，两分支一致）：
```js
90  export function buildDocumentViewModel(files, invoiceDocs = null) {
91    const USE_INVOICE_DOCUMENT_ROWS = Array.isArray(invoiceDocs) && invoiceDocs.length > 0
92    const documents = USE_INVOICE_DOCUMENT_ROWS
93      ? invoiceDocumentsToRows(invoiceDocs, files)
94      : groupFilesByDocument(files)   // ← session.documents 为空时退回按原始 page files 分组
```
其中 `invoiceDocs = session?.documents`（`FileContext.jsx:67`）。

而 master per-file 循环里的 `ensureDocumentFromFileObj` / `ensureDocumentMetadata` 只写**全局** `DocumentStore`：
- `DocumentStore.ensureDocumentFromFileObj`（`stores/DocumentStore.js:106`）→ `documents.set(docId, doc)`（模块级全局 Map），**不调 `addDocument`**。
- 只有 `ImportSessionStore.addDocument`（`stores/ImportSessionStore.js:174`）才 `session.documents.push(doc)` 并 `notify(sessionId)`。

→ 视图模型**根本不读全局 store**，所以 master 在 per-file 循环里对全局 store 的写入对 FileList/统计是**无效功**。

---

## 四、`hasAssembledDocs` 块自身还有一个脆弱点（即便 documents 非空也可能空）

master/left-thumbnail 的 assembled 块都按：
```js
matchingItems = items.filter(i => i.invoiceNumber === assembled.invoiceNumber)
matchingFiles = chunk.filter(f => matchingKeys.has(f.key))
if (matchingFiles.length === 0) continue   // ← documents 有，但 items 缺 invoiceNumber → 直接跳过，不 addDocument
```
若 items 未带 `invoiceNumber`（输入链未完全修好），`matchingFiles` 为空 → `continue` → 该发票的 `addDocument` 不执行 → `session.documents` 仍空 → 同样退回 `groupFilesByDocument`。

---

## 五、完整因果链（输入字段 → 统计异常）

```
前端输入缺 sourceDocId/pageNum/totalPages
        ↓  (import_batch_manager.py:632-671: src_doc_id 空 → else 直写，不 append assembled_documents)
后端 batch.assembled_documents = []
        ↓  (app.py:1698: documents = batch.assembled_documents or [])
GET /results 返回 documents: []
        ↓  (useFileOps.js:486 解构为空；:553 hasAssembledDocs=false)
master hydrateChunk 跳过 assembled 块，且无 fallback
        ↓  (per-file 循环只写全局 DocumentStore，不 addDocument)
session.documents = []   ← 关键空窗
        ↓  (documentViewModel.js:91 USE_INVOICE_DOCUMENT_ROWS=false)
buildDocumentViewModel → groupFilesByDocument(files)
        ↓  按每页 file 分组（若 docId/pageNum 也乱 → 无法聚合）
FileList：同票多页 = 多行；统计：总发票数 = 行数（异常）
```
left-thumbnail 在 `session.documents = []` 这一步被 fallback 块兜底（`addDocument` 填充），**从不会掉进 `groupFilesByDocument`**，故不出现上述现象。

---

## 六、建议（未执行，待你确认）

1. **首选**：把 left-thumbnail `useFileOps.js:548-564` 的 `if (!hasAssembledDocs)` fallback 块**原样恢复**到 master（一行不多、语义已在 golden path 验证）。恢复后 master 行为与 left-thumbnail 对齐，`session.documents` 永远非空。
2. **加固**：`hasAssembledDocs` 块里 `matchingFiles.length === 0` 时**不要静默 `continue`**——至少对「documents 有但 items 无 invoiceNumber」的情况补一个 fallback 分支，避免 documents 非空却仍空窗。
3. **可观测**：master per-file 循环对全局 `DocumentStore` 的 `ensureDocumentFromFileObj`/`ensureDocumentMetadata` 写入对 FileList/统计无贡献（视图模型不读全局 store），属无效功，可考虑移除以降低误导与开销——但这是次要清理项，非修复必需。
4. **输入链仍要继续收尾**：`sourceDocId/pageNum/totalPages` 是后端 `assembled_documents` 的唯一来源（第四节）。即使恢复了 fallback，要让「按 documents 组装」这条更优路径生效，输入字段必须正确。两者不冲突：fallback 是保底，documents 是优选。
