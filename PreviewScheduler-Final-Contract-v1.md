# Preview Scheduler Final Contract v1

> 状态：**冻结待实施**（2026-08-22）
> 修复对象：**Preview Scheduler 生命周期缺陷**（非 OFD 特殊问题）
> 背景根因：同一 canonical file 的「占位 → 富态」晋升被误判为新 selection，多个 effect 重复调度 `handlePreview`，全局 version token 把同 key 请求彼此取消，导致 resolved RenderAsset 永不 commit（O2-R 运行时铁证：seq 10/11 双 A-input、12/13 B-output、无 C-setPreview）。
> 本文档是唯一实施依据。实施必须严格限定在下文「实施范围边界」内，禁止扩展。

---

## 1. Intent 映射表（逐调用点冻结）

Intent 表达**调用者语义**，不是「最终 key 是否相同」。

| # | 调用源 | 代码位置（usePreview.js） | Intent | 语义 |
|---|---|---|---|---|
| 1 | 首次无 preview → `files[0]` | :1979（effect-1） | `select` | 建立新 selection |
| 2 | 当前 preview 被删除 → fallback 文件 | :1996（effect-1） | `select` | 原 selection 已失效 |
| 3 | 用户点击文件 | handlePreview 入口 | `select` | **即使同 key 也视为显式 supersession** |
| 4 | prev / next 导航 | :2126/:2132/:2146/:2152 | `select` | 用户显式切换 |
| 5 | mergeMode 导致当前文件需重渲染 | :1955（mergeMode effect） | `refresh` | 保持 selection |
| 6 | docId `null → value` | :2042（effect-2） | `refresh` | placeholder → resolved |
| 7 | file object reference replacement | :2097（effect-3） | `refresh` | 同一 canonical file snapshot 更新 |
| 8 | 自动预览中的 merge 变化 | :2010（effect-1） | `refresh` | 当前 selection 重算 |

### 1.1 用户点击同一文件：冻结为 `select`

用户明确点击 =「现在重新处理这个 selection」，即使 key 没变，也允许 supersede 当前 transaction。
后台 docId 晋升 =「当前 selection 的对象状态变好了」。
**两者是不同的生命周期事件，不得混为同一种 intent。**

---

## 2. `refresh` 的严格规则

`refresh` **绝不能创建 selection、绝不能 ++version、绝不能替换 transaction.key、绝不能 resurrect 旧 selection**。

```text
refresh(A):
    当前 transaction = A   → 合并 snapshot（更新 transaction.snapshot）
    当前 transaction = B   → ignore
    当前 transaction = null → ignore
```

防倒退 invariant：

```text
select(A) → select(B) → stale refresh(A)
                             └→ 必须 ignore，不得把 A 反向拉回
```

---

## 3. Transaction 异步边界 ownership checklist

原则：**任何可能跨越控制权的 `await`，在继续执行 selection-dependent 副作用之前/之后，都必须重新验证 transaction ownership。**

已审计的异步边界（usePreview.js 单文件路径）：

```text
T0
│
├─ await loadFilePreview(snapshot)          (:1669)
│      ↓
│   CHECK ownership（version + key）
│
├─ snapshot 是否晋升？（引用比较）
│      ├─ yes → reload 最新 snapshot
│      └─ no  → 稳定，继续
│
├─ CHECK ownership（loadDocFacts 前）        (:1727 前，新增)
│
├─ await loadDocFacts(...)                   (:1727)
│      ↓
│   CHECK ownership                          (:1727 后，新增)
│
├─ selection-dependent state 计算
│
├─ CHECK ownership（saveDocFacts 前）        (:1748 前，新增)
│
├─ await saveDocFacts(...)                   (:1748)
│      ↓
│   CHECK ownership                          (:1748 后，新增)
│
└─ setPreviewFile / commit
       ↓
    FINAL CHECK ownership                    (:1875，已存在)
```

### 3.1 关键：副作用前也要 CHECK

`saveDocFacts` 之前必须 CHECK，否则：

```text
A await loadDocFacts → B select → A resume → A saveDocFacts（已产生 stale 副作用）
```

完整规则：

```text
await loadDocFacts
CHECK

CHECK（saveDocFacts 前）
await saveDocFacts
CHECK（saveDocFacts 后）
```

---

## 4. Snapshot promotion loop 正式语义

**不是「最多 reload N 次」，而是「只要同 transaction 的 snapshot 在当前 load 期间发生引用替换，就重新 load 最新 snapshot，直到 snapshot 稳定」。**

```js
let loadedFile = null
let stable = false
for (let attempt = 0; attempt < MAX_PROMOTION_RELOADS; attempt++) {
    const snapshotAtStart = transaction.snapshot
    const loaded = await loadFilePreview(snapshotAtStart)

    if (!ownsTransaction(version, key)) return   // superseded，禁止 commit

    if (transaction.snapshot !== snapshotAtStart) {
        continue                                  // 引用晋升，reload
    }

    loadedFile = loaded
    stable = true
    break
}
```

### 4.1 达到上限仍持续变化：**不 commit stale/unstable result**

```text
达到 MAX_PROMOTION_RELOADS 仍变化
→ abort 当前 transaction
→ 不发布 preview
→ 等后续 refresh / select 触发新 transaction
```

`MAX_PROMOTION_RELOADS` 是**防死循环保险丝**，不是业务语义。实施前按真实 `setFiles` 状态跃迁确认具体值（建议 3~5），不得作为「业务上允许 N 次晋升」的依据。

---

## 5. 最终核心状态机

| 当前 transaction | 事件 | intent | version | 结果 |
|---|---|---|---|---|
| `null` | 用户选择 A | select | ++ | 创建 A |
| A | 用户选择 B | select | ++ | A superseded，创建 B |
| A | 用户再次点击 A | select | ++ | A 当前 transaction superseded，创建新 A |
| A | A placeholder→resolved | refresh | 不变 | 更新 A snapshot |
| A | A ref replacement | refresh | 不变 | 更新 A snapshot |
| B | stale refresh(A) | refresh | 不变 | ignore |
| A in-flight | A snapshot changes | refresh | 不变 | transaction reload |
| A | 文件删除 / clear | invalidate | ++ | transaction 失效（clearCommitted :219） |
| A | 连续 refresh | refresh | 不变 | 合并最新 snapshot |

---

## 6. 实施范围边界（冻结）

**允许改动：**
- `handlePreview` 增加 intent 形参（默认 `select`）
- `doLoadPreview` 引入单一 `previewTransactionRef`（`{ key, version, snapshot }`）
- intent 分派（三态：select / refresh / stale-refresh）
- transaction snapshot promotion / reload
- ownership guard 补齐（见 §3）

**明确禁止改动：**
- ❌ OFD Render Engine 分支
- ❌ DisplayAdapter
- ❌ 三个 effect 的业务语义（仅在其调用点补 intent 传参）
- ❌ `loadFilePreview` 内部逻辑
- ❌ `resolveDocumentIdentity` / Identity Resolver
- ❌ 不再给 OFD 单独加分支

---

## 7. 回归矩阵（T1–T10，冻结）

### T1 — 正常 Selection Supersession

```
select(A) → transaction A / version=N
select(B) → version=N+1
A async result returns → 必须不得 commit
B result returns → 必须 commit B
```

验证：A 的 `setPreviewFile` 不发生；B 成为最终 preview；A 后续任何 selection-dependent commit 被 ownership guard 阻止。

### T2 — 同 key 用户显式重新点击

```
select(A) → version=N
select(A) → version=N+1
```

第二次点击是新的 `select`，必须 supersede 第一次 A transaction；第一次 A 的异步结果不得 commit；第二次 A 可正常 commit。**这是 intent 最易被误实现成 refresh 的 case，必须单独回归。**

### T3 — Placeholder → Resolved Promotion（本次根因 Case）

```
select(A-placeholder) → transaction A / snapshot=placeholder
refresh(A-resolved)   → version 不变，snapshot=resolved
placeholder load 返回 → 检测 snapshot 已变化 → reload resolved
resolved load 返回    → snapshot stable → commit resolved RenderAsset
```

验证：version 不增加；resolved snapshot 必须重新经 `loadFilePreview`；最终 commit 的是 resolved `loadedFile` 而非 raw snapshot；OFD WebP RenderAsset 最终发布。

### T4 — 同 key 多次 Refresh 合并

```
refresh(A1) refresh(A2) refresh(A3)  // 同 key 不同引用
```

不创建新 transaction、不增加 version、只使用最新稳定 snapshot、中间 snapshot 不覆盖最终结果。

### T5 — Stale Refresh 不得 Resurrection（Red-Team 补上的关键保护）

```
select(A) select(B) refresh(A)
```

`transaction.key===B`，version 不变，`refresh(A) → ignore`。A 绝不能创建 transaction / 增加 version / 覆盖 B / 重新触发 A preview。

### T6 — `loadDocFacts` 异步期间发生 Supersession

```
select(A) → await loadDocFacts(A) → select(B) → A resumes
```

A 在继续任何 selection-dependent 操作前失去 ownership；不继续 A 的 preview state commit；不产生 stale 副作用。

### T7 — `saveDocFacts` 前后的 Ownership（副作用前/后 CHECK 都锁进测试）

1. `saveDocFacts` 前已被 B supersede → A 不得执行 stale save。
2. `saveDocFacts` await 期间被 B supersede → 返回后 A 不得继续 commit。

### T8 — Snapshot 持续变化达到保险丝

```
A1 → load → A2 → reload → A3 → reload → … 超过 MAX_PROMOTION_RELOADS
```

不 commit unstable/stale result；不死循环；不错误提交最后一次未稳定结果。**测的是安全保险丝，非正常业务路径。**

### T9 — 删除当前 Preview

```
select(A) → A in-flight → delete A → clearCommitted()
```

version 失效；A 返回后不得 commit；fallback selection 存在则按 `select` 建新 transaction。

### T10 — OFD 实际根因回归（端到端 / UI，不依赖 Node 级 Scheduler 测试）

```
OFD import → placeholder preview → docId resolved → refresh → RE WebP ready → resolved RenderAsset commit → Display 收到 preview
```

验收：不再长期卡「加载中」。O2-R 原先的 `A-input(resolved) → B-output(url=Y) → 无 C-setPreview` 必须变为 `… → ownership valid → C-setPreview`。

---

## 8. 不可违反 invariant（INV-PS1～PS6，冻结）

- **INV-PS1 — Version Ownership**：`previewVersionRef` 只表示 selection supersession，不得因普通 refresh 增加 version。
- **INV-PS2 — Refresh Non-Resurrection**：`refresh` 只能更新当前同 key transaction；不匹配当前 transaction 的 refresh 必须 ignore。
- **INV-PS3 — Explicit Selection Wins**：任何用户显式点击都是 `select`，包括同 key 重点。
- **INV-PS4 — Resolved Must Be Re-rendered**：placeholder→resolved 后，resolved snapshot 必须重新经 `loadFilePreview(resolved snapshot)`，不得拿 resolved raw `fileObj` 直接替换 commit。
- **INV-PS5 — Ownership Before Side Effects**：所有跨异步边界后的 selection-dependent 后续操作必须重新验证 ownership；对可能产生 stale side effect 的异步操作，执行前也必须验证。
- **INV-PS6 — Stable Snapshot Before Commit**：只有 transaction snapshot 稳定时产生的 `loadedFile` 才允许 commit。

---

## 9. 实施顺序（TDD，冻结）

1. 先写三态 Scheduler 回归测试（T1–T9 Node 级）
2. 在旧实现上确认根因 Case（T3）能失败
3. 实施 transaction（§6 范围边界内）
4. 跑完整矩阵（T1–T10）
5. OFD UI 验证（T10）

---

## 附：已审计关键代码位置

| 符号 | 位置（usePreview.js） |
|---|---|
| `selectedFileKey` state | :66 |
| `previewVersionRef` | :121 |
| `clearCommitted`（++version） | :219 |
| `doLoadPreview`（++version） | :1624 |
| `loadFilePreview` await | :1669 |
| version guard（loadFilePreview 后） | :1671 |
| `loadDocFacts` | :1727 |
| `saveDocFacts` | :1748 |
| commit（cache 分支） | :1807/:1811 |
| commit（normal 分支） | :1876/:1880 |
| `handlePreview` | :1911 |
| `setSelectedFileKey` | :1916 |
| debounce（150ms） | :1919-1931 |
| `doLoadPreview` immediate | :1936 |
| effect-2（docId 晋升） | :2028-2044 |
| effect-3（引用替换） | :2065-2100 |
| mergeMode effect | :1953-1957 |
| 导航 prev/next | :2126/:2132/:2146/:2152 |
