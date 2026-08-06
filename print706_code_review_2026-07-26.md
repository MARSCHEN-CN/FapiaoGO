# print706 性能 & Bug 深度审查报告（预览速度优先）

> 审查范围：后端渲染管线（`backend/render_engine`、`backend/cache.py`、`backend/services`、`backend/field_extractor`）+ 前端预览链路（`frontend/src/hooks/usePreview.js`、`components/*`、`utils/*`、`renderers.js`、`App.jsx`）。
> 方法：并行 Explore 映射全路径 → 对 20+ 关键文件逐行取证（file:line + 片段 + 根因）。每一条均附**当前源码证据**，文档已述但代码已改的结论以"已核实"标注。
> 数据支撑：DPI/像素量/缓存容量/线程模型等量化指标列于各条。

---

## 一、总览

**整体印象**：预览渲染管线架构设计是**好的**——后端 Render Engine 统一了 PDF/Image/OFD 三条渲染树、`RenderCache` 用 ETag + `immutable` 缓存头（URL 唯一决定字节，见 `cache.py:123-150`）、文档句柄常驻 LRU 避免重复 `fitz.open`、前端 `FileList` 已虚拟化、`useFileOps` 用 `requestIdleCallback` 批处理。这些应当保留。

**核心问题集中在三类**：
1. **渲染结果只进内存缓存，磁盘缓存的 `preview` 命名空间从未写入**——最高收益、最被忽视的缺口。
2. **预览预取/前端冗余取流**——后端的 `RenderQueue` 每任务新建线程（无界），前端 `usePreview` 对已注册文档仍发一次永不显示的预览请求 + 依赖数组过宽导致旋转任意文件都重渲染。
3. **静默能力退化 & 身份错位类 Bug**——锚点检测器因导入错误被静默关闭、多页 PDF 第二页拿不到 `pageId`、Legacy 路径 270° 旋转镜像。

标注：审查中发现的一处"文档声称已修但代码未修"——`p0-stage1-closeout.md` 说 `renderers.js:buildCacheKey` 已改用 `paperKeyFragment(resolvePaper(...))`，**实际 `renderers.js:1010` 仍用原始 `customPaper?.widthMM`**（见 B3）。另：有文档称 `/preview` 用 `must-revalidate`，**实测 `api.py:372` 走 `make_cache_headers(etag)` 默认 `immutable`**，属正确设计，非缺陷。

---

## 二、性能问题（预览速度）

### 🔴 P1 — `RenderQueue` 每任务新建守护线程，无界并发
**位置**：`backend/render_engine/queue.py:75-76`
```python
t = threading.Thread(target=self._run_task, args=(task,), daemon=True)
t.start()
```
- **根因**：`submit()` 对每个渲染任务 `spawn` 一个全新 daemon 线程，没有线程池/信号量上限。文件头虽声明 `MAX_QUEUE = 200`（line 44），但**全文件从未引用它**——上限形同虚设。
- **为什么慢**：渲染任务是 CPU 密集（`get_pixmap` 光栅 + Pillow WebP 编码）。OFD 预览默认 **300 DPI**（`ofd_adapter.py:29`）→ 单页像素量约为 PDF 150 DPI 的 **4×**（`(300/150)²`）。当首屏渲染触发 `prefetch_neighbors`（邻页预取，`api.py:379-384`）叠加缩略图生成、导出渲染线程池时，会瞬间新建大量线程打满所有核，**反而饿死用户正在看的那一页的首屏渲染**。
- **数据支撑**：`prefetch_neighbors` 仅 ±1 页（克制），但 `RenderQueue.submit` 不区分来源、一律无界起线程；与有界导出的 `_export_render_executor(max_workers=2)`（`app.py:1504`）形成无统一调度的超卖。
- **建议**：用固定大小 `ThreadPoolExecutor` 或 `threading.Semaphore` 限制并发渲染线程数（如 `min(2*cpu_count, 8)`）；或把任务压入优先级队列由 N 个 worker 消费，而非立即起线程。

### 🔴 P2 — 渲染结果从不落盘，`CacheManager.preview` 命名空间声明却从未写入
**位置**：
- `backend/cache.py:163` → `NAMESPACES = ['pdf_text', 'ocr', 'fields', 'preview']`
- `backend/render_engine/cache.py:33-34` → `RenderCache` `MAX_ENTRIES=1000 / DEFAULT_TTL=3600`（纯内存）
- grep 全仓第一方代码：**零** `set(..., namespace="preview")` 调用（仅 `api.py:172` 的 `preset="preview"` 是 unrelated 查询参数）。

- **根因**：磁盘 `CacheManager` 基础设施完备（原子写、`OCR_CACHE_MAX_BYTES=500MB`、7 天 TTL、后台 TTL 清扫线程），但**渲染预览图只进 `RenderCache` 内存**，从不 `set` 到 `preview` 命名空间。OCR/字段/`pdf_text` 有磁盘缓存，唯独最常被重复请求的预览图没有。
- **为什么慢**：
  1. 内存缓存上限 1000 条、TTL 1h，**进程重启 / 多 worker 部署 / 容量淘汰后全部丢失**，重复光栅同一页。
  2. 同一 PDF 在 preview/print/thumbnail 多档位下各自独立缓存键，**同一像素无跨档复用**。
- **数据支撑**：企业场景常开多窗口/多 worker；首屏预览 150 DPI 输出约 1750×2475 px 的 WebP，单次光栅+编码是主要 CPU 热点，落盘后可省下大量重复计算。
- **建议**：在 `engine.render()` 缓存 MISS 写出后（或 MISS 路径）把 `data` 写入 `CacheManager` 的 `preview` 命名空间，key 用现有 `make_cache_key(...)`；命中时先查磁盘再查内存。基础设施已具备，改动量小、收益高。

### 🔴 P3 — 已注册文档走 `DocumentViewer` 时，`usePreview` 仍发一次永不显示的预览请求（双取流）
**位置**：
- `frontend/src/hooks/usePreview.js:734-741`（RE probe）
```js
if (hasRenderEngineUrl && reBlockedDocId !== previewFile.docId) {
  const url = reUrl
  ...
  if (committedPreviewRef.current.url !== url) {
    startREProbe(url, previewFile, flowToken)   // new Image() 去 fetch 后端
  }
  return
}
```
- `frontend/src/components/DocumentViewer.jsx:64-67`（自己的取流）
```js
const previewUrl = useMemo(() => {
  if (!currentPage || !document?.docId) return null
  return resolvePreviewUrl(currentPage, document.docId)  // 独立发 /preview/{docId}?page=N
}, [currentPage, document?.docId])
```
- `frontend/src/components/DisplayAdapter.jsx:124-134`：注册文档 → 渲染 `DocumentViewer`，**完全不使用** `usePreview` 产出的 `previewUrl`/`previewCanvas`（仅传给 `PreviewCanvas` 旧路径）。

- **根因**：`usePreview` 的渲染 effect（line 565）对"当前预览文件"无条件跑 RE probe（line 741 `new Image().src = reUrl`），但 `DisplayAdapter` 对注册文档已改由 `DocumentViewer` 自己取流。**两条独立取流链并存，且 `usePreview` 那条产物被丢弃**。
- **为什么慢**：每次切文件 = **2 次后端 `/preview` 请求 + 2 次解码**，其中 `usePreview` 那次永不显示，纯浪费带宽/解码/首屏延迟。
- **建议**：在 `usePreview` effect 开头判定"消费者是 `DocumentViewer` 新路径"时直接 `return`（短路 RE probe），让 `DocumentViewer` 成为唯一取流方；或在 App 层给 `usePreview` 传 `consumerIsNewPath` 标志。

### 🔴 P4 — `usePreview` effect 依赖整个 `fileRotations` 对象，旋转任意文件都重渲染当前预览
**位置**：`frontend/src/hooks/usePreview.js:904-907`
```js
}, [previewFile, mergePair, settings.paperSize, currentRotation, fileRotations, settings.mergeMode,
    settings.marginLeft, settings.marginRight, settings.marginTop, settings.marginBottom,
    settings.customPaper?.widthMM, settings.customPaper?.heightMM, reBlockedDocId,
    renderCommand, renderCommandReady])
```
- **根因**：依赖数组含 `fileRotations`（整个 map 对象）。旋转**任何**文件都会改变 `fileRotations` 引用 → 当前预览文件的整条渲染 effect 重跑（含 RE probe 取流，见 P3），即便被旋转的文件根本不是正在预览的那个。`currentRotation` 已是当前文件的旋转量，与 `fileRotations` 冗余。
- **为什么慢**：快速连续旋转多个文件（或任一文件旋转）会重触发一次完整取流 + 解码，造成卡顿/闪烁。
- **建议**：把 `fileRotations` 替换为 `fileRotations[previewFile?.key]`（仅当前文件的旋转值），与 `currentRotation` 去重；effect 只在"正在预览的文件"旋转时才重渲染。

### 🟡 S1 — OFD 预览 300 DPI vs PDF 150 DPI，首屏明显更慢
**位置**：`backend/render_engine/adapters/ofd_adapter.py:29` `DEFAULT_OFD_DPI = 300`；`backend/render_engine/preset.py:30` `preview dpi=150`。
- **根因**：OFD 走 adapter，默认 300 DPI；PDF/Image 预览 150 DPI。
- **数据支撑**：300/150 = 2 倍线性，平方 = **4× 像素量**，WebP 编码（`method=4`，`ofd_page_render.py:165-200`）耗时显著更高。
- **建议**：OFD 预览 DPI 对齐 150（或按视口/网络动态降档；缩略图仅 48 DPI 已证明降档可行）。

### 🟡 S2 — OCR 光栅(200 DPI) 与 预览光栅(150 DPI) 对同一页各 `get_pixmap` 一次
**位置**：`backend/parsers/pdf_ocr.py:160-190`（OCR 用 200 DPI）；`backend/render_engine/engine.py:639`（预览用 150 DPI）。
- **根因**：两处独立 `page.get_pixmap(matrix=mat)`，无共享像素缓存。导入解析后预览同一页会被再次光栅化。
- **建议**：解析阶段缓存一次高 DPI pixmap（如 200 DPI），预览时直接下采样到 150 DPI，避免重复光栅。

### 🟡 S3 — PDF 字段缓存「只写不读」，每次解析都重提字段
**位置**：`backend/services/invoice_service.py:423-448`
```python
cached_fields = get_fields_cache(field_cache_key, params=field_cache_params)   # 423 读
...
extra_fields = extract_fields(raw_text_for_extract, ...)                        # 435 无条件重提
...
set_fields_cache(field_cache_key, extra_fields, ...)                            # 446 写回
```
- **根因**：`cached_fields` 在 line 424 读出后，**从未在 `if cached_fields:` 守卫下复用**——`extract_fields()` 无条件执行（仅 `CACHE_DEBUG` 时把 `cached_fields` 置空）。缓存读取是死代码，每次解析都重跑昂贵的字段提取。
- **为什么慢**：字段提取（16 步 + bbox）是解析主路径 CPU 热点之一，缓存命中却不能跳过 → 徒增延迟。
- **建议**：`if cached_fields: extra_fields = cached_fields else: extra_fields = extract_fields(...); set_fields_cache(...)`。

### 🟡 S4 — `ThumbnailStrip` 未虚拟化，长文档 DOM 节点随页数线性增长
**位置**：`frontend/src/components/ThumbnailStrip.jsx:79-95`
```jsx
{document.pages.map((page, index) => (
  <div key={page.pageId} ref={(el) => setItemRef(index, el)}>
    <ThumbnailItem index={index} thumbnailUrl={thumbnailUrls[index]}
      active={index === currentPage} shouldLoad={shouldLoadPage(index)} ... />
  </div>
))}
```
- **根因**：对每一页都 `map` 创建 DOM 节点 + `itemRefs` Map 条目。仅 `<img>` 懒加载（±5 页，`LAZY_RANGE=5`），但**容器节点与 ref 全部常驻**。
- **数据支撑**：企业发票 30/100/300 页 → 300+ 个 `.thumbnail-item` DOM 节点 + 300 个 ref 句柄在内存/布局中。主列表 `FileList` 已用 `react-window` 虚拟化，缩略图栏是**唯一未虚拟化的长列表**。
- **建议**：对缩略图列表做定高 windowing（`react-window` 的 `FixedSizeList`），仅渲染可视区 ± overscan 的条目。

### 🟡 S5 — `processPdfFile` 逐字节 `charCodeAt` 拷贝（导入期主线程卡顿）
**位置**：`frontend/src/utils/fileHelpers.js:91-95`
```js
const binaryStr = atob(page.page_bytes)
const bytes = new Uint8Array(binaryStr.length)
for (let j = 0; j < binaryStr.length; j++) {
  bytes[j] = binaryStr.charCodeAt(j)   // O(页字节数) 同步主线程
}
```
- **根因**：每页 base64 → 逐字节 JS 循环拷贝。多页 PDF 拆分时是明显同步块（虽在批间 `setTimeout(0)` 让出，但单页内仍是长同步）。
- **建议**：`Uint8Array.from(atob(b64), c => c.charCodeAt(0))`，或经 `fetch('data:application/pdf;base64,'+b64)` 直接得 Blob，免去手写拷贝。

### 💭 N1–N5（Nice to Have）
- **N1** `renderCommand`/`renderCommandReady` 进 effect 依赖（usePreview.js:907），无关切片变化也会重跑 → 收窄依赖。
- **N2** `[PREVIEW FLOW ...]` 诊断 `console.log` 残留在生产 effect（usePreview.js:572/656/667/740…），应加日志开关。
- **N3** `fullCacheRef` 共享 canvas 引用，淘汰时 `canvas.width=0`（`usePreview.js` ~140）→ 若正显示则闪白（低概率竞态）。
- **N4** `buildFileObj` 仍把 base64 包成 `data:` URL（`fileHelpers.js:17-50`），新路径不用却随每个 `fileObj` 常驻内存。
- **N5** 被取消的中间请求产生的 `createObjectURL` blob 延迟到下次成功 `doLoadPreview` 才 revoke（`usePreview.js` pendingBlobUrlsRef）——快速连切时有短暂泄漏窗口。

---

## 三、Bug 相关问题（正确性）

### 🔴 B1 — 多页 PDF 第二页拿不到 `pageId`（0-based/1-based 身份错位）
**位置**：
- `frontend/src/utils/fileHelpers.js:100` → `buildFileObj(pageFile, pageName, getPathFn(file), null, data.doc_id, page.page_index)`
- `frontend/src/utils/identity.js:80-84`
```js
export function resolvePageId(docId, pageNum, explicitPageId) {
  if (explicitPageId) return explicitPageId
  if (!docId) return undefined
  if (pageNum == null || pageNum <= 1) return undefined   // pageNum<=1 → 无 pageId
  return `${docId}:p${pageNum}`
}
```
- **根因**：`fileHelpers.js:100` 把 **0-based** 的 `page.page_index` 当作 **1-based** `pageNum` 传入。于是：
  - page_index=0 → pageNum=1 → pageId=undefined
  - page_index=1 → pageNum=1 → pageId=**undefined**（应为 `docId:p2`）
  - page_index=2 → pageNum=2 → pageId=`docId:p2`
  - **第 1、2 页共用 `docId` + 无 pageId → 身份完全碰撞**。
- **叠加**：`DisplayAdapter.jsx:97` `const initialPage = (file?.pageNum || 1) - 1` 又假设 `pageNum` 是 1-based 再减 1，进一步错位。
- **影响**：多页 PDF 的分页身份不可区分，下游按 `pageId` 索引/缓存/预览的逻辑会串页。
- **建议**：统一约定——要么全程 0-based（同步改 `resolvePageId` 与 `DisplayAdapter`），要么 `buildFileObj` 传 `page.page_index + 1`（1-based）。推荐后者，改动最小。

### 🔴 B2 — 锚点检测器因导入错误被**静默关闭**（能力退化且不可见）
**位置**：
- `backend/field_extractor/segmenter.py:26-35`
```python
try:
    from .anchor_detector import AnchorDetector, AnchorCollection
    from .region_builder import RegionBuilder, RegionCollection
    from .table_anchor import TableAnchorDetector, TableAnchorCollection
    ANCHOR_DETECTOR_AVAILABLE = True
except ImportError:
    ANCHOR_DETECTOR_AVAILABLE = False   # 静默降级
    AnchorDetector = None
    ...
```
- `backend/field_extractor/anchor_detector.py:20` → `from models import OCRDocument`（**绝对导入**，错误根因）
- **根因**：`anchor_detector.py` 用绝对导入 `from models import OCRDocument`，但当 `field_extractor` 作为包被导入时，`models` 不在顶层路径 → `ImportError` → 被 `segmenter.py` 的 `except` **吞掉**，`ANCHOR_DETECTOR_AVAILABLE=False`。结果：区域分割算法**静默回退**到传统 segment，**不打印任何错误日志**，运维/开发完全无感知。
- **影响**：更优的锚点分区能力永远不生效（也是隐性性能损失）；且"能力失效"无信号，排查极难。
- **建议**：改 `from .models import OCRDocument`（相对导入）；并在 `except ImportError as e:` 中 `logger.warning("anchor_detector unavailable: %s", e)` 让退化可见。

### 🟡 B3 — `renderers.js:buildCacheKey` 绕过 `resolvePaper` 用原始 `customPaper`（与文档声称已修矛盾）
**位置**：`frontend/src/renderers.js:1010`
```js
const _customKey = layoutOptions.customPaper?.widthMM ? `c${layoutOptions.customPaper.widthMM}x${layoutOptions.customPaper.heightMM}` : ''
```
- **根因**：合并/打印合成缓存键直接用 `layoutOptions.customPaper?.widthMM`，**未走 `resolvePaper()`**。而 `previewState.js` 等消费边界已统一 `resolvePaper`（`preview-aspect-ratio-diagnosis.md` 核实已修）。
- **影响**：残留的 `customPaper`（如历史 `100×340`）会污染多票合成（merge/print）缓存键 → 不同纸张却命中同一缓存位 → **显示错误合成图**（L2↔L3 漂移）。
- **证据**：`p0-stage1-closeout.md` 声称此处已改用 `paperKeyFragment(resolvePaper(...))`，**实测当前代码仍是原始 `customPaper?.widthMM`**——文档与代码不符，需重新修。
- **建议**：用 `paperKeyFragment(resolvePaper(layoutOptions.customPaper, ...))` 生成 `_customKey`，与预览侧保持一致。

### 🟡 B4 — 自动预览按 `files.length` 触发，而非 docId 就绪（视觉路径不一致）
**位置**：`frontend/src/App.jsx:704-710`
```js
useEffect(() => {
  if (files.length > prevFilesLengthRef.current && !previewFile) {
    handlePreview(files[0])   // 按"文件加入"事件触发
  }
  prevFilesLengthRef.current = files.length
}, [files.length, previewFile])
```
- **根因**：自动预览响应"文件数量增加"事件，而非"docId 注册就绪"状态。导入后首个文件在 `docId` 尚未与后端同步时就被预览 → 落入 Canvas/legacy 路径；用户随后点击同文件则走 RE 路径，**两条路径几何/字体不一致**（见 `auto-preview-re-path-bug.md`，仍开放）。
- **建议**：自动预览改由 `livePreviewDocId` 就绪的 effect 统一触发（现有 `usePreview` 内已有 `livePreviewDocId` 逻辑），不依赖 `files.length`。

### 🟡 B5 — Legacy 渲染路径 `prerotate(rotation)` 在 270° 产生镜像（与已校准路径不一致）
**位置**：`backend/render_engine/engine.py:624-645`（Legacy `_render_pdf_page`）
```python
rotation = vs.get("rotation", 0) % 360
mat = fitz.Matrix(zoom, zoom)
if rotation:
    mat.prerotate(rotation)   # rotation=270 → prerotate(+270) → 镜像
```
对比 `engine.py:542`（RenderSpec 路径，已校准）：
```python
_pre = {0: 0, 90: 90, 180: 180, 270: -90}[cr]   # 270→-90 避免镜像
```
- **根因**：`_render_page` 在 `render_spec is None` 时走 Legacy（`engine.py:427-429`），而 `/preview` 无 spec 参数时 `render_spec=None`（`api.py:104-105`）。Legacy 路径直接 `prerotate(rotation)`，rotation=270 时按 `engine.py:540` 的实测注释会**镜像**。
- **影响**：任何无 spec、带 270° 旋转的预览请求得到镜像图。属潜藏的正确性 + 视觉 Bug。
- **建议**：Legacy 路径复用同一映射 `{0:0,90:90,180:180,270:-90}`，或抽一个 `_build_rotation_matrix()` helper 供两条路径共用。

### 💭 B6–B8（低风险，建议观察）
- **B6** `segmenter.py:435+` 多处 `except Exception:` 逐区吞错 → 真实解析回归被掩盖；建议带 region 上下文 `logger.debug`。
- **B7** `import_batch_manager.py:296` `except Exception:` 跳过 RE 注册，静默降级预览到 legacy，无信号。
- **B8** `runChunkedImport.js:187-189` catch 兜底仍在 hydration 抛错时 `onFileUpdate(key,'parsed')` 空 payload → 可能清空已 hydrate 的 `invoiceType/amount` → 统计 `total=0`（主路径已修，catch 分支有复发风险）。

---

## 四、值得保留的良好实践（Praise 👍）

- **`RenderCache` ETag + `immutable` 缓存头 + "URL 唯一决定字节"不变式**（`cache.py:123-150`、`api.py:372`）：浏览器永不无谓重协商，设计正确。
- **文档句柄常驻 LRU**（`registry.py`，`MAX_DOCUMENTS=200 / IDLE_TTL=4h`）：避免重复 `fitz.open`，是预览管线里最该保留的缓存。
- **`useFileOps` `requestIdleCallback` 批处理**（`useFileOps.js:80`）：导入/解析状态更新合并，避免逐文件 `setFiles` 渲染风暴。
- **`FileList` 已 `react-window` 虚拟化**（`FileList.jsx`）：主列表无性能问题。
- **滚轮缩放 rAF 批处理 + ResizeObserver rAF 节流 + 平移走 CSS transform**：高频交互不重解码。
- **Adapter 短路派发**（`engine.py:420`）：OFD 在 PDF/Image 分流前短路，避免把 OFD zip 当图片解码崩溃。
- **L2 `previewCanvas` 缓存**（上限 10）：二次打开瞬时出图。

---

## 五、优先级行动清单

| # | 级别 | 问题 | 文件 | 修复成本 |
|---|---|---|---|---|
| P2 | 🔴 | 渲染图落盘（preview 命名空间从未写） | `cache.py` / `engine.py` | 低（基础设施现成） |
| P1 | 🔴 | RenderQueue 无界线程 | `queue.py` | 中 |
| P3 | 🔴 | usePreview 冗余取流 | `usePreview.js` | 低 |
| P4 | 🔴 | effect 依赖整个 fileRotations | `usePreview.js` | 低 |
| B1 | 🔴 | 多页 pageId 错位 | `fileHelpers.js` / `identity.js` | 低 |
| B2 | 🔴 | 锚点检测器静默关闭 | `segmenter.py` / `anchor_detector.py` | 低 |
| S1 | 🟡 | OFD 预览 300→150 DPI | `ofd_adapter.py` | 低 |
| S2 | 🟡 | OCR/预览光栅去重 | `pdf_ocr.py` / `engine.py` | 中 |
| S3 | 🟡 | 字段缓存只读不写 | `invoice_service.py` | 低 |
| S4 | 🟡 | 缩略图虚拟化 | `ThumbnailStrip.jsx` | 中 |
| S5 | 🟡 | 逐字节 charCodeAt | `fileHelpers.js` | 低 |
| B3 | 🟡 | renderers customPaper 绕过 resolvePaper | `renderers.js` | 低 |
| B4 | 🟡 | 自动预览按 files.length | `App.jsx` | 低 |
| B5 | 🟡 | Legacy 270° 镜像 | `engine.py` | 低 |

---

## 六、下一步建议

1. **立即做高收益低成本的 4 项**：P2（落盘缓存）、P3/P4（前端取流去重）、B1（pageId 错位）、B2（锚点导入修正）——这四项改动小、证据确凿、收益大。
2. **P1 线程池化**与 **S4 缩略图虚拟化** 是中工作量但能显著改善高并发/长文档体验，建议排入下一迭代。
3. 修复后**补契约测试**：身份契约（docId/pageId 1-based 一致性）、RenderSpec/Lazy 两路径旋转矩阵一致性（270° 不复活镜像）、缓存落盘命中率监控。

> 审查日期：2026-07-26。所有 file:line 均对应当前工作区源码；文档与代码冲突处已显式标注。
