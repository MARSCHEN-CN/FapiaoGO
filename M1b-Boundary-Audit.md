# M1-b Boundary Audit — page-base 规范化边界审计

> **纪律声明**：本轮**纯只读**。未修改任何生产代码、未创建 `SourcePageResolver.js`、未提交。
> 本文档只做**证据判定**，不做实施方案裁决。
> 判定基准 = 已冻结的 `SourcePageIdentity` 契约（见 `SourcePageResolver-Design-Audit.md` v2）与 M1-a 事实表（见 `M1a-PageBase-Freeze-Report.md`）。

日期：2026-08-09
上游：M1-a ✅（32 用例锁定现状）→ 本轮 M1-b

---

## 0. 总判定（先说结论）

本轮最重要的产出**不是**在 B1/B2/B3 里挑一个，而是发现**问题被建模错了**。

> **M1 的病灶不是「基数不统一」，而是「两套不同的页坐标系共用了同名字段」。**

系统里存在两个语义完全不同的页坐标：

| 坐标系 | 语义 | 归属域 | 代表字段 |
|---|---|---|---|
| **Source Page** | 这一页是**源文档**的第几页 | Identity | `sourcePageIndex`（待建）、`fileObj.pageNum`、`/split_pdf.page_index` |
| **Render Locator** | 这一页是**物理制品内**的第几页 | Capability | `renderPage`、`DocumentStore.pages[].index`、`_page_registry["page"]`、`extract_page_pdf(page)` |

这与项目已冻结的**核心原则 1（Identity ≠ Capability）完全同构**。

由此三条判定直接落地：

- **B1 ❌ 被证据否决**（不是"风险大"，是与一个**显式的 1-based 能力契约**正面冲突）
- **B2 🟡 不能作为 boundary**（已证明无法覆盖 OFD，且会导致依赖方向倒置）
- **B3 🟢 是唯一剩余可行位置**，但输入模型必须是 `resolveSourcePages(sourceDocument, pageEvidence)`
- **Render 域的 boundary 已经存在且实现正确**（`engine.py:_render_page`），**不应动它**

---

## 1. B1 — 后端 emit boundary（`app.py:987`）

### 1.1 硬反证：`page_index` 不只是 transport，它同时喂给一个 1-based 能力 API

`/split_pdf` 的同一个 `page_num` 值有**两个去向**：

```python
# backend/app.py:977-990
for (i, page_num, page_id, page_bytes) in chunk:
    with _page_registry_lock:
        _page_registry[page_id] = {"doc_id": doc.doc_id, "page": page_num}   # ← 去向 ①（Render 域）
    ...
    pages.append({
        "page_index": page_num,                                              # ← 去向 ②（Source 域 transport）
        "page_id": page_id,
        "page_bytes": ...,
    })
```

去向 ① 被 `/download_page` 消费，且下游是一个**文档里明写 1-based 的能力 API**：

```python
# backend/render_engine/engine.py:360-386
def extract_page_pdf(self, doc_id: str, page: int = 1, ...):
    """
        page:     1-based page number          ← 显式契约
    """
    page_idx = max(0, page - 1)                 # ← 静默钳位
    if page_idx >= len(src):
        raise ValueError(...)
```

**若 B1 把 `page_num` 改成 0-based**，`_page_registry["page"]` 随之变 0-based，则 `/download_page`：

| 请求页（0-based） | `page_idx = max(0, page-1)` | 实际返回 | 结果 |
|---|---|---|---|
| 0（首页） | `max(0, -1)` = 0 | 第 1 页 | 偶然正确 |
| 1（第 2 页） | 0 | 第 1 页 | ❌ **静默错页** |
| N-1（末页） | N-2 | 倒数第 2 页 | ❌ **静默错页** |

`max(0, …)` 把负数钳掉，**首页不会报错**；越界分支也永远触发不了（0-based 最大值 N-1 → `page_idx = N-2 < len`）。
∴ 这是一条**全程无告警的数据错误路径**。

### 1.2 第二爆炸面：用户可见文件名 + 三方名对齐不变式

```js
// frontend/src/utils/fileHelpers.js:130
const pageName = buildSplitPageName(file.name, page.page_index)   // ← 1-based 实参
```

而 `buildSplitPageName` 的 JSDoc（`fileHelpers.js:70-81`）写的是：

```
 * @param {number} pageIndex - 0-based 页码
 * @returns {string} 如 "invoice_p0.pdf"
```

**文档与实参矛盾**：生产实际产出 `invoice_p1.pdf … invoice_pN.pdf`（1-based）。

更关键的是同一段 JSDoc 声明了一条跨层不变式：

> 「前端拆分：`invoice_p{index}.pdf` → 后端存储：`invoice_document_to_db_record` 按各自页名落库 → 导出选材：`ExportService.extractExportFileNames` 用同名精确匹配」
> 「三者对齐 → 一个多页 PDF 拆出的 N 页在导出时全部可被检索到（不会互相覆盖/丢失）」

三方消费的是**同一个生成字符串**，所以当前自洽。但 B1 改 base 会让文件名整体位移一位（`_p1` → `_p0`），造成：

- 用户可见的首页从 `_p1.pdf` 变成 `_p0.pdf`（体验回退）
- **与历史 DB 记录 / 已导出物的名字匹配失配**（跨 session 破坏）

### 1.3 B1 判定

> ❌ **被证据否决**。B1 不是"影响面大"的选项，而是要求同时变更：
> ①`_page_registry` 存储语义 ②`extract_page_pdf` 的显式 1-based 能力契约 ③用户可见文件名 ④历史落库名匹配不变式。
> 其中 ② 属于 **Render 域**，本就不该被 Source 域的身份需求倒逼修改（违反 Identity ≠ Capability）。

### 1.4 值得表扬：全仓最干净的一处 base 边界声明 ✨

```python
# backend/render_engine/engine.py:418-419, 439-441
# page_idx 已是 0-based（经 max(0,page-1) 转换），直接喂 adapter.render(page_idx)
# （OFDAdapter 合同为 0-based）；1-based URL 契约不变，前端零改动。
```

这段同时讲清了三件事：**URL 契约 1-based**、**adapter 契约 0-based**、**归一发生在哪一行**。
这正是 M1-b 在找的 boundary 范式——**不是消灭多种 base，而是声明每种 base 的归属并指定唯一转换点**。Source 域应当照抄这个形态。

---

## 2. B2 — FileObj boundary（`buildFileObj`）

### 2.1 B2 的真实优势：`pageNum` 只有一个写入点

全仓扫描确认（排除测试）：

- 唯一写入点：`fileHelpers.js:23` 形参 → `:52` `pageNum: pageNum ?? null`
- 唯一实参来源：`processPdfFile:133` 传入 `page.page_index`
- **`parseResultConsumer` 完全不碰 `pageNum`**（grep 零命中）

∴ **`fileObj.pageNum` 在整个生命周期内恒为 1-based，不存在"解析前后变基"**。
这是一个天然的收敛点，价值应当保留。

### 2.2 消费端不是 36 个文件，而是 10 处真正解释 base

29 处非测试命中，按**是否解释 base** 三分：

| 组 | 性质 | 位置 | 与生产（1-based）一致? |
|---|---|---|---|
| **组 1a** | 解释为 1-based | `DisplayAdapter:96`、`DocumentStore:150`、`identity.js:56/66` | ✅ 一致 |
| **组 1b** | 解释为 0-based | `usePreview:247/626/1302/1349/1582/1649`、`usePrint:575` | ❌ **矛盾** |
| **组 2** | base 无关（排序/去重/分组/存在性） | `useFileOps:806`、`docFacts:108`、`buildPrintExecutionPlan:76/140/141/152`、`groupDocuments:127/141/211/253/267`、`invoiceDocumentViewModel:77`、`runChunkedImport:141` | — |
| **组 3** | 纯透传 | `parseRunner:60/62/84/86` | — |

**关键洞察**：真正的爆炸面是组 1（约 10 处），不是 36 个文件；且组 1b 的 6/7 处集中在 `usePreview` 单文件。
**但组 2 的"安全"是有条件的**——排序/去重只要求 base **自洽**，不要求 base **正确**。base 一旦在中途被改，组 2 会静默继续工作，**不产生任何失败信号**。这正是漂移能长期潜伏的机制。

### 2.3 B2 的不可逾越边界：OFD（本轮对 v2 结论的重要订正）

v2 审计写的是「OFD 的 page evidence 没有进入打印链」。本轮证据要求**订正为更精确的定性**：

**OFD 的 page evidence 存在，而且是正确的：**

```js
// frontend/src/services/renderDocument.js:173  （P8-lite capability guard，仅 OFD 可查）
if (fileObj.fileFormat !== 'ofd') return null
const meta = await fetchDocumentMetadata(fileObj.docId, { signal })
return ensureDocumentFromMetadata({ ...meta, filename: fileObj.name }, { silent })

// frontend/src/stores/DocumentStore.js:257-268
const pages = rawPages.map((p) => {
  const index = p.index ?? 0                 // 后端 metadata，0-based
  return createPageMeta({ docId, index, ..., renderPage: index + 1 })   // ← 正确的多页渲染坐标
})
```

∴ OFD 在 DocumentStore 里得到 `index 0..N-1` / `renderPage 1..N`，**完全正确**。

**缺陷在消费端取数来源不一致：**

| 消费端 | 取数来源 | 结果 |
|---|---|---|
| `printAdapter.buildPrintJobItem:65-78`（活代码，`usePrint.js:17` 导入） | `getDocument(docId)` → **DocumentStore** | 拿到正确 OFD 多页，但 `:74` 用**数组位置**覆盖 `index`（= M5） |
| `PrintPreviewModel:348` | `f?.pageCount`，`f` = **fileObj** | `buildFileObj:56` 硬编码 `pageCount: 1` → **OFD 永不展开** |

> **订正结论**：OFD 不是「证据缺失」，而是「**读错了源**」。

### 2.4 B2 判定

> 🟡 **不能作为 boundary**。要让 B2 覆盖 OFD，必须把 DocumentStore（异步 metadata 权威）回写进 FileObj（导入期快照）——**依赖方向倒置**，且在 metadata 到达前 FileObj 必然携带错误的单页表示。
> 但 B2 的**单一写入点**性质应予保留：它是 Source 域 evidence 进入前端的唯一入口，适合作为**声明点**（声明 base）而非**归一点**。

---

## 3. B3 — SourcePage boundary（Resolver 内）

B3 是排除法之后唯一剩下的位置，但本轮为它补了两条此前没有的约束。

### 3.1 约束一：evidence 具有时序性

OFD 的 page evidence 是**异步到达**的（`ensureDocumentMetadata` 在 `consumeParseResult` **之后**由 import orchestration 调用）。
∴ Resolver 必须能区分三种状态，而非两种：

```
evidence 确认为单页        → [{ sourceIdentity, 0 }]          ✅ 合法
evidence 尚未到达（pending）→ 明确失败 / 待定                   ⛔ 不得降级为单页
evidence 确认缺失          → SourcePageIdentityError           ⛔ 不得 fallback
```

当前代码恰恰把这三种混为一谈：`pageCount || 1`（`PrintPreviewModel:348`）与 `pageNum ?? 1`（`DocumentStore:150`）都是**用值的形状猜语义**——与后端 `_parse_page_info` 的 `page_num_str.startswith('0')` **同构**。M3 禁止的 `docId ?? id ?? key` 是同一个反模式的第三种形态。

### 3.2 约束二：Resolver 不能只吃 FileObj（正式否定，附证明）

1. `buildFileObj:56` 硬编码 `pageCount: 1` + `pages: [{index:0,…}]` → FileObj **自带一个伪造的单页表示**
2. 全仓无一处回写 `fileObj.pageCount`
3. OFD 的 fileObj 走三参调用 `buildFileObj(file, name, path)` → `pageNum = null`，**无任何页维度证据**
4. OFD 的真实证据只存在于 DocumentStore，且异步

∴ `resolveSourcePage(fileObj)` 对多页 OFD 只能返回单页 0，**且所有校验全绿**——形式正确、语义缺失，是最危险的一类设计错误。

> **正式否定 `resolveSourcePage(fileObj)`。采纳 `resolveSourcePages(sourceDocument, pageEvidence) → SourcePageIdentity[]`。**

### 3.3 B3 判定

> 🟢 **唯一剩余可行位置**。代价确认：Resolver 必须知道各 evidence 的来源语义（provenance），不能做成 `pageNum - 1` 的简单 helper。
> 这个代价是**必要的**，因为它恰好就是「区分两套坐标系」这件事本身——把它挪到别处只会让别处承担同样的复杂度。

---

## 4. Boundary 对照表

| Boundary | 能解决什么 | 不能解决什么 | 引入新语义风险 | 推荐性 |
|---|---|---|---|---|
| **B1** 后端 emit | 统一 producer base；`page_index` 与 `page_id` 后缀的自相矛盾一并消除 | 无法修正任何既有 consumer；不解决 OFD（OFD 不走 `/split_pdf`） | **与 `extract_page_pdf` 的显式 1-based 契约冲突** → `/download_page` 静默错页；用户可见文件名位移；破坏历史落库名匹配 | ❌ **否决** |
| **B2** FileObj | 前端 Source 域入口统一（单一写入点，天然收敛） | **OFD evidence 不在 FileObj 内**，且异步；组 2（base 无关消费）不会给出失败信号 | legacy `pageNum` 与新 `pageIndex` 双轨；若强行覆盖 OFD 则依赖方向倒置 | 🟡 **保留为声明点，不作归一点** |
| **B3** Resolver | Source identity 统一出口；可同时消费 FileObj 与 DocumentStore 两类 evidence；可严格区分 pending / 单页 / 缺失 | 无法修复错误或缺失的 evidence 本身（如 `pageCount:1`、M5 数组下标） | Resolver 需承载 provenance 语义，不能是简单 helper | 🟢 **唯一可行** |
| **Render 域**（既有） | `engine.py:_render_page` 的 `max(0, page-1)`：URL 1-based → adapter 0-based | 与 Source 域无关 | 无 | ✅ **已存在且正确，不动** |

---

## 5. 三个必答问题

### ① page-base normalization 的唯一 boundary 到底在哪一层？

> **不存在"唯一一层"——因为有两套坐标系，各需一个 boundary。**

- **Render 域 boundary：已存在且正确** → `engine.py:_render_page` 的 `page_idx = max(0, page - 1)`。保持不动。
- **Source 域 boundary：尚不存在** → 这才是 M1-c 要建的，位置在 **B3**。

∴ 命题需要修正：不是「B1/B2/B3 三选一」，而是「Render 域已在 B1 层归一且正确；Source 域应在 B3 层建立」。**两者互不替代。**

### ② 规范化后，哪一个字段成为唯一 canonical page index？

> `SourcePageIdentity.sourcePageIndex`（0-based），**且仅在 Source 域内唯一**。

| 字段 | 域 | base | 分类 | 生命周期 |
|---|---|---|---|---|
| `/split_pdf.page_index` | Source / transport | 1-based | **C legacy** | 保留，但必须显式声明 base |
| `fileObj.pageNum` | Source / transport | 1-based | **C legacy** | 保留至 Resolver 建立、consumer 迁完 |
| `_page_registry["page"]` | **Render** | 1-based | **B 必须保留** | 与 `extract_page_pdf` 契约绑定 |
| `DocumentStore.pages[].index` | **Render** | 0-based | **B 必须保留** | 物理制品内定位 |
| `DocumentStore.renderPage` | **Render** | 1-based | **B 必须保留** | URL 参数 |
| `sourcePageIndex` | Source / identity | 0-based | **A canonical** | 新建 |
| 数组下标 | 无 | — | **D 禁止** | M5 消灭 |
| `updatePageMeta()` | — | — | **D 可删** | 零生产调用方（见 N5） |

**防止"第四种状态"的机制不是把所有 base 改成 0**，而是：

> **每个字段显式声明「所属域 + base」，且跨域必须经过一个声明式转换点。**

组 2（base 无关消费）恰恰证明了这一点：它们对 base 完全不敏感，强行统一 base 对它们零收益、却带来全量回归风险。

### ③ 「0-based」是 SourcePageIdentity 的规范，还是所有 transport 也必须立即 0-based？

> **仅 SourcePageIdentity。transport 不必，且其中一部分不应。**

反例（均为本轮硬证据）：

- `_page_registry["page"]` 改 0-based → 与 `extract_page_pdf(page: 1-based)` 冲突 → `/download_page` 静默错页
- `buildSplitPageName` 改 0-based → 用户可见文件名位移 + 破坏历史落库名匹配
- `DocumentStore.renderPage` 改 0-based → 与 RE 的 1-based URL 契约冲突

∴ **「0-based」是身份层规范，不是全局 transport 规范。**
transport 字段只需满足两个条件：**base 被显式声明**，且**跨域点有唯一转换**。

---

## 6. F4 定性（本轮反转）

### 6.1 结论：**正常的 representation distinction，不是历史补偿逻辑**

```js
// frontend/src/stores/DocumentStore.js:171-182（注释为原文）
// - pageNums.length > 1（原始多页 PDF，未拆分）：同一 docId 对应物理多页，
//   index = pageNum - 1（0-based 数组索引），renderPage = pageNum（1-based URL 参数）
// - pageNums.length === 1（拆分后的单页文件/单页图片/OFD）：每个 docId 对应物理单页，
//   不管 fileObj.pageNum 是多少（它是父 PDF 中的页码，用于排序），物理文件内只有 1 页，
//   index = 0，renderPage = 1。
const isSinglePagePhysicalDoc = pageNums.length === 1
```

`isSinglePagePhysicalDoc` 区分的是**物理制品的页数**，不是源文档的页数。
对拆分页而言，物理文件确实只有 1 页 → `index=0 / renderPage=1` 是**正确的渲染坐标**。
源页码（第 2 页 / 共 5 页）留在 `fileObj.pageNum`，此处**刻意丢弃**——因为它不是渲染坐标。

> ∴ `DocumentStore.pages[].index` **根本不是 source page index，而是 render locator**。
> 上一轮"分支不统一"的描述是**误判**：它不是两套规则，是**一套规则作用在两种物理形态上**。

### 6.2 `pageCount = 1` 的定性：**是 FileObj 表示缺陷，并且已经造成上游 contract gap**

两件事必须分开：

- **`buildFileObj:56` 的 `pageCount: 1`** —— 表示缺陷。FileObj 在导入期无法知道页数，却**编造**了一个"单页"事实，而不是留 `null` 表示"未知"。这是把「未知」伪装成「已知」，与 §3.1 的三态混淆是同一个错误。
- **`PrintPreviewModel:348` 的 `f?.pageCount || 1`** —— contract gap。它从 FileObj 取页数，而正确的权威是 DocumentStore。`printAdapter` 在同一件事上取的就是 DocumentStore。

> ∴ `pageCount = 1` **既是 FileObj 表示缺陷，也已经通过 `PrintPreviewModel` 造成 OFD 多页不展开的实链后果**。
> 但它**不是 base 问题**，修 base 不会修好它。归 M1-b 输入、由 Resolver 输入模型解决（§3.2）。

---

## 7. 本轮新增 Finding

| # | 级别 | 内容 | 证据 |
|---|---|---|---|
| **N1** | 🔴 | B1 硬反证：`page_index` 同时进入 `_page_registry`，下游 `extract_page_pdf` 显式 1-based 且 `max(0,page-1)` 静默钳位 → 改 base 会全程无告警地错页 | `app.py:979,987`；`engine.py:360-386` |
| **N2** | 🔴 | B1 第二爆炸面：`buildSplitPageName` 产出用户可见文件名（实为 `_p1`），JSDoc 却写 0-based/`_p0`；同段 JSDoc 声明前端拆名/后端落库/导出选材三方对齐不变式 | `fileHelpers.js:70-82,130` |
| **N3** | 🟢 | F4 定性反转：`isSinglePagePhysicalDoc` 是 representation distinction，非补偿逻辑；`DocumentStore.pages[].index` 属 Render 域 | `DocumentStore.js:171-182` |
| **N4** | 🔴 | OFD 结论订正：evidence **存在且正确**（`renderPage: index+1`），缺陷是**读错源**——`PrintPreviewModel` 读 FileObj、`printAdapter` 读 Store | `DocumentStore.js:257-268`；`PrintPreviewModel.js:348`；`printAdapter.js:65-78` |
| **N5** | 🟡 | `updatePageMeta()` **零生产调用方** → D 类死代码。（`patchPageMeta` 是活的：`DocumentViewer.jsx:129`） | `DocumentStore.js:303`；全仓 grep |
| **N6** | 🔴 | **新实链缺陷（首次登记）**：`usePreview:1302/1349` `pageForPreview = (pageNum ?? 0) + 1` → `buildPreviewUrl` → `?page=` 直接决定渲染页。生产 `pageNum` 1-based + 端点 1-based + `effectiveDocId` 解析后指向**父多页 PDF** → 首页请求父 PDF 第 2 页，末页越界 | `usePreview.js:1309-1312,1356-1359`；`engine.py:296`；`fileHelpers.js:52`（唯一写入点）|
| **N6-b** | 🟢 | **M1-a 遗留疑点收窄**：`usePreview:626` 的 `rePage` **不构成错页**——`wireFieldsOf` 不含 `page`，`appendRenderSpecToUrl` 只做 `&` 追加不覆写 `?page=` → `rePage` 仅进 `spec_sig` 调试签名 | `renderSpec.js:34-57,182-195` |
| **N7** | 🟡 | 测试盲区：`parseRunner.test.js:51` 断言 `page_num==='0'`「首页必须保真」，用 0-based 合成 fileObj；生产发 1-based。两者在后端分走 `startswith('0')` 与默认分支、**都得到正确结果** → 该测试对 base 变更完全失明 | `parseRunner.test.js:43-51`；`import_batch_manager.py:1131-1140` |

### N6 的确信度声明

静态证据链已闭合四环：
1. `pageNum` 全生命周期唯一写入点、恒 1-based（`parseResultConsumer` 零命中）✅
2. RE preview 端点 1-based（`engine.py:296`）✅
3. `pageForPreview = pageNum + 1` 经 `buildPreviewUrl` 直接进 `?page=` ✅
4. `USE_RENDER_ENGINE_PREVIEW = true`（`config.js:37`，M1-a 已证）✅

**仍未做运行时验证**：需确认 RE preview 失败是否被静默回退掩盖（若每次都回退到 pdfjs/Canvas，用户可能看不到症状）。
**本轮仅登记，未修**，建议并入 M1-b 输出后单独立项验证。

---

## 8. 对后续顺序的影响

冻结顺序**不变**：

```
M1-a ✅ → M1-b → M1-c → M3 → M4 → Resolver → Plan 携带 → M5 → M2
```

但 **M1-c 的内容因本轮而改变**：

| | 原设想 | 本轮后 |
|---|---|---|
| M1-c | 「消灭 runtime base guessing」+ 统一 base | 「消灭 runtime base guessing」+ **为每个字段声明所属域与 base**，**不统一 base** |

理由：统一 base 已被 §1.1 / §5③ 的硬证据否决；而 `_parse_page_info` 的 `startswith('0')` 猜测**仍必须消灭**——它与 `pageCount || 1`、`pageNum ?? 1`、`docId ?? id ?? key` 是同一个反模式（**用值的形状推断语义**），这部分 M1-c 目标不变。

---

## 9. 变更纪律核验

- ❌ 未修改任何生产代码
- ❌ 未创建 `SourcePageResolver.js`
- ❌ 未 commit / 未 push
- ❌ 未选定最终实施方案（B1 的 ❌ 是**证据判定**，不是方案裁决）
- ✅ 仅新增本文档
