# Pass 2 — D20 / C8 只读追踪审计（不改动代码）

> **纪律**：本轮仅做只读追踪 + 判定，不修改任何生产代码、不创建 `SourcePageResolver.js`、不提交。
> 目标（用户指令）：确认 `usePreview` 的 `pageNum` 应在**哪一个 boundary** 转成 render locator，哪些调用者真正依赖当前的 `+1`，避免「简单删除 +1 → 表面修好 PDF preview → 却破坏其它 0-based internal locator 调用者」的危险修复。

---

## 1. 总判定（Verdict）

**D20 / C8 是静态确定的 contract violation，runtime 验证只确认用户可见症状 / 是否被 fallback 掩盖，不回过头决定该 Finding 是否成立。**（依用户 M1-c 口径修正 #2）

`fileObj.pageNum` 生产态 = **1-based**（M1-a 事实表锁死：`app.py:987` emit `page_index = i+1`）。
`(pageNum ?? 0) + 1` 把 1-based 证据再 +1 → **2-based**，喂给 1-based 的 render locator（`?page=` / `renderPage`）。
这是**双加错误**（double +1），不是「0-based→1-based 转换」。

**直接反证（golden reference）**：`DisplayAdapter.jsx:96-101` 把 `file.pageNum`（`?? 1`）**直接**用作 1-based `renderPage → /preview/{sourceDocId}?page=N`，**无 +1**。`useViewerState.js:78` 把 `fileObj.pageNum` 当 1-based，用 `pageNum - 1` 转成 0-based 内部 index。两处都与「+1」相反，且都与生产一致 → 证明 usePreview 的 6 处 `+1` 是错的。

---

## 2. 六个消费点逐一定位（当前行号，Pass 1 注释已偏移）

| # | 行 | 所属函数 | 代码 | 下游流向 | 进 URL 页号？ | 进签名？ |
|---|---|---|---|---|---|---|
| A1 | 247 | `computeDocumentState(loadedFile)` | `pageNum: (loadedFile.pageNum ?? 0) + 1` | 写 `DocumentState.pageNum` | ❌（状态字段） | ❌ |
| A2 | 1602 | `documentStateRef.current = {...}` | `pageNum: (loadedFile.pageNum ?? 0) + 1` | 写 `DocumentState.pageNum`（另一条路径） | ❌（状态字段） | ❌ |
| B1 | 1311 | `doLoadPreview` image/ofd 分支 | `pageForPreview = (fObj.pageNum ?? 0) + 1` → `buildPreviewUrl(effectiveDocId, pageForPreview)` | `_previewImageUrl = ...?page=N` | ✅ **直接** | — |
| B2 | 1358 | `doLoadPreview` pdf 分支 | `pageForPreview = (fObj.pageNum ?? 0) + 1` → `buildPreviewUrl(effectiveDocId, pageForPreview)` | `_previewImageUrl = ...?page=N` | ✅ **直接** | — |
| C1 | 635 | render effect dispatch | `rePage = (previewFile.pageNum ?? 0) + 1`（仅拆分页） → `buildRenderSpec(renderCommand, { page: rePage })` | `getRenderEnginePreviewUrl(previewFile, …, previewSpec)` | ❌（被 `wireFieldsOf` 丢弃） | ✅（进 `spec_sig`） |
| C2 | 1669 | L2 cache-hit 路径 | `pageForPreview = (loadedFile.pageNum ?? 0) + 1` → `buildRenderSpec(l2Command, { page: pageForPreview })` | `getRenderEnginePreviewUrl(loadedFile, …, l2Spec)` | ❌（被 `wireFieldsOf` 丢弃） | ✅（进 `spec_sig`） |

**关键机制（M1-b 对 635 的「仅进签名」判断已复核确认）**：
- `buildPreviewUrl(docId, page=1)` → `${BACKEND_URL}/preview/${docId}?page=${page}`（`config.js:66-69`）——`page` 直接拼 `?page=`，后端 1-based。
- `buildRenderSpec(renderCommand, { page=1 })` 把 `page` 留在 spec 对象里（`renderSpec.js:143`），但 `wireFieldsOf(spec)`（`renderSpec.js:34-57`）**不含 `page`** → `appendRenderSpecToUrl` 不会把 `page` 写进 query 参数，只保留 base URL 里既有的 `?page=`。`spec_sig`（`renderSpecSignature(spec)`）则覆盖完整 spec，**包含 `page`**。
- `getRenderEnginePreviewUrl(previewFile, …)` 以 `previewFile._previewImageUrl` 为 base URL（`previewTarget.js:36`）——而该 URL 正是在 B1/B2 用 `+1` 拼好的。所以 **C1/C2 的 `page` 不决定渲染页，渲染页由 B1/B2 写入的 base URL 决定**；C1/C2 的 `page` 只进签名。

---

## 3. 下游效果分类

### Group A（A1/A2 → `DocumentState.pageNum`）
- 产出 `documentStateRef.current.pageNum`（= 2-based，因 +1）。
- 在 `usePreview.js` 内部仅被整体透传（`usePreview.js:2076` `documentState: documentStateRef.current` 返回给消费方）。
- **外部唯一真实消费者**：`exportSnapshotBuilder.js:89` `const page = isPdf ? (previewPage || documentState?.pageNum || 0) : 0`，作为导出 `sourceRef.page` 喂 `buildExportRenderCommand`。导出后端 `extract_page_pdf(page)` 为 1-based（`engine.py:360`）。
  - 当前：`documentState.pageNum` 是 2-based → 导出页 off-by-one，但被 `previewPage ||` 前缀**掩盖**（previewPage 为 1-based 当前页时直接用它）。
  - 故 Group A 的 +1 仅在 `previewPage` falsy 时泄漏为导出 off-by-one。

### Group B（B1/B2 → `?page=`）
- **直接、可观察地**把 `?page=` 设成 2-based。
- 拆分页（`isParsedSplitPage`，`effectiveDocId = sourceDocId`）时：生产 `pageNum=1` → `?page=2` → 请求父 PDF 第 2 页 → **首页被请求成父 PDF 第 2 页，末页还可能越界**。
- 单页 / 非拆分文件：`pageNum=1`（或 null→0→+1=1）→ `?page=1` → 恰巧正确（掩盖了 bug）。
- **这就是 N6 的静态实链**：B1/B2 是 N6 的真正落点；C1/C2 不独立决定页号。

### Group C（C1/C2 → `buildRenderSpec.page` → 仅签名）
- `page` 不进 `?page=`，只进 `spec_sig`。
- 危险面不在「渲染错页」，而在**签名一致性**：`spec_sig` 对 `page` 敏感，但 `page` 不进 wire fields → 后端若按 URL 参数重建 spec 再验签，会因缺 `page` 无法复算（是否拒绝由后端实现决定，属独立潜在 bug，**与 +1 无关**）。

---

## 4. 正确转换 boundary（回答用户问题①）

> **`1-based Source pageNum` → `1-based render locator (?page= / renderPage)` 是恒等变换（identity），不需要任何 `±1`。**
> usePreview 当前插入的 `+1` 是凭空多出来的一层，根因是 244/245、1599/1600 两处注释**错误地声称「pageNum 是 0-based」**。

系统内已存在**正确的**转换 boundary（用户担心的「统一移动转换点」其实早就有）：
- `DocumentViewer.jsx:109-111` → `resolvePreviewUrl(currentPage, docId, file)` → **`PreviewResourceResolver`**（注释 107 明写「使用 sourceDocId + pageNum 拼接 URL」）。这是官方 resolver 路径，不做 +1。
- `DisplayAdapter.jsx:96` 作为同目的参照：直接 `?page=file.pageNum`。
- `useViewerState.js:78`：`fileObj.pageNum - 1` 是「1-based → 0-based 内部 index」的**唯一正确**位置（若某处需要 0-based locator，应在那一层做 `-1`，而非在 Source 层 +1）。

**结论**：D20/C8 的修复边界 = **删除 usePreview 内凭空的 `+1`**，而非新增转换点。也更优做法是让 usePreview 的预览 URL 走 `resolvePreviewUrl`（与 DocumentViewer 一致），从根上消灭手写 +1。

---

## 5. 「危险修复」分析（回答用户问题②：谁真正依赖当前 +1）

用户担心的形态：
```
错误的 Source pageNum → 简单删除 +1 → 表面修好 PDF preview → 却破坏已用 0-based internal locator 的调用者
```

**逐组验证：**

| 组 | 删 +1 后行为 | 是否破坏 0-based 调用者 | 结论 |
|---|---|---|---|
| B1/B2 | `?page=file.pageNum`（1-based），与 DisplayAdapter 完全一致；拆分页首页回到 `?page=1`；非拆分 `?page=1` 不变 | 否（无调用者依赖 +1 后的 `?page=`） | ✅ 安全修复，且消除 N6 |
| A1/A2 | `documentState.pageNum` 由 2-based 变 1-based | 否；唯一外部消费者 `exportSnapshotBuilder:89` 正需要 1-based 导出页 → **变正确** | ✅ 安全修复（消除被 previewPage 掩盖的导出 off-by-one） |
| C1/C2 | 仅改变 `spec_sig` 里的 `page` 值 | 否（不进 `?page=`） | ⚠️ 须同步处理签名：要么从 `buildRenderSpec` 调用里**移除 `page` 参数**（它本就不进 wire），要么确认后端签名校验容忍缺 `page`。**不应为保留签名而保留 +1** |

**关键安抚**：用户设想的「0-based internal locator 调用者」在本 6 点范围内**不存在**。
- 真正需要 0-based 的地方是 `useViewerState`（用 `pageNum - 1`），它读 `fileObj.pageNum` 原始值，不读 `documentState.pageNum`，不受 A1/A2 改动影响。
- 没有任何代码把 `documentState.pageNum`（A1/A2 产出）当作 0-based 来用。

> 但「不存在」是基于本轮 grep 证据（所有 `pageNum` 消费点已普查，见 §7）。**真正动手前仍须对每个消费点逐一复核**，不可假设。

---

## 6. 两条平行的预览 URL 构造路径（架构发现）

| 路径 | 代码 | base 处理 | 状态 |
|---|---|---|---|
| **官方 resolver** | `DocumentViewer.jsx:111` → `resolvePreviewUrl` → `PreviewResourceResolver` | `sourceDocId + pageNum`（1-based，无 +1） | ✅ 正确 |
| **usePreview 手写** | `usePreview.js:1311/1358` → `(pageNum??0)+1` → `buildPreviewUrl` | 双加 +1 | 🔴 错（N6） |

usePreview 的预览 URL 是**绕开官方 resolver 的遗留平行实现**，正是 D20/C8 的温床。修复的「优雅形态」是让 usePreview 也走 `resolvePreviewUrl`，而非继续手写 +1；但最小安全修复（Pass 2 收口动作）只需删 +1，与 `DisplayAdapter` 对齐即可。

---

## 7. 证据普查范围（claim 的支撑）

本轮对 `frontend/src` 全量 grep `pageNum`（`*.{js,jsx}`），覆盖：
- 6 个 `+1` 消费点（usePreview 247/635/1311/1358/1602/1669）。
- 正确参照：`DisplayAdapter.jsx:96`、`useViewerState.js:78`、`DocumentViewer.jsx:107-111`。
- `documentState.pageNum` 唯一外部消费者：`exportSnapshotBuilder.js:89`。
- 其它 `pageNum` 用法（`docFacts.js:108`、`useFileOps.js:806`、`buildPrintExecutionPlan.js:152`、`usePrint.js:575` 等）均**直接读 `fileObj.pageNum`**，不受本 6 点 `+1` 影响（其中 `usePrint.js:575` 把 `pageNum` 误命名为 `pageIndex` 属独立命名问题，不入 Pass 2）。

---

## 8. 待确认修复方案（不在此轮执行）

**选项甲（最小安全，推荐收口动作）**：
1. B1/B2：`pageForPreview = fObj.pageNum ?? 1`（删 `+1`），与 DisplayAdapter 对齐。
2. A1/A2：`pageNum: loadedFile.pageNum ?? 1`（删 `+1` + 删错误「0-based」注释 244/245、1599/1600）。
3. C1/C2：从 `buildRenderSpec(...)` 调用中**移除 `page` 参数**（它不进 wire，仅污染签名）；若签名校验需要 page，改由 base URL 的 `?page=` 反推，而非在 spec 里塞 +1 值。
4. 不动 `previewPage` 分支（它本就是 1-based，正确）。

**选项乙（更优，工作量更大）**：usePreview 预览 URL 改走 `resolvePreviewUrl`/`PreviewResourceResolver`，删除手写 `+1 + buildPreviewUrl` 平行路径，与 DocumentViewer 单一化。

**无论甲/乙，都必须**：
- 修 244/245、1599/1600 两处错误「0-based」注释（否则下一任开发者会再次 +1）。
- 跑 `frontend/test/pageBaseContract.m1a.test.mjs` + `backend/tests/test_m1a_split_pdf_page_base.py` 守护。

---

## 9. 运行时验证（N6，独立跟踪，不阻塞 Pass 2）

即使静态已定罪，仍建议单独立项确认：
1. RE preview 是否真的命中（拆分页 `?page=2` 是否被后端渲染成父 PDF 第 2 页）。
2. RE 失败时是否 fallback 到 Canvas/pdfjs 路径（掩盖错页）。
3. 用户最终看到的是错页还是正确页。
4. PDF / OFD / 拆分页表现是否一致。

**N6 与 Pass 2 解耦**：N6 是「症状可见性」问题，D20/C8 是「静态 contract violation」问题。Pass 2 收口不依赖 N6 runtime 结果。

---

## 10. 变更纪律核验

- ❌ 未修改任何生产代码（本轮仅 Read / Grep）。
- ❌ 未创建 `SourcePageResolver.js` / 修改 Resolver。
- ❌ 未 commit / 未 push。
- ✅ 仅产出本文档（只读审计）。
- ✅ N6 继续独立 runtime-verification 跟踪。
