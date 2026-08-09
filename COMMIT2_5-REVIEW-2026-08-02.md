# Code Review — Commit 2.5: InvoiceAssembly 多页明细完整性

**状态**：✅ 已实现 · 三项前置验证完成 · 已提交 `3d39a697` · 已 push `origin/master`
**边界**：与 Commit 2（DTO 字段传递）不同链路 —— 本 commit 修的是 **InvoiceAssembly 的明细合并策略**
**裁决**：保留改动、独立成 commit、不并入 Commit 2、不丢弃（用户定）

---

## 问题根因

多页发票的「字符级/OCR 明细通路」(`grid_to_excel_rows` 产出的 `line_items_excel_rows`，
中文键如 `税率/征收率`) 此前**不在 `_APPEND_KEYS`** 中。

`multi_page_merge.merge_page_results` 对未分类 key 采取「取第一页」保守策略，于是：

```
page1 (传统提取器):  line_items=[A,B],        line_items_excel_rows=[A,B]行
page2 (OCR 通路):    line_items=[C,D],        line_items_excel_rows=[C,D]行
                          ↓ merge（旧）
assembled:           line_items=[A,B,C,D],   line_items_excel_rows=[A,B]行  ← page2 丢失！
```

下游 `app.py:_db_record_to_export` 优先级：
`manual_corrections.line_items > line_items_excel_rows > 传统 line_items`
→ `line_items_excel_rows` 非空时**跳过** `line_items` → page2 明细与税率（含免税）全部丢失。

> 属于「Document identity 正确，但 document content 不完整」——比金额显示错更隐蔽。

---

## 修复

```python
_APPEND_KEYS = frozenset([
    'line_items',              # 项目明细（传统提取器）
    'line_items_excel_rows',   # 项目明细（字符级/OCR 通路，导出优先级更高）
])
```

merge 对 `_APPEND_KEYS` 做 `combined.extend(items)`（所有页、按页码序）→
`line_items_excel_rows` 现在 = `[A,B,C,D]行`，page2 不再丢失。

---

## 三项前置验证（按用户要求，未直接 commit）

### 1. 来源优先级 ✅
- `line_items` 与 `line_items_excel_rows` 现均为「所有页 append」；
- `line_items_excel_rows` 确认是**导出权威源**（`_db_record_to_export` 优先级已读码确认）。

### 2. 真实 fixture ✅（非手写假数据）
模拟 `parse_invoice_service` 输出结构（顶层 `amount`/`page_num`/`clientKey` + `extra_fields`
中英键并存），覆盖两种真实情形：
- 每页双通路：`line_items` + `line_items_excel_rows` 都有；
- `page2` 仅 OCR 通路、`page1` 无 `excel_rows`（最易暴露丢失的边界）。

### 3. 不变量锁 ✅（且证伪过）
```python
assert len(merged['extra_fields']['line_items_excel_rows']) == len(p1_rows) + len(p2_rows)
assert [r['项目名称'] for r in merged['extra_fields']['line_items_excel_rows']] == ['商品A','商品B','商品C','商品D']
```
**假绿检验**：临时把 `_APPEND_KEYS` 改回旧版跑测试 → `3/3 失败`（`2!=4`、`0!=2`）→
证明是真回归锁，非假绿。已还原修复。

---

## 测试与回归

- `backend/tests/test_commit2_5_line_items_merge.py`：**3/3 绿**
- 与 Commit 2 的 `test_commit2_assembled_contract` 合并运行：**8/8 绿**
- `test_invoice_assembly.py`（既有）：Case A-D **全绿**，无回归（`line_items` 旧行为未变）
- 测试文件被 `.gitignore` `**/tests/*` 忽略 → 延续 Commit 2 约定 `-f` 强制纳入

---

## 评审意见

### 👍 值得表扬
- 改动克制：只加一行到 `_APPEND_KEYS`，无新逻辑分支，复用既有 append 机制。
- 注释到位：点明「下游跳过 line_items」的连锁后果，后人一看即懂。
- 验证严谨：先证伪再提交，杜绝假绿（正是用户最担心的风险）。

### 💭 小注
- 导出权威源的"两条字段并存"问题（同时有 `line_items` 和 `line_items_excel_rows`）
  目前由 `_db_record_to_export` 的优先级隐式处理，未显式去重。若未来两条字段
  内容冲突，需在导出层明确裁决——但属导出层职责，不在本 commit 边界内。

### ⚠️ 另需你裁决：`backend/app.py` 一处 stray 改动
`app.py` 的 `__main__` 日志块被改为 `RotatingFileHandler` 写 `logs/backend.log`
（诊断用，正是本会话 `backend.log` 中「字符级通路诊断」的来源）。**与本修复无关**，
未纳入 Commit 2.5，保持未提交。建议：单独 commit 或丢弃。

---

## 下一步

- **Commit 3**：`selectDocumentRows` 收敛为 `DocumentSelector`（扩大 InvoiceDocument 消费者前，先把内容补全 ✓）
- **Commit 4**：`page_num` / Assembly 分组漂移修复
- 待决：`app.py` 日志改动单独处理
