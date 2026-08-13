# print706 发票打印系统 — 项目记忆（索引式）

> 本文件只存「不变量 + 当前状态索引」。权威源见 docs/ 与各 freeze 文档。

## 冻结契约（改动前必读）

**Identity v1.1**：docId = 后端 `_make_doc_id` content-only sha256[:24]，前端只透传。三层身份 renderDocId（物理页）/ documentId（业务发票含 pages[]）/ pageId（UI），resolver `utils/identity.js`。**禁 `fileObj.key` 进 Render/Fact/Cache**。坑：fitz.prerotate 映射 `{0:0,90:+90,180:180,270:-90}`；Canvas DPI150 vs Render300 ratio=0.5。

**IS-3**（tag `IS-3-impl-freeze`@`ae28be0a`）：⚠️ `disconnect != cancel`（SSE onerror 绝不接 cancel job）。manager 不持 bytes / identity 在 spool 物化 / release 幂等 / `parse_invoice_service(bytes)` 签名冻结 / Ref 只许 `{refId}`。

**导入模型边界**：三因子 InvoiceDocument = ① `sourceDocId`（物理硬边界）② page sequence ③ `invoiceNumber`（业务一致性，**非主键**）。任一字段不得单独作合并主键。

**Invoice Entity Boundary**（tag entity-boundary-v1/v2）：三层 Domain=InvoiceDocument（CREATED→REGISTERED→SEALED→DELETED）/ Projection=Export·Print·Action / Resource=DocumentStore（纯 registry）。`invoiceDocumentId`=领域主键（`resolveInvoiceIdentity` 唯一出口）；ImportSessionStore.documents=唯一列表来源；`deleteInvoiceDocument`=唯一删除入口；Print Preview 不修改实体。

**打印四层隔离**：`InvoiceIdentity ≠ PrintExecution ≠ PrintPreviewRenderResource ≠ ViewerRenderResource`。Simulator 模拟**打印结果**，展示区渲染**原文件**（禁 safeMargin）。`buildPrintExecutionPlan()` 产出 `{strategy, mergeMode, pages:[{type,paper,orientation,source,slots:[{fileId,rotation}]}]}`；**rotation 属 slot 不属 paper；Plan 不含几何**。复用点：`computePaperLayout`(previewState.js:178) / `computeTicketSlots`(SlotLayout.js:48) / `createPlacement`(composePlacement.js:65) / `renderFileToPrintImage`。

**Print Margin Contract v1.0**（`docs/print_margin_contract.md`）：margin = 固定纸坐标系 contain-fit，**非页面扩展**。`/Rotate` 恒 0、旋转烤进内容、`expand_box` 删除。门控 RG-1~4。禁止 bugfix 顺带改契约（§11）。

**RenderCommand 契约**（`RenderLayoutFactory.js:73-99`，7 条校验）：须有 `version===1` / `placement{scale,offsetX,offsetY}` 有限数 / `rotatedBounds` 正数 / `contentRotation` number / `paper` 非空。🐛 缺任一 → `drawRenderCommand` 静默跳过 = **全白 bitmap**。口诀：**bitmap 尺寸对 + bbox=null ⇒ 先查契约校验**。

**Rotation 权限表**（`RotationResolver.js:4-10`，Commit 2-C 冻结）：Viewer 拥有 contentRotation / PrintPreview 拥有 requestedPaperOrientation 且不可改 contentRotation / PrintPipeline 只执行 placement 不决定旋转。净视觉公式 L35：`最终视觉 = contentRotation(烤入内容) + layoutRotation(纸面适配)`，串行不互相修正。`layoutRotation ∈ {0, −90}`；`placedRect` = **两者都施加后**的包围盒。

## 双轨打印现状（config.js:9 PRINT_PIPELINE.mode='source'）
- 合并/多票 → createPlacement 轨（几何烤进 canvas，Policy B）。单文件 → Sumatra；有 Plan placement 的 PDF 走 `placement-bake-processor.js`（bake 优先跳过 pdfMargin，互斥）；无 placement/OFD/图片保持原生 fit。
- 🔴 安全边距机制不一致：source 轨靠 `main.js` pdfMargin 烘焙（`imgExts` 不含 `.ofd` → OFD 无边距）；canvas 轨走 paperLayout。切轨必须验证 ±0.5mm。
- **Policy A**（冻结，纸面跟随内容旋转）≠ canvas `createPlacement` 的 Policy B（仅限 A4/merge）。画布级旋转是 Policy A 唯一正解（`rotateCanvasCommand`；直接改 offset 会转出画布）。

## C-2 系列状态（2026-08-12）
- **C-2-E**：横向凭证纸 = **executor capability blocker**（驱动无 PostScript 纸，唯一 240×140 dmPaperSize=32767；`paper=postscript` 无效 token）。非 geometry/旋转语义。
- **16 表**（`sumatra-command-resolver.js`）：实测查表 = 唯一 truth，**不重构为动态推导**；**仅适用直打模型，不适用 bake 路径**（bake 下 270 全倒置）。竖纸 golden baseline 冻结。
- **Sumatra landscape 隐含旋转 = −90°**（实测定论），bake 路径需常量 +90 抵消。
- **E 已实施 commit `e23107b`**（E1 `placement_bake.py` 两处 phi=`(360+contentRotation+layoutRotation)%360` + E1a `buildBakeSpec` 透传 contentRotation + E2 `main.js` executor offset 归一 `landscape?90:0`）。验证 INV-R 8/8 / 几何 8/8 / cr=0 字节级 / E2 command shape 8/8。`e23107b` 保留不回退。
- **G2 Paper Direction 已实施 commit `c39ae14`**：仅 `frontend/src/services/PrintService.js` `buildPrintSettings()` 补传 `paperOrientation: requestedPaperOrientation(userSettings)`（与 `resolvePaperSpec` 同源，单一来源），零 electron 改动。数值四象限 Plan==IPC==normalize==dims 8/8；E regression PASS。
  - 🔒 **G2 解冻边界（用户锁定）**：仅 PrintService.js；不解冻 electron/print-settings.js、`usePrint.js` executionPaper 接线、`executionPaper.orientation`、`placement_bake.py`/`placement-bake-processor.js`/`main.js`、resolver、16表、RotationResolver、margin contract、noscale。
  - **G2-R1 镜像审计**（portrait×landscape）：c39ae14 对该组合 change-delta=0（惰性）→ **已证非裁切触发修改**；是否早于 c39ae14 **UNKNOWN**（缺真机 A/B 证据）。
  - 🔴 **T5 真机 FAIL（2026-08-12）**：竖纸 A4×横向 ❌。物理 = 纸已正确 297×210（Paper Direction ✅），但内容反向 90°（成品逆时针转 90° 才正立）。→ **C-2-G = BLOCKED / G2-R2 OPEN READ-ONLY**。
  - **G2-R2 范围已收敛**：原命名「Canvas Paper-Direction Authority Divergence」被 R2-1 证伪——T5 单文件 placement=null→`hasPlacement=false`→走纯 source/Sumatra/fit 路径（不经 bake、不经 canvas）。根因 = **source/fit 路径对「portrait 发票×landscape 纸×0°」缺内容方向补偿**：`print-settings.js:292` `if (orientResult.contentRotation!==0)` 短路跳过 rotate（contentRotation=0 来自 UI rotation=0），暴露 Sumatra `-landscape` 隐含 −90°，内容反向侧躺。理论补偿 `ROTATE_MATRIX[portrait][landscape][0]=270`(`sumatra-command-resolver.js:37`) 但该函数 electron 从未调用。审计 `c2g-r2-content-rotation-causal-audit.md`。
  - **冻结**：`e23107b`/`c39ae14` 均保留不回退；不改代码（不进 RotationResolver/margin/normalize/16表/Canvas 双权威）。修复须用户批准 + 单变量纪律（只针对 portrait×landscape×0° 组合补 rotate，不混入 G3/E1/E1a/E2/横纸×纵向 G2）。
  - 结构债（非 T5 触发层）：canvas 轨 `forcedLandscape`/`documentState.*Orientation` 与 source 轨 `normalize` 是两套方向权威，未统一——真实债但 T5 不走此轨。
  - **32-Case Print Command Truth Matrix（2026-08-12 末，用户实测）**：4 轴 `invoiceOrientation × rotation(4) × paperType(竖向/横向纸张类型) × paperOrientation(2)` = 32。两 16-case 子矩阵：Table A=横向纸张类型(rotate∈{90,270}) **== 既有 `ROTATE_MATRIX`(electron 从未调用)**；Table B=竖向纸张类型(A4 等, rotate∈{0,180}) 新测。跨矩阵不变量：**Table A = Table B + 90°（逐格恒定偏移）**。一致性审计 `c2g-r2-32case-truth-matrix-audit.md`。
  - 🔴 **T5 值修正（paperType 维度，180=candidate 非 frozen）**：T5=竖纸 A4(竖向纸张类型)×横向方向 → 查 **Table B** → **candidate**=`landscape,rotate=180,fit`（非 §五 误配的 `ROTATE_MATRIX[portrait][landscape][0]=270`，那是横向纸张类型值；270−180=90 恰为跨矩阵偏移，自洽）。180 来自「Table B + 跨矩阵 +90° 不变量」**一致性推导，非独立真机验证**；T5 恰是唯一已知物理 FAIL 的 Case → 180 须回真机复测才能从 candidate 升 frozen。**纪律：物理实测→Truth→矩阵一致性→冻结；不可矩阵一致→推导→认为物理正确。** 修复候选=对竖向纸张类型 portrait×landscape×0° 单组合补 rotate=180（绕过 `print-settings.js:292` contentRotation≠0 短路）。
  - **G2-R2 性质变更 + 架构方向**：从「推导旋转算法」→「冻结 32-case Truth → 一致性审计 → 最小 `PrintCommandTruthResolver`(PrintState→SumatraCommand, 不碰 PDF/Preview/Canvas/几何/Margin) → G2-R2 impl」。纪律：paperType 与 paperOrientation 两独立维度；Margin 独立成层。未改生产代码。
  - **G2-R2 状态分叉（2026-08-12 深夜，用户裁决）**：从「算法推导」正式转「物理 Truth 驱动」。三层：①32-case 实测(measured/candidate 数据源，**非全 frozen**；T5 为唯一已知 FAIL 格) ②矩阵一致性(Table A=Table B+90° 逐格，强证据非物理证明) ③T5 candidate=`landscape,rotate=180,fit` / **FROZEN=UNKNOWN**。Gate=数据→Truth→一致性→异常→单点物理复核→Frozen Truth→Resolver→impl（禁反向推导）。Resolver 边界：只答 PrintState→Sumatra 命令，不知 PDF/Canvas/Preview/Margin/placement/Invoice/RotationResolver；第一版直接硬编码两子矩阵，不压缩公式。Margin 独立成层。**当前唯一动作=T5 单变量物理实验**(verticalPaper/portrait/0°/landscape 试 landscape,rotate=180,fit)；**implementation 未批准**。报告 `c2g-r2-truth-driven-state.md`。
  - **🔴 fit×margin 关系审计（2026-08-13，`c2g-r2-fit-margin-audit.md`）**：用户「D2 noscale 前提于 margin≥硬件边」表述**错误**——该检查属独立 Capability Guard(§5.1,只放行/告警/阻断,不得改 fit)，D2(§0/§4)是无条件硬冻结(fit 必按 printable area 再缩 96–98% 破严格边距+引入第二 scale 解释点,§2.3/§2.5)。**F2**:32-case 表只录 orientation+rotate,`fit/noscale` 从未逐格实测→「all 32=fit」是 assertion 非 Truth。**F3**:即便采信 fit 也直接违反 D2,须走 §11 契约变更(推翻 D2+更新 vectors+双侧执行器),Resolver 无权覆盖。**F4**:当前 fit 可能掩盖 desync(§2.4);用户提议实验 `landscape,rotate=0,fit` 改错了轴,正确应为 `landscape,rotate=0,noscale`(只改 rotate 对齐 Truth,scale 维持 D2)。**F5**:scale 策略不归 Resolver「拥有」,属 Margin Contract(D2)职责,Resolver 只引用不裁定。未改生产代码。
  - **✅ fit×margin 冲突解决方案（2026-08-13，`c2g-r2-fit-margin-resolution.md`）**：用户「应用层 contain-fit 到 inner-paper-area + 边距 → 最终 PDF → Sumatra `noscale`」是对 F1–F5 的干净收敛，**不推翻 D2**。代码事实：margin-bake 路径(`main.js:569-604`)与 bake 路径(`main.js:532-568`)已用 `scalePolicy:'none'`(noscale)+应用层几何；**唯一缺口=纯 source 路径(`main.js:605`)仍依赖 Sumatra fit**。`placement-bake-processor.js:99` 明写「fit 会二次变换」。→ 32-case Truth 进一步纯化为 `{orientation, rotate}`，`scalePolicy='noscale'` 是 Margin Contract 常量非 Truth 维度（消解 F2/F3）。命名=Fit-to-inner-paper-area（先 inset margin→inner box→**先 rotate 后** contain-fit），禁「先 fit 满纸再 +margin」。风险 R1:`pdfMargin.process` 对超大 PDF 是否真 contain-fit 还是 clip 须确认；R2 不双重边距；R3 旋转顺序统一；R4 OFD 一致性；R5 与 bake 路径互斥(no-op)。几何实验 A(Sumatra fit) vs B(app-fit+noscale) 用非 T5 case 验证。未改生产代码。
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
