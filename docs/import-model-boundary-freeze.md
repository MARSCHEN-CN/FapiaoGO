# 导入模型边界冻结 + 验证矩阵 v3.1（2026-07-28 基线，2026-07-30 补 L/M/N/O）

> 目的：停止补丁式修复，冻结"导入分组 → Document 生成 → Duplicate 检测 → FileList 展示"的边界契约。
> 本文件为 **审计结论 + 待执行验证计划**，**不含代码改动**。
> 演进：`v1 双因子(sourceDocId+物理页序)` → `v2 三因子 + marker 序列优先` → `v3 补 4 个隐藏坑（page_num 不单独合并 / invoiceNumber 状态机 / DuplicateKey 加 sourceDocId / AssemblyResult 中间层）+ 案例 J/K + Step 顺序调整`。
>
> **v3.1（2026-07-30）增补**：补 L/M/N/O 四个场景的验收结论（见 §十四）。`L`=同内容文件隔离（docId 绑 file instance key，非内容哈希）；`M`=同路径重复导入幂等（Import Admission Gate 拦截）；`N`=同内容不同路径放行（得 2 个独立 Document）；`O`=生命周期隔离（删除文件后同路径可重新导入）。**探针清理**：移除 saga forensic 探针 `[PROBE]`/`[ASSEMBLY_ENGINE]`/`[ASSEMBLY_INPUT]`/`[ASSEMBLY-LOOP]`/`[ASSEMBLY_MATCH]`/`[ASSEMBLY_ADD]` 及 `[PROBE-1/2/3]`/`[PROBE-STATE]` 注释，删除死代码 `utils/multiPageInvoice.js`；保留冻结态既有可观测性 `[E1]`/`[ADD DOCUMENT]`/`[IMPORT_ADMISSION]`（本文验证方法论依赖之）。

## 一、三因子边界模型（冻结，v2 起稳定）

```
Physical File (PDF/OFD/Image)
   │  sourceDocId（物理来源边界，永不跨）
   ▼
PageResult[]   每个 PageResult 必须携带：
   │   sourceDocId, pageNum(物理), totalPages,
   │   invoiceNumber, pageMarker(第M页/共N页，含优先级)
   ▼
InvoiceDocument 边界由三因子共同决定
   │  ① sourceDocId  ⇒ 物理隔离（可否合并的硬边界）
   │  ② page sequence ⇒ 候选连续性（须用 page marker 序列，非物理 page_num）
   │  ③ invoiceNumber ⇒ 业务一致性（校验条件，非主键）
   ▼
DuplicateGroup   不同 sourceDocId + 同 invoiceNumber ⇒ 建组，不改 Document
   │
   ▼
FileList → DocumentViewer
```

**最终冻结句**：
> sourceDocId 决定物理隔离；page sequence 决定候选连续性；invoiceNumber 决定业务一致性。三者共同决定 InvoiceDocument 边界，**任何单一字段不得作为合并主键**。

## 二、为什么"双因子（sourceDocId + 物理页序）"不够 —— v1 的坑

若分组键直接定为 `sourceDocId + 物理 page_num 连续`，则：
```
A.pdf  page1=111(1/2)  page2=111(2/2)  page3=222(1/1)
```
物理页码 1,2,3 连续 → 会被错误合并成 1 个 Document(pages=3)。**这违背案例 C/H，暴露 v1 遗漏的关键维度：Document Boundary ≠ sourceDocId。**

同 PDF 内多张单页发票必须能拆成多个 Document。因此 page sequence 的"连续性"必须落在 **page marker 序列（第M页/共N页）**：
- p1 marker "1/2"、p2 marker "2/2" → marker 序列 1→2 连续 ⇒ 候选同票多页
- p2 marker "2/2" → p3 marker "1/1" → marker 序列断裂（2/2 之后不是 3/…）⇒ 关闭上一组、开新组 ✓

⚠️ **关键精度**：候选连续性判断必须 **marker 优先于物理 page_num**（是"marker 连续，否则回退物理"，不是"marker OR 物理"）。若用 `OR`，案例 I 会退化回错并。

## 三、Assembly 算法 v3（候选 + 校验两段式，含 4 坑修正）

```python
pages = store.get_pages(sourceDocId)
pages.sort(key=lambda p: p.page_num)   # 物理顺序仅用于稳定遍历

def seq_continuous(last_m, m, last_p, p):
    # marker 序列优先；两端都有 marker 时以 marker 为准
    if last_m and m:
        return m.current == last_m.current + 1 and m.total == last_m.total
    # 任一缺 marker → 回退物理 page_num 连续（D 级推断）
    # ⚠️ 坑1：物理连续只证明"相邻"，不证明"同票"（见 §5，须配合 invoiceNumber 校验）
    return p.page_num == last_p.page_num + 1

def invoice_state(last_no, cur_no):
    # 坑2：显式状态机，杜绝"空 = true"漏判
    if not last_no or not cur_no:
        return 'MISSING'            # 一端/两端空：低置信，允许合并但标记
    if last_no == cur_no:
        return 'MATCH'              # 同号：高置信合并
    return 'CONFLICT'               # 两端皆非空但不同号：禁止合并

current, groups = [], []
for page in pages:
    m = extract_page_marker(page)        # 优先级 A>B>C>D（见 §四）
    if not current:
        current.append(page); continue
    last, last_m = current[-1], extract_page_marker(current[-1])
    seq_ok = seq_continuous(last_m, m, last, page)
    state  = invoice_state(last.invoiceNumber, page.invoiceNumber)
    # 合并条件：序列连续 且 非冲突（MISSING 仍合并但低置信）
    if seq_ok and state != 'CONFLICT':
        current.append(page)
    else:
        groups.append(current); current = [page]
if current: groups.append(current)

# 校验每组并 emit AssemblyResult（见 §六 中间层）
for g in groups:
    if len(g) == 1:
        emit single InvoiceDocument(confidence='high')
    elif marker_complete(g) and invoice_consistent(g):
        low = any(invoice_state(a.invoiceNumber, b.invoiceNumber) == 'MISSING'
                  for a, b in zip(g, g[1:]))
        emit merged InvoiceDocument(
            confidence='low' if low else 'high',
            warning=low and 'invoice_number_missing')   # 坑2：漏号合并须告警
    else:
        # 序列/号码不全 → 保守不合并，逐页回退为独立 Document
        for p in g: emit single(p)
```

要点（对应 4 坑）：
- **坑1**：`seq_ok` 的物理回退只证明相邻，合并还必须 `state != 'CONFLICT'`；**page_num 永远不能单独成为合并理由**。
- **坑2**：`invoice_state` 显式 MATCH/MISSING/CONFLICT；`123+123=MATCH`→合并，`123+空=MISSING`→合并但 `confidence=low`+warning，`123+456=CONFLICT`→拆分。不再"空=true"。
- **坑3**：Duplicate 检测在 Document 层，key = `(invoiceNumber, sourceDocId)`（见 §五）。
- **坑4**：emit 前先生成 `AssemblyResult` 中间态（见 §六），错误/异常不直接污染 DocumentStore。

## 四、page marker 优先级（不要硬失败）

| 等级 | 来源 | 说明 |
|---|---|---|
| A | 结构化页码（系统已知页数 / 拆分元数据） | 最可信 |
| B | 文本页码（PDF/OFD 文本解析"第M页/共N页"） | **文本型无需 OCR** |
| C | OCR 页码（图片型 PDF 经 OCR） | 不稳定，需置信度 |
| D | invoiceNumber + sourceDocId 推断 | 仅当 A/B/C 全缺时兜底 |

**收敛规则（坑1 延伸）**：marker 缺失时 `page_num` 仅作"相邻"推断；OCR 不稳定（漏号/错号）时以 A/B 级结构化或文本 marker 为权威，C 级 OCR 结果仅作佐证。

## 五、DuplicateGroup 边界（坑3 修正）

**当前状态（gap）**：`documentViewModel.js:96` → `detectDuplicateInvoices(documents)`，而它（`utils.js:159`）按 `key = invoiceNumber` **单一字段**分组——**不含 sourceDocId**。在"OCR 重跑产生 `A_inv_123_v2`"等场景下存在误判风险。

**冻结目标**：
```
DuplicateGroup 成立条件：
   documentA.sourceDocId != documentB.sourceDocId
   AND documentA.invoiceNumber == documentB.invoiceNumber
   AND invoiceNumber 非空
```
- 同 sourceDocId（真多页发票，多页共享 1 个 sourceDocId）→ 1 个 Document → **不构成重复**（与"三页同号=1条"语义一致）。
- 不同 sourceDocId + 同号（案例 D：A.pdf 与 B.pdf 同 123）→ 2 个 Document → **重复组**。
- `invoiceNumber` 永不参与身份键（与 `documentViewModel.js:59` 既定原则一致）；加 `sourceDocId` 是"不同物理来源"的再保险。

💭 **待拍板（产品语义）**：若用户**重新导入同一份物理文件**（两次导入产生不同 sourceDocId、相同 invoiceNumber），按 `(invoiceNumber, sourceDocId)` 将**不**判定为重复；按现有 `invoiceNumber` 单键则会判定。是否需要在 Step 3 明确"重导入同文件是否算重复"？建议默认"不同 sourceDocId 即视为不同来源、不自动合并"，由用户在 UI 手动去重。

## 六、AssemblyResult 中间层（坑4，未来架构，非本次 Step 0/1 落地）

**动机**：当前 `PageResult[] → 直接 emit InvoiceDocument`，缺页/ OCR 冲突/ 页码异常等异常态会直接污染 DocumentStore。引入中间态，使错误状态可拦截、可人工确认、不入库。

```python
@dataclass
class InvoiceAssemblyResult:
    sourceDocId: str
    status: 'OK' | 'LOW_CONFIDENCE' | 'CONFLICT' | 'PARTIAL' | 'ERROR'
    groups: List[AssemblyGroup]      # 每个 group: pages[] + invoiceNumber + confidence + reason
    warnings: List[str]              # 如 'invoice_number_missing' / 'page_marker_drift'

# 消费方：仅 status in (OK, LOW_CONFIDENCE) 才 hydrate 为 InvoiceDocument；
# PARTIAL/CONFLICT/ERROR → 进"待确认"队列，不写 DocumentStore。
```

- 与矩阵案例 **F（缺页 1/3+3/3）** 直接关联：当前 `received=2 < total=3` 永不 emit（静默丢页）；引入后改为 `status=PARTIAL` 显式暴露，可补 partial-source 兜底或人工确认。
- 与 **J/K（号码漂移/漏号）** 关联：`LOW_CONFIDENCE` + warning 携带冲突证据，前端可选择性提示。

> ⚠️ 此层为**前瞻性架构约定**，本次 Step 0/1 不实现；Step 1 仅替换 `invoice_assembly_pipeline.py` 的 grouping engine（仍直接 emit，但算法遵循 §三）。在 Step 3 清理时一并评估是否落地中间层。

## 七、当前代码边界核对（审计结论）

### ✅ 已正确
| 边界 | 位置 | 状态 |
|---|---|---|
| 前端跨 sourceDocId 合并清零 | `useFileOps.js` `hydrateChunk`：`sameSourceFiles = matchingFiles.filter(f => (f.sourceDocId||f.docId) === assembled.sourceDocId)`；异源进 `crossSourceFiles → fallbackFiles`（per-file 独立 Document） | 已消除 |
| chunk 时序拆分防护 | `page_result_store.py:72-73` `completed = received >= total_pages`；`import_batch_manager.py:664` 仅当收齐才 `assemble` + emit `assembled_documents` | 已防护 |
| 同 PDF 不同票 → 2 Document（共享 sourceDocId 不合并） | `invDocId = ${sourceDocId}_inv_${invoiceNumber}`，不同票 ⇒ 不同 docId | 已满足 |
| Duplicate 在 Document 层 | `documentViewModel.js:97 detectDuplicateInvoices` 按 document 条目（同号 2 条=重复组） | 已满足（**但 key 仅 invoiceNumber，缺 sourceDocId，见 §五 gap**） |
| COMMITTED 门 | 后端 PageResultStore gate 隐式实现；前端靠 `hasAssembledDocs` 标志 | 基本满足（非显式 phase 机） |

### 🔴 唯一待冻结修复（"偶发拆分"真因 + v2/v3 修正）
`invoice_assembly_pipeline.py:98-105` 在单个 sourceDocId 内部仍按 `invoice_number` 主键分组：
```python
groups[invoice_number].append(page)
```
真实多页发票若 OCR 在两页读出不同发票号（p1=123 / p2=124）→ 拆成 `A_inv_123(pages=[p1])` + `A_inv_124(pages=[p2])` → 前端各自 fallback → 两个独立 Document = 拆分。
**v2/v3 修正**：分组主键改为 §三 三因子算法；`invoiceNumber` 降为校验条件（状态机）；文本 PDF 走文本解析页码（不 OCR）。落点在后端 `assemble()`，**前端不动**。

## 八、验证矩阵（仅看三个中间结果，不看 UI）

观察点：
- `assembled_documents`：`app.py:1704` 批量响应 `documents` 字段（现有 `[ASSEMBLY_INPUT]` 探针已 log `documents`）。
- `DocumentStore`：`getDocument` / `session.documents`（现有 `[E1]` 探针）。
- `documentView.documents`：FileContext（现有 `[FC-INVOICE]` 探针）。

| 案例 | 输入 | 期望 |
|---|---|---|
| **A** 同票 2 页 | B.pdf 两页同号 | 1 Document / pages=2 |
| **B** 同票 3 页 | 同号 3 页 | 1 Document / pages=3 |
| **C** 同 PDF 不同票 | p1=X, p2=Y | 2 Document |
| **D** 两 PDF 同号 | A123 + B123 | 2 Document + Duplicate |
| **E** 两 PDF 不同号 | A111 + B222 | 2 Document |
| **F** 缺页 1/3+3/3 | 3 页源缺第 2 页 | ⚠ 当前=0/丢页（received=2<total=3 永不 emit；待补 partial-source 兜底，见 §六） |
| **G** 追加导入同号 | 先 A123，再追加 B123 | 不合并，各独立 + 重复组 |
| **H** 同 PDF 多单页 | p1=111, p2=222, p3=333 | **3 Document（不可合并成 1）** |
| **I** 同 PDF 多页+单页混合 | p1=111(1/2), p2=111(2/2), p3=222(1/1) | **Document1(111,2页) + Document2(222,1页)** |
| **J** 号码漂移多页 | p1=111(1/2), p2=112(2/2) | **1 Document / pages=2 + warning: invoice conflict**（Step1 修复目标，验证 OCR 漂移不再拆分） |
| **K** OCR 漏号 | p1=111(1/2), p2=空(2/2) | **1 Document / confidence=low（MISSING 合并，不拆）** |

## 九、执行顺序（v4 — 添加 Step 0.5 Assembly Gate 修复）

- **Step 0（前端 Document boundary 验证）** ✅ 已完成
  - A（同源多页）→ PASS ✅
  - C（同源不同票）→ PASS ✅（关键证明：sourceDocId 不单独合并）
  - D fallback（不同源 → 两独立物理 doc）→ PASS ✅（基础物理边界成立）
  - **结论**：前端 sourceDocId boundary 修复（sameSourceFiles/crossSourceFiles 拆分）方向正确；但合并路径内的跨源隔离因后端组装门限无法在测试中触发（见 Step 0.5）。

- **Step 0.5（修复 Assembly Gate — 2026-07-28 已落地）**
  - **问题**：`import_batch_manager.py:651` 的 `page_num_str.isdigit() and total_pages_str.isdigit()` 将非 split_pdf 源的文件挡在组装管外，导致：
    - `assembled_documents` 永远为空
    - 前端永远走 fallback 物理 docId，**合并路径（含跨源隔离保护）永远无法被测试触发**
    - 验证矩阵 D 因此无法进入装配区
  - **修复**：移除 digit 硬门禁。所有带 `src_doc_id` 的页面无条件进入 PageResultStore。`page_num`/`total_pages` 缺失时默认 `page_num=0, total_pages=1`（独立单页语义）。加防御 `if page_num >= total_pages: total_pages = page_num + 1`。
  - **原则**（v3 第 3 条）：page marker 决定合并置信度，不应决定 PageResult 是否有资格存在。
  - **改动**：`backend/import_batch_manager.py` 第 648-694 行。
  - **验证**：D 重测应显示后端 `[InvoiceAssembly]` 行 + 前端 `_inv_` docId。

- **Step 1（修 backend assembly 三因子算法）**：仅解决"同 PDF 内 invoiceNumber OCR 漂移导致拆分"；用 §三 三因子算法替换 `groups[invoice_number]`；**不动 frontend**。

- **Step 2（backend 修完立即跑完整矩阵）**：**A / B / C / D(E) / H / I / J / K**，全部为 assembly 能力测试（H/I/J/K 验证边界，J/K 直接验证 Step1 修复目标）。D(E) 仍用"两不同源同号文件"。

- **Step 3（清理 + commit）**：
  - 代码清理：`multiPageInvoice.js` 死代码 + `useFileOps.js` 7 处 console.log + `ThumbnailStrip.jsx` hooks 修复 + `useFileOps.js` sourceDocId 边界 + `import_batch_manager.py` Step 0.5 门禁修复，一起 commit（push 由 UGit 接管）。
  - 模型收尾：§五 DuplicateKey 加 `sourceDocId` 的 gap 修复 + §六 AssemblyResult 中间层是否落地（与 §五 💭 重导入语义一并拍板）。
  - ✅ **已执行（2026-07-30）**：见 §十四。代码清理实际范围 = 删除 saga forensic 探针（`[PROBE]`/`[ASSEMBLY_*]` 及 `[PROBE-1/2/3]`/`[PROBE-STATE]` 注释）+ 死代码 `multiPageInvoice.js`；**保留** `[E1]`/`[ADD DOCUMENT]`/`[IMPORT_ADMISSION]` 作为冻结态既有可观测性（原"7 处 console.log"中的这三类诊断日志未删，因本文验证方法论依赖）。

## 十、问题 1：`POST /import/batch/cancel` 404（非主线，cleanup race）

- 性质：前端 import 完成/卸载仍发 cancel，后端任务已 GC → 404。不影响主流程。
- **冻结语义**：cancel 请求"任务不存在"**不是失败**，是正常终态。建议后端返回：
  - `HTTP 204 No Content`（幂等删除语义），或
  - `200 { cancelled:false, reason:"already_finished" }`
- **前端不动**。不要改成"任务存在才成功"的错误判定。

## 十一、最终冻结契约（canonical）

```
InvoiceDocument creation contract:

A Document MAY contain pages iff ALL of:

  1. same sourceDocId
        AND
  2. page sequence forms a valid candidate chain
        (marker sequence preferred; physical page_num fallback only when marker absent,
         and NEVER as the sole merge reason)
        AND
  3. invoiceNumber consistency passes
        (MATCH or MISSING → merge; CONFLICT → split)

Otherwise:
  pages MUST NOT enter the same InvoiceDocument.
  They remain independent Documents and MAY participate in a DuplicateGroup.

DuplicateGroup contract:
  forms across Documents where (sourceDocId differs) AND (invoiceNumber equal & non-empty).
  Within one sourceDocId, multiple pages = one Document = never a duplicate.
```

## 十二、Step 0 验证操作手册（实测字段对照）

> 适用：矩阵 **A / B / C / D / E / G**（证明 frontend `sourceDocId` boundary 已正确）。
> H / I / J / K 属 Step 2（backend 修完才跑），本手册不涉及。
> 核心原则：**后端 `documents[]` ↔ 前端 `[E1]` 必须 1:1 对应；只看中间结果，不信 UI。**

### 1. 在哪看（两层）

| 层 | 看什么 | 怎么看 |
|---|---|---|
| **后端（ground truth）** | `assembled_documents` 数组 | ① 真机：浏览器 DevTools → Network → 过滤 `/import/batch`，找 `GET .../results` 响应里的 `documents[]`；<br>② 或后端终端日志 `[InvoiceAssembly] 组装完成: number=.. pages=..`（每个 sourceDocId 调一次 assemble，故跨文件会出多行） |
| **前端（被测对象）** | `[E1] addDocument` 探针 | 浏览器 DevTools → Console → 过滤 `[E1]`。`ImportSessionStore.js:197` 打印 `docId=.. pages=.. docsCount=..`，其中 `docsCount` = `session.documents.length`，即前端 DocumentStore 权威计数 |

⚠️ **不要看** `parseResultConsumer.js:44` 那个 `[E1] consumeParseResult`（那是解析消费，不是 Document 生成）。
⚠️ 上一轮提到的 `[FC-INVOICE]` 探针**当前代码已移除**，勿找。前端计数用 `[E1] docsCount` 代替，二者等价。

### 2. 后端 `documents[]` 真实字段（import_batch_manager.py:681）

```
{ sourceDocId, invoiceNumber, invoiceType, pageCount }
```
> 注意：后端 payload **没有** `pages[]`、也没有每页 sourceDocId。后端只看"几条 / 各几条页 / 各什么号"。

### 3. 前端 `[E1]` 真实字段（ImportSessionStore.js:197）

```
[E1] addDocument: docId=<sourceDocId>_inv_<invoiceNumber>, pages=<N>, docsCount=<M>
[E1] addDocument: dedup skipped docId=.. (已存在则跳过，不重复计数)
```
`docId` 格式 = `${sourceDocId}_inv_${invoiceNumber}`（见 §七）。**docId 由 sourceDocId 决定**——这是判定"是否跨源合并"的最硬证据。

### 4. 跑法（每案例隔离）

1. 案例间点**清空列表**（触发 `clearActiveSession`，见 e806b11c）→ 避免 session 残留。
2. **案例 G 不清空**（验证追加不合并）。
3. 导入后在 Console 过滤 `[E1]`，数 `addDocument` 调用次数 + 读 docId + 看末尾 `docsCount`。
4. 如需对照后端：同窗口开 Network 抓 `GET .../results` 的 `documents[]`。

### 5. 各案例预期（三层对照）

| 案例 | 后端 `documents[]` | 前端 `[E1]` | PASS 判据 |
|---|---|---|---|
| **A 同票2页** | `[{sourceDocId:B, invoiceNumber:123, pageCount:2}]` | 1 条：`docId=B_inv_123, pages=2`，`docsCount=1` | 后端1条 ↔ 前端1 doc pages=2 |
| **B 同票3页** | `pageCount=3` | `docId=B_inv_123, pages=3`，`docsCount=1` | 同上 |
| **C 同PDF不同票** | `[{A,X,1},{A,Y,1}]`（共享 sourceDocId=A） | 2 条：`A_inv_X`/`A_inv_Y` 各 pages=1，`docsCount=2` | 共享 sourceDocId **但拆 2 doc**（不合并） |
| **D 两PDF同号** | `[{A,123,1},{B,123,1}]`（sourceDocId 不同） | 2 条：`A_inv_123`/`B_inv_123` 各 pages=1，`docsCount=2` | **2 doc + 重复组标记**；**绝不能**出现 1 条 `A_inv_123 pages=2` |
| **E 两PDF不同号** | `[{A,111,1},{B,222,1}]` | 2 条：`A_inv_111`/`B_inv_222` | 2 doc，无重复组 |
| **G 追加同号** | 先 `{A,123,1}`；追加后新增 `{B,123,1}` | 第一轮 `docsCount=1`；追加后新增 `B_inv_123`（`docsCount=2`），**不合并** | `docsCount` 1→2，无跨源合并 |

### 6. 成败的"一句话判据"

- ✅ **多页合并成功**：恰好 **1 条** `[E1] addDocument ... pages=N (N≥2)`，`docsCount=1`。
- ✅ **边界正确（未跨源合并）**：案例 D 出现 **2 条** `[E1]`，docId 分别为 `A_inv_123` 与 `B_inv_123`，每条 `pages=1`。
- 🔴 **边界失败（bug 复发）**：案例 D 只有 **1 条** `[E1]`，`docId=A_inv_123, pages=2` → 前端又把两个不同 sourceDocId 的文件压成 1 个 Document（即回到"一个 page 显示、另一个藏底下"）。

> 若 `[E1] docsCount` 未按预期增长，先查有无 `[E1] addDocument: dedup skipped`（同 docId 已存在→跳过），再查 `[IMPORT_ADMISSION]` 的 `skip duplicate path`（同路径被 Admission Gate 拦截）或 `[ADD DOCUMENT][gate-reject]`（缺分页标识走 per-file 独立 Document），定位是闸门误合并还是 deduplication 误跳。

## 十三、Step 0 实测结果（2026-07-28，用户真机）

| 案例 | 后端 `[InvoiceAssembly]` | 前端 `[E1]` | 结论 |
|---|---|---|---|
| **A 同票2页** | `number=2644...193859, pages=2` ✅ | 1 条 `6e2dd..._inv_2644... pages=2 docsCount=1` ✅ | **PASS** — 多页合并链路通 |
| **C 同PDF不同票** | 2 条 `pages=1`（共享 `56eb16fd...`）✅ | 2 条 `56eb16fd..._inv_2544...` / `56eb16fd..._inv_2532...`，各 pages=1，`docsCount=2` ✅ | **PASS** — 同 sourceDocId 但按发票号拆 2 doc（证明 sourceDocId 不单独合并） |
| **D 两PDF同号** | **空**（无 `[InvoiceAssembly]`）⚠️ | 1 条 `b20b16e0...`(物理 docId，无 `_inv_`) + `dedup skipped ... already exists` ⚠️ | **INCONCLUSIVE — 污染**：两"PDF"解析为同一物理 docId → 实为同一文件重复导入，触发 fallback+dedup，未测到跨源边界 |
| **G 追加同号** | **空** ⚠️ | 同 `b20b16e0...` + `dedup skipped`，`docsCount` 保持 1 ⚠️ | **INCONCLUSIVE — 同污染**：追加的是同一文件，测的是"重导去重"非"跨文件同号" |

### 关键证据解读
- **A/C 的 `[E1]` docId 带 `_inv_` 后缀** → 走的是 assembly 合并路径（useFileOps 合并分支），证明后端组装 + 前端合并路径正常工作。
- **D/G 的 `[E1]` docId 为 `b20b16e0a59175bc24879ce4`（无 `_inv_`）+ `dedup skipped`** → 后端未产出 assembled（fallback 路径 useFileOps:768-791 触发），且同一物理内容被导入两次被 ImportSessionStore:194 去重。**这测的是"同文件重导去重"，不是冻结模型 Case D（两不同文件同号）。**
- **结论**：前端 `sourceDocId` boundary 修复在 A/C 上已被验证成立；但修复的**首要目的**（阻止"不同 sourceDocId + 同发票号"被合并）**本次未被干净测试**——D 用了相同内容的文件。

### D 重测（第 2 次，17:37）——仍 INCONCLUSIVE（新原因：sourceDocId 未传入）

用户改用两个**内容不同**的文件重跑 D。后端 probe 显示 `src_doc_id='' len=0`（`source_doc_id` 从未写入 `job.metrics`）→ 根因：`app.py:1626` 的 `meta.get('sourceDocId') or ''` 返回了空字符串。

**修复**：加 `record.doc_id` fallback（`app.py:1626`），确保后端自产物理身份。

### D 重测（第 3 次，18:13）——PASS ✅（三部修复齐效）

修复全部落地并重启后端后：
- 后端：`[PROBE] src_doc_id='ba656243...' len=24` ✅ → `[InvoiceAssembly] 组装完成: number=25322...` ✅
- 前端：`[E1] docId=b20b16e0..._inv_25322...` + `[E1] docId=ba656243..._inv_25322...`，各 pages=1，`docsCount=2` ✅
- **跨源同号 → 2 个 `_inv_` doc，未合并，无重复。Case D 正式通关。**

### D 重测配方（不要拆 A；用两个内容不同但同号的单页 PDF）
> 用户 2026-07-28 17:30 复核：拆 A 有隐藏风险——拆分工具可能改变/丢失 marker 或 invoice metadata，测出的变成 OCR/marker 而不是 source boundary。改用：
- **方案1（最佳）**：找两张真实不同的单页发票，手动改金额/日期/购方信息使其发票号相同 → hash 不同、sourceDocId 不同、invoiceNumber 相同。
- **方案2**：复制同一页后改一个像素 / 加空白边 / 重新导出 → `sourceDocId(A) != sourceDocId(B)`，OCR 仍读同一发票号。
- **禁止**：把 Case A 的 2 页 PDF 拆成两个 1 页 PDF 当 D 测试。

跑法：清空列表后导入这两个文件。

**D PASS 标准（只看中间结果，不信 UI）：**
- 后端 `documents[]`：`[{sourceDocId:A,invoiceNumber:123,pageCount:1},{sourceDocId:B,invoiceNumber:123,pageCount:1}]`（两条、sourceDocId 不同、各 pageCount=1）。**绝不能**是 `[{sourceDocId:A,...,pageCount:2}]`。
- 前端 `[E1]`（探针已增强，见下）：**2 条** `docId=A_inv_123` 与 `docId=B_inv_123`，各 `pages=1`，`docsCount=2`。
- 随后 `documentView` 出现重复组（现有 `detectDuplicateInvoices` 按 invoiceNumber 分组，2 条同号 `_inv_` doc 即会成组）。

**过关硬指标**：2 条 `[E1]` 的 `docId` 必须**不同且都带 `_inv_`**、`sourceDocId` 字段不同、`invoiceNumber` 相同；绝不能是 1 条 `dedup skipped` 的物理 docId（那是同文件重导污染）。

### `[E1]` 探针已增强（2026-07-28 17:30）
`ImportSessionStore.js:addDocument` 现打印 `sourceDocId` + `invoiceNumber`（从 `docId` 按 `_inv_` 解析，只读、不调 store getter、不新增 import）。示例：
```
[E1] addDocument: docId=A_inv_123, sourceDocId=A, invoiceNumber=123, pages=1, docsCount=2
[E1] addDocument: dedup skipped docId=b20b16e0..., sourceDocId=b20b16e0..., invoiceNumber=-, already exists (pages=1)
```
> 注意：物理 fallback docId（无 `_inv_`）解析后 `invoiceNumber=-`，借此可与 `_inv_` doc 区分，直接识别"重导污染" vs "干净跨源同号"。D 干净测试必须 2 条都带 `invoiceNumber=<非零值>` 且 `sourceDocId` 不同。

## 十四、L / M / N / O 验证结论（2026-07-30 补，端到端真机 PASS）

> 背景：v3 矩阵止于 K。L/M/N/O 为导入"重复 / 隔离"语义的边界场景，全部基于 IS-4.2.1 Import Admission Gate（按归一化路径拦截）与三层身份（FileInstance → SourceDocument → InvoiceDocument）。

### L — 同内容文件隔离（docId 绑 file instance key，非内容哈希）
- **根因 bug**：原 `docId = ${sourceDocId}_inv_${invoiceNumber}`，同内容两文件 `sourceDocId` 相同 → docId 收敛 → 第二个文件被吞（不形成独立 Document/File）。
- **修复**：assembly 路径 `useFileOps.js` 改 `invDocId = ${repFile.key}_inv_${assembled.invoiceNumber}`（commit `e7c85970`）；fallback 路径 `effectiveDocId = fileObj.key`（commit `6d189ff8`）。
- **结论**：✅ PASS。同内容两文件得两个不同 docId，各自成 Document。

### M — 同路径重复导入幂等（不新增）
- **根因（M-1 长链）**：① 诊断日志出口断链——gate 三处日志用 `addImportLog`（仅写 React state，UI 不渲染），用户观测源是 DevTools Console，故"看不到 `[IMPORT_ADMISSION]`"；② 真正根因 `createSessionFile` 不保存 `printPath`（`ImportSession.js`），替换文件后 `session.files[i].printPath=undefined`，gate 比对空值永不命中。
- **修复**：① `console.log` 双写 + gate 入口常驻日志（commit `61d17a6f`）；② `createSessionFile` 加 `printPath: input.printPath || input.path || null`（commit `4fc998d3`）。
- **结论**：✅ PASS（2026-07-30 验证）。`gate enter: existingPaths=1, incoming=1` → `skip duplicate path` → `所有文件均为重复，导入已跳过`。

### N — 同内容不同路径（应放行，得 2 独立 Document）
- **结论**：✅ PASS，**无需改码**。① Admission Gate 按归一化 path 拦截，`useFileOps.js:334` 注释明写"不同路径同文件名应允许"，双路径互不碰撞；② backend `group_pages_into_documents` 对两页同内容单页：`page_num` 均 =0 → `_physically_consecutive = 0==0+1 = False` → 拆 2 组 → 2 Document；③ docId 已绑 file instance key（L 修复）。
- **真机验证（2026-07-30 17:58）**：两 `[ADD DOCUMENT][assembly]`，`sourceDocId` 同为 `932b5a1b...`（同内容，符合预期），但 `id` 不同（`..._1785405302736_66163961-...` vs `..._1785405311903_92adac75-...`，file instance key 的 `Date.now()+UUID` 不同）→ 2 个独立 Document，pages=1，无 skip 行。

### O — 生命周期隔离（删除后同路径可重新导入）
- **根因**：四个删除路径 `removeFile` / `removeFailedFiles` / `removeDuplicateFiles` / `removePreviousYearFiles` 只 `setFiles` 过滤 React state，**从不 prune `session.files`**；而 gate 的 `existingPaths` 由 `session.files` 派生 → `session.files` 单调只增不减 → 删除文件后仍永久拦截同路径重导入。
- **修复**：`ImportSessionStore.js` 新增 `removeFilesFromSession(sessionId, fileKeys)`（与 `addFilesToSession` 对称），四个删除点调用（commit `8f2b2d37`）。
- **真机验证（2026-07-30 17:53）**：`gate enter: existingPaths=0`（首次 A）→ `session files pruned: removed=1, remaining=0`（删 A）→ `gate enter` 再次 `existingPaths=0` 且无 skip 行 → A 重新准入。

### 探针清理记录（2026-07-30，随 M/N/O 收尾）
- **删除**（saga forensic 探针 + 死代码）：
  - backend `import_batch_manager.py`：`[PROBE] _on_job_done` logger.info（保留 `instance_id` 赋值，仍用于 `:683` 分桶键）。
  - backend `invoice_assembly_pipeline.py`：模块级 `[ASSEMBLY_ENGINE]` logger.info（import 期早于 basicConfig，结构性不可见）。
  - frontend `useFileOps.js`：`[ASSEMBLY_INPUT]` / `[ASSEMBLY-LOOP]` / `[ASSEMBLY_MATCH]` / `[ASSEMBLY_ADD]` 四处 console.log + `[PROBE-1]` / `[PROBE-2]` / `[PROBE-3]` / `[PROBE-STATE]` 注释。
  - frontend `utils/multiPageInvoice.js`：死代码（无调用点），`git rm` 并移除 `useFileOps.js` 的 import。
- **保留**（冻结态既有可观测性，本文验证方法论依赖之）：`[E1]`（ImportSessionStore / parseResultConsumer）、`[ADD DOCUMENT]`（useFileOps 三处）、`[IMPORT_ADMISSION]`（useFileOps gate）。
- **不在本次范围**：`[PRINT]` / `[Cache]` / `[ImportBatch]` / `[LineSegmenter]` / `[PdfExport]` / `[DIAG]` / `[Worker]` 等其它子系统的既有结构化日志，保持不变。
