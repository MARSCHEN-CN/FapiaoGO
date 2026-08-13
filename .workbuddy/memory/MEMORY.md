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
- **16 表**（`sumatra-command-resolver.js`）：实测查表 = 唯一 truth，**不重构为动态推导**；**仅适用直打模型，不适用 bake 路径**（bake 下 270 全倒置）。竖纸 golden baseline 冻结。
- **Sumatra landscape 隐含旋转 = −90°**（实测定论），bake 路径需常量 +90 抵消。
- **E 已实施 `e23107b`**（保留不回退）：`placement_bake.py` phi=`(360+contentRotation+layoutRotation)%360` + `buildBakeSpec` 透传 contentRotation。**⚠️ 该 commit 中的 `main.js` executor offset `landscape?90:0` 已被 G2-R2 移除**（旧规则污染，把 sourceRotation 当命令旋转）；landscape 纸的 +90 executor 补偿改由 32-case Execution Truth Resolver 对应格给出（等价且精炼 blanket-90）。
- **G2 Paper Direction 已实施 `c39ae14`**（保留不回退，零 electron 改动）：仅 `PrintService.js buildPrintSettings()` 补传 `paperOrientation: requestedPaperOrientation(userSettings)`。📌 G2 解冻边界：**G2-R2（2026-08-13 收口）已解冻** `electron/print-settings.js` 与 `electron/main.js`（用户终审令移除 3 个旧注入点）。未解冻：`usePrint.js`、`placement_bake.py`、16表、`RotationResolver`、`margin_contract.py`/`apply_pdf`、`normalize`、Geometry Translator 核心。fit/noscale 仍属 Margin Contract 独立决策。

**T5 真机 FAIL（2026-08-12）**：竖纸 A4×横向方向 → 纸向正确(297×210) 但内容反向90°。根因 = source/fit 路径缺内容方向补偿（`print-settings.js:292` `contentRotation!==0` 短路跳过 rotate）。→ **C-2-G = BLOCKED**（待物理 Gate）；**G2-R2 已于 2026-08-13 收口**（Execution Truth Resolver 替代旧注入）。

**32-case Truth Matrix（用户实测）**：4 轴 `invoiceOrientation × rotation(0/90/180/270) × paperType(竖纸/横纸) × paperOrientation(2)` = 32。Table A(横纸,rotate∈{90,270}) = Table B(竖纸,rotate∈{0,180}) **+90° 恒定偏移**（逐格，强证据非物理证明）。T5 查 Table B → **candidate=`landscape,rotate=180`**（非 §误配的 `ROTATE_MATRIX[portrait][landscape][0]=270`，那是横纸值；270−180=90 恰为跨矩阵偏移，自洽）。**T5 FROZEN=UNKNOWN**，须真机复核才升 frozen。纪律：物理实测→Truth→矩阵一致性→冻结，禁反向推导。

**🔒 G2-R2 架构（Execution Truth 层，2026-08-13 已完成收口，几何引擎仍 FROZEN）**：
```text
32-case Truth {orientation, rotate}
   ↓ Geometry Translator（R6 公式，见下）
margin_contract.apply_pdf {nativePaperW, nativePaperH, contentRotation}   ← margin 常量 3mm
   ↓ Final PDF: MediaBox=目标纸, /Rotate=0
Sumatra noscale
```
- 🔴 **命名纪律**：Sumatra `fit`（执行期，被 D2 禁）≠ 应用层 `contain-fit`（apply_pdf，配 noscale）。**禁共用 `fit`**。
- **R6 双重交换已收敛为精确 Translator 公式**：`apply_pdf` 无 orientation 参数，输出方向由 `policy_a(native, contentRotation%180)` 唯一推导。translator：`r=rotate%180; nativeOri = (r==90)? swapped(orientation) : orientation;` 把 native 纸 width/height 指派为 nativeOri 形状；`orientation` 只一次性决定 native 指派，policy_a 做唯一 swap，绝不二次传 orientation。自检：T5 landscape+180→native 297×210→policy_a portrait-swap? 否(θ%180==0)→landscape ✅；Gate2 landscape+0→297×210→landscape ✅。
- **Gate 序列**：Gate1 ✅ 代码级 PASS（apply_pdf 已是真正 contain-fit，fit 目标=inner area，非 clip，非新引擎）；Gate2 = A/B 非 T5（A:Sumatra fit vs B:app rotate→contain-fit→inner area→noscale，比 方向/四边距/内容尺寸/裁切/R6）；Gate3 = T5 单变量物理复核（candidate rotate=180, noscale）。**implementation 已批准并推进（2026-08-13 末起）**。
- **实现就绪审计（只读）**：`c2g-r2-implementation-readiness.md`。Truth 已在 `ps`：`orientation=ps.paperOrientation`(PrintService.js:79)、`rotate=ps.sourceRotation`(PrintService.js:69)。Gate2 case 默认 3mm 边距→落 margin 路径(main.js:569)已走 apply_pdf，纯 source `else`(main.js:605) 不触发→**G1a 延后(D1)**。最终 change set=G1b(main.js:583 补 opts.paperW/H_mm)+G1c(pdfMargin.process 加 contentRotation 槽位→CLI --content-rotation 已支持)+G1d(新建 geometry-translator.js §9.4 纯函数)。noscale 已就位(main.js:600+print-settings.js:301)。
- 🔴 **致命发现**：**禁复用 `normalize()`(print-settings.js:172) 当 Translator**——其 swap 准则=`requestedOrient!==naturalOrient`(纸向 vs 内禀)，与 §9.4 的 `rotate%180==90` 不同；对 landscape+90 会再被 policy_a swap 成 portrait（双重交换）。G1d 必须全新独立、且几何路径只消费 G1d 输出。
- 审计文档：`c2g-r2-content-rotation-causal-audit.md` / `c2g-r2-32case-truth-matrix-audit.md` / `c2g-r2-truth-driven-state.md` / `c2g-r2-fit-margin-audit.md` / `c2g-r2-fit-margin-resolution.md`（§9/§10/§10.6 为终态）/ `c2g-r2-wiring-audit.md`（生产链接线审计）。
- **Gate 2 实施进度（2026-08-13 末启动）**：G1d 已新建 `electron/print-service/geometry-translator.js`（§9.4 纯函数，独立不依赖 normalize）+ `geometry-translator.test.js`（8 组合+负向控制 B9）；G1c `pdfMargin.process` 已加 `contentRotation` 槽位（→CLI --content-rotation，rotate=0 省略）；G1b `main.js` margin 路径(L573-614) 已接 Translator：取 `settings.paperOrientation`/`sourceRotation` + `resolvePaperMmFromSettings` → `translateGeometry` → 透传 `paperW/H_mm, contentRotation` 作 `opts` 第5参。**执行验证待跑**（本回合 shell infra 故障未能 `node --test`/golden/chain-check）。**纪律守**：margin_contract.py / add-pdf-margins.py / bake / 16表 / RotationResolver 全未动；未复用 normalize()；G1a 纯 source 仍延后(D1)。T5 `rotate=180` 仍 candidate。
- **终态裁决(用户终审 2026-08-13 收口)**：不再优化 `apply_pdf` 算法（已有单 CTM+Form XObject+inner-area contain+scale≤1+/Rotate=0，即最优）。唯一可优化=margin 表达/调用边界/几何阶段数，非换算法。冻结：① margin 属 Paper Geometry Contract(`margin_mm=3`→`expandMarginSymmetric`→LTRB 仅引擎内部；3mm=physical paper inset 非 source page inset) ② 无中间 PDF(已满足) ③ margin 非独立步骤(`fitTarget=Paper-margins`,placement 一次算) ④ 几何权威收回 App(Sumatra 仅 executor) ⑤ 边界守 `noscale≠物理3mm`(打印机 unprintable area 是 D2 physical precondition，非引擎能解) ⑥ 三层准确性=几何(apply_pdf)/执行(D2 noscale)/物理(打印机) ⑦ Translator 单入口(所有几何路径走 `Truth{orientation,rotate}→{nativePaperW/H,contentRotation}→apply_pdf`，Margin 层永不知 orientation，根治 rotation drift) ⑧ 优先级 G1a/b/c/d ≫ margin_contract，只收接线不碰引擎。顺序严格 golden→wiring→Gate2→Gate3。详见 `c2g-r2-wiring-audit.md` §7。
- **Geometry Authority 收敛(§10)**：用户 8 点提案逐点代码核实——#1/#2/#3/#5/#6/#8 已被 `apply_pdf` 满足（单一 CTM、无中间 PDF、scale≤1、pt-native、Margin 不重判 Truth、INV-M1..M10）；#4 margin 对称展开适配器与 #7 几何黄金测试集(`docs/margin_contract_vectors.json`)为新增。路线=保留 apply_pdf 晋升唯一几何权威、消灭纯 source Sumatra fit、统一 noscale；INV-M8(几何只算一次)最关键；INV-M10 边界=`policy_a` 推导输出方向是几何执行非 Print Truth 重判。

### G2-R2 完成态（2026-08-13 · 5/5 完成标准全过）
- **唯一旋转权威 = 32-case Execution Truth Resolver**（新模块 `electron/print-service/execution-truth-resolver.js`，纯函数 `resolveExecutionTruth({paperType, invoiceOrientation, userRotation, requestedPaperOrientation}) → {paperOrientation, rotate}`）。32 条实测矩阵 > 任何抽象公式（用户终审）。
- **commandOrientation 恒等于 requestedPaperOrientation**（32 格全验证）；rotate 由 4 输入查表唯一确定，禁 +90/swap/normalize/natural-orient 推导。横向纸 rotate = 同格竖纸 +90°（mod 360）跨验证规则维持。
- **三处旧注入已断**：① `main.js` bake 路径 `sourceRotation = execOrient==='landscape'?90:0` 移除 → 改 `injectExecutionTruth(settings,{baked:true})`；② `print-settings.js buildPrintSettings` 不再 `commandRotate=sourceRotation` 身份映射 → 消费上游注入的 `commandOrientation/commandRotate`（兜底才解析）；③ `print-backend.js` 移除 `paperOrientation = getPaperShapeOrientation(paper)` 覆盖（G2-R2-5）。
- **单向往架构**：32-case Truth → `resolveExecutionTruth` → `{commandOrientation, commandRotate}` → (Sumatra Executor | Geometry apply_pdf)；无第二旋转 resolver 夹在中间。`main.js` 三路径（bake/margin/source）统一经 `gatherTruthInputs`+`injectExecutionTruth` 注入；bake 语义 `userRotation=0 / invoiceOrientation=请求方向`。
- **5 完成标准**：G2-R2-1 32/32 单测 PASS（`execution-truth-resolver.test.js`）✓ / G2-R2-2 FAIL case 竖向纸+横向发票+0°+landscape → `landscape,rotate=0`（命令串 `landscape,fit,paper=a4`，rotate=0 在 Sumatra 省略）✓ / G2-R2-3 无 `landscape?90:0` 字面量 ✓ / G2-R2-4 无 `commandRotate=sourceRotation` ✓ / G2-R2-5 paperOrientation 不被 natural orientation 覆盖 ✓。
- **测试**：`execution-truth-resolver.test.js`（7 用例：32 格+FAIL 回归+跨矩阵+90°+输入校验+中文别名）、`print-settings.g2r2.test.js`（4 用例：buildPrintSettings 端到端）。共 17/17 print-service 测试 PASS（含未动的 geometry-translator）。
- **C-2-G landscape 纸行为保留**：landscape 纸+landscape 请求对应 Truth 格 = rotate=90（等价旧 blanket-90），故横向凭证纸打印不受影响；resolver 精炼了旧 16 表的 blanket 近似（如 横向纸+portrait 请求 = rotate=90）。
- **下一步（物理 Gate）**：真机复核 T5（candidate `landscape,rotate=180` 仍 UNKNOWN）及横向纸各格方向，再谈 Gate2/Gate3。Geometry Translator / `apply_pdf` / margin contract 本轮未动。

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
