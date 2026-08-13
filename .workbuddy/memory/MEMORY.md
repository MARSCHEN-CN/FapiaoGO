# print706 发票打印系统 — 项目记忆（索引式）

> 本文件只存「不变量 + 当前状态索引」。权威源见 docs/ 与各 freeze 文档。

## 冻结契约（改动前必读）

**Identity v1.1**：docId = 后端 `_make_doc_id` content-only sha256[:24]，前端只透传。三层身份 renderDocId（物理页）/ documentId（业务发票含 pages[]）/ pageId（UI），resolver `utils/identity.js`。**禁 `fileObj.key` 进 Render/Fact/Cache**。坑：fitz.prerotate 映射 `{0:0,90:+90,180:180,270:-90}`；Canvas DPI150 vs Render300 ratio=0.5。

**IS-3**（tag `IS-3-impl-freeze`@`ae28be0a`）：⚠️ `disconnect != cancel`（SSE onerror 绝不接 cancel job）。manager 不持 bytes / identity 在 spool 物化 / release 幂等 / `parse_invoice_service(bytes)` 签名冻结 / Ref 只许 `{refId}`。

**导入模型边界**：三因子 InvoiceDocument = ① `sourceDocId`（物理硬边界）② page sequence ③ `invoiceNumber`（业务一致性，**非主键**）。任一字段不得单独作合并主键。

**Invoice Entity Boundary**（tag entity-boundary-v1/v2）：三层 Domain=InvoiceDocument（CREATED→REGISTERED→SEALED→DELETED）/ Projection=Export·Print·Action / Resource=DocumentStore（纯 registry）。`invoiceDocumentId`=领域主键（`resolveInvoiceIdentity` 唯一出口）；ImportSessionStore.documents=唯一列表来源；`deleteInvoiceDocument`=唯一删除入口；Print Preview 不修改实体。

**打印四层隔离**：`InvoiceIdentity ≠ PrintExecution ≠ PrintPreviewRenderResource ≠ ViewerRenderResource`。Simulator 模拟**打印结果**，展示区渲染**原文件**（禁 safeMargin）。`buildPrintExecutionPlan()` 产出 `{strategy, mergeMode, pages:[{type,paper,orientation,source,slots:[{fileId,rotation}]}]}`；**rotation 属 slot 不属 paper；Plan 不含几何**。复用点：`computePaperLayout`(previewState.js:178) / `computeTicketSlots`(SlotLayout.js:48) / `createPlacement`(composePlacement.js:65) / `renderFileToPrintImage`。

**Print Margin Contract v1.0**（`docs/print_margin_contract.md`）：margin = 固定纸坐标系 contain-fit，**非页面扩展**。`/Rotate` 恒 0、旋转烤进内容、`expand_box` 删除。门控 RG-1~4。禁止 bugfix 顺带改契约（§11）。`margin_contract.apply_pdf`（`scripts/margin_contract.py`）是契约 §7.1 唯一几何权威，已是**真正 contain-fit**（fit 目标=inner area，非整纸，非 clip），统一引擎已存在。

**RenderCommand 契约**（`RenderLayoutFactory.js:73-99`，7 条校验）：须有 `version===1` / `placement{scale,offsetX,offsetY}` 有限数 / `rotatedBounds` 正数 / `contentRotation` number / `paper` 非空。🐛 缺任一 → `drawRenderCommand` 静默跳过 = **全白 bitmap**。口诀：**bitmap 尺寸对 + bbox=null ⇒ 先查契约校验**。

**Rotation 权限表**（`RotationResolver.js:4-10`，Commit 2-C 冻结）：Viewer 拥有 contentRotation / PrintPreview 拥有 requestedPaperOrientation 且不可改 contentRotation / PrintPipeline 只执行 placement 不决定旋转。净视觉公式 L35：`最终视觉 = contentRotation(烤入内容) + layoutRotation(纸面适配)`，串行不互相修正。`layoutRotation ∈ {0, −90}`；`placedRect` = **两者都施加后**的包围盒。

## 双轨打印现状（config.js:9 PRINT_PIPELINE.mode='source'）
- 合并/多票 → createPlacement 轨（几何烤进 canvas，Policy B）。单文件 → Sumatra；有 Plan placement 的 PDF 走 `placement-bake-processor.js`（bake 优先跳过 pdfMargin，互斥）；无 placement/OFD/图片保持原生 fit。
- 🔴 安全边距机制不一致：source 轨靠 `main.js` pdfMargin 烘焙（`imgExts` 不含 `.ofd` → OFD 无边距）；canvas 轨走 paperLayout。切轨必须验证 ±0.5mm。
- **Policy A**（冻结，纸面跟随内容旋转）≠ canvas `createPlacement` 的 Policy B（仅限 A4/merge）。画布级旋转是 Policy A 唯一正解（`rotateCanvasCommand`；直接改 offset 会转出画布）。

## C-2 系列终态（2026-08-13 冻结架构）

**已冻结事实（维持）**：
- **C-2-E**：横向凭证纸 = executor capability blocker（驱动无 PostScript 纸，唯一 240×140 dmPaperSize=32767；`paper=postscript` 无效 token）。非 geometry/旋转语义。
- **16 表**（`sumatra-command-resolver.js`）：历史实测查表，仅适用直打、不适用 bake（bake 下 270 全倒置）。⚠️ **已被 32-case Truth 取代且无生产调用方（死代码，残留 R-3）**——清理前须先解决 R-1（`OsLauncherBridge` 仍用 `resolveOrientationCommands`）。
- **Sumatra landscape 隐含旋转 = −90°**（实测定论），bake 路径需常量 +90 抵消。
- **E `e23107b`**（保留）：`placement_bake.py` phi=`(360+contentRotation+layoutRotation)%360` + `buildBakeSpec` 透传 contentRotation。⚠️ 同 commit 的 `main.js` executor offset `landscape→90` 已被 G2-R2 移除（旧污染）。
- **G2 `c39ae14`**（保留）：`PrintService.js` 补传 `paperOrientation: requestedPaperOrientation(userSettings)`。
- 📌 **解冻边界**：G2-R2 已解冻 `electron/main.js` + `print-settings.js`（限 3 个旧注入点）。**仍冻结**：`usePrint.js`、`placement_bake.py`、16表、`RotationResolver`、`margin_contract.py`/`apply_pdf`、`normalize()`、Geometry Translator 核心。`fit`/`noscale` 属 Margin Contract 独立决策。

**T5 已 RESOLVED（2026-08-13 实机 PASS）**：原 FAIL（竖纸 A4×横向纸向 → 纸向对但内容错 90° + 裁切）根因 = **Execution 层 rotation wiring 双重旋转**（`apply_pdf` 已烤入旋转且 `/Rotate=0`，executor 又从旧 `sourceRotation` 再转一次），**非** source/fit 缺内容方向补偿、**非** Geometry/margin。G2-R2 收口后同 case 实机 PASS。

**32-case Truth Matrix（用户物理实测，唯一 Rotation Authority）**：4 轴 `paperType(竖纸/横纸) × invoiceOrientation × userRotation(0/90/180/270) × requestedPaperOrientation` = 32。全表见 **`g2-r2-freeze.md` §2**（代码 `execution-truth-resolver.js: TRUTH_ROWS`）。跨矩阵规则：**横纸格 = 同格竖纸 +90°(mod 360)**，逐格成立——仅作**一致性校验**，**禁作生成来源**。纪律：物理实测→Truth→矩阵一致性→冻结，**禁反向推导**。

**🔒 Geometry 层（`apply_pdf` 引擎 FROZEN；Execution 层见下方 G2-R2 块）**
链路：`Truth{orientation,rotate}` → Translator → `apply_pdf{nativePaperW/H, contentRotation}`（margin 3mm）→ 终态 PDF（MediaBox=目标纸，`/Rotate=0`）→ Sumatra `noscale`。
- 🔴 **命名纪律**：Sumatra `fit`（执行期）≠ 应用层 `contain-fit`（apply_pdf，配 noscale）。**禁共用 `fit`**。
- **R6 公式**（代码权威 `geometry-translator.js`）：`nativeOri = (rotate%180==90) ? swapped(orientation) : orientation`；`orientation` **只一次性**决定 native 指派，`policy_a` 做**唯一** swap，绝不二次传（否则双重交换）。
- 🔴 **禁复用 `normalize()`**(`print-settings.js:172`) 当 Translator——其 swap 准则 `requestedOrient!==naturalOrient` 与 `rotate%180==90` 不同，对 landscape+90 会被 policy_a 二次 swap 成 portrait。几何路径只消费 Translator 输出。
- **终态裁决（冻结）**：**不再优化 `apply_pdf` 算法**（单 CTM + Form XObject + inner-area contain + scale≤1 + `/Rotate=0` = 最优）；可动的只有 margin 表达/调用边界/几何阶段数。3mm = physical paper inset（非 source page inset）；无中间 PDF；margin 非独立步骤（`fitTarget=Paper−margins`，一次算）；几何权威在 App、Sumatra 仅 executor；`noscale ≠ 物理 3mm`（打印机 unprintable area 是物理前提）；**Translator 单入口**，Margin 层永不知 orientation。
- **进度**：G1b/c/d ✅ 已实施（Translator 新建 / `pdfMargin.process` 加 `contentRotation`→CLI `--content-rotation` / margin 路径透传 `paperW/H_mm`）；**G1a 纯 source 延后**（默认 3mm 使生产恒走 margin 路径）。Gate1 ✅；Gate3(T5) ✅ 已由 G2-R2 实机 PASS 达成；**Gate2(A/B fit vs contain-fit) 仍 OPEN**，已非阻塞。
- 文档：`c2g-r2-{content-rotation-causal,32case-truth-matrix,truth-driven-state,fit-margin,fit-margin-resolution,wiring,implementation-readiness}*.md`（终态在 `fit-margin-resolution` §9/§10 与 `wiring-audit` §7/§10，含 INV-M1..M10）。

### 🔒 G2-R2 = FROZEN（实机 Gate PASS，2026-08-13 · `a5adb39` · tag `g2-r2-machine-pass`）
> **权威源 = `g2-r2-freeze.md`**（含 32 格全表、INV-E1..E7、残留项 R-1..R-3、解冻程序）。本条只作索引，冲突以该文件为准。

- **唯一 Rotation Authority = 32-case Execution Truth**（`execution-truth-resolver.js`：`resolveExecutionTruth({paperType, invoiceOrientation, userRotation, requestedPaperOrientation}) → {paperOrientation, rotate}`）。核心不变量：**INV-E1** `commandOrientation === requestedPaperOrientation`；**INV-E3** `sourceRotation` 只作真值输入、永不作命令输出；**INV-E5** `rotate=0` 不进命令串（`landscape,fit` 即 `landscape+rotate=0`）；**INV-E7** bake 路径 `userRotation` 恒 0。
- **三处旧注入永久移除（禁复活）**：`main.js` bake 的 `landscape→90` 硬编码 / `print-settings` 的 `commandRotate:=sourceRotation` 恒等映射（曾致 20/32 错）/ `print-backend` 的 `paperOrientation` 被纸张固有方向覆盖。接线：`main.js:506/:518` → 三路径注入 → `print-settings.js:287-314` 消费（兜底走同一 resolver）。
- **验证**：5/5 标准过 + 17/17 自动化 + 实机 PASS。**裁切消失而 `apply_pdf` 未改 → 根因是 Execution rotation wiring，非 Geometry/margin。** T5 = 横向发票+竖纸+0°+landscape → `rotate=0`（旧 `candidate=180` 系误查竖向发票行，**已作废**）。C-2-G 横向纸 `+90` 由 Truth 横纸矩阵自然给出，凭证纸等价保留。
- ⚠️ **残留 R-1（休眠但危险）**：`OsLauncherBridge.toSumatraArgs` 是**第二命令发射器**，硬编码 `contentRotation:0` → 结构上永不发 `rotate=N`，未接 Truth。仅 `mode='legacy'`（`print-file-direct`）或 intent 管线（`submit-print-job`）可达；`mode='source'` 下 `usePrint.js:1079` 提前 return 使其休眠。**切轨前必须先给它接同一 resolver，否则旋转静默退化为「永不旋转」。** R-2/R-3 见冻结文档。

- ⚠️ **仓库事故（2026-08-10）**：并发 git 写破坏 `.git/refs/` + loose objects（8 commit 消失）。教训：**push 前先 fetch 检查远端**。

## Gate 工程（frontend/test/printGate/）
- 红线：**从 Plan 出发**（`files → buildPrintExecutionPlan → executor → compare`），**禁止 Gate 复制打印语义**。容差 0.5mm / DPI 300。纯函数 Gate ≠ 生产路径 Gate。
- ⚠️ `mask.sum()` 墨水面积对发票失真不可用；改用 bbox 面积/纸面积 ≥15% 防线。IoU 模板匹配只能判「相对模板方向」，**不能判业务正立**。
- 运行坑：① vite `root:'src'` → `/@fs/E:/...` + `?t=` 破缓存 ② vite oxc 比 node 严 ③ `read-file` IPC `{success,data:Buffer}` → `ipcPayloadAdapter` ④ 真实 IPC 名 `window.electronAPI.ipcRenderer.invoke` ⑤ 块注释内 glob 含 `*/` 提前终止 ⑥ 仓库 CRLF，源码守卫切片前先 `.replace(/\r\n/g,'\n')`。
- 跑测试：`node --test test/printGate/gateFramework.test.mjs test/printExecutionPlan.test.mjs test/printExecutionEquivalence.test.mjs test/sourcePrintJobs.test.mjs test/mergePrintJobs.test.mjs`。**别跑 `node --test test/`**（捞到依赖 import.meta.env 的既存技术债）。

## 跨切面事实
- Excel 合计：前端 `excelTotals.js`(roundMoney) ≡ 后端 `excel_exporter.py`(Decimal, +1e-9 避 1.005)。
- OCR：`/parse_invoice`+`/parse_batch` ProcessPool(2)；`/import/batch` ParseJobManager ThreadPool(4)。onnxruntime 用 `backend/venv/Scripts/python.exe`。
- 前端诊断日志必须 `console.log`（addImportLog UI 不渲染）；后端 logger 在 basicConfig 之后。
- 命名域碰撞：`sourceRotation` 在 Viewer 域 = PDF 固有 `/Rotate`，在 Print 域 = 用户 UI 旋转。同名反义。
- 旋转/纸张方向**不跨重启保留**（2026-08-09 产品决策：主进程启动清空 DocFacts.json）；`fileRotations` 是会话内旋转权威，DocFacts 仅作切文件恢复。
- 🔒 **禁止重审计**：展示区 / DocumentStore / invoiceDocumentViewModel / RenderResource / preview cache / row identity。
- 上线遗留：`config.py:53 CACHE_DEBUG` 默认 `'1'`→`'0'`。待清理探针：backend `[PROBE]`/`[ASSEMBLY_ENGINE]`；前端 `[E1]`/`[DIAG-*]`/`[MULTIPAGE-GATE]`。

## 工程纪律
- 每次改码必 commit；`git add` 指定文件后 `git status` 核对再 commit（`**/tests/*`、`docs/` 被 gitignore，需 `git add -f`）。
- **push 必须带 `git -c lfs.locksverify=false`**（否则 git-lfs credentials 报错）。sandbox push 401（无写凭据）→ 用户手动 push。
- ESM/hook 改动验收：eslint `no-undef` 或 import 符号交叉校验，**禁只靠 `node --check`**（漏 import 符号 / 块级作用域 ReferenceError）。
- 给用户的 CLI 命令**必须单行**（PowerShell 续行符踩坑）。
- sandbox `backend/venv` 未跟踪、turn 间 reset；pytest 留用户 CI。
