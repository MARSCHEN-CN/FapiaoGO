# SourcePageIdentity Audit（只读审计）

> 目标：在冻结 `SourcePageIdentity` 契约前，验证 PDF / OFD / Image 三种格式是否都有**稳定的 source identity**。
> 范围：纯只读调查，不修改任何代码。

## 0. 总判定

**可以冻结** `SourcePageIdentity = { sourceIdentity: string, sourcePageIndex: number }`（sourceIdentity 不透明、sourcePageIndex 0-based）。
但冻结前需修正 **3 处与代码现状不符的点**（见 §3）。其中 2 处若不修正，直接冻结会在实现期制造"1-based pageId 误当 0-based"和"config.js 注释与契约矛盾"两个坑。

---

## 1. 已验证事实（evidence-grounded）

所有三种格式的文档级身份都来自后端同一个函数：

```python
# backend/render_engine/registry.py:325
def _make_doc_id(file_bytes: bytes, filename: str = "") -> str:
    digest = hashlib.sha256(file_bytes).hexdigest()
    return digest[:24]          # = sha256(bytes)[:24]
    # filename 刻意不参与哈希（v1.1：重命名不应改变持久身份）
```

| 格式 | sourceIdentity 真实来源 | sourcePageIndex 真实来源 | 稳定性 |
|------|------------------------|--------------------------|--------|
| **PDF 多页**（拆分后） | `split_pdf` → `registry.open` → `doc.doc_id`，**父 PDF 全文件内容哈希**；拆分页 `fileObj.docId` 与 `fileObj.sourceDocId` 都被设为 `data.doc_id`（`frontend/src/utils/fileHelpers.js:133,137`） | `page.page_index` = 后端 `page_num = i+1`，**1-based**（`app.py:959,987`）；`buildFileObj` 原样透传（`fileHelpers.js:51`），DocumentStore `pageNum-1` 归 0-based（L176） | ✅ 同字节同 doc_id；分页共享父 doc_id |
| **OFD** | `/api/documents/open` → `registry.open` → `doc.doc_id`（内容哈希，`filename` 不参与，`api.py:42-61`） | `DocumentStore` 由 `/api/metadata/{docId}` 填充 `pages[].index`（0-based，前端 `renderDocument.js:119`） | ✅ 同字节同 doc_id |
| **单页 PDF / Image** | 同 `_make_doc_id`（`app.py:1201` 单文件 parse 也走此函数，闭合身份链） | `0` | ✅ 文档级=页级 |

### 关键证据
- `app.py:905-1011` `split_pdf`：`doc = registry.open(file_bytes, …)`；返回 `doc_id = doc.doc_id`（整本哈希）；每页 `_page_registry[page_id] = {"doc_id": doc.doc_id, "page": page_num}` —— **拆分页共享父 doc_id**，页码 0-based。
- `app.py:915` `file_hash = sha256(file_bytes).hexdigest()[:16]` 仅用于构造 `page_id`（`f"{file_hash}_{i}"`），**不参与 doc_id**，与 sourceIdentity 无关。
- `api.py:59-64` `/api/documents/open` 返回 `doc_id`（[:24] 截断）+ `content_hash`（**全 64 字符**）—— 印证 `docId` 与 `sourceHash` 是同一哈希的不同长度。
- `fileHelpers.js:133,137` 证明 PDF 拆分页 `docId === sourceDocId`（均为父 PDF 哈希）。
- `image_parser.py:58` 的 `sha256(raw)` 是 **OCR 缓存键（全 64 字符）**，**不是** docId；图片 docId 来自 parse 路径的 `_make_doc_id`。
- `usePrint.js:265` 图片打印走 `read-file`（docId 无关、保留原图分辨率）—— 这是**传输层选择**，与"图片有没有 source identity"正交；图片作为 SourcePage 仍用 `(docId, 0)`。

---

## 2. 与你贴出结论一致的部分（确认）

1. ✅ `split_pdf` 的 `doc_id` 稳定 —— 基于原始 PDF 全文件内容哈希，跨导入不变。
2. ✅ OFD `doc_id` 稳定 —— 基于 OFD bytes 内容哈希，`filename` 不参与。
3. ✅ Image 有稳定 docId —— 同一 `_make_doc_id`，单页 → sourcePageIndex=0。
4. ✅ `docId` 语义过载（source identity 同时被当 render registry id），正应被 opaque `sourceIdentity` 隔离。
5. ✅ `sourceHash`（64 字符）与 `docId`（[:24]）本质同源，但**退休 sourceHash 不应并入本次 Identity 契约冻结**（你第二段已正确克制，附议）。
6. ✅ `file.key`/instanceId 应降级为 Instance/UI identity，不得承担 SourcePage identity。

---

## 3. 需修正的 3 处偏差 🟡

### 🟡 偏差 A：`config.js:53` 的 docId 公式注释已过时，与契约矛盾
```js
// frontend/src/config.js:53
// @param {string} docId   内容寻址的文档 ID（sha256(file_bytes+filename)[:24]）
```
实际 `_make_doc_id`（`registry.py:329-341`）**已不含 filename**，且明确标注 `sha256(file_bytes+filename)` 是 v1.0 已弃用行为。**冻结 Identity Contract v1.1 说 filename 不参与，config.js 却写参与** —— 后续开发者照注释实现会破坏跨会话身份。

**建议**：冻结前把 `config.js:53` 注释改为 `sha256(file_bytes)[:24]`（不改逻辑，只纠文档漂移）。可随 SourcePage Resolver 的契约文档一起改。

### 🟡 偏差 B：`composePagePlan.js:41` 现有 `pageId` 是 **1-based**，与"sourcePageIndex 0-based"直接冲突
```js
// frontend/src/compose/composePagePlan.js:41
const pageId = it.pageId ?? `${docId}#p${(it.pageIndex ?? index) + 1}`  // ← +1 = 1-based
```
当前 SourcePage 的"事实载体" `source.pageId` 编码的是 **1-based** 页码（`#p1/#p2`）。你要冻结的 `sourcePageIndex` 是 **0-based**（与已冻结的 core principle 3「page index 全局 0-based」一致）。

**风险**：若不显式区分，实现期的开发者会以为 `source.pageId` 就是 `sourcePageIndex`，在 Preview→Print 链里把 1-based 当 0-based 用 —— 复现 core principle 3 当初那个"首页丢失"的坑。

**建议**：冻结文本必须写明 ——
> `sourcePageIndex` 是**新的 0-based 字段**；**禁止复用**现有 `source.pageId`（1-based 字符串）。SourcePage Resolver 从 `sourceDocId + pageNum(0-based)` / `docId + pages[].index(0-based)` 派生，不从 `pageId` 字符串解析。

### 💭 偏差 C：composePagePlan 的 docId 兜底仍在用 `key` 当身份（与"file.key 不得当 source identity"原则相悖）
```js
// frontend/src/compose/composePagePlan.js:39-40
const id = it.id || it.key || `item-${index}`
const docId = it.docId ?? id          // ← docId 缺失时 fallback 到 key
```
你第二段明确 "file.key 绝不能承担 SourcePage identity"，但这里当 `docId` 缺失时会 fallback 到 `id`/`key`。

**建议**：列为 SourcePage Resolver 设计的**硬约束** —— Resolver 必须保证 `sourceIdentity` 存在且来自内容哈希；**禁止** key/id fallback。该 fallback 路径应标记为 legacy、仅用于无法回源的旧 session UI 兜底，不得进入 SourcePage 契约。

---

## 4. 冻结建议（采纳你第二段，附 2 条件）

```text
SourcePageIdentity = {
  sourceIdentity: string,   // opaque；消费者不得解析其内部格式
  sourcePageIndex: number    // 0-based；严禁复用 1-based pageId
}
```

**明确禁止**（跨层 SourcePage identity）：
`file.key + pageIndex`、`instanceId + pageIndex`、`docId + physical renderPage`、`printPath + page`。

**明确允许**（实现定位信息，非 SourcePage identity）：
`file.key`、`instanceId`、`docId`、`sourceDocId`、`renderDocId`、`renderPage`、`printPath` —— 各属不同生命周期/层。

**Invariant（采纳，补一句防 C 类坑）**：
```
same source bytes + same sourcePageIndex  → same sourceIdentity + same sourcePageIndex
same sourceIdentity + different sourcePageIndex → different SourcePage
且 sourceIdentity 缺失时 Resolver 必须报错，不得 fallback 到 key/id。
```

**冻结前 2 个必须动作（否则契约与代码漂移）**：
1. 纠 `config.js:53` 注释（filename 不参与）。
2. 在契约里显式隔离 `sourcePageIndex`(0-based) 与 `source.pageId`(1-based)，禁止混用。

**暂不冻结**（采纳你的克制）：`docId 删除` / `sourceHash 删除` / `sourceDocId 删除` —— 留待 Migration Audit 逐个查 producer/consumer。

---

## 5. 与已冻结架构原则的一致性

- 完全契合 working-memory **核心原则 1：Identity ≠ Capability**（docId=Source / renderDocId=Render 解耦）。`sourceIdentity` 是 Source 侧身份，不携带 render 能力，方向一致。
- 完全契合 **核心原则 3：Page Index 0-based**。只需把偏差 B 的 1-based `pageId` 与 0-based `sourcePageIndex` 显式切开。
- 与 B1 hardening 的纪律同源：**身份层不该倒逼生产架构变更**；`sourceIdentity` opaque 正是这条纪律在身份域的体现。

---

## 5.5 勘误（SourcePage Resolver Design Audit 修正）

- ⚠️ 本节 §1 表格原写 "page.page_index **0-based**" 为**误判**。实测 `backend/app.py:959` 构造 `page_num = i+1`、`app.py:987` 输出 `page_index: page_num` → **拆分页 `pageNum` 在前端是 1-based**。`DocumentStore.js:141` 注释 "pageNum 是 1-based（后端 page_index = i+1）" 才是正确的，与 `buildFileObj` 原样透传（`fileHelpers.js:51`）一致。
- 对 Resolver 规则的影响：用户提案 `sourcePageIndex = pageNum` **仅在 pageNum 已在 Resolver 输入处归 0-based 时成立**。若 Resolver 直接读 FileObj.pageNum（1-based），必须 `sourcePageIndex = pageNum - 1`，否则整条链 off-by-one。详见 `SourcePageResolver-Design-Audit.md` Q3。

---

## 6. 下一步（不在此动手）

进入 **SourcePage Resolver Design**（仍只读/设计，不动码）：
- 定义 Resolver 输入（FileObj / DocumentStore entry）、输出（`SourcePageIdentity`）。
- 三种格式映射规则（PDF 拆分页 / OFD / 单页 PDF / Image）。
- 与现有 `composePagePlan`、`parseResultConsumer`、`DocumentStore` 的接缝点。
- 明确偏差 C 的 legacy fallback 处理。
