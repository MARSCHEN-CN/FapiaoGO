# P2 修复设计 —— Preview Scheduler 状态机缺口（X1 / X2 / X3）

> 依据：R2 实机 dump（`outputs/perf-runs/preview-r2-8files-20260904.json`，79 events，8 PDFs）+ `PreviewScheduler-Contract-v2.md`（冻结）。
> 本轮**只钉测试契约与设计，生产代码零改动**。修复基线 = `e6bbb89`（trace 已清理）+ 其后 3 个纯 docs commit，HEAD=`5442768`，无需回退。
> 纪律：本地 commit，不 push。

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

**提案（v2.1 delta）——新增终态 `'committed'`：**

| execution 状态 | refresh 后动作 | 是否新建 execution |
|---|---|---|
| `null`（idle） | `start-execution` | ✅ |
| `loading`（在途） | `update-snapshot` | ❌ |
| `post-load`（在途） | `restart-required`（不变，T12 保持） | ❌ |
| `committing`（在途） | `restart-required`（不变） | ❌ |
| **`committed`（终态，代码已返回，无 boundary 会发生）** | **`start-execution`** | **✅** |
| key/version 不匹配 | `ignore` | ❌ |

Transition 图（Contract v2 §1.4 增补）：

```
committing
   ├── continue → commit → committed（终态，保留 version 供 P4 clearCommitted 判定）
   ├── restart  → loading（same id）
   └── abort    → terminated（null）
fuse-block（半壳/不可展示）→ terminated（null）   ← 新增出口
```

**INV-PS9 豁免声明**：`'committed'` 不是「有效 execution consumer」（其异步代码已返回，不再消费 snapshot），故对同一 `{key, version}` 启动新 execution **不违反** Single Execution Per Transaction。§1.3 Gap A 冻结条件（「仅当当前 transaction 不存在有效 execution consumer」）需补充一句：终态 execution 视为无 consumer。

### 1.3 与 Contract v2 冲突检查（X1）

| Contract v2 条款 | 冲突？ | 说明 |
|---|---|---|
| §1.2 phase 枚举 `loading/post-load/committing` | ⚠️ 缺口 | v2.1 增补 `'committed'`（delta doc） |
| §1.3 表格 | ⚠️ 缺口 | 增补 committed 行（→ `start-execution`） |
| §1.4 Transition（commit → terminated） | ✅ 不冲突 | **Contract 本就规定 commit 后要终止**；僵尸 = hook 未兑现「terminated」——X1 是契约未落地，不是契约矛盾 |
| INV-PS7（L97：无论 loading/post-load/committing/idle 都必须最终 commit 最新 snapshot） | ⚠️ 缺口 | 补 `committed`；当前 MERGE_DEFERRED 正是违约点 |
| INV-PS9（单活 execution） | ✅ 不冲突（需豁免注释） | committed 非 consumer |
| INV-PS10（restart 不 fork） | ✅ 不冲突 | 只约束在途 execution |
| 测试 T12 / T13（post-load/committing → restart-required / 永不 start） | ✅ 不冲突 | 断言集不含 `committed` 相位 |

**结论：X1 = 契约缺口 + hook 未兑现，非契约矛盾。**

### 1.4 最小实现（step 5 执行，本轮不做）

1. `previewScheduler.js`：`resolveRefreshExecution` 增加 `phase==='committed'` → `'start-execution'` 分支。
2. `usePreview.js` 三处出口设终态：
   - `COMMIT_SUCCESS` 后（L2038 之后）：`previewExecutionRef.current = { ...previewExecutionRef.current, phase: 'committed' }`；
   - `COMMIT_CACHE` 后（L1962 之后）：同上；
   - `FUSE_BLOCK`（L1766-1769）：`previewExecutionRef.current = null`（未 commit，无 P4 记录需求，直接 terminated）。
3. Contract v2 delta 文档 + 回归测试 T25（红）→ T26/T27（绿）。

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
X1（终态化：committed/terminated + pure 决策）   ← 核心，先修
   ↓ 修复后 refresh 链自动恢复；但同窗口 select 仍可能被 refresh 顶掉
X2（debounce 意图保真）                          ← 次之
   ↓
X3（防御层保险丝）                               ← 最后兜底
```

**推荐顺序与用户一致：X1 → X2 → X3。** X3 是防御层而非根因修复——它把「失败状态冻结成成功」的放大器拆掉，但调度层的两个真洞（X1 僵尸、X2 意图丢失）必须由前两者补。

---

## 5. 测试契约（本轮交付，生产代码零改动）

| 测试 | 位置 | 断言 | 本轮预期 |
|---|---|---|---|
| **P2-X1-RED-1** | `previewScheduler.test.js`（追加） | 终态 `committed` execution + 同 key refresh → **必须 `start-execution`** | 🔴 红（现返回 `restart-required`）——真实断言红，可运行 |
| **P2-X1-CTRL-1** | 同上 | 在途 `post-load` execution + refresh → 仍 `restart-required`（T12 不回归） | 🟢 绿（边界锁定） |
| **P2-X2-*（4 条）** | `previewP2RedContracts.test.js`（新建） | `resolveDebouncePrecedence` 优先级表（2.2） | 🔴 红（seam 缺失：`TypeError: not a function`）——契约已钉、实现未到 |
| **P2-X3-*（4 条）** | 同上 | `isDisplayablePreview` 半壳/就绪/图像/split-page 判定（3.3） | 🔴 红（同上） |

> X1 红测试放现有文件（import 正常 → 真实断言红）；X2/X3 红测试放新文件（引用尚不存在的导出 → 每测 TypeError 红）。
> seam 落地（step 5）后：X1 断言转绿，X2/X3 文件整体转绿 = 验收。

## 6. 本轮交付与纪律

- commit 1（docs）：本设计文档。
- commit 2（test）：`previewScheduler.test.js` 追加 P2-X1 RED + CTRL。
- commit 3（test）：新建 `previewP2RedContracts.test.js`（X2/X3 契约红）。
- 生产代码（`previewScheduler.js` / `usePreview.js` / Contract doc）**零改动**；不 push。
