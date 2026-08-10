# Phase 1-B Step 4 前置审计 — add-pdf-margins.py 依赖矩阵

> 日期：2026-08-10 ｜ 类型：只读审计（C-2 Step 4-2b-2 冻结后）｜ 基线：`dec5a9f`
> 目标：回答「source path 完成 ≠ 可以删 add-pdf-margins.py」——填 OFD / image / legacy print 三列依赖。

## 1. 结论速览

**add-pdf-margins.py 当前不能删。** 依赖它的生产路径仍有 3 条：

| path | 依赖 pdfMargin？ | 依赖 add-pdf-margins.py？ | 说明 |
|---|---|---|---|
| **source PDF + placement**（4-2b 起） | ❌ | ❌ | bake 优先跳过 pdfMargin（4-2b-1 冻结） |
| **source PDF 无 placement**（fallback） | ✅ `process` | ✅ | placement 计算失败 / 旧入口 → 仍走 pdfMargin |
| **source image** | ✅ `process`(isImage) | ✅ | 图片无 bake（hasPlacement 要求 .pdf）→ 走 pdfMargin 图片路径 |
| **source OFD** | ❌ | ❌ | `imgExts` 不含 `.ofd`（main.js:514）——**但因此无边距（既有缺口）** |
| **canvas merged**（print-merged-images） | ✅ `extractMargins` + `DirectPrintHandler.process` | ✅（经 process） | ⚠️ 疑似**双重边距**（见 §4） |
| **direct 轨**（print-file-direct） | ✅ `process` | ✅ | DirectPrintHandler，C-2 范围外（Step 4-D 待评估） |
| **预热** | ⚠️ `checkPythonEnv`（仅探测） | — | 删脚本需同步删 |

## 2. 生产调用点清单（唯一入口 = pdf-margin-processor）

```
scripts/add-pdf-margins.py  ← 唯一被 execFile 调用方：
                                 electron/print-service/pdf-margin-processor.js
                                     ↑ process()/extractMargins()/hasMargins()/checkPythonEnv()
                                       ↑ 4 个生产消费者：
                                         1. main.js print-source-file   L527/553/565
                                         2. main.js print-merged-images L851（仅 extractMargins 数值）
                                         3. DirectPrintHandler         L147（PDF+image process）
                                         4. main.js 预热                L1296（checkPythonEnv）
```

⚠️ **add-pdf-margins.py 无直接生产调用方**——所有调用都经 `pdf-margin-processor.js`。删脚本 ≠ 删 processor（processor 的 `extractMargins`/`hasMargins` 是 JS 纯函数，被 merged 轨与预热依赖）。

## 3. 逐路径判定

### 3.1 source PDF + placement → ❌ 已迁移（C-2 达成）
4-2b-1 起 `bakeEnabled` 时 bake 优先并跳过 pdfMargin。4-2b-2 后走 noscale。**这是唯一完整迁移的路径。**

### 3.2 source PDF 无 placement → ✅ 仍依赖（fallback 是真实存在的）
触发场景：
- `placements[f.key]` 计算失败（`resolveContentPlacement` catch 跳过——如边距超纸，usePrint.js:554-556）
- 非 Plan 入口（直接 executePrint legacy 分支 / 旧调用方）
此时 `bakeEnabled=false` → `hasMargins && imgExts.includes(fileExt)` → `pdfMargin.process`（PDF，expand_box 语义）。
**删除前置**：需决策 fallback 语义——报错提示（拒绝无边距打印）或迁移。

### 3.3 source image → ✅ 仍依赖（图片未进 bake）
`hasPlacement` 要求源 `.pdf`（placement_bake 依赖 pikepdf Form XObject）→ 图片恒 `bakeEnabled=false` → `pdfMargin.process(filePath, margins, isImage=true, ...)` → add-pdf-margins.py 图片路径（img2pdf → 边距）。
**删除前置**：图片先转 PDF 再走 bake（A3V3 报告 §112 已提「图片源 img2pdf 转 PDF 后同 bake 路径」）——需 placement_bake.py 支持图片输入或前置转换，属新工作。

### 3.4 source OFD → ❌ 不依赖（但无边距是既有缺口）
`imgExts = ['.pdf','.png','.jpg','.jpeg','.bmp','.tiff','.tif']` 不含 `.ofd`（main.js:514）→ OFD 走 else 分支无边距处理。
⚠️ **这不是「干净的独立」**：OFD 在 source 轨**从来没有安全边距**（预览有、打印无——print_preview_simulator_freeze 冻结文档 R4 记录）。且 OFD 本身 Sumatra 无法直接打印（需转 PDF），其打印链路（转换点在哪）不在本次审计范围，建议独立跟踪。
**删除前置**：无（不依赖），但 OFD 边距缺口需单独解决。

### 3.5 canvas merged（print-merged-images）→ ✅ 依赖，且疑似双重边距
- L851 `extractMargins(settings)` → 数值传给 `batch-png-to-pdf`（pyscripts/pdf_tool.py:93-113）→ `png_to_pdf_with_margin(png, pdf, margins, dpi)` **已在 PNG→PDF 时烤边距**。
- L888 对同一批 PDF 再调 `DirectPrintHandler.handle` → L147 又 `pdfMargin.process(destPath, margins, ...)`（hasMargins=true 时）。
- **若两个 margins 同源（都是 extractMargins(settings)），则为双重边距**（add-pdf-margins 的 expand_box 对已含边距 PDF 再撑大一次）。⚠️ 未实测（canvas 轨属 C-2 红线，只读标记），建议 Step 4-D（direct 轨 authority audit）一并验证。
**删除前置**：canvas 轨要么弃用 DirectPrintHandler 的 margin 段（batch 已烤），要么保留 process——需 Step 4-D 决策。

### 3.6 direct 轨（print-file-direct IPC → DirectPrintHandler.handle）→ ✅ 依赖
预览确认直打（main.js:445-448），PDF+image 均 `pdfMargin.process`。**这是 C-2 范围外的独立轨**（Step 4-D authority audit 待评估）。
**删除前置**：direct 轨迁移完成前不可删。

## 4. ⚠️ 附加发现：canvas 轨疑似双重边距（既有，未在 C-2 范围）

```
PNG → batch-png-to-pdf（png_to_pdf_with_margin：烤边距①）
    → DirectPrintHandler.handle → pdfMargin.process（烤边距②，同源 margins）
```
同一 margins 烤两次 → 边距翻倍风险。**非本步引入**（C-2 全程未动 canvas 轨）；建议 Step 4-D 实测确认（打印一张 merged 样本量边距）。

## 5. 删除路线图（分步，禁止一步到位）

| 步骤 | 内容 | 前置 |
|---|---|---|
| S1 | source 图片迁移：图片 → img2pdf → placement bake（同 PDF 路径） | placement_bake.py 支持图片输入 / 前置转换 |
| S2 | source 无 placement fallback 决策：报错 or 拒绝 or 保留旧路径 | 产品决策 |
| S3 | canvas merged：确认/修复双重边距；决定 batch 已烤后是否跳过 DirectPrintHandler margin 段 | Step 4-D audit |
| S4 | direct 轨迁移（独立 authority audit） | Step 4-D |
| S5 | 删 add-pdf-margins.py + pdf-margin-processor 精简（保留 extractMargins/hasMargins 纯函数） | S1-S4 全绿 |
| S6 | 预热 checkPythonEnv 清理 + shellGeometryGuard 更新（守卫对象消失） | S5 |

**守卫影响**：`shellGeometryGuard.mjs` 与 `runGate.mjs`（production 快照对比）直接引用 add-pdf-margins.py——删除时需同步更新守卫（或守卫随脚本退役）。

## 6. 结论

- **C-2 范围（source PDF + placement）已完成迁移**，pdfMargin 在该路径零介入。
- **add-pdf-margins.py 删除 = 多轨联动**（source fallback / image / canvas merged / direct / 预热 / 守卫），不可随 C-2 收尾顺带删除。
- 建议顺序：**P0 真实打印验证（C-2 收尾）→ Step 4-D（canvas/direct 轨 authority audit，含双重边距实测）→ 本路线图 S1-S6**。
