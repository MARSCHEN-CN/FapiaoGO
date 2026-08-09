# print703 全链路架构与管线梳理（2026-07-30）

> 审查基线：`76d23bf8 feat(identity): IS-4.2 instance identity`
> 范围：从进程启动到纸张输出的**全部六个阶段**。用户已自行完成「阶段 1 导入–文件列表」，本文对该阶段只做边界确认与补充发现，重点在阶段 2–6。
> 性质：**���读审查**，未修改任何源码。

---

## 0. 全局架构：三进程模型

```
┌─────────────────── Electron Main (Node) ───────────────────┐
│ main.js  单实例锁 → whenReady 编排                          │
│   ├─ logger.init()                                          │
│   ├─ pdfMargin.checkPythonEnv()      ← .catch(()=>{}) 吞错  │
│   ├─ initTempManager() / initNewPrintPipeline()             │
│   ├─ PaperRegistryProvider.initialize()                     │
│   ├─ startBackendServer()   spawn python app.py :5000       │
│   │    · 开发模式**直接 return，不启动后端**（需手动跑 Flask）│
│   │    · waitForBackendReady 轮询 /health，250ms×30s         │
│   │    · 失败不阻断窗口创建                                  │
│   ├─ initUpdateManager()                                     │
│   └─ createWindow()  frame:false                             │
│        nodeIntegration:false / contextIsolation:true         │
│        sandbox:true / 导航白名单 / 外链走 shell.openExternal │
│                                                              │
│ IPC 层：ipc-file-ops / ipc-rename / ipc-pack / ipc-db(废弃)  │
│ 打印层：print-service/（SumatraPDF 命令行）                  │
└──────────────────────────────────────────────────────────────┘
              ↕ contextBridge（preload.js，前缀白名单）
┌─────────────────── Renderer (React) ────────────────────────┐
│ App.jsx → contexts → hooks → stores → services → HTTP        │
│ 渲染合成：compose/ + layout/ + renderers.js + render.worker  │
└──────────────────────────────────────────────────────────────┘
              ↕ HTTP / SSE  127.0.0.1:5000
┌─────────────────── Flask Backend (Python) ──────────────────┐
│ app.py（主路由）+ render_engine/api.py（渲染蓝图）           │
│ 解析域：import_batch_manager / parse_job_manager / parsers   │
│ 渲染域：render_engine（registry / engine / cache / queue）   │
│ 持久化：db.py（invoices.json + oplog）、cache.py             │
└──────────────────────────────────────────────────────────────┘
```

**关键事实**：开发模式下 Electron **不会**拉起 Flask（`main.js:699-702`），这解释了为什么本地调试必须手动开后端终端。

---

## 1. 阶段一：导入 → 文件列表（用户已梳理，此处只确认边界）

### 1.1 双管线并存

`config.js:40` 的 `IMPORT_SCALE_V1` 开关决定走哪条：

| 开关 | 前端入口 | 客户端 | 传输 | 后端端点 |
|---|---|---|---|---|
| `true`（当前） | `import/runChunkedImport.js` | `ImportBatchClient.js` | FormData + **EventSource SSE** | `POST /import/batch` |
| `false`（旧） | `useFileOps.js:139` | `ParseBatchClient.js` | fetch + ReadableStream | `POST /parse_batch` |

旧路径代码仍完整存活（`StreamConsumer.js` 被 `useFileOps.js:14/157` 引用），两套状态管道存在漂移风险。

### 1.2 通信协议细节

- `createImportBatch`（ImportBatchClient.js:57）：`CREATE_TIMEOUT_MS=30000`，**超时绝不重试**（防重复批次）。
- `subscribeBatchProgress`（:134）：`GET /import/batch/{id}/events`，终态 `completed/failed/cancelled` 立即 `close()`。
- `cancelImportBatch`（:181）：404 视为幂等成功。
- `getBatchResults`（:216）：3s→5s 重试，带 `_retryable` 标志。

### 1.3 状态所有权

| Store | 拥有什么 | 谁写 | 谁读 |
|---|---|---|---|
| `DocumentStore.js` | 业务 PageMeta（Law D1：**不存渲染资源**） | registerDocument / ensureDocumentFromFileObj / ensureDocumentFromMetadata | Viewer / Print，经 `useSyncExternalStore` |
| `ImportSessionStore.js` | 会话编排、进度、文件状态、结果 | useFileOps / runChunkedImport | FileContext.jsx |
| `ImportFileRegistry.js` | —— | **无人** | **无人** |

`ImportSessionStore.addDocument`（:210）把 DocumentStore 的 InvoiceDocument **双写镜像**进 `session.documents[]`（代码自称「E-1 双写模式」）→ 两份真源，潜在漂移。

### 1.4 身份标识体系（六套 id）

| id | 定义处 | 生成规则 | 语义 |
|---|---|---|---|
| `key` | `fileHelpers.js:12` | `${name}_${Date.now()}_${uuid}` | UI 实例身份，React key |
| `docId` | 后端 `registry.py:325` | `sha256(bytes)[:24]`，**v1.1 起 filename 不参与** | 内容身份 |
| `sourceDocId` | `fileHelpers.js:118` | 父 PDF 物理身份 | 多页归组 |
| `instanceId` | `fileHelpers.js:47/98`（IS-4.2 新增） | 单文件=key；多页 PDF=共享 uuid | **业务实例身份** |
| `pageId` | `InvoiceDocument.js:55` | `${docId}:p${index}` | 页身份 |
| `renderDocId` | `InvoiceDocument.js:52` | `renderDocId \|\| docId` | 渲染能力身份（**前端概念，后端无此字段**） |

**IS-4.2 的价值**：`DocumentStore.resolveDocumentIdentity`（:41-45）把存储主键升级为 `instanceId || docId || id`，使同内容 A/B 两份文件（docId 相同、instanceId 不同）不再互相覆盖。测试固化于 `DocumentStore.identity.test.js:42/55/63`。

---

## 2. 阶段二：解析（Parse）

### 2.1 端到端调用链

```
前端提交 refId 列表
  → ImportBatchManager.create_batch          import_batch_manager.py:224（仅接受 refId）
  → _scheduler_loop                          :429  SUBMIT_WINDOW=50 准入控制
  → ParseJobManager.submit_job               parse_job_manager.py:432
       ThreadPoolExecutor(min(cpu,4))        :330  + QueueProcessor 守护线程 :375
  → _execute_job                             :454  （双取消检查点 :468 / :486）
  → _parse_via_registry                      import_batch_manager.py:273
  → parse_invoice_service(skip_db_write=True) invoice_service.py:137
       ├─ xml   → parse_xml                  :208
       ├─ ofd   → parse_ofd                  :222
       ├─ image → parse_image_ocr            :241
       └─ pdf   → parser_registry.parse      :333 + parse_pdf_with_bbox_from_doc :347
  → _on_job_done                             import_batch_manager.py:617
       ├─ 释放 temp ref                      :638
       └─ PageResultStore.put                :713（桶键 = instance_id）
  → 收齐 → InvoiceAssemblyPipeline
       ├─ group_pages_into_documents         invoice_assembly_pipeline.py:126
       ├─ merge_page_results                 multi_page_merge.py:69
       └─ invoice_document_to_db_record      :268
  → ResultBuffer.add → 阈值 50 → db.batch_upsert_invoices  db.py:962
```

**多页协调分支**：`InvoiceParseCoordinator.parse`（:51）→ `MultiPageAnalyzer.analyze`（multi_page_analyzer.py:76）→ `group_pages`（group_pages.py:53）。

### 2.2 契约与抽象

- `ParseResult` dataclass — `parsers/base.py:16`；`FileMeta` :64；`BaseParser` ABC :82
- `ParserRegistry` :133 — 按 priority 排序：`xml > ofd > pdf_text > pdf_ocr`
- **无独立 `InvoiceDocument` 类**，组装产物是裸 dict
- `contracts/document_layout.py` 只有 `BBox`，无版本化
- `backend/models/` 只有 PaddleOCR 权重（cls/det/keys/rec），**不含任何 Python 数据契约**
- 前端 `contracts/` 目录**为空**，`adapters/`、`contracts/import/` 亦空

### 2.3 持久化

`db.py` 双文件设计：
- `invoices.json` 快照，`SCHEMA_VERSION=2`（:221/:270）
- `invoices.oplog` append-only（:284），缓冲 0.5s / 20 条 flush（:163）
- 压缩阈值 `COMPACT_THRESHOLD=50`（:157），两阶段提交 `.compact_writing → .compact_done`（:582，崩溃安全）
- 4 个内存索引（by_id / hash / filename / number，:195）+ `RWLockFair`（:212）
- 去重三态（`upsert_invoice` :878）：同文件刷新 / 内容重复建独立记录并标 `is_duplicate` / 原件软删则接管

`cache.py`：`CacheManager` 单例，namespace = pdf_text / ocr / fields / preview；TTL 7 天、500MB / 1000 文件；hourly sweep（:212）。
⚠️ **`CACHE_DEBUG` 默认 = 1**（`config.py:53`），**绕过所有缓存**。

### 2.4 生命周期

- 批次状态机：`queued → running → completed / failed / cancelled`（:46），`to_dict` 对 SSE 把 queued 映射为 pending（:94）
- 取消：`cancel_batch`（:409）置标志；`cancel_job`（parse_job_manager.py:540）pending 直取消 / running 置 flag + `future.cancel`
- 临时文件：`TempFileRegistry` 单例（temp_file_registry.py:151），`spool`(:244) 先落盘后登记，`retain`/`release` 幂等，启动 `sweep_stale` 回收 24h 孤儿（:329）

---

## 3. 阶段三：渲染 / 预览（Render）

### 3.1 端到端调用链（RE `<img>` 路径，`USE_RENDER_ENGINE_PREVIEW=true`）

```
usePreview.js:553  buildRenderCommand(paperLayout, {contentRotation,...})   ← 同步，React render 阶段
  → :579  buildRenderSpec(renderCommand, {docId, page, dpi: PREVIEW_DPI})   layout/renderSpec.js:137
  → :587  getRenderEnginePreviewUrl()  ?spec=v1&spec_sig=…&scale&ox&oy&content_rotation
  → :654  startREProbe   ── 异步边界① ──  new Image().src = url
        onload  → probe.decode() → commit() :661-676  原子提交 previewUrl + dims
        onerror → recoverREPreview :703
                    ├─ 探 /metadata → DOC_NOT_REGISTERED
                    ├─ autoRegister :634 → POST /api/documents/open → 重试
                    └─ 仍败 → setReBlockedDocId → Canvas 容灾 renderToCanvas :762（pdf.js）
  → 后端 api.py:70  preview()
        verify_render_spec :95（malformed → 400）
  → _render_and_respond :321 → engine.render
  → engine.py:282  make_cache_key(doc|preset|page|vs_hash+spec_tag) :320-322  ── 缓存命中点② ──
        HIT → 直接返回 :330-332
        MISS → _render_page :396
                 ├─ doc.adapter（OFD）           :420
                 ├─ render_spec is None → _render_legacy_page :427（Frozen Baseline）
                 └─ _render_spec_page :484  ← RenderCommand 纯执行器
                       validate_render_command :907
                       fitz.Matrix(scale).prerotate(映射表 :542)
                       get_pixmap → 白画布逐行 memoryview 粘贴到 (ox,oy) :598-613
                       _encode_pixmap :828
  → ETag / 304  api.py:361-365（/preview 用 must-revalidate 而非 immutable）
  → page==1 触发 prefetch_neighbors 后台线程 :379-384  ── 异步边界③ ──
```

**缓存四层**：浏览器 HTTP(ETag) → 后端 RenderCache → 前端 `committedPreviewRef` → L2 `renderResultCache` / L1 `itemRenderCache`（renderers.js:819/1088）。

`committedPreviewRef`（usePreview.js:739）是 Commit Buffer，防 A→null→B 白板闪烁——这是个干净的设计。

### 3.2 后端资源模型

| 组件 | 文件 | 状态 |
|---|---|---|
| `Registry` | registry.py:65 | `open` → `ref_count` + `acquire/release`(:102-122)、`release_idle`(IDLE_TTL=4h)、`MAX_DOCUMENTS=200` + LRU 淘汰(:252)；`_create_document`(:182) 按 magic bytes 分流 PDF/Image/OFD |
| `RenderCache` | cache.py:25 | TTL 1h、1000 条、get 时续期 |
| `RenderQueue` | queue.py:36 | ⚠️ **名不副实**——`submit`(:58) 直接起 daemon 线程立即执行(:76-78)，priority 只是标签，`MAX_QUEUE=200` 未被使用，**无排队无限流** |
| `WarmPlanner` | warmup.py:62 | `ENABLE_IMPORT_WARMUP` 默认 0（config.py:60），符合「import 不预热」铁律 |
| `Resolver` | resolver.py:29-31 | 接口冻结，**未实现任何 backend、未接线** |

### 3.3 前端合成层（V16 三层所有权）

| 层 | 职责 | 唯一实现 |
|---|---|---|
| **C1 Geometry** | mm→px 离散化 | `compose/composeSlotRasterizer.js`（冻结旧 createLayout 公式）；`compose/composeSlot.js` mm 级 Factory |
| **C2 Placement** | fit / center | `compose/composePlacement.js:65 createPlacement` |
| **C3 Execution** | clip→translate→rotate→drawImage | `layout/renderDraw.js:24 drawRenderCommand` |

**C2 合规性已核实**——五处调用全部委托 `createPlacement`：
`RenderLayoutFactory.js:195`（buildRenderCommand）、`renderers.js:762`（_buildComposeCommand）、`singleFileRenderCommand.js:54`、`exportRenderCommand.js:78`、`SlotLayout.fitIntoSlot:103`。

**C3 合规性已核实**——单文件 / Merge 主线程（renderers.js:1214）/ Worker（render.worker.js:3,33）/ Print 四端共用 `drawRenderCommand`。

**多票合一页**：`SlotLayout.computeTicketSlots`（:48）竖向等分 band、末位吃余数、`slotSafeInset` 内缩；`slotToLandscape`(:120) 轴交换。`MultiTicketComposer.composePlans`（:68）产出 N 个 RenderCommand，每票 clip 锁自己的 slot。

> **记忆勘误**：项目记忆中「Worker 走旧 createLayout 兼容路径」**已过时**。`render.worker.js` 现在是纯执行器，只消费主线程预组好的 `commands`（`compositeCanvas` :24-33）。
> **但双实现仍在**：`renderers.js:29 canUseSlotComposer` 要求 `strategy !== 'grid'`，**merge4（grid）仍走旧 `createLayout` + `_buildComposeCommands`**（:896-910 / :1175-1189）。几何虽同源 createPlacement，但 slot 分区有两套（`layout.js:90` vs `SlotLayout.js:48`）。

### 3.4 Preview ≡ Export 契约核查

| 检查项 | 结论 |
|---|---|
| 同一 placement 函数 | ✅ 五处全走 `createPlacement` |
| 字节相等测试固化 | ✅ `exportRenderCommand.test.js:43` `assert.deepEqual(exportCmd, preview)` |
| DPI 一致 | ⚠️ `PREVIEW_DPI=300`（config.js:88）与 `EXPORT_DPI=300`（layout/exportConstants.js:16）是**两个独立常量**，相等靠约定不靠共享 → **漂移风险** |
| clip 刻意不同 | ✅ Preview = paper 级（RenderLayoutFactory.js:214-222 `clipRect ?? paperRect`）；Export = contentRect 级（composePlacement.js:92-98） |

### 3.5 旋转 / 缩放语义

- `contentRotation`：唯一决策点 `buildRenderCommand`（RenderLayoutFactory.js:149），`normalizeRotation`(:42) snap 到 90° 倍数；后端翻译为 prerotate（engine.py:542 映射表，**270→-90 规避 fitz 镜像坑**）
- `rotation`：LEGACY wire，恒 0（RenderLayoutFactory.js:236、renderSpec.js:45/160）
- `paperLandscape`：由 paperOrientation Fact 派生(:153)，后端只交换画布尺寸（engine.py:546-554；:543-545 记录了曾因 snake_case 读错导致永远 False 的历史 bug）
- `scale`：`min(fitW, fitH)`（composePlacement.js:74-76），后端逐字用作 `fitz.Matrix`（engine.py:563）
- **缓存 key 维度**：后端 = `doc|preset|page|vs_hash|spec_sig`（签名覆盖整个 normalize 后 spec）；前端 L2 `buildCacheKey`（renderers.js:1005-1011）含 rotations/margins/customPaper/slotCount/strategy

---

## 4. 阶段四：打印（Print）

**两条并行链路，均为活跃代码**：

### 链路 A — 源文件直通（主路径）

```
usePrint.js:11,724
  → PrintService.js:107  printSingleSourceFile
  → ipc.invoke('print-source-file')  :126
  → main.js:471
       ├─ pdfMargin.process()      :518  30s 超时
       ├─ createBackend('sumatra') :537
       └─ print-backend.js:198  SumatraBackend.print()
            buildSumatraCommand() :107-154
              ['-print-to', printer, '-silent', '-print-settings', str, filePath]
            spawn :206  120s 超时
            interpretExitCode() :168-178
  外层 180s 总超时  main.js:472-478
```

### 链路 B — Canvas → PDF → PrintService

```
usePrint.js:938 renderPrintContent → :946 submitPrintIntent
  → usePrintIntent.js:66  api.generatePdfFromCanvas → main.js:434
  → usePrintIntent.js:85  api.submitPrintJob       → main.js:414
  → print-service/PrintService.js:101 submit()
  → OsLauncherBridge._executeJobInternal() :464
```

**所以打印不是 `webContents.print()`，而是捆绑的 SumatraPDF.exe 命令行 + PDF 中转。**

- 静默打印：`-silent` 恒定注入（print-backend.js:148、OsLauncherBridge.js:500），**无用户开关**
- 打印机解析：`PrintService.js:84 resolvePrinterName`，回退链 `printSettings.printerName || printSettings.printer || settings.printerName`（usePrint.js:652-654），缺失报错；默认机检测 `OsLauncherBridge.js:126`（Electron 原生优先，回退 PowerShell）
- ⚠️ **份数实现不一致**：链路 A 拼 `${copies}x` 塞进 `-print-settings`（print-settings.js:233）；链路 B 用独立 `-print-copies` 参数（OsLauncherBridge.js:504）

---

## 5. 阶段五：导出（Export）

### (a) Excel / CSV — 安全实现的样板

```
useExport.js:84 → ExportService.js:111 exportExcel
  → IPC 'select-save-path' :133（main.js:1140 系统对话框）
  → POST /api/export-excel-sse :152 → app.py:347
       validate_export_path()  excel_exporter.py:168-188  ← 四重校验
         ① 路径遍历  ② 绝对路径  ③ EXPORT_ALLOWED_BASE_DIRS 白名单  ④ 扩展名
       sanitize_columns()      :119  列白名单
       sanitize_excel_text()   :197  CSV 注入防护（公式前缀加 '）
       daemon 线程 :397 → queue.Queue → SSE :400-419
  → 前端手工解析 data: 行 :177-219
```

### (b) PDF

```
useExport.js:190 → ExportService.js:242 startPdfExport
  → POST /api/export-pdf  app.py:1525 → 返回 taskId
  → EventSource /api/export-pdf/events/<taskId>  app.py:1554
       → export_stream.py stream_export_progress  0.5s 轮询 ExportTask.to_dict() 直至终态
  执行：ThreadPoolExecutor(max_workers=2)  app.py:1466
  取消：POST /api/export-pdf/cancel  :1577
```

### (c) Render 导出（新管线）

`useExport.js:185 startRenderExport → POST /api/export-render`（app.py:1652）。
仅 `mode === 'merge'` 且 flag 开启时启用（useExport.js:156-157），single 模式强制回落 legacy。

### (d) 重命名 + 打包（纯 Electron 本地，不走后端）

```
useRenamePack.js
  ├─ 预览  generatePreviewInner :108 / handleRename :157
  │     → ipc 'preview-rename-names' :130,:206 → ipc-rename.js:186 → buildNameParts()
  │     冲突检测在**前端** :85-91（同名计数>1 打 conflict 标记，仅提示不阻断）
  ├─ 执行  handleRenameConfirm :226 → ipc 'rename-invoices' :294 → ipc-rename.js:47
  │     多页拆页 :254-269（非首页加 _p{n}）
  │     前端路径守卫 :259,:272  /^[a-zA-Z]:\\|^\\\\/  只放行 Win 绝对路径/UNC
  │     主进程冲突用 _1/_2 递增 :119-123
  │     跨盘 copy+unlink 带 3 次重试 :71-86,:152，失败标 partialSuccess
  │     完成后 fire-and-forget POST /api/invoices/rename :181  .catch(()=>{})
  └─ 打包  handlePack :346 → ipc 'pack-invoices' :379 → ipc-pack.js:18
        ZIP / RAR / 7Z，后两者找不到工具时**静默降级 ZIP** :151-167
```

**命名规则唯一定义地**：`electron/rename-utils.js`
`INVALID_FILENAME_CHARS = /[<>:"/\\|?*\n\r\t]/g`（:11）→ 替换 `_`，去首尾点，单段截断 80 字符（`sanitizeFilenamePart` :21-32）；`getFieldText`(:42) 字段分派；`buildNameParts`(:98) 组装。

---

## 6. 审查发现清单

### 🔴 Blockers

**B1 — `/api/export-pdf` 与 `/api/export-render` 存在任意路径写入**
`app.py:1531` 直接取 `data.get('outputPath')`；`_build_export_items`（:1467-1500）只检查非空，**从未调用 `validate_export_path`**。`/api/export-render` 同理（`export_render_schema.py:146-149` 只做 `isinstance(str)`，随后 `app.py:1635-1643` 直接 `os.makedirs` + `open(out_path,'wb')`）。

**Why**：Excel 导出已有 `excel_exporter.py:168-188` 的四重校验（路径遍历 / 绝对路径 / 白名单 / 扩展名），PDF 两条路径完全绕过。Flask 监听 127.0.0.1 降低了远程利用面，但任何本机进程或渲染进程被 XSS 都可写任意路径（含启动项、DLL 劫持位）。同一代码库里两套标准，属于典型的安全债务不一致。

**Suggestion**：把 `validate_export_path` 提升为共享工具（例如 `crosscutting/path_guard.py`），在 `_build_export_items` 和 `export_render_schema` 里各调一次，扩展名限定 `.pdf`。

---

**B2 — `_run_export_task` 异常后任务永不终止，SSE 无限轮询**
```python
# app.py:1521-1522
except Exception:
    logger.exception("[PDF Export] 后台导出异常 task=%s", task_id[:8])
    # ← 缺 task.fail()
```
**Why**：`stream_export_progress`（export_stream.py）的终止条件是 `TaskStatus in {COMPLETED, FAILED, CANCELLED}`。异常路径下 task 永远停在 `running`，生成器 `while True` 以 0.5s 间隔无限 yield ——泄漏一个 Flask 工作线程 + 一条 EventSource 连接，前端进度条永久卡住且无任何错误提示。对比 `_run_export_render_task`（:1649）**正确调用了 `task.fail(str(e))`**，说明这是遗漏而非设计。

**Suggestion**：
```python
except Exception as e:
    logger.exception(...)
    task.fail(str(e) or "pdf export failure")
```

---

**B3 — `RenderQueue` 是假队列，无背压**
`queue.py:58 submit()` 直接 `threading.Thread(daemon=True).start()`（:76-78）立即执行，`priority` 只是标签，`MAX_QUEUE=200` 定义了却从不使用。

**Why**：`prefetch_neighbors`（api.py:379-384）在每次 page==1 预览时都起后台线程；批量浏览或打印风暴下会无限创建线程，每个线程持有 fitz pixmap（数 MB 级）。这是 OOM + 线程耗尽的直接路径，且名字叫 Queue 会让后续维护者误以为已有限流。

**Suggestion**：换成 `ThreadPoolExecutor(max_workers=N)` + 有界队列，或至少加信号量。若暂不改，把类名改为 `RenderDispatcher` 避免误导。

---

### 🟡 Suggestions

**S1 — `warmup` 的缓存 key 与真实请求错位（隐性失效）**
`warmup.py:105` 用 `_EMPTY_VS_HASH` 预热 legacy key，而所有真实预览请求都带 `spec_tag`（engine.py:320）。即使把 `ENABLE_IMPORT_WARMUP` 打开，**预热结果也永远不会被命中**。当前默认关闭掩盖了这个 bug——将来某人打开开关会得出「预热没用」的错误结论。

**S2 — `PREVIEW_DPI` / `EXPORT_DPI` 双常量**
`config.js:88` 与 `layout/exportConstants.js:16` 各定义一次 300。Preview≡Export 是本项目的核心不变量，靠两个独立字面量维持等价太脆。建议单一来源 + 一条 `assert PREVIEW_DPI === EXPORT_DPI` 的构建期断言。

**S3 — 三个死模块**
- `stores/PrintSessionStore.js`（176 行 / 13 个导出）**零消费者**——已 grep 确认全仓只有 `ExportSessionStore.js:7` 的一句注释提到它。打印进度实际由 `usePrint.js:955-961` 的本地 state 承载。
- `stores/ImportFileRegistry.js` 零引用。
- `fix-ipc-print.js`（根目录）硬编码 `D:\marsprint\print605\electron\ipc-print.js`——指向**上一代项目**，且该文件在 703 中已不存在。

**S4 — 文件状态机无转移守卫**
`ImportSession.js:35` 定义 `uploading|splitting|ready|parsing|parsed|error`，但 `ImportSessionStore.updateFileStatus`（:193）直接 `Object.assign` 无校验，可发生 `parsed → parsing` 回退。对比 `TaskRegistry.updateTaskStatus`（:155）有 `VALID_TRANSITION` 守卫——项目内已有正确范式，照抄即可。
附带：`buildFileObj` 初始 status = `'parsing'`，`createSessionFile` 初始 = `'uploading'`，双重初始化不一致。

**S5 — `queueUpdate` last-write-wins 竞态**
`runChunkedImport.js:172-177` 注释自承：hydrateChunk 写入富字段后，若再来一次空 extra 的 `onFileUpdate('parsed')` 会覆盖。当前靠 `terminalFileKeys` 时序保护，脆弱。建议改为字段级 merge 而非整对象替换。

**S6 — 异常吞掉清单**
| 位置 | 后果 |
|---|---|
| `image_parser.py:133` | 返回默认「未知号码」**并 `set_ocr_cache` 缓存了空结果**（:123/126/130/135）→ 错误被永久固化进缓存 |
| `invoice_service.py:254` | image 分支 except 仅 log，result=None 继续 |
| `invoice_service.py:298` | `set_fields_cache` except pass |
| `ipc-rename.js:181` | 后端 DB 与文件系统失同步，无任何提示 |
| `ipc-rename.js:33-39` | 所有失败路径统一 `resolve({updated:0})` |
| `ipc-pack.js:183-185` | 删除原件失败仅 console.warn，packResult 不体现 |
| `main.js:1227` | `checkPythonEnv().catch(()=>{})` |

其中 `image_parser.py:133` 最值得优先修——**缓存错误结果**意味着一次瞬时 OCR 失败会让该文件永远解析错误，除非清缓存。

**S7 — `CACHE_DEBUG` 默认开启**
`backend/config.py:53` 默认 = 1，绕过所有缓存。生产构建里这是纯性能损失。

**S8 — Excel SSE 协议字段不匹配**
后端返回 `{'result': {'success':…, 'filePath':…}}`（app.py:392），前端读 `msg.result.path`（ExportService.js:199）→ 靠 `|| savePath` 兜底遮盖；`successCount`/`failCount`（:203-204）后端从不下发，永远是默认值。

**S9 — preload 白名单是「默认放行」模型**
`preload.js:14-32` 用前缀匹配 `'get-'`、`'read-'`、`'delete-'`、`'open-'`。任何未来新增的同前缀 handler 自动获得渲染进程可达性。建议改为显式 channel 列表（默认拒绝）。
配套：`read-file`（ipc-file-ops.js:85）可读任意 <50MB 文件无目录限制；`ipc-pack.js:41` / `ipc-rename.js:114` 的 targetFolder 无 base dir 约束。

**S10 — `sanitizeFilenamePart` 未过滤 Windows 保留设备名**
`rename-utils.js:21-32` 处理了非法字符，但漏了 `CON/PRN/AUX/NUL/COM1-9/LPT1-9`。若发票字段恰为这些值，`fs.renameSync` 直接失败。

---

### 💭 Nits

- **N1** 两套并发模型并存：单文件 `/parse_invoice` 走 ProcessPoolExecutor（app.py:1084），`/import/batch` 走 ThreadPoolExecutor（parse_job_manager.py:330）。
- **N2** `TempFileRegistry.read_bytes_by_ref` 的跨进程路径实际无人使用（`/import/batch` 用 ThreadPool，单文件直接传 bytes），属推测性代码。
- **N3** 热路径 `print(flush=True)`：`api.py:86/114`、`engine.py:514-516` 每请求打印。
- **N4** 陈旧注释：`usePreview.js:634-637` 声称 doc_id 含 filename，与 `registry.py:325` v1.1 纯内容哈希矛盾；`TaskRegistry.js:18` 称 StreamConsumer「已在 P5-A 删除」但它仍在被使用。
- **N5** 已知缺陷被测试固化：`rotation_flow_cachekey.test.js:49-52` 测试③锁住了「L2 缓存命中分支的 RE URL 不带 spec/rotation」这个 bug。建议改为 `it.skip` + TODO，避免它变成不可动的契约。
- **N6** deprecated / 未接线：`engine.py:884 _rotation_to_fitz_arg`（标注 V17 待删）、`resolver.py` 全模块、`documentEngine.js`（USE_DOCUMENT_ENGINE 默认 false，renderers.js:1023-1025 自带「P3 前必须删除此开关」警告）、`ipc-db.js` 整体 @deprecated、`print-backend.js:265 LegacyBackend` 永远返回失败的占位类。
- **N7** 双份实现：`print-service/` 下 `.ts` 与 `.js` 并存（运行时只加载 `.js`）；`electron/update/` 与 `electron/services/Update/` 两套，`main.js:22` 只引用后者。
- **N8** 废弃路由：`/parse_batch`（app.py:1274）、`/api/export-excel`（:428，前端已全量走 `-sse`）。
- **N9** 临时文件泄漏：`backend/2f8f0fd469d2482a8dc9c67e24e9db53_export_260717.pdf`（105KB，实物遗留）；`_export_render_output_path()`（app.py:1599-1608）写 temp 后代码注释自承「client delivery 是 out-of-scope follow-up」，即生成后无人取用也无人清理。
- **N10** 杂物：`canvas.css.bak`、`*.rollback.bat`、`poc-test.jsx`；legacy `_apply_margins` A4 硬编码（engine.py:794，renderSpec.js:18 承认「删除 A4 硬编码尚未完成」）。
- **N11** 常量不一致：前端 `IMPORT_CHUNK_SIZE=100`（config.js:45）与后端 `SUBMIT_WINDOW=50` 解耦，潜在背压 mismatch。
- **N12** OFD 能力缺口：`pdf_handlers/ofd_handler.py:23/30` NotImplementedError（merge/split 未实现），对应记忆中的 P9。

---

## 7. 值得肯定的设计

不是所有地方都是债：

1. **V16 三层所有权链真实成立且有测试护栏**。C1/C2/C3 五处调用点全部收敛到 `createPlacement` / `drawRenderCommand`，`exportRenderCommand.test.js:43` 用 `deepEqual` 固化 Preview≡Export，`stage0-paperlayout-invariant.test.js` 守住不变量。这在一个演进了这么多轮的项目里很不容易。
2. **`db.py` 的两阶段提交压缩**（`.compact_writing → .compact_done`，:582）是正确的崩溃安全实现，很多项目在这里会直接原地覆写。
3. **`excel_exporter.py` 的导出安全**——路径四重校验 + 列白名单 + CSV 公式注入防护（:197），是教科书级别的。问题只在于 PDF 路径没照抄它。
4. **`committedPreviewRef` Commit Buffer**（usePreview.js:739）用一个 ref 干净地消灭了 A→null→B 白板闪烁。
5. **命令注入面已封死**：所有外部进程调用（7z / WinRAR / where.exe / SumatraPDF / Python / PowerShell）都用 `execFile`/`spawn` 数组参数，无一处 shell 字符串拼接。
6. **`recoverREPreview` 三级降级**（探 metadata → 自动重注册 → Canvas 容灾）体现了对渲染会话易失性的正确认知。
7. **IS-4.2 instance identity** 把「同内容不同实例」这个真实业务语义从 docId 里正确剥离了出来，并有测试锁住。

---

## 8. 建议的后续梳理顺序

你已完成阶段 1。基于上面的依赖关系，建议这样往下走：

| 顺序 | 阶段 | 理由 | 入口文件 |
|---|---|---|---|
| ① | **解析（阶段 2）** | 紧邻导入，数据契约在此定型；`PageResultStore` 的 instance_id 分桶是理解 IS-4.2 的关键 | `import_batch_manager.py:224` → `parse_job_manager.py:432` |
| ② | **渲染（阶段 3）** | 独立子系统，边界清晰，看完能理解全部 identity 语义 | `usePreview.js:553` → `engine.py:282` |
| ③ | **合成 / 排版** | 建立在渲染之上，V16 铁律主战场 | `RenderLayoutFactory.js:149` → `composePlacement.js:65` |
| ④ | **导出（阶段 5）** | 复用合成层，且这里有 B1/B2 两个 blocker 需处理 | `ExportService.js:242` → `app.py:1525` |
| ⑤ | **打印（阶段 4）** | 最外层，依赖前面全部；两条链路需决定是否收敛 | `PrintService.js:107` → `print-backend.js:198` |

**修复优先级建议**（与梳理并行）：
1. B2（一行代码，立刻消除线程泄漏）
2. S6 的 `image_parser.py:133` 缓存错误结果（数据正确性）
3. B1（安全，需要提取共享 path guard）
4. B3（RenderQueue，需要设计决策）
5. S3 死模块清理（低风险，减少后续梳理噪音）

---

*本文所有结论均经文件路径与行号定位；B1 / B2 / S3 已人工二次复核。*
