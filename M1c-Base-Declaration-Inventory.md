# M1-c Base Declaration Inventory — page 坐标系声明 / 猜测清单

> **纪律声明**：本轮**纯只读**。未修改任何生产代码、未创建 `SourcePageResolver.js`、未提交。
> 本文档是 M1-c 的**第一步交付物**：一份 inventory（清单），不是修复方案。
> 它只回答用户指定的两个问题：
> **① 现有各 evidence 在什么地方被「声明为 1-based / 0-based」？**
> **② 哪些地方在偷偷猜测 base（用值的形状推断语义）？**
>
> 判定基准：M1-b 已冻结的「Source Identity ↔ Render Locator 双坐标系」模型，与 M1-a 事实表。

日期：2026-08-09
上游：`M1-a ✅ → M1-b ✅ → 本轮 M1-c（只读 inventory）`

---

## 0. M1-c 的目标（用户冻结的四条）

M1-c **不是**「统一所有 page base」。而是：

> **消灭 runtime base guessing，并建立 Source / Render 坐标系的显式 boundary。**

四条冻结口径：

```text
① Source Identity
   sourcePageIndex = 0-based canonical（尚不存在，待 Resolver 建立）

② Source transport
   /split_pdf.page_index
   fileObj.pageNum
   可以继续保持 1-based
   但必须显式声明语义

③ Render Locator
   DocumentStore.index / renderPage / _page_registry
   继续保持各自已有 contract

④ Cross-domain conversion
   只能在明确的 boundary 做转换
   禁止通过值形状猜 base
```

下面 §2 是①/②/③的**声明清单**，§3 是②的反面——**猜测清单**，§4 是④的**转换点目录**，§5 抽共同病灶，§6 给 **Resolver 准入门禁**。

---

## 1. 范围与方法

- 扫描后端 `app.py / import_batch_manager.py / invoice_assembly_pipeline.py / page_result_store.py / render_engine/** / group_pages.py / multi_page_analyzer.py` 与前端 `src/**` 全部 `*.js/*.jsx/*.ts`。
- 以「显式 `0-based`/`1-based` 注释 / docstring / JSDoc」+「值流向」双重确认每个点的真实 base。
- 标注三态：`✅ 声明且与生产一致` / `🟡 声明但 base 错或语义错` / `❌ 无声明、靠猜` / `⚠️ 声明自相矛盾`。
- 关键确认：`/split_pdf.page_index` 全后端**仅 `app.py:987` 一处 emit**（M1-a 已证 1-based）；`SourcePageIdentity` / `resolveSourcePages` 当前**无任何实现**（仅设计文档）。

---

## 2. 声明清单（Declaration Inventory）

> 每个 page 坐标系 evidence 点的「声明 base / 所属域 / 是否与生产一致」。

| # | 字段 / evidence | 声明位置 | 声明 base | 域 | 与生产一致? | 备注 |
|---|---|---|---|---|---|---|
| D1 | `/split_pdf.page_index`（transport） | `app.py:987` | 🟡 **生产真值=1-based，declaration=absent**（无注释，靠流向推断） | Source/transport | ✅ 真值 1-based / 🟡 未声明 | 全后端唯一 emit 点；状态同 D5，属「事实语义 ≠ 声明」 |
| D2 | `/split_pdf` `page_id` 后缀 | `app.py:934` | 0-based（`{file_hash}_{i}`，i=0-based 页序） | Source/transport 身份 | ⚠️ 自相矛盾 | 同一响应内 `page_index`=1-based 而 `page_id` 后缀=0-based（M1-a 事实 2） |
| D3 | `group_pages.py` `page_index` | `group_pages.py:91,96,100` | 0-based（注释 `multi_page_analyzer.py:55`） | 内部分析 | ⚠️ 同名异义 | 与 D1 的 `page_index` 同名但 0-based，是**命名重载**而非同一字段 |
| D4 | `invoice_parse_coordinator._extract_page(page_index)` | `invoice_parse_coordinator.py:142` | 0-based（pdfplumber 风格） | 内部 | — | 物理页定位，属 Render 域 |
| D5 | `fileObj.pageNum` | `fileHelpers.js:23/52`（形参+`?? null`）、`processPdfFile:133` 传 `page.page_index` | **生产真值 1-based**；但**无显式注释声明** | Source/transport | ✅ 真值 1-based / 🟡 未声明 | 唯一写入点，恒 1-based；但缺 JSDoc 声明 base（下游各自猜） |
| D6 | `fileObj.pageCount` | `fileHelpers.js:56` | 硬编码 `1` | Source/transport | ❌ 表示缺陷 | 「未知」伪装成「已知单页」= F4 缺陷；造成 `PrintPreviewModel:348` OFD 不展开 |
| D7 | `DocumentStore.pages[].index` | `DocumentStore.js:170,176` | 0-based（注释 `index = pageNum - 1`） | **Render** | ✅ | F4 定性：这是 render locator，不是 source page |
| D8 | `DocumentStore.renderPage` | `DocumentStore.js:266` | 1-based（`index + 1`） | **Render** | ✅ | URL/API 表示 |
| D9 | `_page_registry["page"]` | `app.py:979` | 1-based | **Render** | ✅ | 绑定 `extract_page_pdf(page: 1-based)`（M1-b N1） |
| D10 | OFD metadata `rawPages[].index` | `DocumentStore.js:257` | 0-based（后端 metadata） | **Render** | ✅ | `renderPage: index + 1` 正确（M1-b N4 订正：evidence 存在且正确） |
| D11 | `extract_page_pdf(page)` | `engine.py:296,366` | 1-based（docstring 显式） | **Render** | ✅ | 内部 `max(0,page-1)` 静默钳位（B1 否决根因） |
| D12 | `/preview?page=` | `render_engine/api.py:170` | 1-based（default 1） | **Render** | ✅ | URL 契约 |
| D13 | `OFDAdapter.render(page_index)` | `ofd_adapter.py:65` | 0-based | **Render** | ✅ | adapter 契约 |
| D14 | `sourcePageIndex`（canonical） | **不存在** | 应为 0-based | Source/identity | — | 待 Resolver 建立；是 M1-c ②的落点 |
| D15 | `page_result_store.page_num` | `page_result_store.py:60,92` | 0-based（Channel B 契约） | Source/contract | ⚠️ 与 D1 不同通道 | 批量导入通道（Channel B），与 `/split_pdf`（Channel A, D1）各自为政；记忆原则 3 适用范围须限定于此 |
| D16 | `DisplayAdapter.renderPage = pageNum` | `DisplayAdapter.jsx:96,101` | 1-based（注释显式） | Source→Render 透传 | ✅ 声明正确 | 注释 `:90` 提及「resolver 默认路径即可得到正确 URL」——证明 Resolver 曾被预期 |
| D17 | `InvoiceDocument.index / renderPage` | `InvoiceDocument.js:23,29,47,64` | index 0-based / renderPage 1-based | **Render** | ✅ 声明清晰 | 注释明确「renderPage = 物理文件内页码（1-based）」 |
| D18 | `identity.js` pageNum（两处冲突） | `identity.js:56`（1-based）/ `identity.js:76`（0-based） | 各自声明但不一致 | Source | ⚠️ 同文件两函数 base 相反 | `:56` 批注「1-based；>1 隐含 pageId」；`:76` 批注「0-based 页码」 |
| D19 | `useViewerState.initialPage` | `useViewerState.js:78` | **假设 pageNum 1-based**（`fileObj.pageNum - 1`） | Source→display | ✅ 与生产一致 | **与 D20 直接矛盾** |
| D20 | `usePreview` doc.pageNum | `usePreview.js:244,1599`（注释「pageNum 是 0-based」）+ `:247,1602` `(pageNum ?? 0) + 1` | **声明 0-based** | Source→display | 🔴 **误声明** | 生产 `pageNum` 实际 1-based；`+1` 对真实拆分页**整体 off-by-one**。与 D19 矛盾 |
| D21 | `parseRunner` pageNum | `parseRunner.js:55,79` | 0-based（合成/test 路径） | Source | ⚠️ 仅测试 | 测试夹具用 0-based，与生产（D5=1-based）不符（M1-b N7 盲区） |
| D22 | `usePrint` print job `pageIndex` | `usePrint.js:575` `pageIndex: previewFile.pageNum ?? 0` | 透传（Render locator） | **Render** | 🟡 | 取 `pageNum ?? 0` 作打印页定位 |
| D23 | `printAdapter` `pageNum` | `printAdapter.js:100`（`pageNum=1` 默认） | 1-based（默认） | Source→Render | 🟡 | `:106` `resolvePrintUrl({index: pageNum-1})` 做转换 |

**声明清单要点**：
- **真正干净的声明**：D7/D8/D9/D10/D11/D12/D13（Render 域，base 显式且正确）、D17（InvoiceDocument）。
- **生产正确但缺声明（🟡）**：D1（`/split_pdf.page_index` 真值 1-based 但无注释）与 D5（fileObj.pageNum 真值 1-based 但无 JSDoc 声明 base）同属「事实语义 ≠ 声明」——这是 M1-c 第 1 条口径修正的落点，也是直接诱发 D20 误声明与 `import_batch_manager` 错误 0-based 注释的根因。
- **误声明（最危险）**：D20（usePreview 注释 0-based，实为 1-based）、`import_batch_manager.py:986-989` 注释「page_num 0-based 与 /split_pdf.page_index 一致」——而 D1 实际 1-based。**后者是 M1 能潜伏至今的核心机制**：注释说 0-based，代码发 1-based，无人告警。
- **同名异义重载**：`page_index` 在 D1（1-based transport）/ D3（0-based 内部分析）/ D4（0-based 物理）三处含义不同——命名碰撞本身是声明危害。

---

## 3. 猜测清单（Guessing / Anti-pattern Inventory）

> 所有「evidence 不足时，通过值的形状猜测它代表什么」的位点。它们表面各异，根因同构。

| # | 反模式 | 位置 | 猜了什么 | 为何错误 | 严重度 |
|---|---|---|---|---|---|
| G1 | `page_num_str.startswith('0')` | `import_batch_manager.py:1132-1142` | 字符串首字符 `'0'` → 判定 0-based 透传，否则默认 1-based 做 `-1` | 用字面形状推断 base；数字/非数字静默降级为 0 | 🔴 |
| G2 | `min(page_num)==0 → 0-based else 1-based` | `invoice_assembly_pipeline.py:126-166` | 组内最小页码是否 0 决定整组 base | 单页无法区分 0/1-based 时靠值形状赌 | 🔴 |
| G3 | `page.get('page_num') or page.get('page_index') or 0` | `invoice_assembly_pipeline.py:205` | OR 链兜底，合法 `page_num=0` 被吞 | M6：or 链把合法 0 当 falsy 丢弃 | 🔴 |
| G4 | `pageNum ?? 1` | `DisplayAdapter.jsx:96`、`DocumentStore.js:150` | `null` → 当作第 1 页 | base 正确（1-based），但**把「证据缺失」与「单页」混为一谈**（M1-b §3.1 三态混淆）；当前因 base 巧合正确而良性，证据模型一变即爆 | 🟡 |
| G5 | `pageCount || 1` | `PrintPreviewModel.js:348`、`PrintTask.js:120`、`useRenamePack.js:155` | 未知页数 → 1 | `PrintPreviewModel` 从 FileObj 取（D6 缺陷），**造成 OFD 多页永不展开**实链后果 | 🔴（PrintPreviewModel）/ 🟡（其余） |
| G6 | `(pageNum ?? 0) + 1` | `usePreview.js:247,635,1311,1358,1602,1669` | 默认 0-based，+1 转 1-based 展示 | **D20 误声明**：生产 pageNum 已是 1-based，+1 → 真实拆分页整体 off-by-one；6 处同源 | 🔴 **最高优先 · 静态 contract violation**（runtime 仅确认用户可见症状 / 是否 fallback 掩盖） |
| G7 | `(pageNum ?? 0)` 排序/比较 | `useFileOps.js:806`、`usePrint.js:575`、`buildPrintExecutionPlan.js:152`、`docFacts.js:108`、`invoiceDocumentViewModel.js:77` | 缺失 → 0 参与排序 | 排序/去重只要求**自洽**不要求**正确**；base 中途变更时**无失败信号**（M1-b §2.2 组 2 机制） | 🟡（隐性漂移源） |
| G8 | `docId ?? id ?? key` | `identity.js:64`、`composePagePlan.js:25,40`、`documentEngine.js:40,205`、`parseResultMapper.js:71`、`usePreview.js:1855` | 身份缺失时按值形状 fallback | **Identity resolution guessing**（M3 邻接反模式）；与 G1–G7 共享「值形状补洞」思想但**非 Page-base guessing**，不计入 M1-c 关闭条件 | M3 交叉引用（邻接） |
| G9 | 数组下标 → page identity | `printAdapter.js:74`、`docFacts.js:202`、`buildPrintExecutionPlan.js:311,327`（`pageIndex: 0` 硬编码） | 用数组位置冒充页身份 | M5：位置 ≠ 身份；`buildPrintExecutionPlan:311,327` 硬编码 `pageIndex:0` 致下游 5 处各自重算（Migration Audit 主链断裂） | 🔴（主链） |
| G10 | `(pageNum ?? 0) + 1 → buildPreviewUrl(?page=)` | `usePreview.js:1311,1358,1669` | 同上，且直接进渲染 URL | **N6 实链缺陷**：生产 1-based + 端点 1-based + `effectiveDocId` 指向父多页 PDF → 首页请求父 PDF 第 2 页，末页越界；**静态四环闭合，合同违就已确定** | 🔴 **最高优先 · 静态 contract violation**（runtime 仅确认用户可见症状 / 是否 fallback 掩盖） |

**猜测清单要点**：
- G1/G2/G3 是**后端 base 猜测**，G4–G10 是**前端 base / identity 猜测**。
- 它们分属 Page 域（G1–G7,G9,G10）与 Identity 域（G8）。**G8 是 Identity resolution guessing**，与 G1–G7 有共同的「值形状补洞」思想，但**不属于 Page-base guessing**，列为 **M3 交叉引用（邻接反模式）**，**不作为 M1-c 关闭条件**（避免污染 M1 边界、顺手清 Identity fallback）；正文保留其同构关系以供对照。G1–G7,G9,G10 的**根因**一致：evidence 不足时用值形状推断语义，正是 M1-b 抽出的「两套坐标系 + 反模式家族」的具体落点。
- **G6/G10（D20/C8）是本轮最高优先 Finding**——它们不是「待 runtime 验证才成立」的猜测，而是**静态确定的 contract violation**：1-based evidence 被一个显式声明为 0-based 的消费者再 `+1`。runtime 验证只用于确认最终用户看到的页面是否正确、以及 RE 失败是否经 fallback 把错误掩盖，**不应反过来决定该 Finding 是否成立**。G6/G10 是同一误声明（D20）的两种表现；G10 即 N6。

---

## 4. 跨域转换点目录（Cross-domain Conversion Catalog）

> 哪里发生了 Source↔Render 的 base 转换。判定「是否声明 + 是否正确」。

| # | 转换点 | 方向 | 声明? | 正确? | 备注 |
|---|---|---|---|---|---|
| C1 | `engine.py:418` `page_idx = max(0, page-1)` | URL 1-based → adapter 0-based | ✅ 注释讲清三件事 | ✅ | **Render 域范式**：声明每种 base 归属 + 唯一转换点（M1-b §1.4 表扬） |
| C2 | `DocumentStore.js:176` `index = pageNum - 1` | Source→Render（PDF 多页） | ✅ | ✅ | `isSinglePagePhysicalDoc ? 0 : max(0,pageNum-1)` |
| C3 | `DocumentStore.js:266` `renderPage = index + 1` | Render 内部 | ✅ | ✅ | 物理页 0-based → URL 1-based |
| C4 | `usePrint.js:208,210` `fetchPrintRaster(docId, page.index + 1)` | Render 内部 | ✅ | ✅ | `page.index` 是 0-based render locator |
| C5 | `previewResourceResolver.js:44,61,77` `pageNum = renderPage \|\| (index + 1)` | Render 内部 | ✅ | ✅ | renderPage 优先，fallback index+1 |
| C6 | `printAdapter.js:106` `resolvePrintUrl({index: pageNum - 1}, docId)` | transport 1-based → Render 0-based | 🟡 注释 `:33` 写 `?page=index+1` 与代码 `pageNum-1` 矛盾 | ✅ 代码正确 | 注释与实现反向，声明缺陷 |
| C7 | `useViewerState.js:78` `initialPage = fileObj.pageNum - 1` | Source 1-based → display 0-based | ✅（假设 1-based） | ✅ | **与 C8 直接矛盾** |
| C8 | `usePreview.js:247,1602` `(pageNum ?? 0) + 1` | 假设 0-based → 1-based | 🔴 误声明（D20） | ❌ 生产实际 1-based | 与 C7 冲突；off-by-one 根源 |
| C9 | `PageNavigator.jsx:72` / `PrintPreviewCanvas.jsx:181` `onJump?.(page - 1)` | display 1-based → internal 0-based | ✅ | ✅ | UI 跳转 |
| C10 | `buildSplitPageName` | Source→文件名 | 🟡 JSDoc `fileHelpers.js:77` 写 0-based，实产 `_p1` | 🔴（命名） | M1-b N2：用户可见文件名位移 + 三方名对齐不变式 |

**转换点要点**：
- 已声明且正确的转换（C1–C5）**全部在 Render 域或 Source→Render 单一归一点**。
- 真正有问题的转换是 **C8（usePreview 误声明）** 与 **C6/C10 的注释缺陷**——错误不在算术，而在**声明与实现不一致**，使下游无法信任 base。

---

## 5. 共同病灶（Common Root Cause）

把所有 G1–G10、D20、C8 归并，得到**唯一底层反模式**：

> **当 evidence 不足时，通过「值的形状」猜测它代表什么。**

五种具体形态（表面完全无关，本质同构）：

```text
pageNum ?? 1              → 用「是否 null」猜「是不是单页」
pageCount || 1            → 用「是否 falsy」猜「页数=1」
page_num_str.startswith('0') → 用「首字符」猜「base 是 0 还是 1」
docId ?? id ?? key        → 用「字段存在性」猜「身份优先级」
array position → page id  → 用「数组下标」猜「页身份」
```
> 注：G8 `docId ?? id ?? key` 属 **Identity resolution guessing**（M3 邻接反模式），非 Page-base guessing，不计入 M1-c 关闭条件；此处并列仅展示其「值形状补洞」思想与 G1–G7 同构。

这恰好就是 M1-b 的核心结论在**代码层**的投影：Source 与 Render 两套坐标系共用同名字段，而「猜测」是系统在 evidence 不齐时**下意识用值形状补洞**的本能。M1-c 的全部工作 = 把这些补洞点**显式声明化**（每个字段标 domain+base），并禁止在补洞点偷偷转换。

---

## 6. Resolver 准入门禁（Admission Gate）

> `resolveSourcePages(sourceDocument, pageEvidence) → SourcePageIdentity[]` **现在不能写**。
> 以下门禁全部满足后，它才会是「规范化器」而非「第 N 个 base 猜测器」。

| # | 门禁 | 当前状态 | 阻塞项 |
|---|---|---|---|
| R1 | 每个 Source evidence 字段有**显式声明 base**（无静默默认） | 🟡 部分 | D5 缺 JSDoc；D20 误声明；`import_batch_manager:986` 注释错 |
| R2 | 「证据缺失」与「证据=单页」**可区分**（三态，非二态） | ❌ | D6 `pageCount:1` 把未知伪装成已知；G4/G5 的 `??1`/`||1` |
| R3 | Resolver 输入不依赖 FileObj 单点（须能吃 DocumentStore evidence） | ❌ | `resolveSourcePage(fileObj)` 已正式否定（M1-b B3）；须 `resolveSourcePages(doc, evidence)` |
| R4 | 6 处 `(pageNum??0)+1`（G6/G10）在 Resolver 喂入前**先统一声明 base** | ❌ | 否则 Resolver 输出被二次偏移 |
| R5 | 后端 G1（`startswith('0')`）+ G2/G3（invoice_assembly_pipeline）猜测**改为显式 base 标签** | ❌ | Channel B 仍靠值形状赌 base |
| R6 | D19↔D20 / C7↔C8 的 **语义来源已裁决，Source→Display 转换点唯一化**（裁决「谁是什么」，非「大家都变成什么」） | ❌ | useViewerState(1-based,✅) 与 usePreview(0-based,❌) 直接冲突；裁决后正确态仍可为 `Source pageNum 1-based →(唯一转换)→ Viewer internal 0-based` |
| R7 | 跨域转换只在声明边界（照抄 C1 范式），禁止散点 `±1` | 🟡 部分 | C6/C10 注释缺陷；G6/G10 散点转换 |
| R8 | Resolver **禁止接收未标注 provenance 的裸 page number** | ❌ | 禁止 `resolveSourcePages(doc, {pageNum: 2})` 这类输入；须携带 `{value, field, domain, base, provenance}` 或由上游 evidence adapter 先完成声明再交给 Resolver（否则只是把 G6/G1 从 Resolver 内部挪到外部） |

**结论**：R1–R8 未满足前写 Resolver = 把猜测从消费端搬进 Resolver，徒增一层。**M1-c 的本职就是先把这些门禁逐个清单化并立 ticket**，而非急于实现。

---

## 7. M1-c 冻结核心模型（压缩规范）

经过 M1-a/b/c 三阶段，page 坐标系可被压缩为一句强规范：

```text
Source Identity
    └── sourcePageIndex : 0-based canonical

Render Locator
    ├── index      : 0-based physical locator
    └── renderPage : 1-based transport/API locator
```

证据 → 边界 → 规范化的两条独立通道：

```text
legacy evidence
    ↓
[显式声明其 domain + base]
    ↓
SourcePage normalization boundary
    ↓
SourcePageIdentity.sourcePageIndex

render locator
    ↓
[显式声明其 domain + base]
    ↓
Render boundary
    ↓
renderer / API
```

**两条 boundary 都存在，但不是一个 boundary。** 这正好解释：

- `engine.py:_render_page` 不该动（Render 域已正确归一）；
- `/split_pdf.page_index` 不该为「统一」而改成 0-based（它是 Source transport，可保持 1-based）；
- `DocumentStore.pages[].index` 不该改成 source page（它是 Render locator）；
- `SourcePageIdentity.sourcePageIndex` 可成为 Source 域 canonical（0-based）；
- Resolver 不能简单写成 `pageNum - 1`（那是第 N 个 base 猜测器）。

> **M1-c 核心句**：裁决的是「谁是什么」，不是「大家都变成什么」。
> 正确终态仍可以是 `Source pageNum 1-based →（唯一明确转换）→ Viewer internal 0-based`，
> 而非要求 D19/D20 两边都变成同一个 base。

## 8. M1-c → Resolver 交接 Gate

M1-c 视为完成（进入 Resolver 编码的前提），当且仅当：

1. §2 声明清单中每个 `🟡/❌/⚠️` 项已确权（声明正确 base 或立 remediation ticket）。
2. §3 猜测清单中每个 `🔴` 项已挂修复 ticket（**G1/G2/G3/G5/G6/G9/G10**；G8 不计入 M1-c 关闭条件，见 §3/G8）。
3. §4 转换点目录中 `🔴/🟡` 注释缺陷已修正（C6/C8/C10）。
4. §6 R1–R8 中至少 **R2/R3/R6/R8** 关闭（证据三态 + 输入模型 + 矛盾裁决唯一化 + 禁裸 page number），方可动笔写 `resolveSourcePages`。

**本轮只交付 inventory（§2–§6 + §7 模型 + 本门禁），不动代码、不建 Resolver、不提交。**

## 9. 声明 / 修复 Pass（M1-c 收口动作，仍不写 Resolver）

M1-c 冻结后，下一步是一个**很小的 declaration/remediation pass**，而非 Resolver 编码：

1. 给 **D1 / D5** 补真实 base 声明（`/split_pdf.page_index`、`fileObj.pageNum` 明确标注 1-based transport）。
2. 修正 **D20 / C8** 的错误 contract（`usePreview` 注释「0-based」→ 1-based；`(pageNum ?? 0) + 1` 改为 `pageNum` 透传或唯一转换点，消除 off-by-one）。
3. 修正 `import_batch_manager.py:986-989` 那条**错误的 0-based 注释**（称 page_num 0-based 与 /split_pdf 一致——而 D1 实际 1-based）。
4. 明确 **D3 / D4** 的 `page_index` 属于 Render / 内部物理定位表示，避免继续与 Source transport 同名混淆（命名解耦：如 `analyze_page_index` / `physical_page_index`）。
5. 给 **G1 / G2 / G3 / G5 / G9 / G10** 建 remediation ticket（G8 交 M3）。
6. 关闭 **R2 / R3 / R6 / R8**（证据三态、输入模型、矛盾裁决唯一化、禁裸 page number）。
7. **最后才允许写 `resolveSourcePages(sourceDocument, pageEvidence)`。**

第 7 点即本线纪律：现在确实还**不应该创建 `SourcePageResolver.js`**。最大风险不是算法写错，而是把尚未裁决的 provenance/base 语义偷偷固化进 API——那会比现在的散点问题更难拆。

## 10. 变更纪律核验

- ❌ 未修改任何生产代码
- ❌ 未创建 `SourcePageResolver.js` / `resolveSourcePages`
- ❌ 未 commit / 未 push
- ✅ 仅新增/修订本文档（inventory + 口径修正 + R8 + 冻结模型 + remediation pass）
- ✅ N6 仍作为独立 runtime-verification 跟踪项，未并入 M1-c 修复
