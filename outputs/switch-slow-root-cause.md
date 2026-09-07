# 切换发票 → 展示区加载慢：根因诊断

日期：2026-09-07 · 分支 `rotation-b1-hardening` @ `e2fa158` · **只读诊断，未改动任何生产代码**

测量环境：PyMuPDF 1.28.0 / Python 3.12 / Flask(threaded=True) / 220 份测试发票。
基准脚本：`outputs/perf-runs/switch-slow/`（`_image_dpi_bench.py`、`_switch_bench.py`、`_switch_bench_http.py`）。

---

## 0. 一句话结论

**展示区的"缓存"从来没生效在展示区上**；而真正的耗时大头是后端把每张图片/OFD 发票
**按 2.44 倍像素面积放大后再渲染**——一张 12MP 手机拍照发票冷渲染 **6.3 秒**，16MP 的
**29.3 秒**。用户切一次付一次，切回来还得再解码一次 29MP 的大图。

---

## 1. 实测数据（硬证据）

### 1.1 单张渲染耗时（`_image_dpi_bench.py` / `_switch_bench.py`）

| 发票类型 | 源 | 产物像素 | 产物体积 | **冷渲染** | 后端缓存命中 |
|---|---|---|---|---|---|
| 矢量 PDF（电子发票） | 595×842pt | 1240×1755 | 55.8 KB | **303 ms** | 0.03 ms |
| 扫描件 150dpi A4 | 1240×1754 | 1938×2741 | 508 KB | **1 154 ms** | 0.04 ms |
| 高拍仪 2592×1944 | 5 MP | 4050×3038 | 1.1 MB | **2 918 ms** | 0.09 ms |
| 手机拍照 3000×4000 | 12 MP | 4688×6250（29 MP） | 2.8 MB | **6 277 ms** | 0.02 ms |
| 手机拍照 4608×3456 | 16 MP | 7200×5400（39 MP） | 3.9 MB | **29 286 ms** | 0.02 ms |

后端 RenderCache 本身是好的（命中 0.02 ms）；**问题在"没命中时有多贵"和"命中了前端也要重解码"**。

### 1.2 预取争用（`_switch_bench.py` §C）

| 场景 | 前台渲染延迟 |
|---|---|
| 无后台任务 | 244 ms（中位） |
| 同时跑 6 个后台预取渲染 | **448 ms（中位）· max 470 ms** |

前台被预取拖慢 **+84%**。

### 1.3 注册表容量形同虚设（`_switch_bench.py` §D / `_switch_bench_http.py` §6）

`DocumentRegistry.MAX_DOCUMENTS = 200`，但实测注册 **220 份后仍持有 220 份**，
220 个 fitz 句柄全部处于打开状态。

---

## 2. 根因清单（按影响排序）

### 🔴 R1（主因，实测）图片/OFD 渲染无像素上限，`dpi/72` 施加于位图

`backend/render_engine/engine.py:726`

```python
zoom = preset.dpi / 72.0          # preview preset: dpi=150 → zoom = 2.083
mat = fitz.Matrix(zoom, zoom)
pix = img_doc[0].get_pixmap(matrix=mat)
```

fitz 把位图包装成 1 页 PDF 时按 **96 dpi** 定尺（页面 pt = 像素 × 72/96），
于是净放大倍数 = `150/96 = 1.5625` **线性 / 2.44 倍面积**，且**没有任何上限**。

- 12 MP 手机拍照 → 输出 29 MP → 编码 2.8 MB → **6.3 s**
- 16 MP → 输出 39 MP → 3.9 MB → **29.3 s**

发票场景以拍照/扫描件为主，这就是"常常要等特别久"的直接来源。
（对比：矢量 PDF 走 `_render_pdf_page`，`zoom = dpi/72` 对 72dpi 的 pt 坐标系是正确语义，只有位图路径错。）

### 🔴 R2（实测）预取与前台抢资源

- `frontend/src/App.jsx:169` `PREFETCH_RANGE = 3` → 每次切换预热 **6 张**邻居，`prefetchPreviewUrls` concurrency=2。
- `backend/render_engine/api.py:610` 每次 page1 渲染后再 `render_queue.submit(... prefetch_neighbors ...)`，
  后台再起线程渲染 page±1。
- 实测前台延迟 244 ms → 448 ms。图片类发票下，6 张 × 数秒的后台渲染会把前台彻底拖死。

### 🟠 R3 双预览管线并存，每次切换渲染两遍且缓存键不同

展示区实际只渲染 `DisplayAdapter → DocumentViewer → ViewerViewport`
（`App.jsx:1254`，`<img src={resolvePreviewUrl(...)}>` → `/preview/{doc}?page=N&schema=2`）。

但遗留 `usePreview.js` 的渲染 effect（`usePreview.js:671`，deps 含 `previewFile`）仍在跑：

```
usePreview.js:696  reUrl = getRenderEnginePreviewUrl(previewFile, USE_RENDER_ENGINE_PREVIEW, previewSpec)
usePreview.js:867  if (hasRenderEngineUrl && ...) startREProbe(url)   ← new Image() 真发请求
```

该 URL 带 `spec_sig=...` 等参数 → **与展示区 URL 是两个不同的后端缓存键**
（`engine.py:321` `spec_tag` 进 cache_key）。后果：

1. 每次切换 = 2 次全量渲染（图片类即 2 × 数秒）。
2. RenderCache 条目翻倍（实测 200 份：200 条 → 400 条）。
3. 这份产物除 `App.jsx:1214` 的 loading 遮罩判定外**无人消费**（`previewUrl`/`previewCanvas`
   不进任何渲染组件）——是纯浪费。

### 🟠 R4 L2 画布缓存（`fullCacheRef`）对展示区是死代码

`usePreview.js:150,1021`：`setFullCache()` 只在 `renderToCanvas()`（遗留 canvas 路径）里调用。
展示区走 `<img>`，永不写入、永不命中。注释写的"✅ 渲染完成 → 缓存快照到 fullCache，**后续切换秒开**"
在当前架构下从未生效。而且它上限只有 10 条。

### 🟠 R5 前端 LRU 上限 50 < 文件数 200，尺寸探测每次重下整图

`usePreview.js:301-306`：`previewLoadCacheRef` 一个 Map 共享 `blob_/dims_/pdf_/pdfDims_`
四类键，`MAX_CACHE_ENTRIES = 50`。200+ 文件必然抖动。

- 图片/OFD：`usePreview.js:1385` **无条件** `await fetchImageDims(url, key)`，
  缓存未命中就整图下载（`timeoutMs = 8000`）只为拿宽高——而图片类恰恰是最大最慢的那批。
- PDF：`usePreview.js:1496` 每次 `fetch(/metadata/{docId})`，前端零缓存（实测 2~3 ms/次，非主因但每切必发）。

### 🟡 R6 展示区每次切换强制回"加载中…"并重新解码

`ViewerViewport.jsx:85-113`：`previewUrl` 一变就 `setNaturalDims(null)` →
`dimsKnown=false` → wrapper `opacity:0` + "加载中…"。

即使字节来自浏览器缓存（`/preview` 返回 `Cache-Control: public, max-age=0, must-revalidate`，
走 304），29 MP 的 WebP **仍要重新解码**（数百 ms ~ 秒级，且解码后 RGBA 约 117 MB/张）。

### 🟡 R7 注册表上限永不生效 + 缓存内存无上限

- `registry.py:56` `MAX_DOCUMENTS = 200`，但 `Document.ref_count` 默认 1（`registry.py:42`）、
  `open()` 命中既有文档还 `+=1`，而前端从不调 `release()`；`_evict_oldest()` 只挑 `ref_count==0` 的
  → **永不淘汰**。实测 220/220 全常驻（打开句柄 + `file_bytes`），200+ 导入后内存只增不减。
- `RenderCache.MAX_ENTRIES = 1000` 无字节上限：图片类单条 0.5~3.9 MB → 满仓可达 GB 级；
  `_evict_oldest()` 用 `min()` 全表扫描且持锁。

---

## 3. 为什么 A→B→C→A 来回切"都"很慢

| 环节 | 首次 | 切回时 |
|---|---|---|
| 后端渲染 | 1.2 s ~ 29 s（R1） | 0.02 ms（RenderCache 命中） |
| HTTP 传输 | 0.5 ~ 3.9 MB | 304，无 body |
| **浏览器解码** | 29 MP WebP，数百 ms~秒 | **同样要重新解码**（R6，naturalDims 被清零） |
| 遗留管线补刀 | 再一次全量渲染（R3） | 同左（不同缓存键） |
| 预取争用 | +84% 前台延迟（R2） | 同左 |
| 缓存被挤掉后 | — | 重付 1.2 s ~ 29 s（R5/R7：LRU 50、1000 条上限） |

即：**后端命中只省掉了"渲染"，省不掉"解码 + 重绘"**；而一旦任何一层缓存被挤掉，
就要重付完整冷渲染。所以"来回切"体感与首次几乎无差别。

---

## 4. 优化建议（按 ROI 排序，均未实施）

| # | 措施 | 位置 | 预期收益 |
|---|---|---|---|
| 1 | 位图渲染加输出像素上限 / 修正 dpi 语义（让 preview 对位图 ≈ 1:1，并对长边封顶，如 2000px） | `engine.py:726` `_render_image_page` | 12MP 拍照 **6 277 ms → <200 ms**；产物 2.8 MB → <300 KB。收益最大 |
| 2 | 预收窄：±3 → ±1，且仅在前台渲染完成后 idle 触发；图片类可禁用 | `App.jsx:169`、`api.py:610` | 前台延迟 -84% |
| 3 | 关停遗留 `usePreview` 的 RE probe（展示区已不消费其产物，仅 `App.jsx:1214` 用它判遮罩，需同步改判定） | `usePreview.js:867` | 每次切换省一次全量渲染；缓存条目减半 |
| 4 | `fetchImageDims` 改走 `/metadata` 取尺寸（该 fallback 分支已存在），不再整图下载；或把 LRU 上限提到 > 文件数 | `usePreview.js:1385,301` | 图片类切换省一次整图下载 |
| 5 | `ViewerViewport` 同 URL 时不清空 `naturalDims`（沿用上一帧尺寸），消除"秒白 + 加载中" | `ViewerViewport.jsx:85` | 切回几乎无感 |
| 6 | 修 `ref_count` 语义或改强制 LRU，让 `MAX_DOCUMENTS` 真正生效 | `registry.py:42,56,252` | 200+ 导入内存可控 |
| 7 | `/preview` 支持按容器尺寸请求合适分辨率（如 `?maxpx=`），避免小窗看大图 | `api.py:71` | 传输/解码双降 |

> 纪律提示：R1/R7 涉及 `render_engine` 渲染输出字节变化，属契约级改动，
> 需同步 `RenderCache` 的 `RENDER_ENGINE_VERSION` 失效旧缓存，并按项目惯例走
> 「冻结契约 → 红测试 → 设计审计 → 实现 → 绿测试」链路，不可直接顺手改。
