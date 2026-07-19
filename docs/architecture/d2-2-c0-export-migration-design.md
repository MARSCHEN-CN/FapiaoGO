# D2-2-c0 Export Migration Design Audit（只读设计）

> 承接 D2-2-0：live Export 仍走 legacy `/api/export-pdf`。本步只读设计，回答三问并锁定迁移边界，
> 暴露 c1 必须处理的契约细节。**不改代码。**

---

## 0. 结论缩写

```
现状：ExportService 只持有 {mode, files:[{path,name}], outputPath} —— 零几何。
真相：几何源全部已在 App.jsx 协同存在（usePreview 暴露 paperLayout/documentState/fileRotations/previewPage）。

迁移边界（c1）：
  App.jsx（或 useExport 薄桥）从 PreviewState 取几何输入
        ↓ buildExportRenderCommands（createPlacement，export dpi）
  ExportService.startRenderExport(commands)  ── 仅消费，几何无关
        ↓ POST /api/export-render
  backend execute_export_render（零重算）

★ 关键约束：Export 几何必须在 export dpi 下重算，不能转发 Preview 的 @PREVIEW_DPI command。
```

---

## 1. Q1：ExportService 能否拿到 Preview 已有状态？

**现状：不能。** `ExportService.startPdfExport(config)` 仅收 `config = {mode, files:[{path,name}], outputPath}`（ExportService.js:238-266）。`config.files` 来自 `PdfExportConfirmModal` 透传的 `files` prop（PdfExportConfirmModal.jsx:59-65），而该 prop = `files.filter(f => f.status === 'parsed')`，其中每个 `f` 是**业务记录对象**（App.jsx:547-553）：

```
{ key, name, path, printPath, status, invoiceType, ..., fileFormat, previewImage, ... }
```

**无任何几何字段**（无 contentRect / sourceWidth / sourceHeight / rotation / paper / sourceRef）。

**但几何源确实存在且就在调用链上游**（usePreview return，usePreview.js:1830）：

| 几何输入 | PreviewState 来源（usePreview return） | 用于 |
|----------|----------------------------------------|------|
| `contentRect`（可打印区 px） | 由 `paperLayout` + `settings.margins` 推导 | createPlacement 入参 |
| `sourceWidth/Height`（内容固有 px） | `documentState`（per file：源像素 / PDF 页尺寸） | createPlacement 入参 |
| `rotation` | `fileRotations[f.key]`（App.jsx:164 持有） | createPlacement 入参 |
| `paper`（PaperSpec） | `settings.paperSize` + `customPaper` → `resolvePaper` | 命令 paper 字段 |
| `sourceRef.page` | `documentState.pageNum` / `previewPage` | sourceRef |
| `pageCount` | `loadedFile._pdfPageCount`（usePreview.js:217/1419） | 多页判定 |

→ **结论**：迁移不该让 Export 重新算尺寸/旋转/fit（那是第二套几何，正是 D2 要消灭的）。正确边界是
**App.jsx（同时持有 `files` / `preview` / `settings` / `fileRotations`）装配每文件 RenderCommand 输入，交给 ExportService 消费**。ExportService 保持几何无关（纯 consumer），ownership 不变式守住。

⚠️ **多文件几何源未现成**：`usePreview` 仅暴露**当前预览文件**的 `documentState`（usePreview.js:1853 `documentState: documentStateRef.current`）。N 文件导出需 N 份 `documentState`（各自 sourceWidth/Height/pageNum）。c1 必须决定来源（见 §5 开放决策 ①）。

---

## 2. Q2：sourceRef 填充策略（PDF 多页）

**`pageCount` / `pageNum` 已追踪**（usePreview.js:217 `loadedFile._pdfPageCount || 1`、:1500 `loadedFile.pageNum || 1`、state `previewPage`）。

**后端契约强约束**（export_render_schema.py:11-13, 37-48）：
- `sourceRef` 必须由 caller 填 `{path, page}`；**null 拒绝**。
- 约定：`image → page=0`，`PDF → 实际页码`，`OFD → 后续`。

**现状缺陷**：`buildExportRenderCommands`（exportRenderCommand.js:87）发 `sourceRef: null` —— **违反后端契约**，c1 必须改为 `{path: file.path, page: <pdf 预览页 | 0>}`。

→ **结论**：sourceRef 可无猜测地填充（PDF 用预览页 pageNum，image 用 0）。PDF 多页导出（全部页）是产品决策，超出 D2-2：后端当前 `insert_pdf` 只插 `sourceRef.page` 单页（export_render_service.py:166），故 D2-2 导出 = 每文件预览页，与 Preview 一致（Preview≡Export）。

---

## 3. Q3：Legacy 退出策略

- `/api/export-pdf`（legacy，PdfExportService/旧 handler）**保留并存**。D3 `/api/export-render` 已 additive 存在。
- **前端加 feature flag**：`ExportService.startPdfExport` 内分支
  ```
  if (EXPORT_RENDER_ENABLED) startRenderExport(commands)   // → /api/export-render
  else                       startLegacyExport(config)      // → /api/export-pdf（现状）
  ```
  默认 OFF（legacy），c1 端到端验证后 flipping ON。
- **后端 legacy 路由 `/api/export-pdf` 不删**，直到 D4（或用户另行指示）。符合你「等 D4 再删除」。

---

## 4. ★ c1 必须处理的三个契约陷阱（本审计最关键产出）

### 陷阱 A：Export 几何必须在 export dpi，不能转发 Preview command
- Preview 的 `renderCommand` 在 `PREVIEW_DPI`（=72，usePreview.js:560/1501）下计算；后端 `paper_px = mm*dpi/25.4` 用命令里 `paper.dpi`。
- 若直接转发 Preview 的 @72 command 到后端（paper.dpi=300）→ 内容被缩到角落、偏移错位。
- **正确做法**：c1 调 `buildExportRenderCommand` 时，`contentRect` 必须用 **export dpi**（如 300）从同一 PaperSpec+margins 重算（= `(mm - margins) * exportDpi / 25.4`）；`sourceWidth/Height` 用**内容固有 px**（与 dpi 无关）。`createPlacement` 输出的 scale 是比率、offset 是 px@exportDpi，后端在 export-dpi 纸上绘制的**分数占比与 Preview 完全一致**（已手算验证：scale_export=(300/72)*scale_preview 时分数占比相等）。
- 这同时是 D2-3「Preview≡Export」成立的保证：两边同一 createPlacement、同一源尺寸、同一纸/边距，仅 dpi 不同 → 版面分数同构。

### 陷阱 B：paper 字段形状冲突（命名撞车）
- 后端 `paper` 必须是 **`{widthMm, heightMm, dpi}`**（export_render_schema.py:25-26，PaperSpec）。
- 前端 `previewState.js:148` 的 `PaperSpec` 是 **`{paperSize, customPaper, margins}`** —— 与后端同名但**不同形状**。
- Preview 的 `buildRenderCommand` 传 `paper: paperLayout`（PaperLayout，含 marginRect 等）—— 后端**禁止**（schema:27-28）。
- **正确做法**：c1 发命令的 `paper` = 后端 PaperSpec `{widthMm, heightMm, dpi: exportDpi}`，由 `resolvePaper(settings.paperSize, settings.customPaper)`（resolvePaper.js:33 返回 `{widthMM, heightMM}`）+ 选定 exportDpi 派生。**绝不转发 `paperLayout`**。

### 陷阱 C：sourceRef 必填且 page 有意义
- 见 §2。c1 必须填 `{path, page}`，`buildExportRenderCommands` 当前 `null` 需改为真实填充。

---

## 5. c1 开放决策（待你拍板）

1. **多文件 documentState 来源**：
   - (A) 扩展 `usePreview` 维护 `documentStateMap`（按 file key）——单一真源，但改 hook 内部。
   - (B) 导出时从 `fObj` 已挂字段（`_previewImageUrl`/`_pdfData`/`_pdfPageCount`，usePreview.js:1154-1309）重算每文件 command——IO 重读非 fit，ownership 仍守，但重复加载。
   - (C) 把几何写回 `fObj` —— **否决**（业务记录混入渲染几何 = ownership 泄漏）。
   - 倾向 (A) 或 (B)，需你定。
2. **export dpi 来源**：常量 300？或 settings 新增导出 dpi？D3 后端测试用 300。建议前端定 `EXPORT_DPI=300`（陷阱 A 依赖）。
3. **PDF 多页导出范围**：D2-2 仅导出预览页（与 Preview 一致）；全页导出留 follow-up（需后端扩 insert_pdf 多页）。
4. **feature flag 形态**：常量 `EXPORT_RENDER_ENABLED` 还是 settings 开关？建议常量默认 OFF，验证后 flipping。

---

## 6. 推荐迁移边界（薄桥草图，非代码）

```
App.jsx / useExport
  for each parsed file f:
    docState = getDocumentState(f)            // §5 决策①
    input = {
      sourceWidth:  docState.naturalW,
      sourceHeight: docState.naturalH,
      contentRect:  computeContentRect@EXPORT_DPI(paperSpec, margins),  // 陷阱A
      rotation:     fileRotations[f.key] || 0,
      paper:        { widthMm, heightMm, dpi: EXPORT_DPI },            // 陷阱B
      sourceRef:    { path: f.path, page: isPdf(f) ? docState.pageNum : 0 }, // 陷阱C
    }
    commands.push(buildExportRenderCommand(input))   // createPlacement，几何同源
  ExportService.startRenderExport(commands)  → POST /api/export-render
```

`ExportService.startRenderExport` 仅做：POST body=`{commands}`、消费 SSE、回调——与现有 `startPdfExport` 同构，但 body 从文件改为 commands。**几何零重算**。

---

## 7. 对 D4 的影响

无。D4 删 `calculateFitScale`/`calculateCenteredPosition`/`calculateRotatedBounds`/`rotateContentOnPaper` 与 c1 正交（这些本就无 production caller）。但 c1 接线后 `buildExportRenderCommands` 成为 production caller，D4 删除时勿误删 `createPlacement`/`buildExportRenderCommand`。
