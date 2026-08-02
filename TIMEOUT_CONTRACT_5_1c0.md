# Timeout / Watchdog Contract Freeze — 5.1c-0

> 状态：**冻结设计，本 commit 不修改任何源码**。
> 基线 tag：`lifecycle-contract-v1` @ `036461b4`（5.1b-3b green）
> 上游契约：5.1b-2 终态分类（`completed_with_errors` / `missingPages` / `failedPages`）、5.1b-3a backend exposure、5.1b-3b frontend transport consume。

---

## 0. 本步明确不改（范围护栏）

- ❌ `backend/import_batch_manager.py`（除 5.1c-2 新增 watchdog，本步不动）
- ❌ `backend/parse_job_manager.py`（JobStore 字段扩展留 5.1c-2）
- ❌ `backend/page_result_store.py`
- ❌ `backend/app.py`（SSE）
- ❌ 任何前端文件

本步只冻结**语义、owner、状态转换、测试矩阵**。

---

## 1. 基线现实（只读审计结论，决定 freeze 是否可落地）

| 项 | 现状 | 对 5.1c 的含义 |
|---|---|---|
| `ParseJob` 时间字段 | 仅 `created_at` + `updated_at` | 无 `started_at`/`finished_at`/`heartbeat_at` |
| `updated_at` 语义 | 每次 `update_status` 都刷新（含 pending→running→terminal） | **无法区分"已创建"与"已开始运行"**，故"从 running 计时"必须新增 `started_at` |
| Job status 集合 | `pending/running/success/failed/cancelled` | `completed_with_errors` 是 **batch-only**（5.1b-2 引入），job 无此态 |
| `heartbeat` | backend 完全不存在 | "OCR 首次加载慢"须靠新字段/机制吸收，不能假设已有 |
| `_wait_for_completion` | 无限 `while True` 轮询，仅查 cancel flag，**无 timeout** | 单 job 卡死 → batch 永远 `running` → SSE 永不终端 → 前端 polling forever（即 5.1c 要填的洞） |
| `_TERMINAL_EVICT_HOURS` | 仅回收**已终态** batch（按小时） | 不处理 `running`，不是 timeout 机制 |

---

## 2. 三个 timeout 层级（独立 owner，互不越权）

### 2.1 Job timeout（单页任务）—— 精确层

**定义**：一个 job 在"运行态"停留过久仍无 terminal result，视为异常。

- **计时起点**：`started_at`（job 进入 `running` 时落盘）。**不**从 `created_at`/排队计时（避免惩罚正常排队）。
- **OCR 首次加载慢的宽容**：`started_at` 在 worker **实际开始处理**时设置（模型加载发生在 running 之前，被排队超时吸收，不计入运行超时）。
- **排队超时（补充）**：若 job 从未进入 `running`（`started_at` 为空）且 `now - created_at > JOB_QUEUED_TIMEOUT` → 也判超时（防止"永远 pending 从未调度"）。
- **需要的新字段（5.1c-2 落地）**：
  - `started_at`：status→running 时写入
  - `heartbeat_at`：worker 周期心跳 / progress 推进时写入（未来精细化用，本冻结先声明）
  - `timed_out: bool`：标记由 timeout 置 failed，供 `_on_job_done` 幂等守卫
- **Owner**：`ParseJobManager`（JobStore 是唯一权威）。watchdog 扫描 JobStore 中 `running` 且超时的 job。
- **超时动作**：`job.status = 'failed'`，`error = 'timeout'`，`timed_out = True`。
- **竞态裁决（冻结）**：worker 在 timeout **之后**才回报 success → **忽略，timeout 胜出**（保证契约确定性）。`_on_job_done` 在 5.1c-2 增加"已 terminal 则跳过"守卫。
- **分类结果**：该页成为 **FAILED 页** → 落入 `failedPages`（见 §3 Case A）。

### 2.2 Batch assembly timeout（整批兜底）—— 背板层

**定义**：一个 batch 等待所有 page 到齐过久，强制收尾。

- **计时起点**：`batch.started_at`（建议新增显式字段；若复用 `created_at` 作 proxy 须在 5.1c-2 注明）。
- **Owner**：`ImportBatchManager._wait_for_completion` 循环内（拥有 batch 上下文，能强制调 `_collect_batch_page_health`）。
- **触发条件**：`batch.status == 'running'` 且 `now - batch.started_at > ASSEMBLY_TIMEOUT`。
- **动作**：任何仍 `pending`/`running`（未 terminal）的 job → 经 JobStore 强制 flip 为 `failed(timeout)`，然后算 health →
  - 有 success → `completed_with_errors`
  - 全 failed/timeout → `failed`
- **与 2.1 的关系**：2.1 是逐页精确超时；2.2 是**兜底**——即使 JobWatchdog 漏掉某 job，整批也不会永久卡死。两层叠加，不冲突。
- **天然衔接 5.1b**：`missing = expected - success - failed`，timeout 页被标记为 `failed` → **永不进入 `missingPages`**（保护公式完整性）。

### 2.3 SSE idle timeout（前端观察者的连接层）—— 绝不越权

**定义**：客户端 SSE 连接多久没有进展。

- **Owner**：前端 `ImportBatchClient`（transport 层）。**不是 backend**。
- **触发**：SSE 流 `SSE_IDLE_TIMEOUT` 内未收到任何事件。
- **唯一允许动作**：`reconnect` 或 `close stream`。
- **铁律**：**SSE idle timeout 绝不调用任何会修改 batch 状态的端点**。SSE 是 batch 状态的纯观察者。
- **与 backend 解耦**：backend 有独立 Job/Batch timeout（§2.1/§2.2）；前端 idle 只关乎"连接健不健康"，不改变"业务是否完成"。

---

## 3. 终态转换定义（冻结）

优先级（沿用 5.1b-2）：`cancelled > failed(allFailed) > completed_with_errors(hasErrors) > completed`

```
running
   │  job timeout (部分页)         → completed_with_errors  (failedPages 列出超时页)
   │  job timeout (全部页)         → failed
   │  assembly timeout (兜底)      → 同上，分层叠加
   ▼
terminal (completed / completed_with_errors / failed / cancelled)
```

### Case A — 单页超时（用户裁决）
```
page0 success
page1 timeout   ← 视为 failed，非 missing
page2 success
```
→ `completed_with_errors`
→ `failedPages: [{sourceDocId, pages:[1]}]`
→ `missingPages: []`   ✅ 公式 `missing = expected - success - failed` 保持完整

### Case B — 整批全超时（用户裁决）
```
page0 timeout
page1 timeout
page2 timeout
```
→ `failed`（全 failed = `allFailed`）
→ `failedPages: [{sourceDocId, pages:[0,1,2]}]`

**关键不变量**：`timeout ≠ missing`。超时页一律归 `failed`，否则会破坏 5.1b 的 `missingPages` 公式语义。

---

## 4. Owner 矩阵

| 层级 | Owner 模块 | 读 | 写 |
|---|---|---|---|
| Job timeout | `ParseJobManager`（JobWatchdog） | JobStore | `job.status='failed'(timeout)`, `timed_out` |
| Batch assembly timeout | `ImportBatchManager._wait_for_completion` | JobStore + batch | flip 残留 job + `batch.status` |
| SSE idle | 前端 `ImportBatchClient` | SSE 流 | 仅本地 reconnect/close，**不写 backend** |

---

## 5. 5.1c-2 需新增的字段/常量（此处声明，本步不落地）

**ParseJob 新增**：`started_at: str`、`heartbeat_at: str`、`timed_out: bool`
**Batch 新增**：`started_at: str`（或明确复用 `created_at` proxy）
**常量**：
- `JOB_TIMEOUT`（running 上限，秒）
- `JOB_QUEUED_TIMEOUT`（pending 从未调度上限，秒）
- `ASSEMBLY_TIMEOUT`（整批兜底上限，秒）
- `SSE_IDLE_TIMEOUT`（前端连接 idle 上限，秒）

> 具体数值由 5.1c-2 依据实测 OCR 耗时标定，本冻结不绑定数值。

---

## 6. 测试矩阵（5.1c-1 红测试应锁）

| ID | 场景 | 期待 |
|---|---|---|
| T1 | 单 job `running` 超 `JOB_TIMEOUT` | 被 flip 为 `failed(timeout)`，`timed_out=True` |
| T2 | worker 在 timeout 后回报 success | job **保持** `failed`，late arrival 被忽略（timeout 胜出） |
| T3 | batch 一页超时、其余 success | `completed_with_errors` + `failedPages:[超时页]` + `missingPages:[]` |
| T4 | batch 全部页超时 | `failed` + `failedPages=all` |
| T5 | JobWatchdog 关闭时整批卡死 | `ASSEMBLY_TIMEOUT` 兜底仍强制收尾为 terminal（不永久 running） |
| T6 | 前端 SSE idle 超时 | reconnect/close，**backend batch 状态不变**（前端测试） |
| T7 | 超时页绝不进 `missingPages` | `missingPages` 不含任何 timeout 页（公式完整性） |

---

## 7. 超出范围（本步及后续明确排除）

- ❌ 任何 UI 行为（缺页 badge / 弹窗 / 自动重试 / 状态色）
- ❌ 修改 `ImportSessionStore` / `InvoiceDocument`
- ❌ 把 SSE idle 与 backend batch timeout 混为一谈（见 §2.3 铁律）
