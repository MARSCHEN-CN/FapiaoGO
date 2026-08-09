# print703 性能专项审查报告

> 审查范围：后端（Python/Flask 导入·解析·导出·DB）+ 前端（React/Electron 预览·列表·导出）
> 审查日期：2026-07-27
> 方法论：先用 Explore agent 并行摸排热点，再对每条高影响项 Read 源码逐行核实（行号已验证）
> 结论：大部分 I/O 路径已做过优化（oplog 缓冲、批量入库、正则模块级编译、前端虚拟化和 Worker 栅格化）。
> 真正"重"的点集中在：**DB 全量重写、导入双重处理、自动旋转多次 OCR、重复光栅化、导出集齐全量字节、预览鼠标移动 setState、files 变化整树派生**。

---

## 🔴 必须关注（用户可感知 / 资源显著浪费）

### 1. DB 全量快照重写 —— 每 50 次写操作重写整个 `invoices.json`
- **位置**：`backend/db.py`
  - `COMPACT_THRESHOLD = 50` （L157）
  - `_maybe_compact()` 在每次 upsert/delete 后检查阈值（L697–700）
  - `_compact_oplog()` → `_write_snapshot(_invoices)` 整表序列化 + 原子写盘（L611–612，函数 L582–632）
- **为什么慢**：单条发票含 `raw_text`(≤5000)、`line_items`、`bbox_data` 等大字段，整库体积随记录数线性膨胀。每累积 50 条写操作就 **O(N) 序列化 + 整文件重写一次磁盘**，记录多/单条 payload 大时引入明显的周期性写放大与停顿；同时整库常驻内存（启动时 `json.load` 全量进 `_invoices`）。
- **旁证**：oplog 缓冲本身设计良好（`_append_oplog` L284–311），但它把**整条 invoice dict**（含全部大字段）序列化进 oplog，oplog 增长 ≈ 整条记录大小，磁盘与回放成本随大字段放大。
- **建议**：
  - 把 `bbox_data` / `line_items` 等大字段剥离到独立 sidecar 文件，主表只存轻量字段，压缩时只重写主表；
  - 或把压缩阈值与 payload 解耦（不要每 50 条就重写整库，可按时间/大小触发）；
  - 长期评估迁移到 SQLite / leveldb 等真正的嵌入式 KV，彻底消除"整文件重写"模型。

### 2. 导入时每个文件被"解析 + 预览"双重处理（重复 open / 解码）
- **位置**：`backend/import_batch_manager.py::_parse_via_registry`（L283–312）
  ```python
  file_bytes = self._temp_registry.read_bytes(input_ref)
  result = parse_invoice_service(file_bytes, filename, ...)   # ① 完整解析（已对 PDF/图 open 过）
  ...
  doc = re_registry.open(file_bytes, filename=filename)       # ② 又为预览重新 fitz.open / 解码
  self._warm_planner.warm_after_import([{"doc_id": doc.doc_id, ...}])  # ③ 后台再 rasterize 预热
  ```
- **为什么慢**：PDF/OFD/大图在导入时**被完整处理两遍**——解析管线已打开 `pdf_doc` 提取文本/bbox，render engine 的 `registry.open` 又**重新 `fitz.open`/解码**同一份源字节用于预览，外加后台 rasterize 预热。1000+ 文件时这些 rasterize 全在同一个渲染线程排队串行（见 #7）。
- **建议**：解析阶段产出的 `fitz.Document` 直接移交 render engine 注册，而不是各自 open；预热改为"仅确有需要时才 rasterize"或合并进解析阶段。

### 3. 自动旋转默认开启 → 每张图最多跑 2~3 次 OCR 推理
- **位置**：`backend/ocr_engine.py::auto_orient_and_ocr`
  - `ocr_call(ocr_engine, arr_0)` 角度 0 全量（L600）
  - `ocr_call(ocr_engine, arr_quick)` 快速定向（L646）
  - `ocr_call(ocr_engine, arr_full)` 最佳角度全量（L675）
- **为什么慢**：导入入口 `create_batch(auto_orient=True)`（见 `import_batch_manager.py`、benchmark L87/293）默认开启，每张图片最多 ~3 次 OCR 推理，CPU 成本乘 2~3。
- **建议**：先用廉价的方向分类（cls 模型）定方向，仅对最终方向跑一次 rec；或缓存定向结果，避免对明显正向的图也跑全量。

### 4. 预览画布鼠标移动 `setState` + 强制 reflow（前端，用户可感知掉帧）
- **位置**：`frontend/src/hooks/usePreview.js::handleCanvasMouseMove`（L1710–1715）
  ```js
  const handleCanvasMouseMove = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect()   // 每次 mousemove 强制同步布局/reflow
    const x = e.clientX - rect.left
    setShowLeftArrow(x < 120)                              // 每次 mousemove 触发 setState
    setShowRightArrow(x > rect.width - 120)
  }, [])
  ```
- **为什么慢**：鼠标在预览区移动时，每个 `mousemove` 都执行 `getBoundingClientRect()`（读布局，可能强制 reflow），并在跨 120px 边界时触发 `usePreview`/`App` 重渲染（重跑 useMemo 依赖检查 + FileContext 子树 reconciliation）。连续 hover 预览画布时可见掉帧。
- **建议**：用 `requestAnimationFrame` 合并；用 ref 记录上次布尔值，**仅当显隐值真正变化时才 `setState`**（绝大多数移动不会跨边界，可完全跳过）；`rect` 只需在 resize/scroll 时重算并缓存。

### 5. `files` 任意变化触发整树派生重建 + 多轮重复 O(n) 遍历（前端）
- **位置**：
  - `frontend/src/contexts/FileContext.jsx`：`documentView = useMemo(buildDocumentViewModel(files, invoiceDocs), [files, invoiceDocs])`（L71–74）；`value` memo 依赖 `files`/`documentView`（L116–142）→ **所有 `useFileContext()` 消费者重渲染**。
  - `frontend/src/components/Sidebar.jsx`：消费 context 后**又**额外算 `duplicateInfo`（L95–98）、`previousYearInfo`（L102，O(n)）、`displayFiles`/`groupFilesByDocument`（L114，O(n)）——同一份 `files` 变化 → 反复 3~4 次 O(n) 遍历 + 多次新数组/Map 分配。
- **为什么慢**：导入 N 个文件期间若多次 flush（`useFileOps` 的 `requestIdleCallback` 200ms 批量），每次 flush 都重做一遍整树派生；文件数百~数千时每次状态更新都可见卡顿。
- **建议**：把 `duplicateInfo` / `previousYearInfo` / `displayFiles` **合并进 `buildDocumentViewModel` 一次算出**，避免 3~4 次重叠 O(n)；并对 `files` 的"结构标识"只算一次（合并 #6 的重复 `filesKeyStr`）。

---

## 🟡 应当优化（明确浪费 / 可量化收益）

### 6. 重复的 `files` 结构键计算
- `frontend/src/hooks/usePreview.js`：`filesKeyStr`（L1632）、`filesKeySet`（L1635）每次 `files` 引用变化重算 O(n) join/Set/find。
- `frontend/src/App.jsx`：`structureKey = files.map(f => f.key).join('\x00')`（L68–69）**重复计算同一件事**（分隔符不同）。
- **建议**：合并为单一 `useMemo` 计算一次，多处共享。

### 7. 预览渲染后台单线程串行
- **位置**：`backend/render_engine/queue.py`（worker 单线程 `threading.Thread`）；`render_engine/warmup.py::warm_after_import`（L74–101）对每文件提交一页 page-1 预热。
- **为什么慢**：1000+ 文件导入后，这些 rasterize 全部在同一线程排队串行，且与交互预览请求竞争。
- **建议**：`RenderQueue` 增加 worker 数（按 CPU 核数）；warm 队列与交互队列分 lane 限流。

### 8. 同一图片源在多个 RenderCommand 下重复光栅化
- **位置**：`backend/services/render_executor.py::draw_render_command`（L74）
  ```python
  src_doc = fitz.open(stream=source_bytes)   # L126 每命令重 open
  pix = src_page.get_pixmap(matrix=matrix)   # L133 每命令重 rasterize
  ```
- **为什么慢**：源字节只读一次（有缓存 ✓），但 `fitz.open` + `get_pixmap` 对每个命令重复执行 → 重复解码 + 重复光栅化（最贵的步骤）。注释声称"read + parse only ONCE"只覆盖了读字节，没覆盖 rasterize。
- **建议**：对重复源缓存"已光栅化的 `fitz.Pixmap`"（按 page+scale+rotation 为键），避免重复 `get_pixmap`。

### 9. 导出前集齐全部源字节 + 合并整本 PDF 驻留内存
- **位置**：
  - `backend/app.py::_build_export_items`：`source = fh.read()`（L1403）把每个文件全量读进内存，`items` 同时持有所有源字节（含 base64 解码分支）。
  - `backend/services/pdf_export.py::merge_files`：逐页插入 `target_doc`，最后 `deflate=True` 一次性压缩写盘（代码自身 L224–226 已警告"超过 500 页建议分批"）。
- **为什么慢**：大批量大 PDF/图片 = 显著内存尖峰；整本合并 PDF 页面全在 `target_doc` 内存中，最后一次性压缩。
- **建议**：导出改为"流式/惰性取字节 + 处理完即释放"，不要在任务开始前集齐全部 `source`；超阈值时分卷，或边插边 `save(incremental=True)` 降峰值内存；纯 PDF 直通优先 `insert_pdf` 而非重新 rasterize。

### 10. `get_config` 每次深拷贝整份配置
- **位置**：`backend/db.py::get_config`（L1455–1466）：`return copy.deepcopy(_config)` / `copy.deepcopy(value)`。
- **为什么慢**：若 `get_config`/`get_setting` 在请求热路径频繁调用，每次都深拷贝整份配置对象，隐性 CPU/内存浪费（配置读多写少）。
- **建议**：返回浅拷贝或不可变视图（如 `types.MappingProxyType`）。

### 11. `get_all_invoices` 无 limit 时全量 copy
- **位置**：`backend/db.py::get_all_invoices`（L1249–1257）：`limit` 为 None 时 `[inv.copy() for inv in filtered]` 整库浅拷贝。
- **建议**：列表返回采用游标/分页直读，避免整库 `.copy()`。

### 12. 隐藏弹窗在每次 App 渲染都做 `files.filter`
- **位置**：`frontend/src/App.jsx`（L1056–1080）：`PdfExportConfirmModal` / `ExcelExportFieldsModal` / `PackConfirmModal` 的 `files={files.filter(f => f.status === 'parsed')}` 在**每次 App 渲染**执行，即便 `visible=false`；且这三个弹窗不在 memo 名单，每次重渲染都重新调用组件函数并分配新数组。
- **建议**：把 `parsedFiles` 提到 `useMemo`；对这三个弹窗加 `React.memo`，避免无谓分配与调用。

### 13. 活动导入路径的 OCR 未走 ProcessPool（CPU 吞吐天花板）
- **位置**：活动路径 `ImportBatchManager → _parse_via_registry → parse_invoice_service → parse_image_ocr → ocr_call` 在 `ParseJobManager` 的 `ThreadPoolExecutor(max_workers=min(CPU,4))` 上**进程内同步**执行；而 OCR 的 `ProcessPoolExecutor`（`_get_executor` / `ocr_pool_task.run_parse`，`app.py` L994–1066）只被旧 `/parse_batch` 与单文件 `/parse_invoice` 的 `_run_parse_offthread` 使用。
- **为什么慢**：OCR 是 CPU 密集且在进程内，受 GIL/进程内串行影响，4 个 worker 并不能线性加速图片 OCR。
- **建议**：活动导入路径也把 OCR 提交到 `ProcessPoolExecutor`（与旧路径共用 `_ocr_executor`），或复用 `_run_parse_offthread`。

---

## 💭 锦上添花（小改 / 观察）

- **双 ResizeObserver 并存**：`usePreview.js`（L910，旧 canvas 路径）与 `ViewerViewport.jsx`（L96，新路径，已 rAF 节流）两条测量链冗余；新路径激活时旧 observer 仍触发 `setContainerSize` 让 App 重渲染 → 新路径下跳过旧 observer。
- **重复 SHA256**：导入时 `registry.open`（`render_engine/registry.py`）对**整个 `file_bytes` 做完整 sha256**，而解析入口对 >4MB 文件只采样哈希；可在 manager 层把已算出的 hash 透传复用。
- **搜索缓存上限 32 偏小**（`db.py` L176 `_SEARCH_CACHE_MAX`）：冷条件首次仍全扫，可按需上调。
- **导出进度回调瑕疵**：`export_render_service.execute_export_render` 的 `progress` 在**所有命令处理完后**才循环触发（L212–215），等于进度"一次性全推"，未真正反映逐命令进度（对比 `pdf_export` 的 `task.advance` 是对的）。
- **旧路径 `/parse_batch` 一次性全读内存**（`app.py` L1218）：解析前把所有上传文件字节读进内存（`MAX_BATCH_SIZE=100`）；活动路径已用 temp registry 流式调度规避，旧路径若仍暴露需注意（属退役路径，优先级低）。

---

## ✅ 已经做对的地方（保住了大部分帧率，值得肯定）

- **前端列表虚拟化**：`FileList` 用 `react-window` 的 `List` + 自定义 memo 比较器，不会一次 render 上百项。
- **栅格化 offload 到 Web Worker**：合成栅格化走 `_renderViaWorker`，PDF 解析用独立 Worker，主线程不被阻塞。
- **关键组件 `React.memo`**：`DocumentViewer` / `ViewerViewport` 已 memo；`ViewerViewport` 的 wheel/ResizeObserver 监听用 ref 持有最新 ctx、`[]` 依赖只注册一次、rAF 节流 + 相等短路。
- **预览几何为纯函数 + useMemo 派生**：`SlotLayout` / `MultiTicketComposer` / `RenderLayoutFactory` 纯函数，`buildRenderCommand` 只调一次 `createPlacement`；文件状态更新时 `renderCommand`/`computedContentLayout` 引用不变 → 预览画布不因无关 files 变化重算（设计正确）。
- **后端搜索 LRU 缓存**（db.py，32 条）+ 搜索文本预计算缓存，缓解重复全表遍历。
- **正则模块级 `re.compile`**（`field_extractor/regex_patterns.py` L9–81）：字段提取无重复编译问题。
- **批量入库**：`ResultBuffer` 满 50 条触发一次 `batch_upsert_invoices`，避免逐条写 DB（设计良好）。
- **依赖精简**：前端仅 react / react-dom / pdfjs-dist / react-dropzone / react-window，无"只用了库一小部分却引入大库"现象。

---

## 优先级排序（按"用户可感知 + 改动性价比"）

| 优先级 | 项 | 维度 | 改动量级 |
|---|---|---|---|
| P0 | #4 预览鼠标移动 setState+reflow | 前端 | 小（rAF+ref 短路） |
| P0 | #5 files 变化整树派生 + Sidebar 多轮 O(n) | 前端 | 中（合并派生） |
| P0 | #1 DB 每 50 写全量重写 | 后端 | 大（存储模型） |
| P0 | #2 导入双重 open/解码 | 后端 | 中（共享 doc） |
| P1 | #3 自动旋转 2~3 次 OCR | 后端 | 小（改 `auto_orient_and_ocr`） |
| P1 | #9 导出集齐全量字节 + 整本驻留 | 后端 | 中 |
| P1 | #13 活动导入 OCR 未走 ProcessPool | 后端 | 中（接线 `_run_parse_offthread`） |
| P2 | #6 重复 filesKey 计算 / #8 重复 rasterize / #7 渲染单线程 / #10 get_config 深拷贝 / #11 全量 copy / #12 隐藏弹窗 filter | 前后端 | 小~中 |
| 💭 | 双 ResizeObserver / 重复 SHA256 / 缓存上限 / 进度回调 / 旧路径 | 前后端 | 小 |

**建议下一步**：先啃 #4、#5 两个纯前端红利（用户立刻感知流畅），再处理 #2/#3/#13 这类"导入吞吐"后端项，#1/#9 作为存储/导出架构重构排期。需要我直接动手改其中某一项吗？
