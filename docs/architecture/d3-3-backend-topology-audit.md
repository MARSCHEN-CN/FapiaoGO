# D3-3-0 Backend RenderCommand Executor — Topology Audit（只读，无代码变更）

> 冻结纪律：D3-3 第一步只读审计，确认 route / handler / sourceRef / writer 四件事，
> 再决定最小实现范围。本文档为 Boundary-freeze 前置产物，不含任何代码改动。
> 前置约束见 `d3-export-rendercommand.md`（D3-1 边界冻结：PDF 透传保留、RenderCommand 管几何不管介质、禁止 fit/calculate_center/重新布局）。

## 审计结论速览

| 审计点 | 结论 |
|---|---|
| ① Flask route 结构 | 现有导出是干净三层 `route → PdfExportService → Handler`；D3-3 应**新增** `POST /api/export-render`（additive），不碰 `export-pdf`。 |
| ② image/OFD handler | `ImageExportHandler` 当前 `insert_image` 原生尺寸、**无 rotation/fit/clip**（D3-1 预判的 Case ④ 缺口）；`OfdExportHandler` 是 **stub（NotImplementedError）** → D3-3c 实际被阻塞。 |
| ③ Canvas/PDF writer | 主栈 `fitz`（PyMuPDF）；`render_engine/engine.py:_apply_margins` **自带 scale+居中**＝后端第二套 fit **反例，D3-3 禁止复用**。 |
| ④ SourceRef 定位 | 现有 source 由 `files:[{path,name}]`→path→bytes 定位；D3-2 的 `buildSingleFileRenderCommand` 已带 `sourceRef` 字段但**当前 emit `null`** → D3-3 消费前必须先由 caller 填充 `{path, page}`。 |

---

## ① Flask route 结构

现有导出入口（`backend/app.py`）：

- `POST /api/export-pdf`（L1299）：`request.json.files → _build_export_items`（path/base64→bytes）→ `task_registry.create` → `_export_pdf_executor.submit(_run_export_task)` → 立即返回 `{success, taskId}`（**非阻塞**）。
- `GET /api/export-pdf/events/<task_id>`（L1328）：SSE 流读 `ExportTask.to_dict()`，仅封装帧/headers。
- `POST /api/export-pdf/cancel`（L1351）。

分层（pdf_export.py 顶部注释已声明）：`Handler 层`（pdf_handlers/，纯能力）→ `Service 层`（PdfExportService，编排+Task）→ `SSE 端点`（app.py）。

**D3-3 边界**：新增 `POST /api/export-render` 走**同构三层**（route → 新 ExecutorService 或 PdfExportService 新方法 → 薄 command executor），不修改 `export-pdf`、不碰 `insert_pdf`。可先**同步**实现（raster 是逐页、无大 IO），不必照搬 SSE/Task 异步；若要保持一致再补 SSE。

---

## ② 当前 image/OFD export handler（重渲缺口 + stub blocker）

`backend/services/pdf_handlers/image_handler.py`：
- `export_to_pdf`（L24）：`fitz.open(stream=source)` → 取 `pixmap` 原始尺寸 → 建**原生像素尺寸** page → `page.insert_image(Rect(0,0,img_w,img_h), stream=source)` → save。**无旋转、无 fit、无 clip**——image 按原始大小直接嵌入。
- `export_merge`（L59）：走临时 PDF `insert_pdf`，同样无几何处理。

这正是 D3-1 边界冻结里的 **Case ④**：image/OFD「后端自带几何重渲」，但它**现在根本没应用 placement/rotation/clip**，与 Preview（已接 RenderCommand）几何完全脱节。D3-3b 的语义 = 把 `ImageExportHandler` 的「原生尺寸插入」替换为「按 RenderCommand placement/rotation/clip 落到 paper 画布」。

`backend/services/pdf_handlers/ofd_handler.py`：
- `export_to_pdf` / `export_merge` 均 `raise NotImplementedError`（Phase 5 stub）。
- **结论**：OFD 目前不可导出，D3-3c（OFD 接入 RenderCommand）**被 stub 阻塞**。在 OFD handler 真正实现前，D3-3c 无实质目标；建议 **D3-3c 推迟到 OFD handler 落地后**，或本轮直接排除（见下方重排范围）。

`backend/services/pdf_handlers/pdf_handler.py`：
- `export_to_pdf`（L30）写源字节（lossless 透传）；`export_merge`（L61）`insert_pdf`（不重渲）。= D3-1 的 **Case ①/②**，保持透传，**不是 D3-3 目标**。

---

## ③ Canvas/PDF writer 能力

- `fitz`（PyMuPDF）是绝对主力：`fitz.open(stream=image_bytes)`、`page.insert_image(Rect, stream=...)`、`page.get_pixmap(matrix=...)`、`fitz.Pixmap` 做 canvas/copy/transform。
- `PIL` 可用（像素处理）。`reportlab` 源码未实际 import（仅 venv pikepdf 元数据提及）；`img2pdf` 已装。
- **D3-3 executor 首选 `fitz`**：建 paper 尺寸 page → `insert_image` 带 clip/matrix（或 `get_pixmap(matrix=scale)` → 落到 paper canvas）→ 保存 PDF。

### 🔴 反例：不得复用 `_apply_margins`

`backend/render_engine/engine.py:696 _apply_margins` 内部：

```python
scale = min(avail_w / src_w, avail_h / src_h, 1.0)   # 后端自己算 fit
ox = (paper_w - draw_w) // 2                           # 后端自己算居中
```

这是后端**已有的第二套 fit/居中原始**，与前端 `createPlacement` 是两套不变量。
D3-3 若复用它，等于把几何所有权又拉回后端，**直接违反 D3-1「禁止 fit_scale / calculate_center / paper_width - image_width 重新布局」**。
正确做法：把 `RenderCommand.placement.{scale,offsetX,offsetY}` + `contentRotation` + `clip` 当**绝对真理**，薄翻译到 canvas——与前端 `drawRenderCommand` 对称（Executor owns pixels，但 geometry 由 command 给定）。`_open_image_doc`（L680）可复用（纯打开，无几何），`_apply_margins` **不可复用**。

---

## ④ SourceRef 定位（最关键的缺口）

### 现状
- 前端 `useExport.js:handleExportPdf` 发 `files:[{name, path, outputPath}]`；后端 `_build_export_items`（app.py:1254）按 `path` 读 bytes（或 `data` base64）。**source 身份 = 文件系统 path + 可选 page。**
- D3-2 的 `buildSingleFileRenderCommand` 已定义 `sourceRef` 字段（L23/L49/L64：`仅透传不决策，默认 null`）。当前 producer **emit `sourceRef = null`**（前端预览持有 live bitmap，无稳定源 id）。

### D3-3 需要的 sourceRef
RenderCommand 必须能回答「这张图/这一页来自哪」。两候选（均保持命令纯几何）：

- **A（嵌入命令，最小）**：caller 填充 `sourceRef: {path, page}`（page 对 PDF 源多票重排版必填，image/OFD=0）。`POST /api/export-render` 单 envelope `{paper, commands:[{...sourceRef}]}`；后端用 `sourceRef.path` 走 `_build_export_items` 式 path/base64→bytes。命令自描述，复用现有 source 定位。
- **B（分离 sources 数组）**：transport = `{sources:[{id,path,page}], commands:[{sourceId, ...geometry}]}`。sources=数据 / commands=几何 彻底解耦，后端按 id 索引。更结构但多一层 plumbing。

**建议 D3-3b 用 A**（贴合现有「path 定位 source」惯例，单 envelope，命令纯几何因 sourceRef 是不透明引用）；若后续多源编排变复杂再升 B。

### ⚠️ 阻塞依赖（必须先行）
D3-3 消费命令前，**`sourceRef` 必须被填充**。当前 D3-2 producer 输出 `null`。两个最小解法（都不污染 producer 纯度）：
- (i) **Export caller 在构建命令时传入 `sourceRef`**（推荐，最小改动；producer 已支持该参数，只是 caller 现未传）。
- (ii) 扩展 `buildExportRenderCommand` 接收 `sourceRef` 透传。

→ 此依赖是 D3-3b 开工前的**必解项**，应在 D3-3a（schema）阶段锁定。

### 💭 canvas 尺寸 schema 注
命令当前携带 `paper / rotatedBounds / placement / clip`，但**未显式序列化 paper 像素尺寸 / dpi**。后端需 paper px 来建 canvas。
- `buildSingleFileRenderCommand` 已接受 `paper`（truthy 透传），前端 export 时须传**真实 paper 对象**（`{widthMm, heightMm, dpi}` 或现有 paper 结构），后端据此算 `paperPx = {w: widthMm*dpi/25.4, h: heightMm*dpi/25.4}`。
- D3-3a schema 应**要求 export 场景 `paper` 为非 null 对象**（区别于 preview 可省略）；`rotatedBounds`/`clip` 即在该 paper px 坐标系内。若担心歧义，可额外加 `canvasPx:{width,height}`，但优先复用 `paper`。

---

## D3-3 最小实现范围（重排，基于本次审计）

| 子项 | 内容 | 状态 |
|---|---|---|
| **D3-3a** | 只读 schema + 新增 route 骨架 + 校验（字段存在/类型/数值合法）；锁定 `sourceRef` 填充约定 + `paper` 必填；additive，不碰 export-pdf | ✅ 本次产出 |
| **D3-3b** | image source executor：消费 command → fitz paper canvas → 按 placement/rotation/clip 落盘 → PDF。**不复用 `_apply_margins`**。复用 `_build_export_items` 式 path/base64→bytes 取源 | ⏳ 下一步 |
| **D3-3c** | OFD 接入 | 🔴 **推迟**：`OfdExportHandler` 是 stub，无实质目标，待 OFD handler 实现 |
| **D3-3d** | 多票重排版（Case ③）：复用 D3-2 `buildExportRenderCommands` 多命令落到 paper(s)；风险高于 3b，3b 跑通后再做 | ⏳ 3b 之后 |

### 禁止项（D3-3 backend 内）
- ❌ `fit_scale()` / `calculate_center()` / `paper_width - image_width` 类重新布局（含复用 `_apply_margins`）。
- ❌ `zoom` / `viewport` / `window` / 读取 `settings.json` / `printSettings` / React state。
- ❌ 改 `insert_pdf` / `export-pdf` / PDF 原生透传路径。

### No-regression 契约
- image 导出几何 ≡ Preview 单文件预览（同一 `createPlacement` 来源）。
- PDF 原生透传行为不变（D3-1 Case ①/②）。
- 现有 `test_export_pdf_endpoint.py` / `test_image_handler.py` 仍绿（D3-3b 改 image 路径后需扩展该测试覆盖 command 路径，不删旧路径）。
- 新增 `backend/tests/test_export_render_command.py`（node/python contract 可选）：锁 command→canvas 的 scale/offset/rotation/clip 应用正确、无后端几何重算。
