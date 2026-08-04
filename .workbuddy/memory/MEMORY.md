# print706 发票打印系统 — 项目记忆（索引式，2026-08-04 压缩）

> **本文件只存「不变量 + 索引」**。过程叙事一律去仓库根冻结文档看，别往这里堆。
> 权威源：`print_preview_simulator_freeze_2026-08-03.md`（打印模拟器，§1-§14.18）、
> `a3_design_spec_2026-08-03.md`（A3 设计，§7.1 旋转契约）、`docs/render-contract.md`、
> `docs/import-model-boundary-freeze.md`、`frontend/test/printGate/README.md`（Gate 运行指引）。

## 冻结契约（改动前必读）

### Identity Contract v1.1
- docId = 后端 `_make_doc_id` content-only sha256[:24]，前端只透传。
- 三层身份：renderDocId（物理页）/ documentId（业务发票，含 pages[]）/ pageId（UI）。Resolver `frontend/src/utils/identity.js`。
- 纪律：文档级 `identity.docId`、页面级 `pageId`、UI `uiKey`/`file.key`；**禁 `fileObj.key` 进 Render/Fact/Cache**。
- 坑：fitz.prerotate(+θ) 映射 `{0:0,90:+90,180:180,270:-90}`；Canvas DPI150 vs Render300 ratio=0.5；pageNum 不影响文件名。

### IS-3（tag `IS-3-impl-freeze`@`ae28be0a`）
- ⚠️ **`disconnect != cancel`**（SSE onerror 绝不接 cancel job）。
- INv：manager 不持 bytes / identity 在 spool 物化 / release 幂等 / opaque ref 边界 / `parse_invoice_service(bytes)` 签名冻结 / Ref 只许 `{refId}` / cross-process ref 共享 temp root。

### 导入模型边界
- 三因子 InvoiceDocument 边界：① `sourceDocId`（物理隔离硬边界）② page sequence（候选连续性）③ `invoiceNumber`（业务一致性，**非主键**）。任一字段不得单独作合并主键。
- 闸门按 source_doc_id 已提交 job 数判定（1-based page_index 透传 bug 已于 2026-07-29 修复）。

### 打印模拟器四层隔离
`InvoiceIdentity ≠ PrintExecution ≠ PrintPreviewRenderResource ≠ ViewerRenderResource`
- 前三层共享 Document identity + content bytes + PrintConfig；Simulator 模拟**打印结果**，展示区渲染**原文件**（禁 safeMargin）。
- 票种判定（`file.invoiceType`）属 InvoiceIdentity/FileList 职责，Plan 只消费归一化结果、**不重新判定**。
- `buildPrintExecutionPlan()`（原名 buildPrintJobs，改名避 Electron print job 歧义）产出「打印前已确定的物理页面计划」：
  `{strategy, mergeMode, pages:[{type:'single'|'multi-ticket', paper, orientation, source, slots:[{fileId,rotation}]}], extraPages}`。
  **rotation 属 slot 不属 paper；Plan 不含几何。**
- safeMargin 不进模型：渲染时实时 `computePaperLayout(paperSpec)` 算 usableRect（几何约束非数据）。预览旋转走 `previewOverrides`，确认时才合并进 Plan。
- 复用（勿重写）：PaperSpec / `computePaperLayout`(previewState.js:178) / `computeTicketSlots`(SlotLayout.js:48) / `createPlacement`(composePlacement.js:65) / fitIntoSlot / MultiTicketComposer / PageNavigator / `renderFileToPrintImage`。

### 双轨打印现状（`config.js:9 PRINT_PIPELINE.mode='source'`）
- **合并/多票** → createPlacement 轨（renderMultipleItemsToCanvas → MultiTicketComposer → buildRenderCommand → createPlacement，几何烤进 canvas）。
- **单文件** → Sumatra 原生 fit（printAllSourceFiles → print-source-file），不调 createPlacement → **与预览漂移**。
- 🔴 **安全边距机制不一致（头号风险）**：source 轨靠 `electron/main.js:515-553 pdfMargin.process` 烘焙进 PDF（`imgExts` 不含 `.ofd` → **source 模式 OFD 无边距**）；canvas 轨走 paperLayout。切轨必须验证边距 ±0.5mm。
- `add-pdf-margins.py` 语义 = **扩展页面尺寸、内容位置不变**（L189），不是 contain-fit。

## A3 进度（canvas 轨复刻 source 语义）

红线：不改 renderMultipleItemsToCanvas 算法 / pdfMargin / Sumatra / customPaper 新 fit；**RenderResource ≠ Placement ≠ PaperTransform**。

| 阶段 | commit | 结论 |
|---|---|---|
| A3-1 | `a896f50c` | renderFileToPrintImage 携带 paperLayout，bitmap 零变化（**不传第 10 参**，传了会触发 canUseSlotComposer 切路径） |
| A3-2 | `171f850e` | native renderer 双 Gate PASS（rot0 ratio 1.0/0.999、rot90 宽高互换无负坐标）→ R1 rotation 风险解除 |
| A3-3-1 | `a7cad7fc` | paperLayoutContract 扩展 `coordinateSpace` + `sourceOrigin`。**sourceOrigin ≠ margin**（数值同为 10mm 是巧合） |
| A3-3-2 | `4f7d61ba` | placementAdapter 纯层，native + 位移 = source 语义，三 Gate 全绿 |
| A3-3-3 | `c7690257`/`99795974`/`75ba73f1`/`6ca58679` | Policy A 画布级旋转落地 + A3-V1 两坑修复（contract 字段 / 居中 offset），71/71；**Rotation Contract ✅ PASS** |
| A3-V1 | `85284c78`/`43078485`/`6ca58679` | 生产采集器 + 两处真实 bug 修复（全白 / 旋转偏右上） |
| A3-3-2 Placement | ✅ | rot0 探针：left/top anchor <0.2mm 吻合 source（placement+坐标系精确） |
| A3-C5 | ⏸ | Full Fidelity Alignment **BLOCKED**：原「canvas==fitz ≤0.5mm」不可达（fitz 非生产渲染器 + 两引擎 ~3.5mm 不可约差）。建议重定义为 canvas rot0↔rot90 自洽（≤0.5mm 几何闭合），fitz 降为独立 RenderResource 指标 |
| A3-R1 | ✅ CLOSED | rot0 证明残差与 rotation 无关（非整体平移/四边错位），归 RenderResource |
| A3-RF | ⚠️ OPEN（结论非 blocker） | **RenderResource Fidelity**：pdf.js vs fitz 同 box 同 dpi 两 rasterizer 保真度差（宽-1.5mm/高-3.5mm），不可约，非代码 bug/box 选择/Placement/Rotation。**R2(CropBox) 已证伪**（`cropbox_eq_mediabox:true`，两引擎同渲 MediaBox）。A3-3-3-07 自洽 round-trip Gate 已落地（脱离 fitz） |

### A3 硬事实
- **Policy A（冻结）**：纸面跟随内容旋转，rot90 → 2717×1890 → 1890×2717。canvas 现有 `createPlacement` 是 **Policy B**（纸固定、内容在纸内转），仅限 A4/merge 路径。
- **画布级旋转 = Policy A 唯一正确实现**：`drawRenderCommand` 的 `contentRotation` 语义是 Policy B（绕落盘中心在画布内转），直接改 command 的 offset/rotatedBounds 会让内容转出画布。正解 = 两段式：rot0 command 画到扩展纸面画布 → `rotateCanvasCommand` 把该画布整体旋转到新画布。
- **C4 sourceOrigin 不旋转**：它是 paper-space 属性，参与**旋转前**的纸面构造；PaperTransform 作用于已完成的纸面。直接对 sourceOrigin 做 `(x,y)→(y,-x)` 会得负坐标。
- A1 锚点：扩展纸面 2717×1890px（≈230×160mm **专用发票纸，非 A4**），native 2480×1654px，sourceOrigin 10mm=118px。
- C5 rot90 锚点：bitmap 1890×2717 / bbox (201,169,1500×2423) / 边距 L17/T14.3/R16/B10.6mm（rot0 的 L14.3/T16/R10.6/B17 顺时针轮换）。
- 待办：**A3-V2 = Sumatra 真实打印方向验证**（node 采集不体现旋转，只能真机打）。⚠️ 原阻塞于 A3-C5；现 A3-C5 待重定义（自洽 vs fitz），A3-V2 可独立于 RenderResource fidelity 推进——旋转正确性已由自洽 Gate 证明，真机只验证 Sumatra 方向语义。

### RenderCommand 契约（`RenderLayoutFactory.js:73-99`，7 条校验）
必须有 `version===1` / `placement{scale,offsetX,offsetY}` 有限数 / `rotatedBounds` 正数 / `contentRotation` 为 number / `paper` 非空。
🐛 **缺任一 → `drawRenderCommand` 静默跳过绘制 = 全白 bitmap**。
**排查口诀：bitmap 尺寸对 + bbox=null ⇒ 先查契约校验，不是几何问题。** 守卫 Gate `A3-E2E-03/04`。

## Gate 工程（`frontend/test/printGate/`）
- 定位：**验收工程**——Gate 先证明、再切轨。从 Plan 出发（`files → buildPrintExecutionPlan → executor → compare`），**禁止 Gate 复制打印语义**。
- 容差 0.5mm / DPI 300。锚样本在 `test_fixtures/print-gate-anchors/`（gitignored 真实发票，框架只引用路径）。
- **纯函数 Gate ≠ 生产路径 Gate**：A3-V1 就是靠端到端采集抓出纯函数全对但实际全白的缺陷。
- 运行链路坑：① vite `root:'src'` → 用 `/@fs/E:/...` 绝对路径 + `?t=` 破缓存 ② vite oxc 比 node 严（同函数级重复 `const`）③ `read-file` IPC 真实契约 `{success,data:Buffer}`，structured clone 后 data 三形态 → 走 `ipcPayloadAdapter.normalizeReadFileData` ④ 真实 IPC 名 `window.electronAPI.ipcRenderer.invoke`（preload.js:51,92）⑤ 块注释内 glob 字面量含 `*/` 会提前终止注释 → 注释里用文字描述 ⑥ 仓库 CRLF，源码守卫切片前先 `.replace(/\r\n/g,'\n')`。
- 跑测试：`node --test test/printGate/gateFramework.test.mjs test/printExecutionPlan.test.mjs test/printExecutionEquivalence.test.mjs test/sourcePrintJobs.test.mjs test/mergePrintJobs.test.mjs`（当前 70/70）。**别跑 `node --test test/`**——会捞到依赖 `import.meta.env` 的文件（既存技术债，非回归）。

## 跨切面事实
- Excel 合计：前端 `excelTotals.js`(roundMoney) ≡ 后端 `excel_exporter.py`(Decimal, +1e-9 避 1.005)。
- OCR：`/parse_invoice`+`/parse_batch` ProcessPool(2, OCR_WORKERS)；`/import/batch` ParseJobManager ThreadPool(4)。
- onnxruntime：`rapidocr` 不列 install_requires；`requirements.txt` 锁 `onnxruntime==1.20.1`；用 `backend/venv/Scripts/python.exe`。
- 前端诊断日志必须用 `console.log`（addImportLog UI 不渲染）；后端 logger 须在 basicConfig 之后。
- 性能：45s→28s 已收口（Step 4/5A/5B/5C/5D/5E/5F-0/5F-1 + 5.1c `41d1c96a`）。剩余 ~20s = UI 终稳 ~8s + batch 生命周期开销，未开票。
- 🔒 **禁止重审计**：展示区 / DocumentStore / invoiceDocumentViewModel / RenderResource / preview cache / row identity。
- 上线遗留：`config.py:53 CACHE_DEBUG` 默认 `'1'`→`'0'`。
- 待清理探针：backend `[PROBE]`/`[ASSEMBLY_ENGINE]`；前端 `[E1]`/`[ADD DOCUMENT]`/`[MULTIPAGE-GATE]`。

## 工程纪律
- 每次改码必 commit；`git add` 指定文件后 `git status` 核对再 commit（`**/tests/*`、`docs/` 被 gitignore，需 `git add -f`）。
- ⚠️ **push 冲突待用户裁决**：项目旧约定「push 由 UGit 接管，assistant 只本地 commit」vs 用户级强制规则「改完即 push 到 GitHub」。2026-08-04 已按用户级规则推送积压 13 commit 到 `origin/master`。
- **push 必须带 `git -c lfs.locksverify=false`**，否则 git-lfs 报 `Git credentials ... not found` 导致整个 push 失败。
- ESM/hook 改动验收：eslint `no-undef` 或 import 符号交叉校验，**禁只靠 `node --check`**。
- sandbox `backend/venv` 未跟踪、turn 间 reset；managed python 跑 stdlib smoke；pytest 留用户 CI。
