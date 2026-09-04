# R2 Preview Runtime Probe — 复现运行手册

> PERF-WHITE-1 · R2：Runtime Preview Evidence Audit（只加探针，不改逻辑）
> 基线：`92b2460` + trace commits（b1fcbf2 / e499e40 / 1fcd8fa）+ R2 探针接线
> 目标：坐实/证伪「展示区自动预览偶发失效，需点一次文件列表才显示」的 4 个事实问题。

## 探针覆盖（对应 R2-1 ~ R2-4）

| 事件 | 位置 | 回答的问题 |
|---|---|---|
| `HANDLE_PREVIEW` | handlePreview 入口（带 caller 栈归因） | R2-1：调了多少次、每次 intent/key/docId/version、**来源是谁** |
| `DEBOUNCED` | 150ms 防抖分支 | R2-2：防抖重排（饥饿观察：sinceLastSwitchMs + hadPendingTimer） |
| `SCHED_DECISION` / `IGNORED` / `INVALIDATED` / `MERGE_DEFERRED` | 调度器决策 | R2-2：每次调用的调度结局 |
| `START` | version/execution 确立后 | R2-2：真正进入加载的次数与 version |
| `LOAD_START` / `LOAD_RETURN` | loadFilePreview 进出 | R2-3：**实际返回了什么**（docId + hasPreviewImageUrl/hasPdfData/hasPreviewImage） |
| `ABORTED` / `RESTART`（at: after-loadDocFacts / before-saveDocFacts / after-saveDocFacts / before-commit） | 4 处 resolveBoundary | R2-2：每次取消发生在哪个边界 |
| `TERMINATED` / `FUSE_BLOCK` | loading loop / INV-PS6 保险丝 | R2-2：终止与禁止 commit 的原因 |
| `COMMIT_ATTEMPT` / `COMMIT_SUCCESS` / `COMMIT_SKIPPED_VERSION` / `COMMIT_CACHE` / `COMMIT_MERGE` | 3 类 commit 出口 | R2-3：**空壳 commit 是否坐实**（COMMIT_SUCCESS 且 docId=null + 三 flag 全 false = 坐实） |
| `AUTO_PREVIEW`（branch: App:scenario-1~4 / usePreview:no-preview-first / auto-nav-1/2/3） | App.jsx 4 场景 + usePreview 3 分支 | R2-1：**185 次到底来自哪个分支**（7 个来源逐一归因） |
| `DOCID_RETRY_EVAL` / `DOCID_RETRY_SKIP`（reason: no-previewFile / live-not-found） | docId 就绪 effect | R2-4：**失败后有没有重试机会**（no-previewFile = 自动预览从未 commit 的凝固证据） |

## 复现步骤（DevTools Console，单行命令）

```js
localStorage.setItem('FAPIAOGO_PREVIEW_TRACE', '1')
```

写入后**刷新页面**（探针在模块加载时读此开关）。然后：

1. 导入一批文件（复现「自动预览失效」场景），或直接在已失效状态下点击文件列表一次（对照组）。
2. 等展示区稳定后，取报告（单行）：

```js
copy(__PREVIEW_TRACE__.dump())
```

剪贴板即完整 JSON（events 时间轴 + counters 汇总）。粘给 AI 即可。
只看计数的话：`__PREVIEW_TRACE__.report().counters`。

不想再跑：`localStorage.removeItem('FAPIAOGO_PREVIEW_TRACE')` 后刷新。

## 判读要点（拿到报告后按此对号）

**R2-1 来源归因**：数 `AUTO_PREVIEW` 各 branch 的计数 + `HANDLE_PREVIEW` 的 caller 字段。
- 同一 effect 重复触发 / 多分支并发 / StrictMode 双跑 / 真雪崩，计数分布会直接给出答案。

**R2-2 取消链**：每个 `START` 应能在时间轴上找到结局——`COMMIT_*`（成功）/ `ABORTED`（被取消，看 at）/ `RESTART` / `TERMINATED` / `FUSE_BLOCK` / `DEBOUNCED`（未 START）。

**R2-3 空壳坐实的唯一标准**：出现
```
COMMIT_SUCCESS  docId: null, hasPreviewImageUrl: false, hasPdfData: false, hasPreviewImage: false
```
才宣布空壳 commit 坐实。只有 `LOAD_RETURN` 空壳 + 无 commit = 只是加载了没提交，是另一回事。

**R2-4 重试凝固**：`DOCID_RETRY_SKIP reason: 'no-previewFile'` 反复出现且从不出现 `DOCID_RETRY_EVAL changed: true`
= 「previewFile 非 null 假象屏蔽重试」假设成立（注意区分：previewFile 为 null 时 skip 是**预期行为**，
只有当它发生在「自动预览本应已成功」的场景之后才算证据）。

## 硬约束（接线已按此落实）

- 所有调用点均为 `if (previewTrace.on) previewTrace.log/state(...)`，**零逻辑参与**；
- 默认关闭：未开启时 `log()/state()` 首行 return，热路径零开销；
- 探针模块零定时器、零依赖、环形缓冲 4000 上限；
- 未改任何业务分支的判断条件（防抖/调度/边界/commit 的 if 结构原样保留，只在分支体内加观测）。

## 验证记录（本次接线后）

- `node --test test/previewTrace.test.mjs test/perfProbe.test.mjs test/importHistoryBatcher.test.mjs` → **47/47 PASS**。
- `npx vite build` → 通过；bundle 含 `HANDLE_PREVIEW` / `AUTO_PREVIEW` / `DOCID_RETRY_SKIP` 标记。
- 符号交叉校验：两文件 `previewTrace` 裸用法仅 import 语句本身，无未导入符号。
