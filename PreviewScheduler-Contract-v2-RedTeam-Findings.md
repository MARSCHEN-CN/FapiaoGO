# Preview Scheduler Contract v2 — Red-Team Findings

> 纯静态审计。依据 = 当前工作区 `frontend/src/hooks/usePreview.js` 真实实现（Step 3 未提交改动），
> 不依赖 Contract v1 文本或过往设计描述。不写代码、不修改 Step 3。

---

## 0. 审计核心问题

> **「transaction 仍然属于 A」≠「还有一个 execution 正在负责把 A 的最新 snapshot 渲染并 commit」。**

结论：**成立，且是系统性缺口，不止 idle-refresh 一处。**

---

## 1. 当前状态模型（代码事实）

`previewTransactionRef`（line 124）= 单一对象：

```js
{ key, version, snapshot }
```

三个字段的读写点与语义：

| 字段 | 写入 | 读取 | 实际承载语义 |
|---|---|---|---|
| `key` | start（1654） | ownsTransaction | selection identity |
| `version` | start（1654） | ownsTransaction | supersession token |
| `snapshot` | start（1654）/ merge（1646） | promotion loop `shouldReload`（1725） | 最新 fileObj |

**关键事实：`snapshot` 只有 promotion loop（1707–1730）的 `shouldReload` 会消费它。**
promotion loop 结束之后，没有任何代码再读 `snapshot` 去触发重新 `loadFilePreview`。

---

## 2. execution 生命周期（真实流程）

```
doLoadPreview(fileObj, intent):
  resolvePreviewTransition → action
  ├─ ignore → return null
  ├─ merge  → previewTransactionRef.current = {…, snapshot}；return null   ← 只更新 snapshot，不启动 execution
  └─ start  → ++version；previewTransactionRef.current = {key, version, snapshot}
              │
              ▼
        [merge mode 分支]（略）
              │
              ▼
        promotion loop（1707–1730）           ← 唯一会「重新 load snapshot」的地方
              │   loadFilePreview(snapshot) → await
              │   ownsTransaction check
              │   shouldReload ? → 回到循环头 reload : break
              ▼
        loadedFile 固化（= 最后一次 load 结果）
              │
              ▼
        rotation / geometry 计算（1738–…）
              │
              ▼
        await loadDocFacts（1784）→ ownsTransaction（1794）
              │
              ▼
        await saveDocFacts（1809）→ ownsTransaction（1811 / 1823）
              │
              ▼
        commit：cachedCanvas 分支（1881）或 normal 分支（1952）→ setPreviewFile(loadedFile)
```

**`loadedFile` 在 promotion loop 结束时固化，之后直到 commit 都不再变化。**

---

## 3. refresh 到达窗口状态矩阵

`refresh`（merge）唯一动作 = 更新 `snapshot`，不 `++version`、不启动 execution。
因此「snapshot 更新能否被消费」完全取决于 **execution 此刻是否停在 promotion loop 内**。

| 窗口 | execution 位置 | refresh 结果 | 是否漏洞 |
|---|---|---|---|
| **W1** | promotion loop `loadFilePreview` await 中 | 在途 loop 的 `shouldReload` 检测到变化 → reload | ✅ 正确 |
| **W2** | `loadDocFacts` await 中 | 1794 ownership 通过（key/version 未变）→ 继续用**旧 loadedFile** 计算并 commit | ❌ 漏洞 |
| **W3** | `saveDocFacts` await 中 | 1811/1823 ownership 通过 → 继续用**旧 loadedFile** commit | ❌ 漏洞 |
| **W4** | commit 前（cacheKey/分支判定） | 用**旧 loadedFile** commit | ❌ 漏洞 |
| **W5** | execution 已结束（idle） | merge return null，**无新 execution** 消费 | ❌ 漏洞（此前已确认） |

**根源统一**：`snapshot` 只在 promotion loop 内被消费。execution 一旦越过 promotion loop（W2/W3/W4）或已结束（W5），`refresh` 更新的 snapshot 就永久丢失——commit 的是「snapshot 更新前」的 loadedFile（对 OFD 即占位空壳）。

---

## 4. 已证实漏洞

### V-1：promotion loop 之后 refresh 静默丢失（W2/W3/W4）

`merge` 更新 snapshot 后，execution 在 `loadDocFacts`/`saveDocFacts`/commit 前不重读 snapshot，
ownership guard（`ownsTransaction`）只比较 key+version，二者在 refresh 下均不变 → 恒通过 →
commit 旧 loadedFile。违反 Contract v1 的 INV-PS4（Resolved Must Be Re-rendered）与 INV-PS6（Stable Snapshot Before Commit）。

### V-2：idle refresh 不重启 execution（W5）

`merge` 在无在途 execution 时只更新 snapshot 并 `return null`，没有任何机制启动新 execution。
这是 OFD Loading 的直接断点（空壳已 commit → 富态 refresh → 无人 load 富态）。

### V-3：invalidate 不清 transaction（`clearCommitted` 221–232）

`clearCommitted` 只 `previewVersionRef.current++`，**不置 `previewTransactionRef.current = null`**。
正确性靠 version 不匹配兜底（残留 transaction 的 `version=N` ≠ 当前 `N+1` → refresh 判 stale ignore），
但 transaction 对象残留是脏状态，语义上「selection 已失效」未被显式表达，未来任何只比较 key 的
新路径都可能误读这个幽灵 transaction。

---

## 5. 不变量缺口

Contract v1 已有的：
- INV-PS1（version = supersession）
- INV-PS2（refresh 不 resurrect）
- INV-PS3（显式点击 = select）
- INV-PS4（resolved 必须重渲染）
- INV-PS5（副作用前 ownership check）
- INV-PS6（snapshot 稳定才 commit）

**v2 缺失的不变量：**

> **INV-PS7 — Latest Snapshot Eventually Commits**
> 一旦 `refresh` 更新了当前 transaction 的 snapshot，就必须保证有一个 execution
> **最终用该 snapshot 重新 `loadFilePreview` 并 commit**。无论 refresh 到达时 execution 处于
> promotion loop、docFacts、commit 阶段，还是已 idle。

> **INV-PS8 — Ownership ≠ Execution**
> transaction ownership（selection 归属）与 execution liveness（是否有在途 loader 会消费 snapshot）
> 是两个独立概念，不得用同一个 `previewTransactionRef != null` 表达。

---

## 6. 状态机修正建议（二选一，供拍板）

### 方向 A：显式分离 ownership 与 execution（推荐，最清晰）

```
transaction  = { key, version, snapshot }          // selection ownership（不变）
execution    = { inFlight: bool, phase: 'promotion-loop' | 'docFacts' | 'commit' }
```

`merge` 语义改为按 execution 状态分派：
- `inFlight && phase==='promotion-loop'` → 只更新 snapshot（现状，shouldReload 消费）
- `inFlight && phase!=='promotion-loop'` → 更新 snapshot + 置「需重跑」；execution 在当前 await 后检测到、回到 promotion loop 重新 load
- `!inFlight`（idle）→ 更新 snapshot + **启动新 execution**（复用 load 逻辑，`version` 不变，不 supersede）

### 方向 B：扩展 snapshot 稳定性检查点（更小，但改动散）

不新增 execution 状态，把 `shouldReload` 检查从「只在 promotion loop」扩展到
`loadDocFacts` 后、`saveDocFacts` 后、commit 前——每个 await 后若 `snapshot` 变化，
`goto` promotion loop 重新 load。idle 场景仍需 merge 分支补「无在途则启动新 execution」。

两者都必须同时修复 V-3：`clearCommitted` 置 `previewTransactionRef.current = null`。

---

## 7. 最小实施边界

**允许：**
- `usePreview.js` 的 `doLoadPreview`（merge 分支 + promotion loop + ownership 检查点扩展）
- `previewTransactionRef` 增 execution 状态（或新增独立 ref）
- 决策层 `previewScheduler.js` 增「refresh 后是否需重启 execution」的纯函数判定 + 对应回归测试

**禁止：**
- 三个 effect 的业务判断逻辑（docId 晋升 / 引用替换 / 自动预览的触发条件）
- `loadFilePreview` 内部
- Resolver / DisplayAdapter / OFD 渲染链 / 后端

---

## 8. 结论

- 核心混淆（ownership vs execution）**成立**，且是 4 个窗口（W2/W3/W4/W5）+ 1 个脏状态（V-3）的系统性缺口，
  不是 idle-refresh 单点。
- 修复必须保证 **INV-PS7（latest snapshot eventually commits）**，而非继续在 merge 分支「更新 snapshot 后 return」。
- 建议采用方向 A（显式分离 execution state），一次性覆盖 W2–W5，避免方向 B 在多处 await 后散落检查点再次漏窗口。
