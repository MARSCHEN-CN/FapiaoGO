# SourcePageResolver Design Audit — v2（收口版，只读）

> v1 回答了 4 个范围问题 + 1 个硬问题。v2 按 review 意见做**契约收口**，并补充 v1 漏审的 2 个接缝层。
> 范围：**严格只读。未创建 `SourcePageResolver.js`，未改任何生产代码。**
> 配套：`SourcePageIdentity-Audit.md`（identity 证据来源 + §5.5 pageNum 1-based 勘误）。

---

## 0. v2 收口修订记录（相对 v1 的 4 处修正）

| # | v1 表述 | v2 修正 | 依据 |
|---|---------|---------|------|
| 1 | 🔴 Resolver API = `resolveSourcePage(fileObj)`，首次建立点 = FileObj→plan 边界 | **改为 `resolveSourcePages(source) → SourcePageIdentity[]`**，chokepoint = **SourcePage 形成点**，非 FileObj 出口 | FileObj 对 OFD 根本不含 page evidence（§1.5 实测，且比 review 判断更严重） |
| 2 | 🟡 verify 断言 `sourceIdentity` 是内容哈希 | **改为 provenance 校验**（来自白名单 evidence 字段 + 非空 + 非禁用字段），不判断内部格式 | `sourceIdentity` 已冻结为 opaque，判 hash 等于把它降级成 ContentHashIdentity |
| 3 | 🔴 source 聚合态可输出 `{sourceIdentity, sourcePageIndex: null}` | **删除该选项**。整本打印走独立的 `WholeDocumentPrintTarget(sourceIdentity)`，不产生无 page 的 SourcePage | `sourcePageIndex: number` 是冻结契约，null 即破约 |
| 4 | 「6 层中没有任何一层拥有 page-level 身份」 | **改为**「page-level **evidence** 已存在多处，但没有正式的、跨层共享的 **contract**」。Resolver 做的是**第一次规范化**，不是第一次产生事实 | `DocumentStore.pages[].index` 就是 0-based 权威 evidence |

**v2 另外新增 2 个 v1 漏审的接缝层**（§5.1），其中 1 个含潜在正确性缺陷。

---

## 1. Resolver 输入（Q1，v2 修订）

### 1.1 FileObj 能提供的 evidence
（`fileHelpers.js:buildFileObj` L23-59 + `processPdfFile` 拆分注入 L133-139）

| 字段 | 语义 | 对 Resolver |
|------|------|------------|
| `sourceDocId` | 父 PDF 哈希（仅多页 PDF 拆分页有）L137 | ✅ PDF split 的 `sourceIdentity` 权威来源 |
| `docId` | `sha256(bytes)[:24]`，拆分页 = 父哈希 | ✅ OFD / single 的 `sourceIdentity` |
| `pageNum` | **1-based**（后端 `i+1`），原样透传 L51 | ✅ PDF split 的 page evidence（需 `-1`） |
| `pageCount` | **硬编码 1** L56，全仓无回写 | ⚠️ 不可作为上界校验依据（见 §1.5） |
| `fileFormat` | pdf/image/ofd | 决定 evidence 路径 |
| `instanceId` / `key` / `id` | 实例/UI 身份 | ❌ 禁止 |

### 1.2 DocumentStore entry 能提供的 evidence
| 字段 | 来源 | 语义 |
|------|------|------|
| `pages[].index` | 拆分 `pageNum-1`（L176）/ OFD `p.index`（L258） | ✅ **0-based 权威 page evidence** |
| `pages[].renderPage` | `pageNum`（L177）/ `index+1`（L266） | ❌ 1-based，仅 URL/Sumatra |
| `pageCount` | `pages.length`（L322） | ✅ 唯一真实页数来源 |

### 1.3 三格式 evidence 路径（确认：不同）
| 格式 | page evidence 载体 | 时序 |
|------|-------------------|------|
| PDF split | **FileObj.pageNum**（同步，导入时注入） | 立即可用 |
| OFD | **DocumentStore.pages[].index**（异步 metadata） | 需 `ensureDocumentMetadata` 先跑（`renderDocument.js:162`，OFD-only） |
| single PDF / Image | **隐式 0** | 立即可用 |

### 1.4 evidence 不足的情形（一律硬失败）
| 情形 | 缺什么 | 行为 |
|------|--------|------|
| 无 `docId`/`sourceDocId` 的 fileObj | source identity | throw |
| OFD 但 metadata 未就绪 | page evidence | throw（**不得**降级成单页 0） |
| 旧 session 只有 `key`/`id` | 全部 | throw，隔离为 legacy UI，不入契约 |
| 多页 PDF 拆分页缺 `pageNum` | page evidence | throw |

### 1.5 🔴 v2 关键实测：OFD 的 page evidence 今天根本到不了打印链

review 指出「FileObj 本身没有 OFD pageIndex」——**成立，且比这更严重**：

```
buildFileObj (fileHelpers.js:56)   →  pageCount: 1     ← 硬编码
全仓 pageCount 写入点扫描          →  仅 DocumentStore.js:322 写 doc entry
                                      从无一处回写 fileObj.pageCount
                                              │
PrintPreviewModel.js:348           →  const pageCount = f?.pageCount || 1
PrintPreviewModel.js:349           →  if (pageCount <= 1) → 不展开
```

`f` 来自 `fileById.get(slot.fileId)`（L347），是 **fileObj**。因此对 OFD：

- `fileObj.pageCount` 恒为 1 → **多页 OFD 在打印预览中永不展开**，恒按单页 `pageIndex:0` 渲染；
- 合并模式更直接：`PrintPreviewModel.js:371-372` 对每个 slot 硬写 `pageIndex: 0`。

**结论**：OFD 的 `pages[].index` 只存在于 DocumentStore，**当前不存在任何 DocumentStore → 打印 plan 的 page 维度通路**。
若 Resolver 只接受 `fileObj`，等于把这条 evidence 缺失**固化进契约**——Resolver 会"正确地"对多页 OFD 返回单页 0，且校验全绿。这是最危险的一类设计错误：**用形式正确掩盖语义缺失。**

→ 故 v1 的 `resolveSourcePage(fileObj)` 必须否决。

---

## 2. Resolver 输出（Q2，v2 修订）

```ts
type SourcePageIdentity = {
  sourceIdentity: string   // opaque —— Resolver 与消费者均不得解析其内部格式
  sourcePageIndex: number  // 永远 0-based，永远是 number（禁止 null/undefined/-1）
}

type SourceDocumentIdentity = {
  sourceIdentity: string   // 文档级；不含 page 维度
}
```

**两个类型必须分离**（review #3）：整本打印是 `WholeDocumentPrintTarget(SourceDocumentIdentity)`，
**不是**「pageIndex 为 null 的 SourcePage」。降级 null 会污染契约，且让下游 `if (idx == null)` 分支重新长出来。

**禁止清单（Resolver 内部与所有调用方）**
- ❌ `key` / `id` / `instanceId` / `fileId` fallback 成 `sourceIdentity`
- ❌ 从 `pageId`（`…#p3` 1-based 串）反解析 `sourcePageIndex`
- ❌ 用 `renderPage`（1-based）当 `sourcePageIndex`
- ❌ 用 `printPath` 当身份
- ❌ 用**数组下标**冒充 `sourcePageIndex`（§5.1 现实中已发生两次）
- ❌ evidence 缺失时返回占位对象

---

## 3. 三格式规则 + split/unsplit 边界（Q3）

```text
PDF split:
  sourceIdentity  = fileObj.sourceDocId          // 父 PDF 哈希
  sourcePageIndex = fileObj.pageNum - 1          // ⚠️ pageNum 是 1-based

OFD:
  sourceIdentity  = fileObj.docId
  sourcePageIndex = DocumentStore.pages[].index  // 后端 0-based，直接采用

single-page PDF / Image:
  sourceIdentity  = fileObj.docId
  sourcePageIndex = 0
```

### 3.1 对 `sourcePageIndex = pageNum` 的 off-by-one 修正（v1 已提，保留）
`app.py:959` `page_num = i+1` → `app.py:987` `page_index: page_num` → `buildFileObj:51` 原样透传。
故 FileObj 侧必须 `-1`；DocumentStore 侧已归一，直接用 `page.index`。

### 3.2 split vs unsplit 同一 PDF（核心边界）
**当前现实**：多页 PDF 永远拆分（`processPdfFile` 仅 `totalPages<=1` 短路 L106-111），**无持久化未拆分表示**。

- **(a) 未来若引入未拆分表示**：其 `sourceDocId` 必须仍 = 后端父哈希 `doc_id`，`sourcePageIndex` = 原 PDF 0-based 页位。两条路径都锚定「父哈希 + 0-based 页位」即收敛到同一 SourcePageIdentity。✅
- **(b) 🔴 契约须写死的禁止项**：未拆分表示**不得**重新哈希产生新 docId、不得用 `file.key`。否则同一 PDF 分裂成两个 `sourceIdentity`。
- **(c) v2 修正——聚合态**：`normalizePrintSources` 按 `instanceId::sourceDocId` 分组、`f.pageNum` 排序（L152），整本交 Sumatra。
  此时**不产生** `{…, sourcePageIndex: null}`，而是产出 `WholeDocumentPrintTarget{ sourceIdentity }`。
  preview 展开仍各自持有完整 `SourcePageIdentity[]`，两条语义并存、互不降级。

---

## 4. 硬问题：compute + normalize + verify + fail（v2 修订 verify 定义）

```text
SourcePage Resolver
        │
        ├── compute / normalize  ← 从受信 evidence 规范化（非"首次产生事实"）
        │
        ├── verify（provenance-based，不看内部格式）
        │     • sourceIdentity 非空字符串
        │     • sourceIdentity 来自白名单 evidence 字段：{ sourceDocId, docId }
        │     • 未取自禁用字段：{ key, id, instanceId, fileId, printPath, pageId }
        │     • sourcePageIndex 是 number & Number.isInteger & >= 0
        │     • sourcePageIndex < 权威 pageCount（来源 DocumentStore.pageCount，非 fileObj.pageCount）
        │
        └── evidence 不足 → throw SourcePageIdentityError（无 fallback）
```

**v2 明确否决的 verify 写法**：
```js
assert(/^[0-9a-f]{24}$/.test(sourceIdentity))   // ❌ 把 opaque 绑死成 ContentHash
```
未来 source identity 若换成 `content://…` / `blob://…` / 远端 document id，上式即失效。
**provenance（它从哪来）可验证；format（它长什么样）不可验证。** opaque 贯彻到底。

---

## 5. 接缝审计（Q4，v2 补 2 层）

### 5.1 🔴 v1 漏审的两层，且都用**数组下标**冒充页身份

**(1) `printAdapter.buildPrintJobItem`（`utils/printAdapter.js:74-77`）**
```js
pages: doc.pages.map((page, index) => ({
  index,                                  // ← 数组位置
  url: resolvePrintUrl(page, doc.docId),  // ← 用真实 page.index
})),
```
同文件 L14 与 L51-52 的文档注释白纸黑字写着「页面身份是 `docId + page.index`」，**但代码发出的是数组位置**。
- pages 稠密有序时二者巧合相等 → 长期看不出问题；
- pages 稀疏时（部分 assembly、缺页、metadata 只回填子集）`index` 与 `url` **指向不同页** → 打印错页且无告警。

这是 🔴 **潜在正确性缺陷**，不只是命名问题。修法很小（`index: page.index`），但**属于 Migration Audit 范围，本轮不动**。

**(2) `docFacts.buildDocumentPageNames`（`layout/docFacts.js:202-209`）**
```js
return pages.map((page, pageIndex) => { … pageIndex, pageCount … })
```
`_p2` 页码后缀由**数组位置**推出，非任何权威 page 身份。这是导出/重命名链的页码来源。

→ 两处共同印证 review #4：**系统里 page-level "定位符"到处都是，但没有一个是契约化身份。**

### 5.2 全量接缝对照（8 层）

| 层 | 当前持有 | 性质 | 问题 |
|----|---------|------|------|
| composePagePlan | `docId ?? id ?? key` + `pageId`(1-based 串) | derived locator | 🔴 C 类 fallback |
| parseResultConsumer | `update.docId` + siblings | evidence 传递 | 不建立身份 |
| **DocumentStore** | `docId` + `pages[].index`(0-based) | ✅ **权威 evidence** | 有事实无契约、非出口 |
| printAdapter ⭐新 | `docId` + **数组下标** | derived locator | 🔴 与自身注释矛盾 |
| docFacts ⭐新 | **数组下标** | derived locator | 页码后缀来源不可靠 |
| PrintPreviewModel | `file.docId` + `pageIndex`(0-based) | derived locator | OFD 恒不展开（§1.5） |
| buildPrintExecutionPlan | `invoiceDocumentId`(doc级) + `{fileId, pageIndex:0}` | 退化 | page 维度硬编码 0 |
| PrintService | `file.key` + `printPath` | 无 page | 整本打印，应走 WholeDocumentPrintTarget |

### 5.3 v2 chokepoint：SourcePage **形成点**，不是 FileObj 出口
```text
                    ┌── PDF split ──── FileObj.pageNum (1-based)
                    │
Source Evidence ────┼── Image/single ── implicit 0
                    │
                    └── OFD ────────── DocumentStore.pages[].index (0-based)
                                              │
                                              ▼
                                   resolveSourcePages(source)
                                              │
                                              ▼
                                   SourcePageIdentity[]
                                              │
                        ┌─────────────────────┼─────────────────────┐
                        ▼                     ▼                     ▼
                  Preview Model         Execution Plan        printAdapter / docFacts

  ── 另一条语义，互不污染 ──
        SourceDocument ──→ WholeDocumentPrintTarget(sourceIdentity) ──→ PrintService(Sumatra)
```
Resolver 接受的是 **source + 其 page evidence provider**（OFD 需 DocumentStore 在手），返回**数组**。
格式无关性由此成立：调用方不需要为 OFD 写特例。

---

## 6. 冻结状态（v2）

| 项 | 状态 |
|----|------|
| `SourcePageIdentity { sourceIdentity: string, sourcePageIndex: number(0-based) }` | 🟢 冻结 |
| Resolver 原则：compute + normalize + verify + fail，无 fallback | 🟢 冻结 |
| 三格式 evidence 映射（含 `pageNum - 1`） | 🟢 冻结 |
| `key/id/instanceId/fileId/pageId/renderPage/printPath/数组下标` 不得为 page 身份 | 🟢 冻结 |
| verify 为 provenance-based，不判 hash 格式 | 🟢 冻结 |
| WholeDocumentPrintTarget 与 SourcePageIdentity 分离 | 🟢 冻结 |
| Resolver API 具体签名（`resolveSourcePages` 入参形态） | 🟡 **不冻结**，待 Migration Audit |
| `docId/sourceDocId/pageNum/pageId/renderPage/fileId/instanceId` 的保留/映射/删除 | 🟡 **不冻结**，待 Migration Audit |

---

## 7. 下一步：Migration Audit（仍只读，需授权）

理由：Resolver 设计再正确，只要旧字段仍在另一条链路偷偷承担 identity，问题就只是换了位置。
§5.1 的 printAdapter 已经是活证据——它在 v1 审计视野之外，却真实参与页身份。

**字段面积（已扫，frontend/src）**：`sourceDocId` 26 文件 / `pageNum` 36 / `instanceId` 19 / `pageId` 14 / `renderPage` 6，另加 `docId`、`fileId`。
**产出**：每字段 Producer → Consumer 清单 + 四分类（可映射 / 必须保留 / 仅 legacy / 可删除）。
