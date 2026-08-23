# Preview Scheduler Contract v2 — 状态模型与回归矩阵（冻结）

> 依据：`PreviewScheduler-Contract-v2-RedTeam-Findings.md`（Direction A）。
> 本文件是 v2 唯一实施依据。状态模型已收敛，未写 usePreview.js。

---

## 1. 三层状态模型

### 1.1 Transaction — selection ownership

```js
{ key, version, snapshot }
```

职责：当前 canonical selection 是谁、哪个 version 拥有 commit 权、最新 snapshot 是什么。

### 1.2 Execution — snapshot consumer ownership

```js
{ id, key, version, phase, consumingSnapshot }
```

- `id`：execution identity（区分同一 transaction 下先后启动的多个 execution）
- `key / version`：绑定 transaction（ownership 判定的第二级）
- `phase`：`'loading'`（在 promotion loop 内 load）｜ `'post-load'`（load 已结束，在 docFacts/几何计算）｜ `'committing'`（进入 commit）
- `consumingSnapshot`：本 execution 当前正在 load / 处理的 snapshot（边界 freshness 判定用）

> 语义区分：`transaction.snapshot` = 最新真相；`execution.consumingSnapshot` = 当前正在处理的版本。
> `resolveBoundary` 的 freshness 判定即 `transaction.snapshot === execution.consumingSnapshot ? continue : restart`。

### 1.3 refresh pending / restart 语义

refresh 的核心动作**始终只有一件事：更新 `transaction.snapshot`**。随后按 execution 状态决定：

| 当前 execution | refresh 后动作 | 是否新建 execution |
|---|---|---|
| `null`（idle） | 更新 snapshot → `start-execution` | ✅ |
| `loading` | 更新 snapshot，当前 loop 的 shouldReload 消费 | ❌ |
| `post-load` | 更新 snapshot → `restart-required` | ❌ |
| `committing` | 更新 snapshot → `restart-required` | ❌ |
| key/version 不匹配 | `ignore` | ❌ |

**关键原则（Gap A 冻结）：**
- `start-execution` **仅当「当前 transaction 不存在有效 execution consumer」时允许**：即 `execution === null`，或现存 execution 不绑定当前 `{ key, version }`。执行层若发现残留的旧 transaction execution，必须先按 ownership/termination 处理，不得形成两个有效 execution（INV-PS9 仍是硬约束）。
- `restart-required` 表示**由当前 execution 自己回 loading**，绝不 fork 出第二个 execution。

### 1.4 Execution Transition Contract（Gap B 冻结）

```
loading
   │ loadFilePreview resolves
   ▼
post-load
   │
   ├── boundary = continue → docFacts / geometry
   ├── boundary = restart  → loading（same execution.id，消费最新 snapshot）
   └── boundary = abort    → terminated
        │
        ▼
committing
   │
   ├── continue → commit → terminated
   ├── restart  → loading（same execution.id）
   └── abort    → terminated
```

**规则：只要 restart，`execution.id` 不变。** 新的 `execution.id` 只允许在「当前 transaction 无有效 execution」且 transaction 仍有效时，由 `start-execution` 创建。

### 1.5 Loading Loop 语义（Direction Y 冻结）

`consumingSnapshot` 是**唯一 freshness 基准**。loading 阶段不再用 `shouldReload` 局部变量（消除 W1 双轨）。每轮迭代统一：

```
loading iteration
    │
    ▼
loadFilePreview(execution.consumingSnapshot)
    │
    ▼
advanceLoadingStep(transaction, execution)
    ├─ terminate       → ownership 失效，execution = null
    ├─ next-iteration  → restart：同 id 回 loading，consumingSnapshot 晋升为 transaction.snapshot
    └─ post-load       → continue：结束 loading，进入 post-load
```

W1 与 W2–W4 从此共用同一套 freshness invariant（`resolveBoundary` + `advanceExecution`），
不再出现 `snapshotAtStart`（shouldReload 局部变量）与 `consumingSnapshot`（execution 字段）两轨。

---

## 2. 不变量

沿用 v1 的 INV-PS1~PS6，新增：

- **INV-PS7 — Latest Snapshot Eventually Commits**
  一旦 refresh 更新了当前 transaction 的 snapshot，就必须保证有一个 execution 最终用该 snapshot 重新 `loadFilePreview` 并 commit，无论 refresh 到达时 execution 处于 loading / post-load / committing / idle。

- **INV-PS8 — Ownership ≠ Execution**
  transaction ownership（selection 归属）与 execution liveness（是否有在途 loader 会消费 snapshot）是两个独立概念，不得用同一个 `previewTransactionRef != null` 表达。

- **INV-PS9 — Single Execution Per Transaction**
  对同一个 `{ key, version }`，任意时刻最多存在一个有效 execution consumer。

- **INV-PS10 — Restart Does Not Fork Execution**
  对仍有效的 execution，`restart-required` 必须由当前 execution 自身完成 restart（`execution.id` 不变、回 loading），不得为同一 `{ key, version }` 创建第二个并发 execution。

- **INV-PS11 — Commit Requires Fresh Consumption**
  任何实际 commit 前，必须确认 `execution.consumingSnapshot === transaction.snapshot`；否则不得 commit，必须 restart 或 abort。

---

## 3. 决策层函数契约

决策层纯函数（`previewScheduler.js`，Node 可测），执行层（`usePreview.js`）只消费其返回值，不自行推导。

### 3.1 保留（v1）

- `resolvePreviewTransition(transaction, version, event)` → `{ version, transaction, action }`
  action：`'start'`（select）｜ `'merge'`（refresh 匹配）｜ `'ignore'`（stale refresh）｜ `'invalidate'`

- `ownsTransaction(transaction, version, key)` → bool

- `shouldReload(transaction, snapshotAtStart)` → bool（⚠ v2 起 loading loop 不再以其为 freshness 真相，仅保留为底层检测）

### 3.2 新增（v2）

- `resolveRefreshExecution(transaction, execution, event)` → executionAction
  前置：`resolvePreviewTransition` 已判定 `action==='merge'`（transaction 匹配）。
  返回：`'update-snapshot'`｜`'restart-required'`｜`'start-execution'`｜`'ignore'`

- `resolveBoundary(transaction, execution)` → `'continue'`｜`'restart'`｜`'abort'`
  每个 await 边界后统一调用，一次同时表达 ownership + snapshot freshness 判定。

- `advanceExecution(execution, boundary, latestSnapshot)` → `PreviewExecution | null`
  boundary 判定后的 execution 状态转换：`'abort'` → null（terminated）；`'restart'` → 同 id 回 `loading`、`consumingSnapshot` 更新为 latest（INV-PS10）；`'continue'` → 原样返回。

- `advanceLoadingStep(transaction, execution)` → `{ action, execution }`
  loading loop 单轮推进（Direction Y）：`resolveBoundary` + `advanceExecution` 的统一封装，
  action：`'terminate'`｜`'next-iteration'`｜`'post-load'`。`consumingSnapshot` 是唯一 freshness 基准。

- `legacyResolveRefreshExecution(transaction, execution, event)` → `'merge-only'`（旧语义，仅供 Red 断言）

---

## 4. 回归矩阵 T1–T24

### Transaction 层（沿用 v1，已通过）

| # | 场景 | 期望 |
|---|---|---|
| T1 | select(A)→select(B) | ++version，B supersede A，A 不得 commit |
| T2 | select(A)→select(A) 同 key 点击 | ++version（INV-PS3），第一次 A 作废 |
| T3 | refresh(A-resolved) 同 key 晋升 | merge，不 ++version（INV-PS1），snapshot 更新 |
| T3-red | legacy 在 refresh 时 ++version | 证明旧缺陷 |
| T4 | 多次 refresh 合并 | 只保留最新 snapshot |
| T5 | select(A)→select(B)→refresh(A) | ignore（INV-PS2），不 resurrect |
| T5-red | legacy 把 stale refresh 反向拉回 | 证明旧缺陷 |
| T6 | await 期间 select(B) | A 失去 ownership |
| T7 | 副作用前后 ownership | 前 owns / 后不 owns |
| T8 | snapshot 持续变化 | shouldReload 连续 true，稳定后 false |
| T9 | invalidate | ++version，transaction=null |

### Execution 层（v2 新增）

| # | 场景 | 期望 |
|---|---|---|
| T10 | **W5**：refresh 时 execution idle | `start-execution`；legacy 返回 `merge-only`（红） |
| T11 | **W1**：refresh 时 execution loading | `update-snapshot` |
| T12 | **W2/W3/W4**：refresh 时 execution post-load / committing | `restart-required` |
| T13 | **INV-PS9**：execution 存在且绑定同 (key,version) | 永不返回 `start-execution` |
| T14 | stale refresh（transaction 不匹配） | `ignore` |
| T15 | boundary：ownership 有效 + snapshot 新鲜 | `continue` |
| T16 | boundary：snapshot 已变（execution 消费的 ≠ transaction 最新） | `restart` |
| T17 | boundary：ownership 失效（supersede / invalidate） | `abort` |
| T18 | post-load refresh → restart | `execution.id` 不变、回 `loading`（INV-PS10） |
| T19 | restart 不 fork 第二个 execution | `advanceExecution` 返回同 id（INV-PS9/PS10） |
| T20 | committing 前 snapshot changed | `resolveBoundary` 返回 `restart`，禁止 commit 旧 snapshot（INV-PS11） |
| T21 | restart 后重新绑定最新 snapshot | `consumingSnapshot` 更新为 transaction.snapshot |
| T22 | **W1 第1轮**：loading 消费 placeholder、refresh resolved | `advanceLoadingStep` → `next-iteration`，同 id 晋升 `consumingSnapshot` |
| T23 | **W1 第2轮**：consumingSnapshot 已同步 resolved | `resolveBoundary` → `continue`（不伪 restart），`advanceLoadingStep` → `post-load` |
| T24 | loading 阶段 supersede / invalidate | `advanceLoadingStep` → `terminate` |

---

## 5. 最小实施边界

**允许：**
- `previewScheduler.js` 决策层（3.2 新增函数）
- 后续 `usePreview.js` 的 `doLoadPreview`（消费 3.2 决策）+ `clearCommitted` 置 null + 新增 execution ref
- 对应回归测试

**禁止：**
- 三个 effect 的业务判断逻辑
- `loadFilePreview` 内部
- Resolver / DisplayAdapter / OFD 渲染链 / 后端
