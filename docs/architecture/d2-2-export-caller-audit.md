# D2-2-0 Export Caller 真接线审计（只读）

> 目标：确认「用户点击 Export 时，真正发出去的 commands 就是 Preview 那套 RenderCommand 几何」。
> 方法：只读追踪 Export 调用链 + 抓取 Preview/Export 两路 producer 几何快照比对。
> 结论缩写：**producer 级几何同源已成立；但「真接线」尚未发生——live Export 走 legacy 路径，不发 RenderCommand。**

---

## 0. 一句话结论

```
Producer 层（纯函数）：
  buildRenderCommand (Preview)  ─┐
                                ├─ 都委托 createPlacement ─→ 几何字节同构 ✅
  buildExportRenderCommand (Export) ─┘

Wiring 层（实际调用）：
  Export 按钮 ─→ ExportService.startPdfExport ─→ POST /api/export-pdf {mode,files:[{path}]}
                                          ↑
                                   LEGACY 路径，不含 renderCommands
                                   buildExportRenderCommands 零 caller

  /api/export-render (D3, 收 RenderCommand) ── 前端 0 调用 ✅后端就绪，前端未接
```

**「真接线」当前状态：未接。** 你预设的「Export 已发 Preview 那套 commands」**目前不成立**——live Export 根本不发 RenderCommand。

---

## 1. Export 按钮实际调用链（实测）

```
components/ActionBar.jsx:91
  onExportPdf()  → setShowPdfExport(true)
        ↓
App.jsx:896 onExportPdf={...} / App.jsx:965 handleExportPdf(config)
        ↓
hooks/useExport.js:95 handleExportPdf(config)
        ↓  (config = {mode, outputType, folderPath, fileName, files:[{path,name}]})
services/ExportService.js:238 startPdfExport(config, handlers)
        ↓
POST `${BACKEND_URL}/api/export-pdf`   ← 注意：/api/export-pdf，非 /api/export-render
  body = {
    mode: 'merge' | 'single',
    files: [{ name, path, outputPath }],   ← 纯文件路径，无 geometry / 无 sourceRef / 无 renderCommands
  }
```

- `ExportService.startPdfExport` 全函数（ExportService.js:241-266）只组装 `{mode, files:[{path,name,outputPath}]}`，**无任何 `renderCommands` / `sourceRef` / `buildExportRenderCommand*` 调用**。
- `useExport.js:95-138` 的 `handleExportPdf` 也只搬运 `config.files` 的 path/name，**不构造 RenderCommand**。

**grep 全 src（非 test）确认**：`buildExportRenderCommand` / `buildExportRenderCommands` 的唯一 caller 是 `exportRenderCommand.test.js`。`ExportService` / `useExport` / `App` / `ActionBar` 均未引用。→ **孤儿 producer**。

---

## 2. 后端契约（两侧都已就绪，但前端接的是另一侧）

| 端点 | body | 实际 handler | 几何来源 |
|------|------|--------------|----------|
| `/api/export-pdf`（app.py:1300） | `{mode, files:[{path}]}` | `_run_export_task` → `PdfExportService` / `pdf_handlers`（legacy） | 后端/旧 handler 重推导 |
| `/api/export-render`（app.py:1417） | `RenderCommand[]`（经 `validate_export_render_request`） | `_run_export_render_task` → `execute_export_render`（D3，消费 sourceRef+paper+几何） | 前端 RenderCommand |

- D3 端点 `/api/export-render` 完整实现且 additive（app.py:1364-1449）：`validate_export_render_request` → `execute_export_render(commands)` → `render_sheet_commands`/`_append_pdf_source`。**后端不重算 fit**（export_render_service.py:21-22 grep ban）。
- 但前端 `/api/export-pdf` 发的是 legacy body → 走 `_run_export_task`（legacy）。**D3 管线从未被 live Export 触发。**

---

## 3. Producer 几何同源证明（可在本层锁死）

两 producer 都最终委托 `createPlacement`，因此相同输入 → 相同几何：

| 字段 | Preview `buildRenderCommand`（RenderLayoutFactory.js，D2-1 后） | Export `buildExportRenderCommand`（exportRenderCommand.js:37） |
|------|------|------|
| 几何源 | `createPlacement({contentRect, sourceWidth, sourceHeight, rotation})` | 直接委托 `buildSingleFileRenderCommand` → `createPlacement`（singleFileRenderCommand.js:54） |
| `placement.scale/offsetX/offsetY` | ✅ createPlacement 产出 | ✅ 同 createPlacement 产出 |
| `rotatedBounds` | ✅ 取自 `placement.rotatedBounds` | ✅ 取自 `p.rotatedBounds` |
| `rotation` / `contentRotation` | 透传 | 透传 |
| `paper` | 透传 | 透传 |
| `sourceRef` | 透传 | 透传（但见 §4） |
| **`clip`** | **paper 级**（portrait=`paperLayout.clipRect`，landscape 交换 w/h，D2-1 故意保留） | **contentRect 级**（`p.clip` = createPlacement 安全边距） |

→ **`placement` + `rotatedBounds` + `paper` + `rotation` 四字段在 producer 层逐字节同构**（同一 createPlacement）。这是 D3 不变式「Preview≡Export 几何」在 producer 层的实质证明。

⚠️ **`clip` 是刻意差异（非 bug，D2-1 已批准）**：Preview 用 paper 级 clip（保留边距外内容可见），Export 用 contentRect 级 clip（几何边界）。因此「Preview command === Export command」对 placement 成立，对 clip **不成立**（语义不同）。契约锁测试应断言 placement 相等，并把 clip 差异显式标注为 approved divergence，而非要求字节相等。

---

## 4. 即便要接，producer 现态还有两个后端契约缺口

即便现在把 `buildExportRenderCommands` 接到 `/api/export-render`，仍有两处不兼容，需先修：

1. **多票 producer 发 `sourceRef: null`**（exportRenderCommand.js:87）→ 后端 `execute_export_render` 要求每命令 `sourceRef.path`（export_render_service.py:153-154），会 `raise ValueError`。单票 `buildExportRenderCommand`（:37）正确透传 sourceRef，但**多票路径未填 sourceRef**。
2. **contentRect 来源缺失**：`buildExportRenderCommand(s)` 需要调用方提供每文件的 `contentRect`（可打印区域 px）。live Export 当前只有 `path`，没有从 PaperLayout 算出的 contentRect。接线时 ExportService 必须复用 Preview 的同一 PaperLayout/margin 推导产出 contentRect（否则会退化成第二套 fit —— 正是 D2 要消灭的）。

---

## 5. 三问答复（对应你列的 D2-2-0 清单）

1. **Export button 调用链**：已确认 `UI → useExport.handleExportPdf → ExportService.startPdfExport → POST /api/export-pdf {mode,files:[{path}]}`。**无 re-fit / re-center / re-rotate**（legacy handler 内部是否重算属另一审计，但前端不发几何）。
2. **Preview command snapshot**：`buildRenderCommand(file)`（RenderLayoutFactory.js）现产出 `createPlacement` 几何，字段见 §3。
3. **Export command snapshot**：`buildExportRenderCommands(files)`（exportRenderCommand.js:70）产出 `createPlacement` 几何，但**无 production caller、且多票 sourceRef=null**。
4. **`PreviewCommand.geometry == ExportCommand.geometry`**：**producer 层成立（placement 同构，clip 刻意不同）**；**end-to-end 不成立**（live Export 不发 RenderCommand，走 legacy /api/export-pdf）。

---

## 6. D2-2 验收目标修正建议

原目标「只做 audit + contract lock」在 producer 层可行；但「同一个用户动作 Preview≡Export」的 end-to-end 证明**前提（接线）缺失**。建议 D2-2 拆为两步：

- **D2-2-a（本步，已做）**：只读审计，确认 producer 同构 + 锁定 gap 位置。
- **D2-2-b（contract lock，可立即做）**：新增 producer 级几何同源测试——
  `buildRenderCommand(previewInput)` 的 `{paper, placement, rotatedBounds, rotation}` ==
  `buildExportRenderCommand(exportInput)`（同 `{sourceWidth,sourceHeight,contentRect,rotation,paper}`），
  覆盖 portrait/landscape/rotated/A4/A5/带边距；clip 标注 approved divergence。
- **D2-2-c（真接线实现，原 pending 项）**：`ExportService` 从 Preview 同 PaperLayout 取 contentRect + 自然尺寸 + rotation + sourceRef + paper，调 `buildExportRenderCommands`，改 POST `/api/export-render`（替换 `/api/export-pdf` legacy body）；多票 producer 补 `sourceRef` 填充。此步是「真接线」的实质工作，已超出「只 audit」范围，需你拍板是否并入 D2-2 或独立成步。

---

## 7. 对 D4 的影响

D4 删除 `calculateFitScale`/`calculateCenteredPosition`/`calculateRotatedBounds`/`rotateContentOnPaper` 的安全性**不受本发现影响**——这些函数本就无 production caller（D2-1 已静态确认）。D4 仍可安全进行。

但若要做 D2-2-c 真接线，需确保接线后的 Export 仍只用 `createPlacement`（不引入新 fit 源）。建议顺序：**D2-2-b 锁 → D2-2-c 接线 → 验证 → D4 删 legacy**。
