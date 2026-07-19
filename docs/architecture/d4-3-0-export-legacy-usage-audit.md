# D4-3-0 Export Legacy Usage Audit（只读）

> 承接 D4-2（`58e41f68`，`EXPORT_RENDER_ENABLED` 默认 true，kill-switch 保留）。
> 本步**只读**：确认 export legacy 的 caller 地图、运行时流量、以及「能否在 D4-3-1 删除」。
> 结论先行：**legacy 现在还不能删 —— D4-3-1 应推迟，直到 render 路径补齐 OFD 覆盖。**

---

## 0. 一句话结论

| 问题 | 答案 |
| --- | --- |
| legacy 还有生产 caller 吗？ | 仅 `useExport.js:155` 的 fallback 分支（flag=false / previewState 缺失 / settings 缺失 时触发） |
| flag=true + 正常状态，legacy 有流量吗？ | PDF/Image 类：**无**。OFD 类：**必须走 legacy**（render 路径无 OFD 处理器） |
| 可以删吗？ | **不可以（现在）**。OFD 输入类在 render 路径零覆盖（D3-3c 推迟），删 legacy 直接破坏 OFD 导出 |
| PrintService 混淆风险？ | 不存在后端 `PrintService` 类；打印走 `render_engine/engine.py`，与 `pdf_handlers` 无关 |

---

## 1. 前端 caller 地图

### 1.1 `startPdfExport`
```
useExport.js:2        import { ..., startPdfExport, ... }
useExport.js:155      const res = await startPdfExport(config, handlers)   ← 唯一生产 caller（fallback 分支）
ExportService.js:238  export async function startPdfExport(...)            ← 定义
ExportService.js:321  注释（与 startRenderExport 协议同构）
exportPaths.test.js   ← 测试（D4-2 新增，验证 fallback 端点）
```
✅ 唯一生产 caller = `useExport.js:155`，且位于 `else` 分支（见 §3 运行时分流）。

### 1.2 `export-pdf` 端点命中（前端生产代码）
```
ExportService.js:262   POST `${BACKEND_URL}/api/export-pdf`          ← 唯一生产 POST 点（在 startPdfExport 内）
ExportService.js:288   GET  /api/export-pdf/events/<taskId>          ← SSE（在 startPdfExport 内）
ExportService.js:397   POST /api/export-pdf/cancel                   ← 取消（在 cancelPdfExport 内）
```
其余命中：`EventStreamConsumer.js:35`（doc 注释）、`ExportTask.js:8`（doc 注释）、`exportConstants.js:11`（doc 注释）、`useExport.js:139`（doc 注释）、`exportPaths.test.js`（测试）。
✅ 没有任何 UI 组件 / 第二个 export 入口直接 POST `/api/export-pdf`。App 只向 `useExport` 注入 `previewState/settings` 参数（D4-2 已确认无隐藏第二出口）。

### 1.3 前端「共享、不可删」项（归 D4-3-1 保留）
```
models/ExportTask.js          ← 路径无关契约，useExport 两条路径共用 createExportTask
models/ExportSession.js       ← session 模型，路径无关
stores/ExportSessionStore.js  ← 同上
EventStreamConsumer.js        ← 两条路径共用 SSE consumer
TaskProgressModal.jsx         ← 两条路径共用进度 UI
```
`ExportTask.js:8` 注释写「/api/export-pdf body」是历史描述，模型本身已路径无关（render 路径也用它）。**D4-3-1 不动这五个文件。**

---

## 2. 后端 caller 地图

### 2.1 `/api/export-pdf` 路由链
```
app.py:1246   from services.pdf_export import PdfExportService, ExportItem
app.py:1251   _export_pdf_service = PdfExportService()              ← 模块级单例
app.py:1252   _export_pdf_executor = ThreadPoolExecutor(...)        ← 模块级单例
app.py:1255   _build_export_items(files, mode, ...)                 ← legacy 参数校验 + 读盘
app.py:1284   _run_export_task(task_id, items, mode, ...)          ← 后台线程入口
app.py:1300   @app.route('/api/export-pdf', ...)  api_export_pdf   ← 路由
app.py:1329   @app.route('/api/export-pdf/events/...')             ← SSE 路由
app.py:1352   @app.route('/api/export-pdf/cancel', ...)            ← 取消路由
```
- 路由是 **HTTP 端点**，仅前端 `startPdfExport` 触发。**无任何后端内部 caller**（grep 无 `requests.post('/api/export-pdf')`、无模块内直接调用）。
- 三条路由 + `_build_export_items` + `_run_export_task` + `_export_pdf_service` 单例 → **全部 legacy-only**。

### 2.2 `PdfExportService` 引用
```
app.py:1246 / 1251         ← 唯一生产 importer（模块级单例）
pdf_export.py:53           ← class PdfExportService 定义
export_stream.py:9         ← 注释（描述其调用链）
export_render_service.py:4 ← 注释（"mirrors export-pdf / PdfExportService"）
tests/*                     ← 测试
```
✅ 唯一生产引用 = `app.py`。`export_render_service.py` 仅注释提及，不 import、不调用。

### 2.3 `pdf_handlers/`（legacy handler 包）
```
pdf_export.py:24           from .pdf_handlers.resolver import PdfExportResolver
pdf_handlers/resolver.py    ← 组合 3 个 handler
pdf_handlers/pdf_handler.py ← PDF：单导出直写 / 合并 insert_pdf
pdf_handlers/image_handler.py ← 图像→临时PDF→insert_pdf
pdf_handlers/ofd_handler.py   ← OFD→栅格化→insert_pdf   ★ render 路径无等效项
pdf_handlers/base.py
```
✅ 整个 `pdf_handlers/` 包**仅被 `PdfExportService` 经 resolver 引用**。新 render 路径（`export_render_service.py`）直接调 fitz `insert_pdf` / `render_executor.insert_image`，**不依赖 `pdf_handlers`**。

### 2.4 后端「共享、不可删」项（归 D4-3-1 保留）
```
services/export_stream.py   ← app.py:1342（legacy events）与 app.py:1442（render events）共用 stream_export_progress
services/task.py            ← task_registry 两条路径共用
services/export_render_service.py ← 新路径（目标，非 legacy）
services/source_adapter.py  ← 新路径 source 层
services/render_executor.py ← 新路径 executor
render_engine/engine.py     ← 打印侧（insert_pdf），与 pdf_handlers 无关
```
🔴 **关键修正**：`export_stream.py` 是**共享 SSE 工具**，不是 legacy 专属。D4-3-1 若误删会导致 render 路径 events 路由（app.py:1442）断流。

---

## 3. 运行时流量确认（flag=true）

`useExport.js:137`：
```js
if (EXPORT_RENDER_ENABLED && previewState && settings) {
  // → startRenderExport → POST /api/export-render → execute_export_render
} else {
  // → startPdfExport → POST /api/export-pdf  (legacy fallback)
}
```
| 输入类 | previewState/settings | 实际路径 | legacy 流量 |
| --- | --- | --- | --- |
| PDF / Image | 正常 | **render** | 无 |
| PDF / Image | previewState 缺失 / settings 缺失 | legacy | 有（安全网） |
| PDF / Image | `EXPORT_RENDER_ENABLED=false`（env kill-switch） | legacy | 有（紧急回滚） |
| **OFD** | 正常 | **render 会失败**（见 §4） | **必须走 legacy** |

---

## 4. 🔴 阻塞删除的缺口：OFD 覆盖

`source_adapter.py:11-15` 明确：
> "PDF passthrough (insert_pdf) is a separate route... The caller routes image (and **later OFD**) sourceRefs to this adapter..."

即 render 路径当前只处理：
- **PDF** → `export_render_service.py:79` `doc.insert_pdf(...)` 透传（无损，OK）
- **Image** → `source_adapter.read_source_bytes` → `render_executor.py:139` `insert_image`（OK，但见 🟡）
- **OFD** → ❌ **无处理器**（D3-3c 推迟，OfdExportHandler 仍是 stub/未接入 render 路径）

而 legacy `ofd_handler.py:16`：
> "OFD → render_engine 栅格化 → page image → 临时 PDF → insert_pdf"

是**当前唯一能导出 OFD 的通路**。

➡️ **若 D4-3-1 现在删 legacy，OFD 文件导出将完全不可用。** 这是推迟删除的决定性理由。

### 🟡 次要缺口：Image rotation/fit/clip
D3-3-0 后端审计已记录：legacy `ImageExportHandler` 有 rotation/fit/clip；render 路径 `image_handler` 在 Case④ 缺口（无 rotation/fit/clip）。旋转过的图像在 render 路径可能错版，legacy 能正确处理。进一步支持「保留 legacy 作图像安全网」。

---

## 5. PrintService 混淆风险 — 不存在

grep `PrintService|class PrintService|import.*PrintService` → **No matches**。
- 后端无 `PrintService` 类。
- 打印侧用 `render_engine/engine.py:387` `page_doc.insert_pdf(...)`（独立路径）。
- `pdf_handlers/` 仅服务 `PdfExportService`（Export），与打印无关。
✅ 删除 `pdf_handlers` / `PdfExportService` 不会影响打印。用户的「不要混淆」提醒在此项目不成立（无同名/交叉依赖）。

---

## 6. D4-3-1 删除名单（锁定，但本次不执行）

> 仅当 §4 缺口关闭后，方可执行。当前**推迟**。

### 前端可删
| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `ExportService.js` | 228-400 区段 | `startPdfExport` + POST/SSE/cancel 三端点 |
| `useExport.js` | 2, 154-158 | `startPdfExport` import + `else` fallback 分支 |

### 后端可删
| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `app.py` | 1246-1252, 1255-1360 | import + 单例 + `_build_export_items` + `_run_export_task` + 三条路由 |
| `services/pdf_export.py` | 整文件 | `PdfExportService` |
| `services/pdf_handlers/` | 整包 | base / resolver / pdf_handler / image_handler / ofd_handler |

### 前端共享（保留）
`models/ExportTask.js` · `models/ExportSession.js` · `stores/ExportSessionStore.js` · `EventStreamConsumer.js` · `TaskProgressModal.jsx`

### 后端共享（保留）
`services/export_stream.py`（两条路径共用 SSE） · `services/task.py` · `services/export_render_service.py` · `services/source_adapter.py` · `services/render_executor.py` · `render_engine/engine.py`

### 后端测试（随删）
`tests/test_export_post_contract.py` · `tests/test_export_pdf_endpoint.py` · `tests/test_pdf_export_service.py` · `tests/test_pdf_export_resolver.py` · `tests/test_pdf_handler.py` · `tests/test_image_handler.py` · `tests/test_ofd_handler.py`

---

## 7. 建议与下一步

1. **D4-3-1 推迟**，不要现在删 legacy。原因：OFD 输入类在 render 路径零覆盖（§4 阻塞）。
2. **保留 kill-switch + fallback**（D4-2 已落地）——它同时是 OFD 的隐式回退通道（previewState 正常时 OFD 也走 render 会失败，需显式保证 OFD 落 legacy）。
   - 💭 建议：在 `useExport.js:137` 的谓词加 `sourceType !== 'ofd'` 守卫，让 OFD **显式**走 legacy，避免 render 路径对 OFD 报错。这是比「等 OFD 接入」更稳的过渡方案（独立小步，不属 D4-3-0）。
3. **D3-3c 复工**：把 `OfdExportHandler` 接入 render 路径的 source adapter（source_adapter 增加 OFD 分支 → 栅格化 → insert_image），关闭 §4 缺口。
4. 缺口关闭 + 观察周期后，再按 §6 名单执行 D4-3-1，并跑验收：
   - `grep export-pdf` 生产代码 0 命中（仅 audit docs / fallback 守卫注释）
   - `npm run build` + 前端测试绿
   - 后端 `pytest` 绿（删前先移走 §6 列出的 legacy 测试）

---

## 8. 验收目标（本审计自身）
- ✅ 前端 `startPdfExport` 唯一生产 caller = `useExport.js:155`（fallback）
- ✅ 后端 `/api/export-pdf` 无内部 caller，仅前端触发
- ✅ `pdf_handlers` 仅 `PdfExportService` 引用
- ✅ `export_stream.py` / `ExportTask.js` 识别为共享、不可删
- ✅ 后端无 `PrintService`，打印路径独立
- 🔴 发现 OFD 覆盖缺口 → legacy 推迟删除
- 工作树无源码改动（本步只读）
