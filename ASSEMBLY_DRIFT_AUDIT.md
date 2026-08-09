# ASSEMBLY_DRIFT_AUDIT.md — Commit 4.0 只读审计

> 状态：**只读审计，未提交**（Commit 4.0 Audit）。不改代码、不入库。
> 日期：2026-08-02
> 范围：`page_num` / 多页 Invoice 聚合契约全链路（Producer → Transport → Consumer → Hydrate）
> **v1.1（2026-08-02，Commit 4.2a 后）**：修正 B2 表述（"退化默认 0"而非"恒 0"），并标记 B2 修复已完成（Commit 4.2a，`page_result_store.py` 复制注入 `page_num`）。

---

## 0. 结论速览

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| B1 | 🔴 | `page_num - 1` 归一化与 0-based 契约冲突，导致批量多页导入首两页 **store key 碰撞**，assembly 永不触发 | `import_batch_manager.py:771` |
| B2 | 🔴 | `page_num` 从未被注入页面 parse_result；production 页面 dict 无 `page_num` → `_page_num_key` 恒返回 0 → 无页码标记的"物理连续"分组回退失效 | `page_result_store.py:82` + `invoice_assembly_pipeline.py:101-103` |
| B3 | 🟡 | 单文件解析（`parseRunner`）不发送 `source_doc_id/page_num/total_pages` → Phase C 的 assembly 分支恒为死代码，单文件多页不聚合 | `parseRunner.js:48-64` vs `app.py:1226` |
| B4 | 🟡 | 完成判定仅看 `len(pages) >= total_pages`，缺页时永不到达 → 静默丢失整张发票 | `page_result_store.py:84-85,116,129` |
| B5 | 🟡 | `total_pages` 取"最后写入胜利"，同桶多页报告不一致时早期假设被覆盖 | `page_result_store.py:79` |
| B6 | 💭 | 测试全部手工注入 `page_num` 绕过 store 传输，**假绿**（B1/B2 未被任何集成测试覆盖） | `test_invoice_assembly.py:30`, `test_commit2_assembled_contract.py:29` |
| — | ✅ | hydrate 身份处理已是"页面身份来自后端"方向，未违反 Step 4 纪律 | `useFileOps.js:720-724` |

---

## 1. 现状：Assembly Contract

### 1.1 数据流（当前系统"多页 Invoice 靠什么聚合"）

```
                ┌──────────────────────────────────────────────────────────┐
                │  Producer：/split_pdf (app.py:900)                         │
                │  产出 pages[]，每页带 page_index（0-based，i ∈ range）      │
                │  例：{ page_index:0, page_id:"hash_0", page_bytes }        │
                └───────────────────────────┬──────────────────────────────┘
                                            │  page_index (0-based)
                                            ▼
   ┌─────────────────────── 前端 fileObj（buildFileObj, fileHelpers.js:23）──────────────────────┐
   │  pageNum = page_index（0-based；`?? null` 保留 0，不转 null，fileHelpers.js:50-51）          │
   │  sourceDocId = split_pdf 的 doc_id（内容哈希）                                              │
   │  instanceId = 前端生成的文档实例身份（IS-4.2）                                              │
   └──────────────┬───────────────────────────────┬──────────────────────────────────────────┘
                  │ 批量路径                         │ 单文件路径
                  ▼                                  ▼
   ┌────────────────────────────┐      ┌────────────────────────────────────┐
   │ runChunkedImport →          │      │ parseRunner.js → /parse_invoice     │
   │ createImportBatch           │      │ 仅发 file/autoOrient/mode           │
   │ 发 pageNum(0-based)/         │      │ 不发 page_num/source_doc_id         │
   │ sourceDocId/instanceId       │      │ （parseRunner.js:48-64）            │
   └────────────┬───────────────┘      └─────────────────┬──────────────────┘
                │ job.metrics['page_num']=str(pageNum)     │
                │ (import_batch_manager.py:520-523)        │ Phase C (app.py:1219)
                ▼                                            │ 读 request.form['page_num']
   ┌────────────────────────────┐                          │ 但前端没发 → isdigit()=False
   │ _buffer_with_assembly       │                          │ → 走 legacy 直写分支
   │ (import_batch_manager.py:764)│                         │ → assembly 永不触发（B3）
   │ _parse_page_info → page_num │                          ▼
   │ normalized = page_num - 1 ★ │                    legacy upsert_invoice
   │ (line 771) ★BUG B1          │                    （无聚合）
   │ store.put(bucket, norm, tp, │
   │   full_result)              │
   └────────────┬───────────────┘
                ▼
   ┌────────────────────────────┐
   │ PageResultStore.put         │  entry['pages'][page_num] = parse_result
   │ (page_result_store.py:48)   │  ★ 不回写 page_num 到 parse_result（B2）
   │ 完成判定 len>=total_pages   │  ★ total_pages 末写覆盖（B5）
   └────────────┬───────────────┘
                ▼ (completed)
   ┌────────────────────────────┐
   │ assemble(pages)             │  group_pages_into_documents
   │ (invoice_assembly_pipeline) │  _page_num_key = page.get('page_num')
   │                            │     or page.get('page_index') or 0
   │                            │  ★ production 两字段皆缺 → 退化默认 0（v1.1 修正：非"恒 0"，若 parser 未来产出 page_index 仍有效；B2）
   │                            │  _physically_consecutive 依赖 page_num+1
   │                            │  ★ 恒 False → 无标记多页被拆单（B2）
   └────────────┬───────────────┘
                ▼
   ┌────────────────────────────┐
   │ invoice_document_to_db_record│ → db.upsert_invoice
   │ + batch.assembled_documents │ → 前端 hydrateChunk 消费
   │   (含 pageClientKeys)       │
   └────────────────────────────┘
```

### 1.2 关键字段契约（本次审计锁定）

| 字段 | 生产者 | 值语义 | 备注 |
|------|--------|--------|------|
| `page_index` | `/split_pdf` | **0-based**（`i` in `range(page_count)`） | `app.py:982-986` |
| `pageNum`（前端 fileObj） | `buildFileObj` | **0-based**，透传 `page_index` | `fileHelpers.js:114,50-51` |
| `page_num`（store key） | `store.put` 第一个参数 | **0-based**（docstring 明示 `page_num: 页码（0-based）`） | `page_result_store.py:60` |
| `page_num`（assembly 读取） | `_page_num_key` | 期望页面 dict 携带 `page_num`/`page_index` | `invoice_assembly_pipeline.py:101-103` |
| `normalized_page_num` | `import_batch_manager.py:771` | `page_num - 1` → **-1-based（错误）** | ★ B1 |

---

## 2. page_num 漂移点三分类

### A. Producer（谁产生 page_num？）
- **唯一物理生产者**：`/split_pdf`（`app.py:900`）。循环 `for i in range(start, end)`，`page_index = i`，**0-based**。
- 没有任何 0/1-based 中途转换发生在 producer 内部。producer 输出稳定为 0-based。
- `page_num` 这个字段名在 producer 输出里其实叫 `page_index`；进入 `PageResultStore` 后才叫 `page_num`（作为 dict key）。这是第一组**命名漂移**：`page_index`（前端/transport）↔ `page_num`（后端 store/assembly）。

### B. Transport（字段有没有丢/错？）
- **批量路径**：`runChunkedImport.js:141` 发 `pageNum`（0-based）。后端 `import_batch_manager.py:520` 读 `fi.get('pageNum')` → `metrics['page_num']` = "0"/"1"/…（0-based 字符串）。✅ 传输未丢。
  - **但** `import_batch_manager.py:771` 在落 store 前做了 `normalized_page_num = page_num - 1`。这是**值语义漂移**：把 0-based 当 1-based 处理 → 得到 -1-based。← **B1 根因**。
- **单文件路径**：`parseRunner.js:48-64` 只发 `file/autoOrient/mode`，**完全不发** `page_num/source_doc_id/total_pages`。后端 `app.py:1226` 的 `page_num_str.isdigit()` 恒为 False → 跳过 assembly 分支走 legacy 直写。← **B3（Phase C assembly 死代码）**。
- **命名漂移**：后端 Phase C 读 snake_case `page_num/source_doc_id/total_pages`（`app.py:1222-1224`），而前端 batch 发 camelCase `pageNum/sourceDocId/totalPages`（`runChunkedImport.js:137-142`）。batch 路径靠 `job.metrics` 桥接（frontend camelCase → backend 在 `import_batch_manager.py:520-523` 重新取 camelCase），所以 batch 路径能通；但**单文件 Phase C 直接读 snake_case form，而前端 parseRunner 根本没发这些字段** → 单文件 assembly 无法触发。

### C. Consumer（PageResultStore 怎么用 page_num？）
- `put` 用 `page_num` 作为 `entry['pages']` 的 **dict key**（`page_result_store.py:82`）。
  - **重复时**：同 key 直接覆盖（dict 语义）→ 后写覆盖先写。这就是 B1 碰撞的落点。
  - **缺失时**：`page_num` 为 `None` 会抛 `TypeError`（`entry['pages'][None]` 虽合法作 key，但排序 `sorted(pages.keys())` 对 `None` 与 `int` 混合会抛 `TypeError`）。实际前端不会发 `None`（用 `?? null` 但空字符串走 legacy）。
- `get_pages` 按 `sorted(pages.keys())` 返回 → **顺序完全依赖 store key 的正确性**。B1 的碰撞会让 key 错位。
- **完成判定**：`len(entry['pages']) >= total_pages`（行 84-85 / 116 / 129）。是**计数**判定，不是"所有期望 key 齐备"判定。
  - 缺页（某页丢失）：计数永远不足 → 永不完成 → 整张发票静默不入库（**B4**）。
  - 碰撞（B1）：计数被"压缩"，同样永不到达。

---

## 3. 五个审计问题回答

### Q1. page_num 来源
- 物理唯一来源：`/split_pdf` 的 `page_index`（0-based）。
- 逻辑来源：batch 路径经 `runChunkedImport → job.metrics['page_num']`；单文件路径根本不传，Phase C assembly 因此不触发。
- **结论**：来源稳定、单一（0-based），但**在 Transport 的 batch 落点被错误 `-1`**。

### Q2. page_num 是否稳定
- producer 内稳定（0-based 不变）。
- transport 内：批量路径稳定但被 `-1` 改写；单文件路径缺失。
- **consumer 内：页面 dict 上根本不存在 `page_num`**（B2）→ assembly 侧读到的是 `0`，**完全不可靠**。
- **结论**：在"页面 dict 携带 page_num"这一契约层**不稳定/缺失**。

### Q3. 缺失时行为
- producer 不缺失。
- transport 缺失（单文件路径）→ Phase C 走 legacy，无聚合（B3）。
- consumer：若 `page_num=None` → `sorted(pages.keys())` 混合 `None`/`int` 抛 `TypeError`（潜在崩溃）；正常路径前端不传 None。
- assembly：`page_num` 缺 → `_page_num_key` 返回 0 → 排序退化为插入序、物理连续回退失效（B2）。
- 缺页 + 计数完成判定 → 整票静默丢失（B4）。

### Q4. 重复时行为
- **store key 重复 → dict 覆盖**（最后写入胜）。B1 下首两页同 key=0 → 第二页覆盖第一页。
- 因覆盖后 `len` 不增，与 `total_pages` 永不相等 → assembly 永不触发，且发票不入库。
- **这是当前最危险的行为**：批量多页导入在 B1 下表现为"看起来解析成功，但多页发票从未被聚合/存储"。

### Q5. identity 是否漂移
- **后端 assembly / store 层：无 identity 重猜**。store 以 `source_doc_id`（或 `instance_id`）为桶键，assembly 产出 `_inv_` 业务 docId，未出现 `doc.docId = assembled.docId` 式补救。✅
- **前端 hydrate（`useFileOps.js:720-724`）**：`fileObj.docId = item.docId`（每页物理 docId 来自后端返回）。这是**页面级身份**（后端已给出），不是按 invoiceNumber 反推 InvoiceDocument 身份 → **符合 Step 4 纪律（页面身份来自后端；InvoiceDocument 身份由 assembly 声明 `pageClientKeys` 供消费）**。✅
- **结论**：identity 未漂移；Commit 4 修复 B1/B2 时**不应**引入"hydrate 重新猜 identity"，只需让 `page_num` 在 store 边界可靠，assembly 即可正确分组，hydrate 继续消费 `instanceId + pageClientKeys` 即可。

---

## 4. 两个真实 Case 推演

### Case A：正常多页（3 页，page_index 0/1/2）
- **批量路径（当前代码，含 B1）**：
  - `pageNum` = 0/1/2 → `metrics.page_num` = "0"/"1"/"2" → `_parse_page_info` → 0/1/2 → `normalized` = 0/0/1。
  - `store.put` key：页0→0，页1→**0（覆盖页0）**，页2→1。
  - `entry['pages']` = {0: 页1, 1: 页2}，`len=2`，`total_pages=3` → `2>=3` False → **永不完成，assembly 不触发**。页0 数据丢失，发票不入聚合库。🔴
- **单文件路径（当前代码）**：parseRunner 不发 page_num → Phase C legacy 直写 → 三页各成独立发票（无聚合）。🟡

### Case B：漂移场景（page2 的 page_num=None）
- 假设某页 `pageNum=null` 到达后端：
  - 批量路径：`metrics['page_num'] = ""`（`import_batch_manager.py:522` `str(pn) if pn is not None else ''`）。`_parse_page_info`：`int("")` 走 `else 0` → `page_num=0`。`normalized=0`。→ 该页落入 key 0，可能与真实首页碰撞。
  - 单文件路径：Phase C `isdigit()` False → legacy，不参与聚合。
- **观察**：`page_num=None` 被静默归一为 0，不报错、不告警（仅 `_parse_page_info` 对 `page_num > total_pages` 有 warning，**对 None→0 无 warning**）。缺页信息被"吸收"，加剧 B4 的静默丢失。

---

## 5. Hydrate 专项（Step 4 确认）

- `hydrateChunk`（`useFileOps.js:656-790`）消费后端 `assembled_documents`：
  - 按 `instanceId` + `pageClientKeys` 精确匹配同实例页面（`resolveInstancePageFiles`，行 780），**不**按 invoiceNumber 全局收敛 → 避免"同号异票"被错误合并。✅
  - 每页 `fileObj.docId = item.docId`（行 722），item.docId 是后端返回的**每页物理身份**，非重新猜测。✅
  - 仅当 `assembled` 缺 `instanceId` 时回退 `sourceDocId` 过滤（行 782-784，已打 warn，不静默）。
- **Commit 4 红线**：不要在 hydrate 里加 `file.docId = assembled.docId` 之类"用 InvoiceDocument 身份反推页面"的补丁。正确方向是把 `page_num` 在 store 边界补实（B2），让 assembly 分组正确，hydrate 继续按 `instanceId + pageClientKeys` 消费。

---

## 6. 发现的完整问题清单

🔴 **B1 — batch 路径 page_num 碰撞（最高优先）**
`import_batch_manager.py:771`：`normalized_page_num = page_num - 1 if page_num > 0 else 0`
- 假设 1-based，实收 0-based → 首两页同 key，第二页覆盖第一页，计数永不达 `total_pages` → 批量多页发票 assembly 永不触发、页0 数据丢失。
- **修复方向**：契约已是 0-based（Phase C 直接 `int(page_num_str)`，store docstring 0-based），故应**删除 `-1`**，直接用 `page_num`。若执意保留 1-based 约定，则需同步把前端 `pageNum` 改为 `page_index + 1`（不推荐，会牵动 preview/DisplayAdapter 等 0-based 用法）。
- 影响面：仅 batch 导入路径触发 assembly（单文件路径因 B3 本就不聚合），故若当前 config 走 legacy `parseRunner`，B1 为**潜伏** bug；一旦启用 batch assembly 即爆发。

🔴 **B2 — page_num 未注入页面 dict，assembly 排序/分组退化**
- `page_result_store.py:82` 仅 `entry['pages'][page_num] = parse_result`，未 `parse_result['page_num'] = page_num`。
- 两条调用路径（Phase C `app.py:1235`、batch `import_batch_manager.py:790`）均未补写。
- `parse_invoice_service` 不产出 `page_num`/`page_index`（grep 确认无赋值）。
- 后果：`invoice_assembly_pipeline._page_num_key` 在 production `parse_result` 当前不携带 `page_num`/`page_index` 时退化为默认 0 → 无"第M页共N页"标记的多页发票在 `_physically_consecutive` 回退中恒 False → 被拆成单页发票；页面顺序完全依赖 `get_pages` dict-key 序（B1 下已被破坏）。
  - **v1.1 表述修正**：并非"所有情况下恒 0"。若 `parse_invoice_service` 未来产出 `page_index`，`_page_num_key` 仍可取之。准确描述为"production `parse_result` 当前不携带 `page_num`/`page_index`，故退化到默认 0"。
- **修复方向（Commit 4.2a，✅ 已完成）**：在 `store.put` 内用 `dict(parse_result)` 复制一页记录并注入 `page_num = page_num`（**复制而非原地修改** `parse_result`，避免污染 DB upsert/前端直写等其它消费者），使 assembly 拿到真实页码。

🟡 **B3 — 单文件 Phase C assembly 死代码**
- `parseRunner.js:48-64` 不发 `source_doc_id/page_num/total_pages` → `app.py:1226` `isdigit()` False → 永远走 legacy 直写。单文件多页发票不聚合。
- **需确认意图**：assembly 是否应覆盖单文件路径？若是，需在 `parseRunner` 补发字段（且字段名需与 Phase C 的 snake_case 对齐，当前是 camelCase 错配）；若否，建议显式注释"assembly 仅 batch 路径"，并评估单文件多页是否可接受丢聚合。

🟡 **B4 — 完成判定仅计数，缺页静默丢失**
- `page_result_store.py:84-85,116,129`：`len(entry['pages']) >= total_pages`。
- 缺页 / 碰撞时 `len` 永远不足 → 整票不入库、无告警。
- **建议（Commit 4.2）**：增加"全部期望 key 齐备"判定（如 `set(pages) == set(range(total_pages))`）或超时强制 flush + warn，避免静默丢失。

🟡 **B5 — total_pages 末写覆盖**
- `page_result_store.py:79`：`entry['total_pages'] = total_pages`（每次 put 覆盖）。多页报告不一致时早期值丢失。
- **建议**：首次写入即锁定，或取 `max`；并校验各页 `total_pages` 一致性，不一致打 warn。

💭 **B6 — 测试假绿**
- `test_invoice_assembly.py:30`、`test_commit2_assembled_contract.py:29` 手工 `'page_num': num` 注入到页面 dict，**绕过** `store.put` 不回写 page_num 的真实传输（B2），也**不经过** `store.put` 的 key 碰撞（B1）。
- 无端到端测试：`store.put(多页) → get_pages → assemble` 的真实链路未被任何用例覆盖。
- **建议（Commit 4 测试策略，见 §7）**：新增经过 `PageResultStore.put` 的真实集成测试，并对 B1 做"假绿证明"（注入 `-1` 旧逻辑 → 测试失败；正确逻辑 → 通过）。

---

## 7. 推荐的 Commit 4 拆分 + 测试策略

### Commit 4.1 — Transport 修复（B1）
- 目标：消除 batch 路径 `page_num - 1` 与 0-based 契约的冲突。
- 改动：`import_batch_manager.py:771` 改为 `normalized_page_num = page_num`（或直接用 `page_num`）。
- 必须配"假绿证明"测试：构造 2 页（page_index 0,1）→ `store.put` → `get_pages` 应返回 2 页且顺序正确；用旧 `-1` 逻辑时断言"仅 1 页 / assembly 不触发"为失败用例。

### Commit 4.2 — Store/Assembly 契约修复（B2/B4/B5）
- 目标：`page_num` 在 store 边界可靠；完成判定防御缺页。
- 改动：
  - `page_result_store.py:82` 前补 `parse_result = dict(parse_result); parse_result['page_num'] = page_num`（或调用方补，单一职责归 store 更稳）。
  - 完成判定增加"key 齐备"或超时 flush + warn。
  - `total_pages` 首次锁定 / 一致性校验。
- 必须配测试：经 `store.put` 注入真实 0-based 多页 → `assemble` 用 `_page_num_key` 正确排序/分组；**移除**测试里手工 `'page_num'` 注入，改为依赖 store 回写，验证 B2 修复。

### Commit 4.3 — 前端 Document registration（仅当 B3 确认需覆盖单文件）
- 若决定 assembly 覆盖单文件：在 `parseRunner.js` 补发 `source_doc_id/page_num/total_pages`（注意 snake_case 与 Phase C 对齐），并确认 `page_num` 为 0-based。
- 否则：显式文档化"assembly 仅 batch 路径"，评估单文件多页丢聚合的可接受性。

### 测试纪律（呼应你此前强调的"不假绿"）
1. 所有 assembly 测试**必须经过 `PageResultStore.put`**（真实传输），不得手工注入 `page_num` 绕过。
2. 对 B1 做"假绿证明"：保留旧 `-1` → 断言失败；正确逻辑 → 断言通过。
3. 新增 Case B（page_num=None / 缺页）用例，验证 B4 不再静默丢失（至少 warn + 可观测）。

---

## 8. 待你裁决的问题（进入 4.1 前）

1. B1 修复采用"删 `-1`"（推荐，贴合 0-based 契约）还是"前端改发 1-based"？
2. B3：assembly 是否应覆盖单文件路径？当前 Phase C assembly 分支是否确定为死代码（待清理或待接线）？
3. 当前 config（`config.js:38` `useNewImport`）默认走哪条？决定 B1 是潜伏还是已爆发。
4. 是否同意 4.1/4.2 各配"假绿证明"测试后再提交？
