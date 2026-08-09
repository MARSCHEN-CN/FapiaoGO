# SourcePage Migration Audit（只读，未改码 / 未建 Resolver / 未提交）

> 判定基准：`SourcePageResolver-Design-Audit.md` v2 已冻结的 `SourcePageIdentity` 契约。
> 纪律：本轮**只记录 Migration finding，不修复**。所有 🔴 均未动。
> 范围：`frontend/src` 全量 + 相关 backend producer。

---

## 0. 总判定

**迁移不能从字段改名开始，必须先关闭 3 个 base/fallback 缺口。**

现状不是「旧字段需要改名」，而是 **同一字段在不同层有互相矛盾的语义，且矛盾被测试固化**。
最严重的一条：`pageNum` 的 0/1-based 在**生产链上是靠字符串猜测**决定的（M1）。
在 M1 关闭前实现 Resolver，只会把猜测封装进 Resolver 内部。

| 编号 | Finding | 级别 | 分类 |
|---|---|---|---|
| M1 | `pageNum` base 契约分裂，后端靠 `startswith('0')` 猜 base | 🔴 P0 | C |
| M2 | `pageId` 三种方言并存，且 `:p1` 在两处含义相反 | 🔴 P0 | C |
| M3 | `docId ?? id` 在 identity 出口本身发生 | 🔴 P1 | C |
| M4 | `sourceDocId || instanceId` 让实例身份偷渡成源身份 | 🔴 P1 | B+C |
| M5 | 数组下标冒充 page identity（printAdapter / docFacts） | 🔴 P1 | D |
| M6 | `or` 链吞掉合法 `page_num = 0` | 🟡 P2 | C |
| M7 | `fileId` = `f.key`，纯 plan 引用，未被误用 | 🟢 | B |
| M8 | `renderPage` 边界干净，仅 URL/渲染 | 🟢 | B |

---

## 1. 🔴 M1：`pageNum` base 契约分裂（本轮最重要发现）

### 1.1 Producer 侧真值：**1-based**，且当前**无任何在跑的测试守护**

```python
# backend/app.py:959
chunks.append([(i, i + 1, f"{file_hash}_{i}") for i in range(start, end)])
#               ^     ^^^^^  i 是 0-based，page_num = i+1
# backend/app.py:987
pages.append({ "page_index": page_num, ... })      # → 1-based
```
全后端 `page_index` **emit 点唯一**（grep 确认仅 `app.py:987`）。其自有测试确实写了 1-based 断言：

```python
# backend/tests/test_split_pdf_chunk.py:80-84（在 _assert_order_and_content 内）
prev_index = 0
assert p["page_index"] == prev_index + 1     # 首页必须 == 1 → 表达 1-based
```

> **🔴 勘误（M1-a 运行时证实，2026-08-09）**
> 本文档 v1 称该断言"把 1-based 焊死"。**实测为误**——它**从未执行过**：
>
> ```
> test_split_open_count_and_order  L123  assert counter["n"] == 1 + expected_chunk_opens   ← 先失败
>                                  L132  _assert_order_and_content(...)                    ← base 断言在此，永不到达
> ```
>
> `python3.11 -m pytest tests/test_split_pdf_chunk.py` 实跑结果：**8 failed / 1 passed**，
> 失败原因全为 `KeyError: 'preview_image'` 与 `fitz.open` 次数不符（`/split_pdf` 响应结构已漂移，
> 与页码基数无关）。唯一 passed 的 `test_split_download_page_after_chunk` 不含 base 断言。
>
> ∴ 结论应加强而非削弱：**`/split_pdf` 的 1-based 基数在当前仓库里处于「无测试覆盖」状态**，
> 这正是它能与「核心原则 3」长期矛盾而无人察觉的直接原因。M1-a 新增的
> `tests/test_m1a_split_pdf_page_base.py` 是**当前唯一在跑的 base 守护**。

#### 1.1-F1 正式表述（本条为规范版本，引用时以此为准）

> `/split_pdf.page_index` 的生产行为经代码证据确认是 **1-based**；但既有
> `test_split_pdf_chunk.py` 的 1-based 断言**实际上从未执行到**，
> 因此此前「被测试焊死」的结论**错误**，已作废。

| 维度 | 状态 | 证据等级 |
|---|---|---|
| 生产事实 | **1-based** | ✅ 已证实（`app.py:959,987`，全后端唯一 emit 点） |
| 既有测试保护 | **无** | ✅ 已证实（L123 先失败，L132 base 断言不可达；实跑 8F/1P） |
| M1-a 新测试 | **1-based** | ✅ 已建立（`test_m1a_split_pdf_page_base.py`，7 passed） |
| 项目记忆 核心原则 3 | **0-based** | ⚠️ 与生产漂移，**归属未定，待 M1-b 裁决** |

**∴ M1-a 的意义不是证明设计正确，而是把真实现状从「隐性行为」提升成「可观察事实」。**
未来是把 `/split_pdf` 改成 0-based，还是让它继续 1-based、在某个 boundary 统一归一，
**属于 M1-b 的裁决范围，M1-a 不预设立场**。

前端原样透传，无任何归一：
`fileHelpers.js:133` `buildFileObj(…, page.page_index, …)` → `:51` `pageNum: pageNum ?? null`。

**∴ 运行时 `fileObj.pageNum` = 1-based。**

### 1.2 但项目冻结原则与后端下游都认为它是 0-based

| 处 | 表述 | 与真值 |
|---|---|---|
| 项目记忆 核心原则 3 | 「`/split_pdf` 的 page_index …必须全部 0-based」 | ❌ 冲突 |
| `import_batch_manager.py:986` 注释 | 「与 /split_pdf 的 page_index（0-based）一致」 | ❌ 冲突 |
| `tests/test_commit4_1_page_num_contract.py:47-48` | mock 按 `'page_num': str(page_index)` 0-based 构造 | ❌ 用 0-based mock 验证 1-based 生产链 |

> Commit 4.1/4.3 归一的是**批量导入 `page_num` 表单通道**；`/split_pdf` 的 `page_index` 输出通道**从未被纳入**，两条通道各自为政。

### 1.3 🔴 后果：后端用字符串前缀「猜」base

```python
# backend/import_batch_manager.py:1131-1140
if page_num_str.startswith('0') and page_num_str:   # ← 猜：以 '0' 开头 = 0-based
    self._zero_based_buckets.add(bucket_key)
    return page_num, total_pages
if 1 <= page_num <= total_pages:                    # ← 否则默认 1-based，-1 归一
    page_num = page_num - 1
```

这是**后端版的 `docId ?? id ?? key`**：不是从 evidence 计算，而是从**值的字面形状**推断语义。
- 生产链发 1-based（`'1','2','3'`）→ 走 `-1` 分支 → 归一正确，但**纯属默认分支恰好命中**；
- 任一上游改成 0-based（`'0','1','2'`）→ 首页 `'0'` 触发 bucket 标记 → 也正确；
- **两条路都"对"，恰恰说明 base 不是契约、而是运行时推断**。一旦某 bucket 首页丢失或乱序到达，标记不触发 → 整桶被 `-1` → key 撞 `-1`/错位。

### 1.4 前端消费端同样分裂成两派（同一字段，相反解读）

| 派别 | 位置 | 代码 | 与 1-based 真值 |
|---|---|---|---|
| **A: 按 1-based** | `DocumentStore.js:150,176` | `pageNum ?? 1` → `index = pageNum - 1` | ✅ |
| | `DisplayAdapter.jsx:96,101` | `pageNum ?? 1` → `renderPage: pageNum` | ✅ |
| | `identity.js:83-84` | `pageNum < 1 → undefined`；`${docId}:p${pageNum}` | ✅ |
| **B: 按 0-based** | `usePreview.js:247` | 注释「⚠️ pageNum 是 0-based」→ `(pageNum ?? 0) + 1` | ❌ 前提写反 |
| | `usePreview.js:635` | `rePage = (pageNum ?? 0) + 1`（拆分页分支） | ❌ 疑似 off-by-one |
| | `usePreview.js:1616,1702` | 同上 | ❌ |
| | `usePrint.js:575` | `pageIndex: previewFile.pageNum ?? 0` | ❌ 1-based 当 0-based index |
| | `parseRunner.js:55,59` | 注释「pageNum(0-based，首页=0)」 | ❌ |

**生效性**：`config.js:37 USE_RENDER_ENGINE_PREVIEW = true` → `usePreview.js:635` 的 RE 分支**在线**。
但 `usePreview.js:1336/1383` 处于 `if (fmt === 'image' || fmt === 'ofd')` 分支内，该分支 `pageNum` 恒为 `null` → `(null ?? 0)+1 = 1`，**结果恰好正确**，属"错误前提 + 无害输入"的巧合安全。

> ⚠️ 未做运行时验证。`usePreview.js:635` 是否构成用户可见的错页，需实测；本轮只登记为 finding，**未修**。

### 1.5 分类与迁移结论

| 字段 | 分类 | 结论 |
|---|---|---|
| `fileObj.pageNum` | **C（Legacy-only）** | 语义为「1-based 物理页码」。**禁止**直接进入 `sourcePageIndex`；Resolver 只能经 `pageNum - 1` 且必须先关闭 M1 |
| `page_index`（后端） | **C** | 名为 index 实为 1-based number，**命名即误导**。改名前不得新增 consumer |
| `_parse_page_info` base 猜测 | **D（应删除）** | 猜测逻辑必须被显式 base 契约替代，而非保留 |

---

## 2. 🔴 M2：`pageId` 三种方言，`:p1` 含义相反

| # | 产生处 | 格式 | 基准 | 首页值 |
|---|---|---|---|---|
| 1 | `identity.js:84` | `${docId}:p${pageNum}` | pageNum（1-based） | `doc:p1` |
| 2 | `InvoiceDocument.js:56` | `${docId}:p${index}` | 数组 index（0-based） | `doc:p0` |
| 3 | `composePagePlan.js:41` | `${docId}#p${(pageIndex ?? index)+1}` | 混合 +1 | `doc#p1` |

🔴 **#1 与 #2 分隔符相同（`:p`）但基准相反**：字符串 `doc:p1` 在 #1 表示**第 1 页**，在 #2 表示**第 2 页**。
两者若在同一 Map/Set 中相遇即静默错配，且**无任何类型或前缀可区分**。

`identity.js:43` 注释称 pageId 为「页面实例身份（docId:pN）」——但 #2 用同一形状表达不同含义。

**分类：C（Legacy-only）**。契约已禁止从 `pageId` 反解析 `sourcePageIndex`（v2 §2），本轮证据支持该禁令：**反解析在方言 #1/#2 之间无解**。
`composePagePlan.contract.test.js:34-38` 与 `composePagePlan.test.js:13,23` 已把方言 #3 焊进测试 → 迁移时须同步改测试，不可只改实现。

---

## 3. 🔴 M3：`docId ?? id` 发生在 identity 出口本身

```js
// frontend/src/utils/identity.js:64  —— resolveIdentity()
const docId = fileObj.docId ?? fileObj.id ?? ''
```

这不是某个消费点的随手兜底，而是**被命名为 "Identity Resolver" 的模块自身**在做 fallback。
`id` 在 `ImportSession.js:29` 的定义是「文件标识（= key，合同中的 fileId）」→ **即 UI/实例身份**。
故此行等价于：`Source identity ← UI key`，正是 v2 契约明令禁止的 C 类偷渡。

同类（均为 Source 位被非 Source 值填充）：

| 位置 | 代码 | 性质 |
|---|---|---|
| `composePagePlan.js:39` | `it.docId ?? it.id ?? it.key` | 🔴 已知 |
| `runChunkedImport.js:137` | `sourceDocId: fileObj.sourceDocId \|\| fileObj.docId \|\| ''` | 🟡 docId→sourceDocId 语义爬升 |
| `instancePageOwnership.js:36` | `(f.sourceDocId \|\| f.docId) === target` | 🟡 同上 |
| `groupDocuments.js:167,291` | `documentId: rep.docId \|\| rep.sourceDocId` | 🟡 方向相反的爬升 |
| `invoiceDocumentViewModel.js:61` | `invoiceDoc.sourceDocId \|\| invoiceDoc.docId` | 🟡 |

**分类**：`identity.js:64` 的 `?? fileObj.id` → **D（可删除）**，无合法 producer 依赖（`id` 与 `key` 同值，`uiKey` 已单独承载）。
其余 `sourceDocId ↔ docId` 互相兜底 → **C**：语义上二者在**未拆分单页**场景确实相等，但相等是巧合非契约，Resolver 必须显式分派而非 `||`。

---

## 4. 🔴 M4：`sourceDocId || instanceId` — 实例身份偷渡成源身份

```js
// buildPrintExecutionPlan.js:87-91  与  groupDocuments.js:74-79（完全同构，重复实现）
const sourceDocId = f?.sourceDocId || ''
if (instanceId && sourceDocId) return `${instanceId}::${sourceDocId}`
return sourceDocId || instanceId || ''        // ← 🔴 instanceId 单独成为分组键
```

正常路径 `instanceId::sourceDocId` 是**正确设计**（`groupDocuments.js:57-64` 的论证成立：同内容 A/B 共享哈希需 instanceId 区分）。
问题只在末行 fallback：`sourceDocId` 缺失时，**`instanceId` 独自承担了源文档分组身份**。
`fileHelpers.js:47` `instanceId: instanceId || key` → instanceId 可退化为 **UI key** → 链条为 `key → instanceId → 源分组键`。

**分类**：
- `instanceId` 本身 → **B（必须保留）**。它承担真实且不可替代的语义：**导入实例生命周期**（`invoiceIdentityResolver.js:15`「同文件删后重导 → 不同 instanceId」）。与 `sourceIdentity`（内容哈希）正交，**不得**并入 `SourcePageIdentity`，也不得删除。
- 末行 `|| instanceId` fallback → **D（可删除）**，应改为显式失败。
- 两处同构实现 → 迁移时须一并处理，否则修一处留一处。

---

## 5. 🔴 M5：数组下标冒充 page identity（v2 已发现，此处定分类）

```js
// utils/printAdapter.js:74-77
pages: doc.pages.map((page, index) => ({
  index,                                   // ← 数组位置
  url: resolvePrintUrl(page, doc.docId),   // ← 真实 page.index/renderPage
}))
```
同文件 L14/L51-52 注释明写「页面身份是 `docId + page.index`」，**代码发出的是数组位置**。
pages 稀疏时 `index` 与 `url` 指向不同页 → 打印错页且无告警。

```js
// layout/docFacts.js:202-209
return pages.map((page, pageIndex) => { … pageIndex, pageCount … })   // 页码后缀来源
```
`docFacts.js:121` 注释坦承：「刻意用**排序后的序号**而非 page.pageNum：pageNum 在部分链路缺失或非连续」
→ 这是**对 M1 的下游补偿**：因为 pageNum 不可信，所以改用数组位置。M1 修复后此补偿应撤销。

**分类：D（可删除）**——两处的「数组下标」都无独立语义，是权威 page evidence 缺位时的替代品。Resolver 落地后应直接替换为 `SourcePageIdentity.sourcePageIndex`。

---

## 6. 🟡 M6：`or` 链吞掉合法的 `page_num = 0`

```python
# backend/invoice_assembly_pipeline.py:205
return page.get('page_num') or page.get('page_index') or 0
```
`page_num = 0`（0-based 首页，合法）为 falsy → 跳过 → 落到 `page_index`（1-based）→ **首页排序键被替换成另一 base 的值**。
与 `parseRunner.js:59` 的纪律注释「pageNum=0 必须保留…绝不用 truthy 判断，会丢首页」**直接冲突**——前端已建立该纪律，后端此处未遵守。

**分类：C**。属 M1 的衍生症状，M1 关闭后应改为 `is not None` 显式判定。

---

## 7. 🟢 M7 / M8：边界干净的两个字段（确认无需迁移）

**`fileId`** — 全量 grep 后确认：始终等于 `f.key`（`buildLegacyPrintPlan.js:83,125`、`buildPrintExecutionPlan.js:271,311,327`），
消费端一律用于 `fileById.get(fileId)` 反查（`deriveMergePrintJobs.js:31`、`deriveSourcePrintJobs.js:33`、`PrintPreviewModel.js:204,347`）。
**未发现任何一处把 `fileId` 当 source identity 使用。**
→ **B（必须保留）**：它是 Plan 内部的**实例引用**，与 `sourceIdentity` 正交，两者应共存于 slot 上。

**`renderPage`** — 6 文件，全部限定在 URL / 渲染定位：
`DocumentStore.js:177,266` 产生，`previewResourceResolver.js:44,61,77` 消费为 `/preview?page=N`。
`InvoiceDocument.js:64-67` 注释边界清晰（「物理文件内的页码」）。
→ **B（必须保留）**：Render 能力身份，符合「Identity ≠ Capability」。
💭 唯一瑕疵：`previewResourceResolver.js:44` `page?.renderPage || (page?.index + 1)` 用 `||`，若 `renderPage` 为 0 会静默 fallback。因 renderPage 恒 ≥1，当前无害，但与 M6 同型，建议一并改 `??`。

---

## 8. 四分类总表

| 字段 | A 可映射 | B 必须保留 | C Legacy-only | D 可删除 |
|---|:--:|:--:|:--:|:--:|
| `sourceDocId`（拆分页父哈希） | ✅ → `sourceIdentity` | | | |
| `docId`（OFD/单页） | ✅ → `sourceIdentity` | | | |
| `DocumentStore.pages[].index` | ✅ → `sourcePageIndex` | | | |
| `pageNum` | | | ✅ 需 `-1`，先关 M1 | |
| `page_index`（后端 1-based） | | | ✅ 命名误导 | |
| `pageId`（3 方言） | | | ✅ 禁反解析 | |
| `instanceId` | | ✅ 导入实例生命周期 | | |
| `fileId` | | ✅ Plan 实例引用 | | |
| `renderPage` | | ✅ Render 能力身份 | | |
| `identity.js:64` 的 `?? id` | | | | ✅ |
| `sourceDocId \|\| instanceId` 末行 | | | | ✅ |
| 数组下标（printAdapter/docFacts） | | | | ✅ |
| `_parse_page_info` base 猜测 | | | | ✅ |

---

## 9. 主链验证：`SourcePage → PrintExecutionPlan → PrintPage/Slot`

契约要求：这是**唯一** page-level identity 主链，Preview / Print 不得自行展开或重算页身份。

**当前违反情况：**

| 层 | 现状 | 是否违反 |
|---|---|---|
| `buildPrintExecutionPlan.js:311,327` | `source: { fileId: f.key, pageIndex: 0 }` | 🔴 page 维度**硬编码 0**，主链上根本没有页身份 |
| `PrintPreviewModel.js:348-349` | `pageCount = f?.pageCount \|\| 1` → `<=1` 不展开 | 🔴 Preview **自行展开**，且因 `fileObj.pageCount` 恒为 1（`fileHelpers.js:56` 硬编码）而永不展开 |
| `PrintPreviewModel.js:371-372` | 合并模式硬写 `pageIndex: 0` | 🔴 Preview **自行赋页身份** |
| `usePrint.js:575` | `pageIndex: previewFile.pageNum ?? 0` | 🔴 第三处独立计算，且 base 错（M1） |
| `printAdapter.js:74` | 数组下标 | 🔴 第四处 |
| `docFacts.js:202` | 数组下标 | 🔴 第五处 |

**结论：主链目前是断的。** `PrintExecutionPlan` 不携带页身份（恒 0），导致下游 **5 处各自重算**——这正是契约要禁止的形态。
迁移的第一个可验证里程碑应是：**让 `PrintExecutionPlan.source` 携带 `SourcePageIdentity`**，而非先去改字段名。

---

## 10. 迁移顺序建议（不含实现，需授权）

严格 bisect，一步一 commit 一验证：

```
M1-a  为 /split_pdf 的 page_index 补 base 契约测试（先锁现状 1-based，不改行为）
M1-b  删除 _parse_page_info 的 startswith('0') 猜测，改显式 base 参数
M1-c  统一 base（0-based）——此步才允许改值，需同步改 test_split_pdf_chunk:80
   ↓（M1 关闭前，以下任何一步都会把猜测封进 Resolver）
M3    删 identity.js:64 的 ?? fileObj.id
M4    删两处 `|| instanceId` 末行 fallback，改显式失败
R     实现 resolveSourcePages(source) → SourcePageIdentity[]
M-chain  PrintExecutionPlan.source 携带 SourcePageIdentity
M5    printAdapter / docFacts 改读 sourcePageIndex，删数组下标
M2    pageId 三方言收敛（最后做，测试改动面最大）
```

**前置铁律**：M1 未关闭前**不实现 Resolver**。否则 Resolver 的 `pageNum - 1` 会成为第 6 处 base 假设。

---

## 11. 本轮边界声明

- 未修改任何生产代码；未创建 `SourcePageResolver.js`；未提交 commit。
- 所有 🔴 均为登记状态，**一处未修**。
- `usePreview.js:635` 是否构成用户可见错页——**未做运行时验证**，仅登记为待验 finding。
