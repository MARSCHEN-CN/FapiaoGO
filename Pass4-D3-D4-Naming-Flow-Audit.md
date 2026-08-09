# Pass 4 — D3 / D4 `page_index` 命名流只读审计

> **纪律**：只读、不改动生产代码、不建 Resolver、不提交。
> **目标**：先答四问（D3 producer/consumer、D4 语义域、D3→D4 数据流或独立、依赖名字 vs 数值的调用者），再决定最小 rename boundary。
> **核心禁令**：不得把 D3/D4 机械改名成 `sourcePageIndex`——那会重新制造 M1-b 已否定的 Source Identity ↔ Render Locator 混淆。

---

## 0. D1 / D3 / D4 三处 `page_index` 概要（来自 M1-c 冻结模型）

| ID | 位置 | 语义域 | base | 性质 |
| --- | --- | --- | --- | --- |
| **D1** | `/split_pdf.page_index`（`app.py:987` 唯一 emit） | Source transport | **1-based** | legacy SOURCE evidence（Pass 1 已声明） |
| **D3** | `PageInfo.page_index`（`multi_page_analyzer.py:98`） | **Render/Physical locator** | **0-based** | PDF 物理页位置（fitz `range(len(doc))`） |
| **D4** | `_extract_page(page_index)`（`invoice_parse_coordinator.py:142`） | **Render/Physical locator** | **0-based** | pypdf/fitz 物理页定位 |

> ⚠️ **重要校准**：M1-c 用户提案中曾试探「`analysisPageIndex` 如果确实属于分析域」。本审计实证结论：**D3 不属于分析域**——`PageInfo.page_index = idx` 中的 `idx` 直接来自 `for idx in range(len(doc))`（`multi_page_analyzer.py:94-98`），即 **PDF 物理页位置**，是 Render/Physical locator，不是分析派生值。因此若 rename，候选名应为 `renderPageIndex` / `physicalPageIndex`，**绝非** `analysisPageIndex` 也**绝非** `sourcePageIndex`。

---

## 1. 四问作答

### 问 1：D3 的 `page_index` 从哪里产生、在哪里消费？

**Producer（唯一）**
- `multi_page_analyzer.py:94-98`
  ```python
  for idx in range(len(doc)):              # fitz/doc 0-based 物理页位置
      ...
      info = PageInfo(page_index=idx)      # ← 赋值点
  ```
- 语义：`idx` 是 fitz 打开 PDF 后的 0-based 物理页码，无任何 Source/业务含义，纯 Render locator。

**Consumer（唯一链路）**
- `group_pages.py:91/96/100/104`：`page.page_index` 被读入 `current_group_indices`（构造 `InvoiceGroup.page_indices`）。
- `group_pages.py:131`：`_finalize_group` 把 `indices` 写进 `InvoiceGroup.page_indices`。
- 下游：`InvoiceGroup.page_indices` 被 `invoice_parse_coordinator.py`（见问 3）消费。

**结论**：D3 的 `page_index` 作用域完全封闭在后端内部（`MultiPageAnalyzer` → `group_pages` → `invoice_parse_coordinator`），**不触达 `/split_pdf` 的 D1 字段、不触达前端、不触达 DB 落库**。

### 问 2：D4 的 `page_index` 是否真的只表示 physical/render locator？

**是。** `invoice_parse_coordinator.py:142-147`：
```python
@staticmethod
def _extract_page(pdf_bytes: bytes, page_index: int) -> bytes:
    doc = fitz.open(stream=pdf_bytes, filetype='pdf')
    new_doc = fitz.open()
    new_doc.insert_pdf(doc, from_page=page_index, to_page=page_index)  # fitz 0-based
```
- `insert_pdf(from_page=, to_page=)` 是 fitz 的 **0-based 物理页定位**，与 D3 的 `idx` 同源同 base。
- 同文件 `:103 / :128`：
  ```python
  page_filename = f"{filename}_p{page_idx + 1}"   # +1 仅为人眼可读文件名（1-based label）
  ```
  `+1` 出现在**文件名字符串**里，与 locator 无关（人类标签，对应 Pass 1 D5 的「文件名 1-based label」语义）。

**结论**：D4 的 `page_index` 是纯 Render/Physical locator，0-based，契约正确，无需 ±1。

### 问 3：D3 → D4 是否存在实际数据流，还是两个独立同名变量？

**存在真实的、且正确的数据流**，不是同名巧合：

```
MultiPageAnalyzer                →  PageInfo.page_index (0-based, fitz 物理位置)
   ↓ (group_pages)
InvoiceGroup.page_indices       →  List[0-based 物理 locator]
   ↓ invoice_parse_coordinator.py:102 / :126-127
_extract_page(pdf_bytes, page_index)  ← D4, 0-based fitz 物理定位
```

- `invoice_parse_coordinator.py:102`：`page_bytes = self._extract_page(pdf_bytes, group.page_indices[0])` —— **D3 值直接喂 D4 入参**。
- 两侧同为 0-based fitz 物理位置 → **恒等透传（identity），无需任何 ±1**。

**结论**：D3 与 D4 是**同一个 0-based Render/Physical locator 链条的两段**，而非独立同名变量。这一发现直接决定 rename 策略（见 §3）：**若要 rename，D3 与 D4 必须保持同名（或显式成对的 `render→render` 名），否则会破坏「两者是同一 locator」的视觉/语义线索**。

### 问 4：哪些调用者依赖「名字」而非仅依赖「数值」？

| 调用者 | 访问方式 | 依赖名字？ | 备注 |
| --- | --- | --- | --- |
| `group_pages.py:91/96/100/104` | `page.page_index`（**属性**） | ✅ 依赖属性名 | rename `PageInfo.page_index` 会波及这 4 处 |
| `group_pages.py:131` | `InvoiceGroup(page_indices=...)`（**属性/列表**） | ✅ 依赖属性名 | rename `InvoiceGroup.page_indices` 波及 |
| `invoice_parse_coordinator.py:102/103/126/127/128` | `group.page_indices[...]`（**属性/列表**） | ✅ 依赖属性名 | D3→D4 数据流必经 |
| `invoice_assembly_pipeline.py:205` | `page.get('page_index')`（**dict key**） | ✅ 依赖键名 | ⚠️ **不同源**——见 §2 危险点 |

> **关键区分**：`invoice_assembly_pipeline.py:205` 的 `'page_index'` 是 **dict 键**，且通过 `page.get('page_num') or page.get('page_index') or 0` 与 `page_num` **OR 链兜底**（即 M1-c 的 G3 猜测器）。它访问的 `page` 是合并/store 层的 dict，其 `'page_index'` 键**不是** `PageInfo.page_index` 属性——很可能是不同来源塞进去的另一份 `page_index`（甚至可能是 D1 的 1-based 值）。
> **因此：对 D3 属性做 rename 不会自动修复 G3；G3 属于 Pass 5 的独立 remediation（provenance-aware），不应并入 Pass 4 的 rename。**

---

## 2. 危险点（必须单列，不并入 rename）

**G3 复燃风险**：`invoice_assembly_pipeline.py:205`
```python
def _page_num_key(page: Dict) -> int:
    return page.get('page_num') or page.get('page_index') or 0
```
- 把 `page_num`（Channel B 0-based）与 `page_index`（来源不明，可能是 D1 的 1-based 或 D3 的 0-based）当成可互换 fallback——**用键名猜语义**的反模式。
- 这恰是 M1-c G3 登记项。它与 D3/D4 的 `page_index` **同名但不同源**，是名字重载真正有害处的地方。
- **处理归属**：Pass 5 G3 remediation ticket，**不在 Pass 4 范围内**。若在 Pass 4 顺手改 G3，会把「命名解耦」与「base 猜测修复」重新耦合（你明确禁止的）。

---

## 3. 最小 rename boundary 候选（不预拍板具体名，仅定边界）

**原则（来自 M1-c 核心句「裁决谁是什么，不是大家变成什么」）**：
- D3/D4 同属 **Render/Physical locator（0-based）**，应统一命名为 render/physical 域，且 D3↔D4 段内**保持一致**。
- **绝对禁止**：`sourcePageIndex`（那会把 Render locator 误标为 Source Identity，`sourcePageIndex` 仅留给未来 Resolver 产出的 `SourcePageIdentity.sourcePageIndex`）。
- **也不要**：`analysisPageIndex`（D3 不是分析域，是物理 locator）。

**若执行 rename，安全的最小边界应同时满足**：
1. 同时改 `PageInfo.page_index` + `InvoiceGroup.page_indices` + `_extract_page(page_index)` 三者（保持 D3→D4 段内同名或显式成对）。
2. **不碰** `/split_pdf.page_index`（D1，1-based SOURCE transport，Pass 1 已声明）。
3. **不碰** `invoice_assembly_pipeline.py:205` 的 dict 键 `page_index`（G3，归 Pass 5）。
4. 文件名里的 `+1`（`:103/:128`）保持不动（它是 1-based label，与 locator 改名无关）。

**候选名（示例，待你拍板，非本项目强制）**：
```
PageInfo.page_index       →  physical_page_index   (或 render_page_index)
InvoiceGroup.page_indices →  physical_page_indices
_extract_page(page_index) →  _extract_page(physical_page_index)
```

**反向论证**：当前 D3/D4 共用 `page_index` 反而**正确地**表达了「两者是同一 0-based 物理 locator」；若改名不当（尤其 D3 改 D4 不改，或反之），会削弱这条恒等透传线索。所以**Pass 4 的产出可以是「建议保持 D3/D4 现状、仅收紧文档声明」，未必一定要 rename**——这取决于你对边际收益的判断。

---

## 4. 与冻结状态的关系

- 本审计**不改变** M1-c 判定基准表：`/split_pdf.page_index`(D1, 1-based) 与 D3/D4(0-based render locator) 是**不同通道/域**，彼此不统一 base 是正确的。
- 本审计**强化了** M1-b 结论：D3/D4 的 `page_index` 是 Render Locator，与 Source Identity 不能混名。
- **Resolver 继续冻结**（R2/R3/R6/R8 未关）；本审计不创建 `SourcePageResolver.js`，不写 `resolveSourcePages`。

---

## 5. 下一步 gate（Pass 4 收口条件）

Pass 4 只读审计完成。收口后两个可选方向（待你定）：
- **(A) 最小 rename**：按 §3 边界执行 D3/D4 三者成对改名（若你认为边际收益足够）。
- **(B) 仅补声明**：不 rename，仅在 `multi_page_analyzer.py:55` 与 `invoice_parse_coordinator.py:142` 各加一行 `[M1-c D3/D4 · frozen] 0-based RENDER/PHYSICAL locator，非 Source Identity` 注释，锁定语义——成本最低、风险最小。

无论 A 或 B，**G3（`invoice_assembly_pipeline.py:205`）必须留给 Pass 5**，不在本批次。
