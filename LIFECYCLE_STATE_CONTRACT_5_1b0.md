# Lifecycle State Contract — 5.1b-0（Design Freeze）

> **状态：设计冻结，非实现。** 本文件是 5.1b 实现与测试要遵循的契约。
> 本步**不修改任何代码**（`ImportBatchManager` / `PageResultStore` / SSE / frontend 一律不动）。
> 配套 checkpoint tag：`assembly-readout-clean-v1` → `23d61ef4`（= 2.7c）。
> 文档修订：2026-08-02 补充 §4.1 页面错误分类与 §4.2 全失败精确定义（实现前裁决检查）。

## 1. 背景（来自 5.1a 只读审计）

当前 `ImportBatchManager` 批次终态只有四种：`running` / `completed` / `failed` / `cancelled`。

Assembly 世界需要的语义比这更细。今天存在一个**错误业务含义**：

```
PDF 3 页
  page0 ✅
  page1 ✅
  page2 ❌ (永久缺失 / worker 抛错)

当前判定：finished == total  →  batch.completed
```

于是：
- 批次被标 `completed`（只要有别的页成功）；
- 那张发票**静默降级**为缺页残片、无合并、无 `MISSING_PAGE` 标记；
- `get_batch_results` 继续返回 2 条 item，amount 回退单页值；
- 前端不转圈，但用户拿到的是**数据不完整却显示成功**的结果。

根因（5.1a §5）：`_is_complete`（PageResultStore）能正确判定桶"不完成"（`{0,1} ⊄ range(3)`），但**这个信息无人消费**——没有终态承载"完成但有缺页"。

## 2. 冻结的状态模型（Batch status）

**保留：**
```
running
completed
failed
cancelled
```

**新增（仅一个）：**
```
completed_with_errors
```

**明确不新增（避免状态爆炸）：**
```
partial  ❌
degraded ❌
warning  ❌
```

> 理由：新增状态越多，前端/调度/重入的判定分支越乱。一个 `completed_with_errors`
> 足以表达"主流程结束但存在缺页/失败页"，细节用 `missingPages` / `failedPages` 数组承载。
> batch 状态表达「流程结果」，page 级问题表达「错误集合」，不把每种业务异常扩散成状态机分支。

## 3. BatchResult 契约（SSE `to_dict` / `get_batch_results` 输出）

```json
{
  "status": "completed_with_errors",
  "missingPages": [
    { "sourceDocId": "abc", "pages": [2] }
  ],
  "failedPages": [
    { "sourceDocId": "abc", "pages": [2] }
  ]
}
```

字段语义：
- `missingPages`：页面**从未被 buffer / 到达**（expected 页中既无 success job 也无 failed job 的页）。
- `failedPages`：页面**到达但 worker 抛错**（JobStore job `status == 'failed'`）。
- 同一页只可能归类其一（缺页 `或` 失败，不重叠；优先级 `FAILED > MISSING`，见 §4.1）。
- `completed` 状态：不携带这两个字段（或空数组），保持向后兼容。

## 4.1 Page error classification（页面错误分类，实现约束）

每条 page 的终态只能归类为以下之一，且分类来源必须明确——否则 failed page 会被错误并入 `missingPages`，直接违反 §3 契约。

```
SUCCESS : JobStore job.status == 'success'
          （权威来源 = JobStore 的每页 job 终态）

FAILED  : JobStore job.status == 'failed'

MISSING : expected pages - SUCCESS - FAILED
          其中 expected = set(range(total_pages))，按 source_doc_id / instance_id 归组
```

**优先级（同一页只归一类）：`FAILED > MISSING`。**
即某页既有 failed job、又因任何原因被算作 missing 时，归入 `FAILED`，绝不进 `missingPages`。

**集合关系（实现必须遵循）：**
```python
success_pages = { page_num | job.status == 'success' }
failed_pages  = { page_num | job.status == 'failed' }
missing_pages = expected - success_pages - failed_pages
```

> ⚠️ 实现注记（关键修正）：分类的权威数据源是 **JobStore**，而非 PageResultStore。
> 原因：`_buffer_with_assembly` 在每桶所有页收齐后会调用 `store.remove(bucket_key)`（assembly 完成即移除暂存），
> 因此**终态判定时刻，已干净完成的文档其成功页早已不在 PageResultStore 中**。
> 若用 `exists in PageResultStore` 判断 SUCCESS，则 Case 1（完整完成）会被误判为「全部 missing」。
> 故 §3 的 `SUCCESS` 必须取自 JobStore `status == 'success'`。PageResultStore 仅用于「未完成桶」诊断
> （`get_missing_pages`），终态判定点不作 success 依据。5.1b-2 的 `_collect_batch_page_health()` 应只依赖 `job_manager`。

## 4.2 「全失败」的精确定义

`failed` 终态的唯一条件：
```
所有 submitted pages 的终态 == 'failed'
即 failed_pages 集合 == 该批次全部 expected 页（failed_count == total）
```

**不是** `success_count == 0`。多页 assembly 场景下即使 `successCount > 0` 但仍有失败页，
应判 `completed_with_errors`，而非 `failed`。例如：
```
PDF A: page0 success, page1 failed
PDF B: page0 failed
⇒ successCount=1, failedCount=2 ⇒ completed_with_errors（不是 failed）
```

## 5. 流转规则（terminal-state 决策）

```
running
  │
  ├─ 用户取消 ─────────────────────▶ cancelled
  │
  ├─ failed_pages == 全部 expected 页（failed_count == total；
  │   注意不是 success_count==0）──▶ failed          (保持原语义，不变 completed_with_errors)
  │
  ├─ finished >= total
  │     │
  │     ├─ 每个 source doc 都 _is_complete
  │     │    且 无 failed page ──────▶ completed
  │     │
  │     └─ 至少一个 source doc 缺页
  │        或 至少一个 page failed ──▶ completed_with_errors
  │              ├─ missingPages = 缺页集合（按 sourceDocId 归组）
  │              └─ failedPages  = 失败页集合（按 sourceDocId 归组）
  │
  └─ (worker 挂死：5.1c 才定义 timeout → 此处暂不处理)

completed_with_errors 是终态，不再二次流转。
```

判定优先级（实现时务必按此顺序）：
1. `cancelled`（用户主动）
2. `failed`（全失败，见 §4.2）
3. `completed_with_errors`（完成但有缺页/失败页）
4. `completed`（干净完成）

## 6. 信息Owner链（从已有能力提升，非新建）

```
PageResultStore
  ├─ _is_complete()        ✅ 已存在（仅供未完成桶诊断）
  └─ get_missing_pages()   ✅ 已存在（诊断用）

JobStore（parse_job_manager）
  └─ 每页 job.status       ✅ 已存在（success / failed 权威来源）

        │  （5.1b 要做的事：用 JobStore 分类 + 缺失推导，汇聚成 batch 终态）
        ▼
ImportBatchManager
  └─ _collect_batch_page_health(batch, job_manager)   ← 5.1b-2 新增
  └─ 决定 completed vs completed_with_errors vs failed
        │
        ▼
SSE to_dict() / get_batch_results
  └─ 输出 status + missingPages + failedPages          ← 5.1b-3 扩展
```

> 关键纪律：**不新增状态机基础设施**，只在既有的"批次完成"判定点（5.1a 定位的
> `_wait_for_completion` 终态 flush / 完成分支）补一个"缺页/失败页汇总"步骤。
> 分类只依赖 `job_manager`（JobStore），不依赖 PageResultStore（见 §4.1 注记）。

## 7. 测试契约草案（供 5.1b 实现时落地为可执行测试）

| Case | 输入 | 期望终态 | 期望附加字段 |
|------|------|----------|--------------|
| 1 完整 | `pages={0,1,2}, total=3` | `completed` | 无 missingPages / failedPages |
| 2 缺页 | `pages={0,1}, total=3`（page2 无 job） | `completed_with_errors` | `missingPages=[{sourceDocId, pages:[2]}]` |
| 3 worker fail | `page2 job=failed` | `completed_with_errors` | `failedPages=[{sourceDocId, pages:[2]}]`（**不**进 missingPages） |
| 4 全失败 | 所有 page `job=failed` | `failed` | **不**变 `completed_with_errors` |

> 实现侧开放问题（5.1b 裁决，不阻塞本冻结）：
> - Case 3 的 `failed` page 是否同时进 `missingPages`？（约定：否，缺页/失败互斥，优先级 FAILED > MISSING。）
> - `sourceDocId` 归组：用 job metrics 的 `source_doc_id`（5.0 transport 已透传）；若缺失，fallback 到 `instance_id`。
> - `completed_with_errors` 是否带总数摘要给 UI？（5.1b 仅定义字段；UI 接线属后续步骤。）
> - 5.1b-3 需注意：`to_dict` 的 `status_map` 须加入 `completed_with_errors`，且下游 `TaskStatus(...)` / `_TERMINAL_STATUSES` 须识别该值（否则 SSE 流不认为是终态）。

## 8. 范围边界（本冻结明确排除）

- ❌ 不改 `ImportBatchManager` 任何方法体（5.1b 才改）
- ❌ 不改 `PageResultStore`（仅允许其既有 `get_missing_pages` 作诊断，不新增写入）
- ❌ 不改 SSE `to_dict()` / `app.py`
- ❌ 不改 frontend
- ❌ 不接 UI（不在本步消费 `completed_with_errors`）
- ❌ **不引入 5.1c timeout**（timeout 触发后必须落到某个 terminal state；而该 state 正是本契约定义的内容。顺序错则 timeout 只能造出无语义的 `failed`）

## 9. 后续顺序（用户裁定，不可乱序）

```
2.7c ✅ (23d61ef4)
  │
  assembly-readout-clean-v1 ✅ (tag)
  │
  5.1b-0 状态契约冻结 ✅ (本文件)
  │
  5.1b-1 新增 lifecycle 测试（先红，test_import_batch_lifecycle.py，4 case）
  │
  5.1b-2 实现 _collect_batch_page_health + terminal 分类（消费 JobStore）
  │
  5.1b-3 SSE/results 输出 completed_with_errors + missingPages/failedPages
  │
  5.1c timeout/watchdog（触发后落到 completed_with_errors / failed）
```
