# P2 修复设计 —— Preview Scheduler 状态机缺口（X1 / X2 / X3）

> 依据：R2 实机 dump（`outputs/perf-runs/preview-r2-8files-20260904.json`，79 events，8 PDFs）+ `PreviewScheduler-Contract-v2.md`（冻结）。
> 本轮**只钉测试契约与设计，生产代码零改动**。修复基线 = `e6bbb89`（trace 已清理）+ 其后 3 个纯 docs commit，HEAD=`5442768`，无需回退。
> 纪律：本地 commit，不 push。
>
> **2026-09-04 P2-GATE 修订**：X1 方案推翻「引入 `committed` phase」，收紧为 **hook 三出口直接 `previewExecutionRef.current = null`**（兑现 Contract §1.4 `commit → terminated`，scheduler 零改动）。详见 `outputs/preview-p2-gate-2026-09-04.md`。本文 §1.2/§1.4/§5 已同步为收紧后版本。

---

## 0. Runtime 证据锚（dump seq 索引）

| 缺口 | 证据 seq | 事件链 |
|---|---|---|
| X1 僵尸 | 45→47, 49→51, 65, 69, 73 | 带 `docId=d8bf968f` 的 refresh **5 次**撞 `MERGE_DEFERRED`（`execAction=restart-required`）→ L1649-1653 静默 return |
| X2 意图丢失 | 55→60, 61→63 | App scenario-2/3 **select（docId 已就绪）**先入 debounce → auto-nav-3 **refresh 同 key 后到**，无脑 clearTimeout 顶掉 select |
| X3 半壳 commit | 38→43 | v6 select → loading → `loadFilePreview` 返回半壳（`docId=null` + `_pdfData=true`）→ fuse 只查 phase → `COMMIT_SUCCESS` |
| 用户点击绕开 | 74→76→79 | 间隔 >150ms 走 immediate 分支 → `START v7` → `COMMIT_CACHE`（docId 就绪）→ 展示成功 |

---

## 1. X1 — MERGE_DEFERRED 僵尸死锁（核心状态机缺口）

### 1.1 机制（代码 + runtime 双坐实）

- **hook 从不把 execution 推进到 `'committing'`**（grep 实证：usePreview.js 只有 L1659/1668 两处 `phase: 'loading'`）。
- **三处 commit 出口从不清理 execution**：
  - `COMMIT_SUCCESS`（L2034-2053）——只 `setPreviewFile`，不动 `previewExecutionRef`；
  - `COMMIT_CACHE`（L1947-1979）——同上；
  - `FUSE_BLOCK`（L1766-1769）——`return` 前连清都不清（比 commit 更早的第二个僵尸位）。
  - 唯一清理 = merge 模式分支 L1715（对照物）。
- 于是每次 commit 后 `previewExecutionRef.current` 残留为 `{ phase: 'post-load', consumingSnapshot, key, version }`。
- 后续同 key refresh → `resolvePreviewTransition` merge → `resolveRefreshExecution` 见同绑定 execution 且 `phase!=='loading'` → `'restart-required'`（previewScheduler.js L188）→ hook L1649 `MERGE_DEFERRED` → return null。
- L1650-1652 注释「在途 execution 会在它的 boundary（advanceLoadingStep / resolveBoundary）检测 consumingSnapshot 变化并自行 restart（INV-PS10）」——**precondition 是「execution 仍在途」**；commit 后 doLoadPreview 已 return，**永远不会再经过任何 boundary** → 注释失效 → INV-PS7（Latest Snapshot Eventually Commits）悬空。

### 1.2 状态转移表：现状 vs 提案

**现状（Contract v2 §1.3 表格）——含僵尸漏洞：**

| execution 状态 | refresh 后动作 | 是否新建 execution | 漏洞 |
|---|---|---|---|
| `null`（idle） | `start-execution` | ✅ | — |
| `loading`（在途） | `update-snapshot`（loop 内消费） | ❌ | — |
| `post-load`（在途） | `restart-required` | ❌ | 依赖「还有 boundary 会发生」 |
| `committing`（在途） | `restart-required` | ❌ | 同上 |
| key/version 不匹配 | `ignore` | ❌ | — |
| **`post-load` 残留（已 commit / 已 fuse-block，无在途代码）** | **`restart-required`** | **❌** | 🔴 **僵尸：defer 给一个永远不会再经过 boundary 的 execution** |

**提案（P2-GATE 收紧，v2 无 delta）——不新增任何 phase，hook 三出口直接终态化：**

| execution 状态 | refresh 后动作 | 是否新建 execution | 说明 |
|---|---|---|---|
| `null`（idle / 已终态化） | `start-execution` | ✅ | **X1 修复后 refresh 走的路径**（T10 已绿） |
| `loading`（在途） | `update-snapshot` | ❌ | — |
| `post-load`（在途） | `restart-required`（不变，T12 保持） | ❌ | ANCHOR-1 锁定 |
| `committing`（在途） | `restart-required`（不变） | ❌ | — |
| key/version 不匹配 | `ignore` | ❌ | — |
| ~~`committed`（终态）~~ | — | — | 🔴 已否决：commit 后 execution 直接置 `null`，不保留新状态 |

**否决 `committed` phase 的理由（P2-GATE）**：committed execution 不再有任何 consumer，本质上就是 terminated；Contract §1.4 本就规定 `commit → terminated`。引入 `committed` = 为修复残留状态再创造一个残留状态类型，且让红测试钉死实现方案而非根行为。**scheduler 层零改动**即满足 X1 语义（`null + refresh → start-execution` 已由 T10 覆盖）。

hook 出口收尾（实施清单，X1 阶段执行）：

```
COMMIT_SUCCESS（L2034-2053 段末）→ previewExecutionRef.current = null
COMMIT_CACHE（L1947-1979 段末）  → previewExecutionRef.current = null
FUSE_BLOCK（L1766-1769）         → previewExecutionRef.current = null（未 commit，无 P4 记录需求，直接 terminated）
```

> 对照：merge 模式分支 L1715 已是此写法（唯一正确出口，作为模板）。restart 分支（L1830/1855/1875/1941）先 null 再递归 doLoadPreview，不受影响。`committedPreviewVersionRef` 在置 null **前**记录（L1962/2038 顺序不变），P4 clearCommitted 判定不受影响。

### 1.3 与 Contract v2 冲突检查（X1，P2-GATE 收紧后）

| Contract v2 条款 | 冲突？ | 说明 |
|---|---|---|
| §1.2 phase 枚举 | ✅ 无缺口 | 不新增 `committed`，枚举不变 |
| §1.3 表格 | ✅ 无缺口 | 不新增行；`null` 行即 X1 修复后的路径 |
| §1.4 Transition（commit → terminated） | ✅ **完全一致** | X1 修复 = hook 兑现 §1.4「commit → terminated」；僵尸 = hook 未兑现，非契约问题 |
| INV-PS7（无论 loading/post-load/committing/idle 都必须最终 commit 最新 snapshot） | ✅ 一致 | 终态化后 refresh 走 `null → start-execution`（T10），INV-PS7 兑现 |
| INV-PS9 / INV-PS10 | ✅ 不冲突 | 无新相位、无豁免需求；在途语义（T12/T13）原样保留 |
| 测试 T10/T12/T13 | ✅ 不冲突 | scheduler 零改动，全部保持 |

**结论（收紧后）：X1 = hook 未兑现 Contract §1.4「commit → terminated」，scheduler 层无缺口、零改动。**

### 1.4 最小实现（step 5 执行，本轮不做）

1. `usePreview.js` **三处出口** `previewExecutionRef.current = null`：
   - `COMMIT_SUCCESS`（L2034-2053 段末）；
   - `COMMIT_CACHE`（L1947-1979 段末）；
   - `FUSE_BLOCK`（L1766-1769）。
   顺序：先记 `committedPreviewVersionRef`（L1962/2038）再置 null；merge 分支 L1715 为模板。
2. `previewScheduler.js` **零改动**（`null + refresh → start-execution` 已绿 = T10）。
3. 实施后以**一次性验收脚本**核对三出口（PASS 后删除）；`previewScheduler.test.js` 保持全绿（ANCHOR-1/ANCHOR-2 锁定 scheduler 两侧语义）。

---

## 2. X2 — debounce 意图保真

### 2.1 机制（dump seq 55-63 铁证）

- seq 55-57 / 58-60：App `scenario-2-docid-arrives`、`scenario-3-first-docid-changed` 触发 **select**（此时 `docId=d8bf968f` 已就绪）→ 进 debounce 分支（sinceMs=1/2，hadPendingTimer=true，替换上家）——**到这里还是对的**（select 逐级替换）。
- seq 61-63：`usePreview:auto-nav-3-replaced`（files 引用替换 effect，L2312-2319）触发同 key **refresh**（sinceMs=28）→ L2113 `clearTimeout` + 重排 → **把 pending 的 select 顶掉**。
- 之后 timer 到点执行的是 refresh → merge → 撞 X1 僵尸（seq 65 MERGE_DEFERRED）→ docId-ready 的明确重预览意图被消灭。
- seq 74 用户点击间隔 >150ms，走 L2129 immediate 分支绕过 debounce → 成功。

**结论：debounce 是「按到达序 last-wins」，不看 intent 优先级。** L2117 注释「timeout 闭包必须捕获 intent（防抖不得丢失 intent 语义）」只做到捕获，没做到**仲裁**。

### 2.2 契约问题：同 debounce 窗口内 select + refresh（同 key）→ select 必须赢？

**从 runtime 证据看：是。** 理由：
- refresh 语义 = merge（同 version 更新 snapshot），对已僵尸的 transaction 无济于事（X1 已证 5 次 MERGE_DEFERRED）；
- select 语义 = supersede（++version，新 execution 绑最新 snapshot），是唯一能突破死锁组合的意图；
- 若 docId 已到的 select 被普通 refresh 顶掉，「自动恢复」永远失败，只剩用户点击一条路（本 dump 的 39s 静默）。

**优先级规则提案：**

| pending | incoming（同 key） | 结果 |
|---|---|---|
| select | refresh | **保留 select**（payload 可升级为 incoming 最新引用，但**不降级为 refresh**） |
| refresh | select | 升级为 **select**（supersede 语义） |
| select | select | incoming（last-wins，INV-PS3） |
| refresh | refresh | incoming（只留最新 payload） |
| 任意 | 不同 key | incoming（新 selection 覆盖，INV-PS3） |

### 2.3 与 Contract v2 冲突检查（X2）

| Contract v2 条款 | 冲突？ | 说明 |
|---|---|---|
| debounce | ✅ 无条款 | debounce 是 hook 实现细节，Contract v2 未覆盖 |
| INV-PS1（refresh 不 ++version） | ✅ 不冲突 | 仲裁只决定「哪个 pending 动作最终执行」，不改变其调度语义 |
| INV-PS3（显式点击一律 select） | ✅ 支持 | select 胜出恰好兑现 INV-PS3 |
| INV-PS7 | ✅ 支持 | 保留 docId-ready select = 让最新 snapshot 有机会最终 commit |

**结论：X2 不违背 Contract，是对 hook 防抖层的意图优先级补契约。** 若认为「防抖层语义」也应收编进 PreviewScheduler Contract，建议在 v2.1 增加一节（不涉及 §3 决策函数，属执行层约束），标注「handlePreview debounce 必须按 intent 优先级仲裁，不得按到达序 last-wins」。

### 2.4 最小实现（proposal，step 5 执行）

1. `previewScheduler.js`（或新纯模块）新增 `resolveDebouncePrecedence(pending, incoming)`，返回**生效 pending** `{ intent, key }`（签名以 `previewP2RedContracts.test.js` 冻结草案为准）：
   - `pending` 为 null 或 key 不同 → `{ intent: incoming.intent, key: incoming.key }`（新 selection 覆盖）；
   - pending `select` + incoming `refresh`（同 key）→ `{ intent: 'select', key }`（**保留 select，不降级**——本规则核心）；
   - 其余（refresh→select 升级 / 同 intent last-wins）→ `{ intent: incoming.intent, key }`。
2. `handlePreview` debounce 分支（L2102-2124）重构：
   - **以纯函数返回值（而非 incoming.intent）重排定时器**——杜绝 pending select 被同 key refresh 覆盖；
   - payload 一律取 incoming 最新引用（`resolvePreviewTransition` 之后 snapshot 自然最新）；

---

## 3. X3 — 半壳 commit gate（防御层）

### 3.1 机制（seq 38-43）

v6 select → loading loop `loadFilePreview` 返回半壳（`docId=null`，`_pdfData=true`）→ `advanceLoadingStep` `post-load` → **fuse（L1766）只查 `execution.phase==='post-load'`，不查快照可展示性** → `COMMIT_SUCCESS`（seq 43）→ DisplayAdapter `storeDocId = resolveDocumentIdentity(file) || resolveDocId(file) || file?.key` 在 DocumentStore 按 docId 哈希 → miss → 展示区空白固化 → 且 `previewFile!==null` 屏蔽所有 `!previewFile` retry 守卫（L2234-2242 docId-retry 的 `no-previewFile` skip）。

### 3.2 与 Contract v2 冲突检查（X3）

| Contract v2 条款 | 冲突？ | 说明 |
|---|---|---|
| INV-PS6（snapshot 稳定才 commit） | ✅ 必要不充分 | 稳定 ≠ 可展示；X3 是 INV-PS6 的**第二闸**（displayability） |
| INV-PS11（commit 前 freshness） | ✅ 不冲突 | 正交 |
| §5 禁止清单（Resolver/DisplayAdapter/渲染链/后端） | ✅ 不冲突 | 谓词放决策层/新纯模块，不改 DisplayAdapter |

**结论：X3 与 Contract v2 无冲突，是把「不可展示状态不得成为 committed preview」固化为 fuse 的第二条件。**

### 3.3 谓词语义（`isDisplayablePreview(file)`）

字段口径对齐 `previewTrace.snapshotFlags`（`_pdfData` / `_previewImageUrl`）+ `docIdOf`（`identity.docId` 优先回落 `docId`）：

| file 形态 | 判定 | 理由 |
|---|---|---|
| pdf-backed（`_pdfData` 或 `_fileFormat==='pdf'`）且无 docId | 🔴 不可 commit | DisplayAdapter/DocumentStore 按 docId 哈希寻档 → miss 即空白 |
| pdf-backed 且 `identity.docId`/`docId` 非空 | ✅ 可 commit | |
| pdf split-page（`sourceDocId && docId !== sourceDocId`） | ✅ 用 `sourceDocId` 判定 | 对齐 buildRenderSpec L1993-1994 effectiveDocId 逻辑 |
| 纯图像（`_previewImageUrl` 就绪，不经 DocumentStore） | ✅ 可 commit（无 docId 也允许） | |

### 3.4 最小实现（proposal，step 5 执行）+ 独立修复不闭合的论证

1. `previewScheduler.js`（或新纯模块）新增 `isDisplayablePreview(file)`。
2. `usePreview.js` fuse（L1766）加第二闸：`phase==='post-load' && isDisplayablePreview(loadedFile)`；不满足 → `FUSE_BLOCK` + **`previewExecutionRef.current = null`**（与 X1 §1.4 的 fuse 终态化同点）。
3. **只修 X3 不闭合**（用户论断确认 + 推理链）：
   - v6 半壳被 fuse 拦 → 若 FUSE_BLOCK 不终态化 execution，残留 `post-load` → 下个 refresh 仍 `restart-required` → MERGE_DEFERRED 僵尸复现；
   - 且 `previewFile` 保持 null 时，docId-retry effect（L2232-2242）走 `DOCID_RETRY_SKIP(no-previewFile)`，**救援守卫被禁用**；
   - 能救场的只剩 App scenario-2/3 select + auto-nav-2-none select —— 它们又依赖 X2（debounce 不吞 select）。
   - → X3 必须与 X1（fuse 终态化）、X2（select 保真）配套，形成闭合链：**fuse 拦半壳 → execution 终态化 → 后续 select/refresh 走 start-execution 重试 → docId 就绪后 commit 成功**。

---

## 4. 三者依赖关系与实施顺序

```
X3（拦半壳 commit）
   ↓ 若单独修：execution 残留 post-load → 下个 refresh 仍僵尸（X1 未修）→ 白屏依旧
X1（hook 三出口终态化 → null）                   ← 核心，先修（scheduler 零改动）
   ↓ 修复后 refresh 链自动恢复；但同窗口 select 仍可能被 refresh 顶掉
X2（debounce 意图保真）                          ← 次之
   ↓
X3（防御层保险丝）                               ← 最后兜底
```

**推荐顺序与用户一致：X1 → X2 → X3。** X3 是防御层而非根因修复——它把「失败状态冻结成成功」的放大器拆掉，但调度层的两个真洞（X1 僵尸、X2 意图丢失）必须由前两者补。

---

## 5. 测试契约（GATE 收紧后，生产代码零改动）

| 测试 | 位置 | 断言 | 当前状态 |
|---|---|---|---|
| **P2-X1-ANCHOR-1** | `previewScheduler.test.js` | 在途 `post-load` + refresh → 仍 `restart-required`（T12 不回归，X1 修复不得误伤在途 restart） | 🟢 绿（边界锁定） |
| **P2-X1-ANCHOR-2** | 同上 | `execution=null` + refresh → `start-execution`（三出口终态化后 refresh 走的路径 = INV-PS7） | 🟢 绿（T10 同语义，X1 叙事绑定） |
| **P2-X2-1..5（5 条）** | `previewP2RedContracts.test.js` | `resolveDebouncePrecedence` 优先级表（2.2） | 🔴 红（seam 缺失：`TypeError: not a function`） |
| **P2-X3-1..5（5 条）** | `previewPolicyRedContracts.test.js` | `isDisplayablePreview` 半壳/就绪/图像/split-page 判定（3.3），seam=`previewPolicy.js` | 🔴 红（module not found，文件级） |

> **G1 红测形态审计结论**：X1 收紧后 scheduler 层**无需红测**（T10/ANCHOR-2 已绿 = 三出口终态化后的收敛语义）；hook「三出口 → null」是纯副作用赋值，在当前测试设施（无 hook harness、仓库无源码审计先例）下**无行为红测形态**——实施时以**一次性验收脚本**核对三出口（PASS 后删除，符合仓库「验收脚本用完即删」纪律），不保留常驻结构护栏。
> **G2 seam 位置结论**：`resolveDebouncePrecedence` → `previewScheduler.js`（debounce 意图仲裁与 select/refresh supersession 同源）；`isDisplayablePreview` → **新纯模块 `previewPolicy.js`**（preview snapshot policy，避免 scheduler 承担 transition/execution/debounce/displayability 四类职责）。
> X2/X3 红 = 契约已钉、实现未到；seam 落地后各自转绿 = 验收。
