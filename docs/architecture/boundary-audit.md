# 4.2.2-b Boundary Audit — Law 4 全仓验证

> **性质**：纯只读验收，零代码改动。
> **日期**：2026-07-20
> **范围**：`frontend/src` + `electron`（源码，经 `git grep` 排除 `dist/`、`release3/`、`venv/` 构建噪声）。
> **前置**：`object-boundary-contract.md`（Law 4 设计基线）。
> **方法论**：对每一类「禁止操作」做定向 grep + 命中处逐行读源码确认语义，区分「字面匹配」与「真正违规」。

---

## 0. 结论速览

| # | 检查项 | Law 4 约束 | 结果 | 关键证据 |
|---|---|---|---|---|
| B1 | SessionFile 是否存在整体 replace | Replace ❌ | ✅ PASS | `files[..]=` 全仓 0 命中；唯一 splice 是占位替换 |
| B2 | Identity 是否存在手写对象 | Replace ❌ | ✅ PASS | `identity = {` 仅 `identity.js:116`；resolveIdentity 仅 3 处授权点 |
| B3 | Placeholder 是否只有 replace | Replace ✅ | ✅ PASS | 仅 `replaceFileItems` splice；无 placeholder enrich |
| B4 | DocumentState 是否出现 enrich | Replace ✅（非 enrich） | ✅ PASS | `documentStateRef.current = {…}` 整体重建；无字段 mutate |
| B5 | RenderState 是否出现 mutate | Replace ✅ | ✅ PASS | `renderState.* =` 全仓 0 命中 |

**全部 PASS。Law 4 在仓库层面成立，可安全进入 4.2.2-c（F-0 Restore）。**

---

## 1. B1 — SessionFile 无整体 replace ✅

**检查**：是否存在 `files[idx] = newFile` 式整对象替换，或等价 splice 覆盖真实 SessionFile。

**证据**：
- `files\[[^]]+\]\s*=` —— 全仓 0 命中。
- `setFiles(` 调用点（App.jsx / useFileOps.js / usePrint.js / useRenamePack.js）逐一确认，形态仅有四类，**全部合法**：
  - `prev.filter(...)` —— 删除（✅）
  - `prev.map(f => ({ ...f, status: x }))` —— 逐字段富化（✅ SessionFile Enrich）
  - `[...prev, ...newItems]` —— 追加（✅）
  - `setFiles([])` —— 会话起始整体清空（✅，非单对象替换）
- 唯一触碰 `session.files` 的 splice：`ImportSessionStore.js:140`
  `session.files.splice(idx, 1, ...newItems.map(i => createSessionFile(i)))`
  —— 位于 `replaceFileItems`（占位→拆分产物替换），且调用方 `useFileOps.js:288` 有守卫：
  `if (prev[idx].status !== 'splitting' && prev[idx].status !== 'uploading') return prev`
  → 该 splice 实际只置换**占位项**，非真实 SessionFile。属 Placeholder Replace ✅（见 B3）。
- 其余 splice 命中均无关 `files[]`：
  `RenameSettings.jsx:46`（UI 重排列表）、`SettingsWindow.jsx:657-658`（拖拽 newOrder）、`usePrint.js:64`（打印 ref 数组）、`printRunner.js:74`（taskQueue）、`utils.js:469`（优先级队列）。
- `Object.assign(fileObj|loadedFile|f, …)` 整体覆盖 —— 0 命中。

**结论**：不存在对真实 SessionFile 的整对象替换。仅有的一次 splice 隔离在占位替换路径内。**PASS**。

---

## 2. B2 — Identity 无手写对象 ✅

**检查**：是否存在 `identity.js` 之外手写/重赋值的 identity 对象。

**证据**：
- `identity\s*=\s*\{` —— 仅 `identity.js:116`（`updateDocumentIdentity` 内唯一授权构造器）。
- `identity\s*:\s*\{` —— 0 命中。
- `uiKey\s*:` —— 仅 `identity.js:117`（构造器内部）。
- `docId\s*:` 全部命中均为**合法消费或构造器内部**，无手写 identity 对象：
  - `usePreview.js:567` `docId: previewFile.docId` —— RenderCommand 字段，消费预览文件 docId（消费者）
  - `usePreview.js:1518` `docId: loadedFile.docId` —— DocumentState 构造消费（消费者）
  - `parseResultMapper.js:71` `docId: enriched.docId` —— 透传 `updateDocumentIdentity` 返回值
  - `fileHelpers.js:38` `docId: docId || null` —— `resolveIdentity({key,docId,...})` 入参
  - `identity.js:114/118/126` —— 构造器内部
  - `*.test.js` —— 单元测试（按契约豁免）
- `resolveIdentity(` 仅 3 处，全部授权：
  - `fileHelpers.js:22` —— Import 创建（buildFileObj 内）
  - `identity.js:60` —— 定义
  - `identity.js:113` —— `updateDocumentIdentity` 内「identity 缺失」异常兜底（非管道内第二创建点）
- 直接重赋值 `\w+\.identity\s*=` —— 0 命中。
- `files\[[^\]]+\]\.(docId|identity|uiKey|sourceHash)\s*=` —— 0 命中（无绕过 identity.js 的直接写身份）。

**结论**：identity 对象唯一构造点为 `identity.js`，全仓无手写/重赋值。**PASS**（与 Law 1 互证）。

---

## 3. B3 — Placeholder 仅 replace ✅（含时序假设）

**检查**：Placeholder 是否只被整体替换（replace），无任何 enrich 路径。

**证据**：
- 工厂：`placeholderGenerator.js:47` `createPlaceholders(files)`。
- 唯一 splice 置换：`ImportSessionStore.js:133` `replaceFileItems(sessionId, fileKey, newItems)` → `:140` splice，调用方 `useFileOps.js:284`。
- 追加入口：`useFileOps.js:268` `addFilesToSession` + `:275` `setFiles(prev => [...prev, ...placeholders.filter(...)])`。
- 无 `placeholder.xxx =` 式 enrich（grep `placeholder` 命中多为 HTML `placeholder=` 属性、`previewState.js` 的 Fact 占位 `placeholderPaperLayout`，均无关）。

**时序假设（文档化，非违规）**：Placeholder 在 `files[]` 中仅存活于「`addFilesToSession`/`setFiles` 追加（:268/:275）」与「`replaceFileItems` 替换（:284）」之间。拆分经 `enqueueSplit`（:302，并发 4）立即启动；Parse 阶段目标为拆分产物而非占位。因此窗口期内无 enrich 路径命中占位。**当前安全**。

**结论**：Placeholder 操作面仅 `createPlaceholders`（建）+ `replaceFileItems`（整体替换），无 enrich。**PASS**。

---

## 4. B4 — DocumentState 无 enrich ✅

**检查**：DocumentState 是否为 Replace-only（每次加载整体重建），无任何 in-place 字段 mutate（enrich）。

**证据**：
- 大小写不敏感 `documentstate\w*\.[a-zA-Z_]\w*\s*=` —— **仅 1 命中**：
  `usePreview.js:1434` `documentStateRef.current = {`
  → 对 ref 整体赋值为**全新对象字面量** = Destroy+Create（Replace），**非** enrich。
- `DocumentState\.id\s*=` 独立赋值 —— 0 命中。
- 两处 `id:` 字段均为**新建 DocumentState 的对象字面量内部**，非对既有对象 mutate：
  - `usePreview.js:218` 位于 `computeDocumentState(loadedFile)` 的 `return { id: loadedFile.identity?.docId || loadedFile.docId || '', … }`（:215-227）
  - `usePreview.js:1437` 位于 `documentStateRef.current = { id: loadedFile.identity?.docId || …, … }`（:1434-）
  - 二者均从 `loadedFile.identity?.docId` 抽取身份，符合 Law 3（单向消费），且是构造的一部分。

**结论**：DocumentState 仅以整体重建方式存在，无字段级 enrich。**PASS**（与契约「DocumentState = Replace ✅」一致）。

---

## 5. B5 — RenderState 无 mutate ✅

**检查**：RenderState 是否从不 in-place mutate，每次绘制由工厂重建。

**证据**：
- `renderstate\w*\.[a-zA-Z_]\w*\s*=` —— **0 命中**（全仓无任何字段赋值）。
- 工厂：`previewState.js:94` `initialRenderState()`。
- 仅消费方式：`usePreview.js:171` `const [renderState, setRenderState] = useState(initialRenderState())` —— 每次 `setRenderState` 传入全新值。
- 绘制纯执行：`renderers.js:1228` / `render.worker.js:33` 共用唯一 executor `drawRenderCommand(ctx, cmd, …)`（`renderDraw.js:24`），DOM-free、无副作用、不回写 renderState。

**结论**：RenderState 仅以工厂重建方式存在，无任何 mutate。**PASS**（与契约「RenderState = Replace ✅」一致）。

---

## 6. 非违规观察项（Watch-items，供 F-0~F-3 恢复时对照）

以下**不构成当前违规**，但属「边界相邻风险」，在 4.2.2-c~f 恢复 ImportSession 时需主动核对：

- **W1（Rename 追加模式）**：`useRenamePack.js:238` `[...prev, ...newFiles]` 以**追加新 SessionFile** 方式实现重命名，而非就地 `files[idx]=` 替换 → 不违反 B1。但 F-2 恢复时需确保「重命名后的新 SessionFile 保留原 `identity`（docId/sourceHash）」，否则会引入 Law 1 的第二个身份创建点。
- **W2（唯一 splice 红警线）**：`replaceFileItems`（`ImportSessionStore.js:140`）是全仓唯一对 `files[]` 做整对象 swap 的代码，且已正确隔离为占位替换。若 F-0~F-3 引入第二个非占位作用域的 splice/replace → 即本次审计准备捕获的**红色信号**。
- **W3（B3 时序依赖）**：B3 的安全依赖「split 紧跟 placeholder 之后」的时序保证。若 Session 恢复引入异步空隙使占位长期滞留、且有 enrich 路径（queueUpdate/applyFileUpdate）可能命中它 → 会变为「enrich 占位」（B3 违规）。当前 parse 只针对拆分产物，安全。

---

## 7. 最终判定

```
Law 4 — Object Replacement Boundary
  B1 SessionFile Replace ❌   → PASS（无整对象替换）
  B2 Identity   Replace ❌   → PASS（无手写对象，仅 identity.js 构造）
  B3 Placeholder Replace ✅   → PASS（仅 replaceFileItems splice）
  B4 DocumentState Replace ✅ → PASS（仅整体重建，无 enrich）
  B5 RenderState Replace ✅   → PASS（仅工厂重建，无 mutate）

=> ALL PASS
=> 4.2.2-b Boundary Audit 通过
=> 可进入 4.2.2-c（F-0 Restore），恢复代码须逐条对照本审计，
   任何新增 splice/replace/enrich 须经 W1~W3 复核。
```
