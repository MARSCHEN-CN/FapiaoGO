# Preview 切换陈旧 `<img>` 根因审查 + 修复

> 触发：用户报告「切换到第二张时内容在左上角 / 切回第一张卡在第二张内容」，经多轮探针与逐行代码追踪，定位到 `previewUrl` 状态与「当前文件渲染路径」未绑定的协调缺陷。

## 一、探针给出的铁证（运行时事实）

用户在 DevTools 分别点击两张文件后跑探针（`.paper img` = `document.querySelector('.paper img')`）：

| 激活文件 | `.paper` 内含 | 结论 |
|---|---|---|
| 第一张 `25322000000330109958_p1.pdf` | **无 `<img>`**（探针=`(none)`） | 走 **canvas 路径**，`previewUrl`=null |
| 第二张 `25447000001115703415_p1.pdf` | `<img>` src=`/preview/0b52ef...?page=1` | 走 **RE `<img>` 路径**，URL 正确 |

**关键反转**：`0b52ef` 是**第二张 25447 的 docId**，URL 切换**完全正确**。之前「URL 不更新」的假设被推翻。真正反常的是——**第一张 25322 根本没走 RE 路径，而是 canvas 路径**（它 `previewUrl` 为 null，故 `PreviewCanvas` 走 L106 `<canvas>` 分支而非 L52 `<img>` 分支）。

## 二、代码链路（每条判断带行号）

`previewUrl` 这个 state 的**全部写入点**（全文 grep `setPreviewUrl`）：
- `usePreview.js:210` `cleanupPreviewUrl` → `setPreviewUrl(null)`
- `usePreview.js:292` 渲染 effect 守卫 `if (!previewFile)` → `setPreviewUrl(null)`
- `usePreview.js:333` **RE 分支内** `setPreviewUrl(url)` ← 唯一写真实 URL 的地方

渲染 effect（`usePreview.js:288-468`）判定路径：
- L301-302：用纯函数算出 `reUrl = getRenderEnginePreviewUrl(previewFile, USE_RENDER_ENGINE_PREVIEW)`，`hasRenderEngineUrl = !!reUrl`
- L333-337：仅当 `hasRenderEngineUrl` 为真，才 `setPreviewUrl(url)` 并 `setPreviewCanvas(null)`
- L356-361：canvas 路径（非 RE）只 `setPreviewImgDims(null)`，**从不调用 `setPreviewUrl`**

`doLoadPreview` 的 `cachedCanvas` 分支（`usePreview.js:870-892`）：
- L873 `skipRenderRef.current = true`
- L879 `setPreviewCanvas(cachedCanvas)` 后直接 `return`
- **该分支永不调用 `setPreviewUrl`**；而 `skipRenderRef` 会让渲染 effect 在 L290 提前 `return`，导致 L333 永远不执行。

## 三、🔴 根本原因（已确认，非推测）

**`previewUrl` 状态没有与「当前文件是否走 RE 路径」绑定。**

- 从 **RE 文件切到 canvas 文件**时：canvas 路径（L356 起）和 `cachedCanvas` 分支都**不复位 `previewUrl`**，`cleanupPreviewUrl`（L210）又只在删除/清空时调用（`App.jsx:169/197`），**普通切换不调用** → `previewUrl` 残留上一个 RE 文件的 URL。
- `PreviewCanvas.jsx:52` 的判断是 `if (previewUrl && displayInfo)`：残留的真值 URL 让本应是 canvas 的文件被误判为 RE，用**上一文件的 `<img>`** + 本文件的 `displayInfo` 尺寸渲染 → 表现为「切回第一张卡在第二张内容 / 左上角缺失」。

该缺陷**与 docId 是否缺失无关**：只要列表里混有 RE 路径与 canvas 路径文件，切换必现。第一张 25322 是 canvas 路径、第二张 25447 是 RE 路径，二者一混，切换即触发。

## 四、✅ 修复（已落地，最小范围）

抽出纯函数 `frontend/src/utils/previewTarget.js` 作为**单一判定来源**，并强制 hook 两个分支对齐不变式 `previewUrl === getRenderEnginePreviewUrl(previewFile)`：

1. `usePreview.js:301-302` 用 `getRenderEnginePreviewUrl` 算 `reUrl`/`hasRenderEngineUrl`（取代内联 `startsWith('http')`）。
2. `usePreview.js:334` RE 分支改用 `const url = reUrl`。
3. `usePreview.js:357-361` canvas 路径补 `setPreviewUrl(null)`（不变式：非 RE 必须复位）。
4. `usePreview.js:880-883` `cachedCanvas` 分支（会绕过渲染 effect）显式 `setPreviewUrl(getRenderEnginePreviewUrl(loadedFile, USE_RENDER_ENGINE_PREVIEW))`。

React 对相同值 `setPreviewUrl(null)` 自动 bail-out，不会额外触发渲染。

## 五、TDD 测试（已加，8/8 通过）

`frontend/tests/preview/previewTarget.test.mjs`：
- `isRenderEngineUrl` / `getRenderEnginePreviewUrl` 各种文件形态（RE pdf / canvas pdf-docId缺失 / 图片 blob / 开关关闭）。
- **切换不变式**：从 RE 文件切到 canvas 文件后，`previewUrl` 必须为 `null`（复现并守护原 bug）。
- 往返切换 RE↔canvas 多轮，最终状态始终对齐当前文件。

运行：`cd frontend && node --test tests/preview/previewTarget.test.mjs` → `# pass 8`。

## 六、相关发现（待办，非阻塞）

### 🟡 A. `App.jsx:554` 对 RE 路径永远命中 loading 遮罩
RE 路径下 `previewCanvas` 恒为 `null`（`usePreview.js:337`），`!displayInfo || !previewCanvas` 永远为真 → 返回 `.canvas-center-overlay canvas-loading`。该 overlay 是 `position:absolute` 居中 `z-index:1`（`canvas.css:119-135`），所以**预览图中央永远叠一个加载圈**（不影响看大图，但观感不对）。
**建议**：L554 条件改为「`!displayInfo || (!previewCanvas && !previewUrl)`」，让 RE 就绪时不再显示 spinner。

### 🟡 B. 第一张 25322 缺 docId → 落 canvas 路径
`loadFilePreview` pdf 分支（`usePreview.js:717-721`）仅在 `fObj.docId` 存在时返回 RE URL；`fileHelpers.js:78` 拆页项带 `data.doc_id`，但 `:95` 单文件回退分支**不传 docId**。第一张是 canvas 路径 ⇒ 它 `docId` 为 null（导入时 `/split_pdf` 未返回 doc_id 或走了回退分支）。这导致它用 pdfjs canvas 而非更清晰的 RE `<img>`。
**建议**：确认后端 `/split_pdf` 对所有导入都返回 `doc_id`；或在 `loadFilePreview` 中当 `docId` 缺失时不退化、改为前端自行计算 docId。

### 💭 C. 遗留诊断代码待清理
`usePreview.js` 的 `window.__PREVIEW_DIAG__` 埋点、`engine.py` 的 `[diag:engine]` print、`PreviewCanvas.jsx` 的 `DIAGNOSTIC` useEffect 均为调试残留，按项目纪律调试完应删除（本次修复未动，便于你复测后清理）。

## 七、验证步骤（请你复测）

1. 导入两张（或更多）发票，其中至少一张走 RE（有 docId）、至少一张走 canvas（无 docId，如 25322）。
2. 点第二张 → 正常显示 RE 图；点回第一张 → **应显示第一张的 canvas 内容，不再残留第二张图**。
3. 反复横跳切换，确认不再出现「卡在旧内容 / 左上角缺失」。
4. 旋转任意文件后切回/切走，确认预览正确更新。
