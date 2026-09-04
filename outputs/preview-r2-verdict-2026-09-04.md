# R2 Runtime Preview Evidence — 实机 dump 裁决（8 文件，2026-09-04）

- dump：`outputs/perf-runs/preview-r2-8files-20260904.json`（用户实机，79 事件，dropped=0）
- 判读器：`outputs/preview-r2-adjudicate.mjs`（v2，version 精确终局匹配 + half-shell 分档）
- 复现场景：导入 8 张 PDF → 展示区空白 → 点一次文件列表才显示（用户报告 B）
- 本裁决零代码改动，纯取证。

---

## 0 · 会话快照

| 项 | 值 |
|---|---|
| 探针窗口 | t=29902.7 → 73945.9ms（44s，导入从 ~29.9s 开始，即 enable 后 ~30s 导入） |
| 漏斗 | HANDLE 17 = DEBOUNCED 10 + 立即 7；SCHED 10 = START 5 + MERGE_DEFERRED 5；START 5 = LOAD 5 = RETURN 5 |
| 一致性 | 全部 [PASS]（counters vs events 实算一致，无截断/漏记） |

## 1 · R2 四问的 runtime 答案

**R2-1 自动预览调了多少次、来自哪？** 15 次 AUTO_PREVIEW（8 分支打点），来源分布：
- `usePreview:no-preview-first` ×4 + `auto-nav-2-none` ×4 —— **两个 usePreview 内置 effect 对同批 files 双触发**（同一次 files 变化打两次，彼此相差 ~0.7ms）
- `auto-nav-3-replaced` ×5 —— previewFile 被引用替换后反复 refresh（**死锁期的循环来源**）
- `App:scenario-2-docid-arrives` ×1、`scenario-3-first-docid-changed` ×1 —— **docId 就绪后各触发 1 次 select，但全部被防抖吞掉**（见 §4-C）
- `scenario-1-first-import` **×0** —— firstReady=false（docId=null）从未触发，dde9f06 的门控生效
- 用户点击 ×1（`handleClick@FileList.jsx:43`，唯一 caller 带 handleClick）

**R2-2 每次为什么被取消？** 5 次 START 的终局矩阵：

| version | key | docId | 终局 | 取消原因 |
|---|---|---|---|---|
| v3 | 020209（第一） | null | **TERMINATED** | 加载 590ms 拿到 pdfData，但 files[0] 已漂移到 020429（排序），transaction 被 v4 取代 |
| v4 | 020429 | null | **TERMINATED** | 拿到 pdfData，被 v5（防抖到期）取代 |
| v5 | 020429 | null | **ABORTED@A1** | loadDocFacts 后 resolveBoundary 发现被 v6 取代 |
| **v6** | 020429 | null | **COMMIT_SUCCESS（半壳）** | ⭐ 唯一成功 commit——docId=null 但有 pdfData |
| v7 | 020429 | **d8bf…** | **COMMIT_CACHE** | 用户点击，docId 已就绪 → RE 路径 + 缓存命中 → **显示** |

即：自动预览的 4 次加载全部作废或半壳，**直到用户点击（v7）才有可显示的 commit**。

**R2-3 空壳 commit 坐实了吗？** 修正为 **半壳 commit（🟠）而非空壳（🔴）**：
```
COMMIT_SUCCESS seq43  docId=null  img/pdf/img3=[F,T,F]  ← pdfData 在、docId 缺
```
- 不是「空壳」（有 pdfData 载荷）；是 **docId 后到窗口的另一半形态**：载荷先到、身份后到
- 但半壳与空壳对展示区等价：**docId=null → DisplayAdapter `storeDocId = resolveDocumentIdentity(file) || resolveDocId(file) || file?.key` → DocumentStore 以内容 hash 注册 → miss → `storeDocument=null` → 空白**（DisplayAdapter.jsx:83-84,111）。载荷躺在 previewFile._pdfData，渲染管线不消费它（走 DocumentStore 合成 document 路径）
- 静态审查的「commit 保险丝只查 phase 不查就绪度」（commit-fuse:INV-PS6，usePreview.js:1763-1768）→ **runtime 坐实**：v6 以 docId=null 照常 commit

**R2-4 失败后有没有重试？** 有，而且全链都试了——**但全部被 MERGE_DEFERRED 死锁吞掉**：

| 时间 | 重试源 | 意图 | 结果 |
|---|---|---|---|
| 30854 | auto-nav-3（pf 引用替换） | refresh | merge → restart-required → **defer** |
| 34651 | DOCID_RETRY_EVAL `changed=true`（docId 到达！） | refresh | merge → restart-required → **defer** |
| 34653 | App scenario-2（docId arrives） | **select** | 150ms 防抖内 → **DEBOUNCED，意图丢失** |
| 34654 | App scenario-3（docId changed） | **select** | 150ms 防抖内 → **DEBOUNCED，意图丢失** |
| 34680→36877 | auto-nav-3 ×3 轮 | refresh | merge → restart-required → **defer**（×3） |
| **→ 73877（+37s 静默）** | **用户点击** | **select** | **立即执行 → v7 → 成功** |

## 2 · 根因链（runtime 证据版）

```
① 导入时 fileObj.docId=null（解析/装配后到）
     ↓
② 自动预览启动（no-preview-first/auto-nav-2 双 effect 触发）
   → doLoadPreview：USE_RENDER_ENGINE_PREVIEW && fObj.docId 不成立 → 走 pdf.js 路径
   → loadFilePreview 返回半壳（_pdfData 在、docId 无）
     ↓
③ files[0] 排序漂移 020209→020429 → v3/v4/v5 三次加载白白作废（TERMINATED/ABORTED）
     ↓
④ v6 半壳 COMMIT_SUCCESS（docId=null + pdfData）← 保险丝只查 phase 不查就绪度（INV-PS6）
   → DisplayAdapter storeDocument miss → 展示区空白
   → previewFile 非 null → 所有 !previewFile 型守卫失效
     ↓
⑤ docId 就绪（34651）→ docId-retry / scenario-2 / scenario-3 / auto-nav-3 全链重试
   ── 但全部撞死锁 ──
   refresh → resolveRefreshExecution 判 restart-required（execution v6 已 commit 成僵尸，
   phase=post-load 但不再经过任何 resolveBoundary）
   → MERGE_DEFERRED 扑空 → 无人真正 restart        🔴 主放大器
   select（scenario-2/3，本可 ++version 强制新 execution）
   → 150ms 防抖 last-wins 被后续 refresh 覆盖 → 意图丢失 🔴 次放大器
     ↓
⑥ 39 秒静默（36877 → 73877 零事件）
     ↓
⑦ 用户点击：距上次调用 37s > 150ms → 立即执行 → select → ++version 7
   → 新 execution → docId 已就绪 → RE URL + full-cache 命中 → COMMIT_CACHE → 显示 ✅
```

## 3 · 先前静态审查结论的坐实/修正对照

| 静态假设（9/4 上午审查） | runtime 判定 |
|---|---|
| 🔴-1 空壳 commit（loadFilePreview:1584 永不 null） | **修正为半壳**（pdfData 在 docId 缺）；核心机制坐实：不可展示对象照常 commit，保险丝不查身份就绪度 |
| 🔴-2 select 每次 ++version → supersede 雪崩 | **部分坐实**：v3/v4/v5 确实是 select 连续 supersede 的雪崩；但真正的死锁在 v6 commit 后的 **refresh 僵尸循环**（supersede 结束后的新形态） |
| 🟡 防抖饥饿（lastSwitchTimeRef 只在非防抖分支更新） | **坐实且更重**：不是无限推迟，而是 **last-wins 丢意图**——scenario-2/3 的 select 被 refresh 覆盖，唯一能救命的意图死在防抖里 |
| 🟡 docId-retry `if(!pf) return` 缺口 | 本轮未触发（pf 非 null）；docId-retry 活着（EVAL changed=true → refresh）但同样撞 merge 死锁 |
| App scenario-1 firstReady 门控 | **坐实**：scenario-1 ×0 触发；接力棒交到 scenario-2/3，而它们被防抖+死锁双杀 |
| dde9f06 = 回归头号嫌疑 | **嫌疑成立但需锚点**：它把自动预览改为「docId 就绪才触发」，docId 就绪后唯一能救的 select 意图路径已坏（见 §5 待定） |

## 4 · 三个需要单独记账的机制缺陷（修复候选，均未实施）

- **P2 候选 X1（merge 僵尸死锁）**：`resolveRefreshExecution` 对 phase=post-load 的已结束 execution 返回 restart-required，但 execution 已离开 loading loop → defer 永不兑现。位置：previewScheduler.js:188（restart-required 分支）+ usePreview 的 MERGE_DEFERRED 处理（:1649 附近）。修法候选：post-load 且已 commit 的 execution 应视为 idle（返回 start-execution）或由 scheduler 直接代执行 restart，而非等 boundary。
- **P2 候选 X2（防抖丢意图）**：`usePreview.js:2118-2124` 防抖 last-wins，后到调用覆盖先到的 intent——scenario-2/3 的 select 死在防抖里。修法候选：防抖队列保留最高优先级意图（select > refresh），或 select 意图绕过防抖。
- **P2 候选 X3（半壳 commit 保险丝）**：commit 保险丝（:1728 附近）加 docId 就绪度 gate（要求 docId 非 null 才 commit；docId=null 时保持 previewFile=null 让重试链继续）。⚠️ 注意本 dump 证明：半壳 commit 后 previewFile 非 null → 屏蔽 !previewFile 守卫——X3 同时解掉这层屏蔽。
- **附带观察（非缺陷）**：no-preview-first 与 auto-nav-2-none 双 effect 同批双触发（×4 次重复）——行为冗余，但不是本次空白的原因。

## 5 · 待定问题

1. **回归锚点（关键）**：dde9f06 之前（8/30 及更早）自动预览在「docId 后到」场景是否正常？若正常 → X2/X3 可能是 dde9f06 引入前的既有洞被时序变化暴露；若也不正常 → 问题更老。**一句话即可，无需 SHA。**
2. 导入文件是纯 PDF（key 后缀 .pdf ×8）——RE 路径对 PDF 需 docId，半壳窗口对 PDF 是主形态；OFD/图片的窗口形态可能不同（图片走 RE 无 pdf.js 兜底）。
3. X3 修法把「pdf.js 兜底路径」（docId=null 时的 _pdfData 加载）是否保留——若保留，半壳 commit 前应等 docId；若不保留，docId=null 直接不启动加载。

## 6 · 结论一句话

**用户点击成功（v7）与自动预览失败（v1-v6）的唯一差异 = 点击时 docId 已就绪 + select 立即执行未被防抖吞掉**；自动预览全部死在「docId 后到 → 半壳 commit → refresh 僵尸死锁 + select 意图被防抖覆盖」的三重复合链上——**这不是渲染性能问题，是调度层状态机在 commit 后对 refresh 的兑现缺口（X1）+ 意图保真缺口（X2）+ commit 就绪度缺口（X3）**。
