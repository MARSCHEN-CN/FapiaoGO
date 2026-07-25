# Render Contract

> **状态：13-B.2 冻结点（2026-07-25）**
> 本文档只记录**已经验证、正在运行的**契约事实，不设计未来。
> 来源：13-A 全链（registry → DocumentViewer → /preview → /metadata）已跨 backend / frontend / cache / viewer 落地，并由回归测试锁死。
> 本文档的目的是在 13-B.3 收敛旧链时，提供不可误删的契约基准。
>
> **本文档不是**：未来设计文档，也不包含 `isPdfFile` 死代码清理（该清理独立 commit `13-B.2.1`）。

---

## 0. 链路事实（已验证）

```
file_bytes
    ↓
registry.open()                 → Document(doc_id, adapter)
    ↓
adapter.metadata()              → pages[]（含 index / width / height / sourceRotation）
    ↓  API 层映射 sourceRotation → rotation
GET /metadata/{docId}           → {doc_id, page_count, page_width, ..., pages:[{index,width,height,rotation}]}
    ↓
DocumentStore.ensureDocumentFromMetadata()
    ↓  前端映射 rotation → sourceRotation（PageMeta）
DocumentViewer（格式无关）
    ↓
GET /preview/{docId}?page=1     → engine._render_page
    ↓  page_idx = max(0, page-1)
    ↓  if doc.adapter: adapter.render(page_idx) → pdf renderer → image renderer
WebP bytes
```

---

## 1. Identity Contract（文档身份）

**规则：文档永久身份 = `sha256(file_bytes).hexdigest()[:24]`（content-only，filename 不进哈希）。**

- 实现：`backend/render_engine/registry.py:325` `_make_doc_id(file_bytes, filename="")`
  - `digest = hashlib.sha256(file_bytes).hexdigest()` → `return digest[:24]`
  - `filename` 参数被接受但**不参与哈希**（历史 deprecated 分支曾用 `sha256(file_bytes + filename)`，已弃用）。
- 前端**只透传不计算**：`docId` 由后端 `_make_doc_id` 计算，经 `/api/documents/open` 与 `/api/metadata/{docId}` 下发，前端 `resolveIdentity` / `resolvePageId` 为纯函数零 I/O，不重算哈希。

**禁止：**
- 把 `filename` 进 identity（rename 必须不改变 docId）。
- 用 `fileObj.key` / `uiKey` 等 UI 键参与 Render / Fact / Cache 标识（仅 UI 层使用）。

**不变式：**
- 同 bytes → 同 docId（幂等）。
- rename / 不同扩展名 → 同 docId。

---

## 2. Page Contract（页码语义）

**External URL（1-based） ↔ Internal engine（0-based）是唯一下标约定。**

| 层 | 参数 / 字段 | 基线 | 示例 |
| --- | --- | --- | --- |
| 外部 URL | `?page=N` | **1-based** | `?page=1` = 第 1 页 |
| 内部 engine | `page_idx` | **0-based** | `page_idx = max(0, page-1)` |
| 适配器 | `adapter.render(page_idx)` | **0-based** | `render(0)` = 第 1 页 |
| Metadata | `pages[].index` | **0-based** | `pages[0].index == 0` |

**转换（唯一入口）：** `backend/render_engine/engine.py:418`
```python
page_idx = max(0, page - 1)   # page 来自 URL，1-based
```
转换后 `page_idx` 直接喂 `doc.adapter.render(page_idx)`（`engine.py:456`），适配器合同为 0-based。

**禁止：**
- preview 单独采用 0-based（必须与 URL 约定一致，由 `max(0,page-1)` 统一转换）。
- thumbnail / render / print 使用与 preview 不同的 page convention。
- 前端自行 `-1` / `+1` 偏移（偏移只在 engine 内部发生一次）。

> 注：`?page=0` 全量契约迁移（跨 thumbnail/render/print/cache/etag/前端）超出本冻结范围，作为独立任务处理，不在 13-B 内。

---

## 3. Metadata Contract（页面元数据）

**Endpoint：** `GET /api/metadata/{docId}`（`backend/render_engine/api.py:209`）

**Response（已验证，api.py:238-247）：**
```json
{
  "doc_id": "a1b2c3...",
  "page_count": 2,
  "content_hash": "....",
  "size": 12345,
  "content_indexed": false,
  "page_width": 2480,
  "page_height": 3508,
  "page_rotation": 0,
  "pages": [
    { "index": 0, "width": 2480, "height": 3508, "rotation": 0 },
    { "index": 1, "width": 2480, "height": 3508, "rotation": 0 }
  ]
}
```

- `pages[]` 是前端未来的**唯一页面消费源**（api.py:213 注释）。
- 顶层 `page_width / page_height / page_rotation` 仅取**首页值**，保留为旧消费者兼容字段；多页文档以 `pages[]` 为全量权威。
- 派发顺序（api.py:224-230）：**adapter → pdf → image**，与 render 派发（`engine.py:414`）一致，无 `if ofd` 分支。

**字段映射（两层，已验证）：**
- 后端：`adapter.metadata()` 返回 `{pageCount, pages:[{index,width,height,sourceRotation}]}` → API 层映射 `sourceRotation → rotation`（`api.py:263`）。API 不感知具体格式。
- 前端：`ensureDocumentFromMetadata(meta)` 接收 `{docId, pages:[{index,width,height,rotation}]}` → 映射 `rotation → sourceRotation`（PageMeta）（`frontend/src/stores/DocumentStore.js:188,144`）。

**Metadata 是权威来源：** `DocumentStore.ensureDocumentFromMetadata` 是页面结构 + 尺寸的最终权威（`DocumentStore.js:184-186`）；当同一 docId 上既有 siblings 注册（欠维，不携带真实尺寸）时，metadata 结果作为最后写入覆盖。

**禁止：**
- `consumeParseResult` 用 siblings 聚合覆盖 metadata 已注册的文档（metadata 优先）。
- 前端用 `previewImage` base64 反推页面尺寸（尺寸只来自 metadata）。

---

## 4. Render Contract（渲染派发）

**优先级（engine._render_page，api.py 与 engine.py 一致）：**

```
doc.adapter.render(page_idx)     ← 格式专属渲染器（OFD / 未来 CAD/SVG/TIFF）
        ↓  adapter 为 None 时
pdf renderer                   ← doc.pdf is not None
        ↓
image renderer                 ← doc.file_bytes 单页图像
```

- adapter 短路位置：`engine.py:418-421`，在 spec/legacy 分流**之前**，使 adapter 文档（OFD 等）走专属渲染器，不被误判为 image 而崩溃。
- `adapter.render(page_idx)` 返回 `Optional[bytes]`（`ofd_adapter.py:64`）：
  - 返回 WebP bytes → 200。
  - 返回 `None` 或越界 → 抛 `ValueError` → API 层映射 **404**（非 500）（`engine.py:434-456`）。

**禁止：OFD → `previewImage` → Viewer**

`previewImage`（base64 JPEG，旧链 `parse_ofd() → render_ofd_page_preview()`，`backend/ofd_parser/_parser.py:114`）**不是 Viewer 契约**。Viewer 主链（DocumentViewer）**只走** `GET /preview/{docId}?page=N` → adapter/pdf/image，绝不读 `previewImage`。

其负向消费边界（谁可以用、谁禁止用、迁移状态）在 **§4.1** 冻结，并由 `previewImageBoundary.test.js` 锁死。

---

## 4.1 Legacy previewImage Boundary（负向边界冻结，13-B.3 C0）

> 13-B.2 冻结**正向契约**（docId → metadata → adapter.render → image）。
> 本节约等于**负向边界**：`previewImage` 这个旧字段还能在哪出现、不能在哪出现。
> 来源：13-B.3 C0 只读审计（2026-07-25），逐文件核实，非设计。

**定义：** `previewImage` = 后端 `parse_ofd() → render_ofd_page_preview()` 产出的 base64 JPEG，挂在 `ParseResult.previewImage`（`models/ParseResult.js:69`、`mappers/parseResultMapper.js:37`；`utils/fileHelpers.js:36` 由 base64 拼成 `data:image/jpeg;base64,…`）。

**Allowed consumers（仅以下位置允许出现 `previewImage`）：**
- **Print legacy pipeline**：`frontend/src/hooks/usePrint.js`（`:184` OFD/图片 blob、`:253` OFD 硬依赖、`:259` 图片、`:372` 可打印判定）；`frontend/src/contexts/FileContext.jsx:61`（OFD 无 previewImage 则不可打印）。
- **Viewer 安全网（非主路径）**：`frontend/src/hooks/usePreview.js:1189` — 仅当 `docId` 缺失时回退 base64，正常流程走 `buildPreviewUrl(docId)`。**刻意保留**，不计入禁止项。

**Forbidden consumers（以下位置禁止出现 `previewImage`，由回归测试锁死）：**
- `DocumentViewer.jsx` / `DisplayAdapter.jsx` / `OverlayLayer.jsx` / `previewResourceResolver.js` — Viewer 渲染链格式无关，已被 13-A.3.7 + 本守卫锁死。
- `ThumbnailStrip.jsx` — 翻页缩略图必须走 `resolveThumbnailUrl(docId)`（`previewResourceResolver.js:43`），不得读 `page.previewImage`。
- Import 文件列表 UI（`FileList.jsx` / `ImportProgress*.jsx`）— 纯文本/进度，**无任何缩略图 `<img>`**，不消费 `previewImage`。
- OCR 详情（`OverlayLayer` + `DocumentViewer`）— 栅格走 `buildPreviewUrl(docId)`，OCR 框叠在上面，不 fallback `previewImage`。

**Migration status（13-B.3 C0 结论）：**
| 域 | 状态 | 说明 |
| --- | --- | --- |
| Viewer | ✅ 已迁移 | docId-first；previewImage 仅缺失 docId 安全网 |
| OCR | ✅ 已迁移 | DocumentViewer + OverlayLayer，docId-first |
| Import UI | ❌ 无消费者 | 列表从不渲染 thumbnail；previewImage 仅透传字段 |
| Print | ⏳ 待 13-B.5 | 唯一活消费者；删旧链前须先迁移 |

**关键约束（影响 13-B.3 是否可删旧链）：**
- **13-B.3 不删 `render_ofd_page_preview()` / `preview_image`**：`usePrint.js` 对 OFD（`:253`）与 image（`:259`）仍以 `f.previewImage` 为唯一渲染来源；删旧链会让 OFD/图片打印直接崩溃。
- 删旧链前提 = 13-B.5 把 Print 迁到 Render Contract（`/print/{docId}` WebP），使 `usePrint` 不再依赖 `previewImage`。

---

## 5. Migration Boundary（债务隔离表）

13-B.1 审计的最大价值是把剩余债务隔离。下表为 13-B.3+ 清理提供边界：

| 模块 | 当前状态 | 处理归属 | 说明 |
| --- | --- | --- | --- |
| DocumentViewer | Render Contract | **冻结** | 格式无关，OFD/PDF/Image 同级（13-A.3.7 锁死） |
| Preview API (`/preview`) | Render Contract | **冻结** | adapter→pdf→image 派发（13-A.3.5d 锁死） |
| Metadata API (`/metadata`) | Render Contract | **冻结** | pages[] 权威，rotation 统一命名 |
| Thumbnail API (`/thumbnail`) | Render Contract | 13-B.3 | 同派发链，确认无 OFD 特判即可 |
| Import `previewImage` | Legacy | **已无消费者** | 列表 UI 不渲染缩略图；字段仅透传，13-B.3 不改 |
| OCR `previewImage` | Legacy | **已迁移** | OCR 详情走 `buildPreviewUrl(docId)`，13-B.3 不改 |
| Print `previewImage` | Legacy（独立链） | **13-B.5 C0 结论**：source 管线已绕过（printPath→Sumatra）；仅 Legacy V2 canvas 路径(merge 强制)+FileContext:61 仍依赖 → **C1 迁 docId 渲染后 C2 删旧链** | Print Contract ≠ Viewer Contract；gate BLOCKED 待 C1 |
| OFD Export (`ofd_handler.py`) | Dead | 删除/重做 | 与 Viewer 渲染无关，独立处理 |

**关键边界：**
- **13-B.3 不碰 Print**（Print Contract 是另一条大链，混入会导致回退，13-A 安全推进即因两域未混）。
- `previewImage` 旧链与 Viewer 新链消费者**隔离**（api.py:55-57 注释确认）；13-B.3 C0 核实唯一活消费者是 **Print**（`usePrint.js`），删旧链前须先迁移 **Print** 消费者（13-B.5）。

---

## 6. 锁定测试（不可回退守卫）

以下回归测试锁死上述契约，13-B.3 清理时**必须全绿**：

**Backend：**
- `backend/tests/test_metadata_contract.py` — `/metadata` 返回 `rotation` 且不含 `sourceRotation`（api.py:263 映射）；PNG 顶层字段兼容不破。
- `backend/tests/test_preview_ofd_contract.py` — `open → /preview?page=N` 完整 HTTP 闭环；OFD 双页 `page=1&2`=WebP、`page=3`=404；PNG/PDF=200。
- `backend/tests/test_registry_ofd_contract.py` — OFD `doc_id` 同 bytes 稳定；`sourceRotation==0`；A4@300dpi=2480x3508。

**Frontend：**
- `frontend/src/audit/ofdBranchCleanup.test.js` — DisplayAdapter / App 不再含 `ofd` viewer 特判；`previewResourceResolver` 无 ofd 分支（13-A.3.7 锁死）。
- `frontend/src/services/__tests__/previewImageBoundary.test.js` — Viewer/OCR/ThumbnailStrip/Resolver 渲染链不含 `previewImage`；`usePrint.js` / `FileContext.jsx` 仍合法持有（反向锚点，证明守卫非真空通过）。13-B.3 C0 锁死。

> 改任何 Render Contract 相关代码前，先跑上述测试。任一变红 = 契约被破坏。

---

## 7. 后续路线（仅索引，不在此文档展开）

```
13-B.2  Render Contract 文档冻结 ✅（本文档）
13-B.3  Legacy previewImage 收敛 → **C0 审计结论：Viewer/OCR 已迁移、Import 无消费者、唯一活消费者=Print（13-B.5）**；冻结负向边界（§4.1）+ 加回归守卫；**不删旧链**
13-B.4  Cache Contract 审计 ✅（C0 只读，全 PASS，见 §9）；不删旧链
13-B.5  Print Contract 单独迁移（独立链）
        └ C0 审计 ✅（2026-07-25）：source 管线已绕过 previewImage（printPath→Sumatra）；依赖仅在 Legacy V2 canvas 路径(merge 强制)+两 gate；backend /print+preset 已就绪；printAdapter.js orphan。Gate=BLOCKED → 先 C1 迁 Legacy V2 到 docId 渲染，再 C2 删 render_ofd_page_preview
```

---

## 9. Cache Contract Audit（13-B.4 C0 只读审计，2026-07-25）

> 只读审计：确认 Render Cache 的 key / etag / prefetch 不会跨格式 / 跨 preset 碰撞，且所有
> 改变输出字节的参数都进入身份。来源：逐文件核实 `cache.py` / `engine.py` / `preset.py` /
> `api.py` / `prefetch.py` / `render_spec_sig.py` + 前端 `previewResourceResolver.js` / `previewCacheKey.js`。
> **不改代码**——仅冻结结论，供 13-B.5 引用。

### Cache Identity — ✅ PASS
- key = `make_cache_key(doc_id, preset, page, vs_hash, hl)` = `doc_id|preset|page|[vs_hash]|[hl_token]`（`cache.py:152-160`）。
- `doc_id` = content-addressed（sha256(file_bytes)[:24]）；`doc.content_hash` = 同字节全 sha256（`registry.py:68`）。PDF/Image/OFD 内容不同 → `doc_id`/`content_hash` 不同 → key/etag 不同。**共用一个 namespace，但内容寻址保证不碰撞。**

### Preset Isolation — ✅ PASS
- `preset_name` 是 key 与 etag 的显式段；`PRESETS` 绑定 dpi/quality/format（`preset.py:25-55`）。
- `GET /preview/{A}?page=1`（150dpi）与 `GET /thumbnail/{A}?page=1`（48dpi）→ 不同 preset 段 → **thumbnail 不会覆盖 preview**。

### Page Semantics — ✅ PASS
- URL `?page=` 1-based（api `_int_param("page",1)`；前端 `page.index+1`）；cache key 直接用该 1-based 值；render 内部 `max(0,page-1)` 转 0-based。
- preview/thumbnail/render/print 同一约定，无 0/1-based 混用。

### Rotation in Cache Identity — ✅ PASS
- 两条路径都把 rotation 纳入身份：
  - Legacy `?rotation=` → `vs["rotation"]` → `_hash_view_state` → `vs_hash`（`engine.py:315`，`api.py:392`）。
  - Commit-B `?spec=`(rotation/contentRotation) → `render_spec_signature` 含 rotation（`render_spec_sig.py:58/191/194`）→ `spec_tag`（`engine.py:320`）→ key+etag。
- 当前前端 preview URL 未带 rotation/spec → 服务端按基准方向渲染（rotation-agnostic）；待 Commit-B 把 rotation 收归后端（B-2.1），经 `?spec=` 进 `spec_tag` 即纳入身份。
- 防御：`/preview` 路由刻意用 `Cache-Control: public, max-age=0, must-revalidate`（非 immutable，`api.py:112`），因 rotation/isLandscape 在迁移期可能未全部进 URL，靠 304 协商纠正陈旧方向响应（符合 `cache.py:123-150` 不变式）。

### ETag Isolation — ✅ PASS
- `etag = md5(content_hash | preset_name | view_state_hash | v | hl)`（`cache.py:102-107`）。content-based（content_hash=字节 sha）+ 含 `preset_name`。
- 危险形态 `etag = docId + page` **不存在**：`/preview` 与 `/thumbnail` 因 `preset_name` 不同 → etag 不同。

### Prefetch Safety — ✅ PASS
- `prefetch_neighbors`（`prefetch.py:15`）只排队 `current_page ± 1` 且 `1 < page < page_count` → **绝不预取越界页 / 错误页**。
- `_prefetch_render` 包裹 `engine.render` 于 try/except；`cache.put` 仅成功路径触发 → **错误页永不入缓存**。
- 与常规渲染同 namespace（同 doc_id/preset/page/vs）。

### 发现（非阻塞）
- 💭 **协商 format 未进 key/etag**：key/etag 不含 webp/jpeg/png（Accept 协商）。当前安全：①`/preview` 用 must-revalidate；②Electron 单客户端恒 webp。若未来出现 png/jpeg 客户端，须把协商 format 纳入 key（或 URL 扩展名），否则同一 URL 不同 Accept 会命中首赢者格式（轻微违背 `cache.py:123-150` 自身不变式）。建议：非 webp 客户端出现时再补。
- 💭 **prefetch 未转发 render_spec**：prefetch 调 `engine.render` 不带 `render_spec` → Commit-B spec 模式下预热 `doc_id|preview|N`（无 spec_tag），而 spec 客户端请求 `doc_id|preview|N|spec:<sig>` → 预热 miss（仅浪费预热，不返回错误字节）。
- 💭 **前端 canvas 缓存键用 `fileKey` 而非 `docId`**（`previewCacheKey.js:47`）：前端 in-memory Canvas 快照缓存，`fileKey` 会话内唯一，非正确性 Bug；但与 Identity Contract「禁 fileObj.key 进 Cache 标识」略有出入，前端作用域、低风险。其键设计本身良好（`fileKey_r{rotation}@{paperSize,isLandscape,paperLandscape,mergeMode,customPaper,margins}`），**无 `docId+page` 危险简化**。

### Required Changes
**none（只读审计，不改代码）。** 6 项全部 PASS；3 个 💭 发现均为非阻塞，可在相关功能出现时再处理。

### 下一步
全部 PASS → 进入 **13-B.5 Print Contract Migration**（Print 是唯一 legacy `previewImage` 活消费者；迁到 `/print/{docId}` WebP 后解锁删除 `render_ofd_page_preview`）。

---

## 10. Print Contract Audit（13-B.5 C0 只读审计，2026-07-25）

> 只读审计：确认 Print 当前真实链路、docId 可用性、backend print 能力、previewImage 依赖范围，
> 以及删除 `render_ofd_page_preview` 旧链的 gate 状态。来源：逐文件核实
> `frontend/src/hooks/usePrint.js` / `services/PrintService.js` / `utils/printAdapter.js` /
> `contexts/FileContext.jsx` / `config.js` + `backend/render_engine/api.py:180` / `preset.py:33`。
> **不改代码**——仅冻结结论，供 13-B.5 C1/C2 引用。

### 审计发现（关键：Print 实际比预设更干净）

**Q1 — Print 当前入口（两条管线，仅一条活）**
- `config.js:9` `PRINT_PIPELINE.mode = 'source'`（active）。
- **Source 管线（active）**：`executePrint`(:720) → `printAllSourceFiles` → `printSingleSourceFile`（`PrintService.js:107`）→ IPC `print-source-file` → Sumatra，参数 `{ filePath: file.printPath, fileFormat: 'ofd' }`。**全程不读 `previewImage`**——OFD 以原生文件路径直送 Sumatra。
- **Legacy V2 管线（canvas bitmap）**：`doPrint`(:348) → `renderFileToPrintImage`(:164) / `renderMergeGroupToPrintImage`(:241) → `submitPrintIntent`（window.print / iframe）。OFD/Image 源栅格来自 `b64toBlob(f.previewImage)`（:184 / :253 / :259）。
  - 触发条件：①`merge` 模式**强制**走 `doPrint`（`:723-726`，与 config 无关）；②`config.mode='legacy'`（当前非，故普通非合并打印不走此路）。

**Q2 — Print 需要的 Render 能力**
- Print ≠ Preview 放大：`print` preset = **dpi 200 / quality 95 / chroma 444**（`preset.py:33`），预览为 150dpi。`docId + page + preset(print) + rotation + paper` 即 Print Contract 输入。
- `renderFileToPrintImage` 内部用 `PREVIEW_DPI`(150) 走前端 canvas 合成（安全边距/merge/纸张布局），Backend `/print` 仅作**源栅格**提供方（不参与前端合成）。

**Q3 — backend 是否已有 print preset / 路由**
- ✅ `PRESETS["print"]` 存在（`preset.py:33`）。
- ✅ `GET /print/<doc_id>` 已存在（`api.py:180-204`），`_render_and_respond(doc_id, "print", page, vs, …)`，经 `_render_page` adapter 短路 → OFD 走 `OFDAdapter` → WebP(200dpi)。**Backend Print Contract 已实现，无需新增 endpoint。**

**Q4 — Electron / Sumatra 链影响**
- Source 管线 = Sumatra 直送（真实物理打印源）。Legacy V2 = canvas PNG → `submitPrintIntent` → iframe/window.print。
- ⚠️ `print-source-file` IPC handler（Sumatra bridge）在 **Electron main 进程，不在本仓库**——OFD 是否被 Sumatra 原生渲染**无法从本仓库判定**。但这一点**独立于 previewImage**：active source 管线送 OFD 走 `printPath`，删旧链不改变其行为。

**docId 可用性 — ✅ PASS**
- `fileObj.docId` 在导入时即填充（`useFileOps.js:164/234/370`、`parseResultMapper.js:64-71`、`parseResultConsumer.js:44`）。Print 文件对象（源自 `files[]`）携带 `docId` → 可构造 `GET /preview|print/{docId}`。

**迁移脚手架已存在（orphaned）**
- `frontend/src/utils/printAdapter.js` 已编码 `fileObj → docId → getDocument → resolvePreviewUrl`（:47-71），但**全仓零 import**（grep 仅命中自身）→ 死适配器。可作 C1 迁移落点，但需先被 `usePrint.js` 引用。

### 审计判定

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| Print Entry | ✅ PASS | 两管线已识别，source=active |
| docId Availability | ✅ PASS | `fileObj.docId` 导入即填充 |
| Print Render Capability | ✅ PASS | `GET /print/{docId}`(api.py:180) + `PRESETS["print"]`(preset.py:33) 已就绪，adapter 短路含 OFD |
| previewImage Dependency | ⚠️ C1 已迁 docId-first | Legacy V2 canvas 路径(:184/253/259) OFD 已改读 `fetchPrintRaster(docId)`；`parsedFiles`(:372)/`FileContext.jsx:61` 放宽 `!docId && !previewImage`；`previewImage` 仅旧 session 兜底 |
| Migration Plan | keep / migrate / delete | C1 ✅ 已完成；C2 待删旧链 |
| Legacy Delete Gate (`render_ofd_page_preview`) | 🟡 **PARTIALLY UNBLOCKED** | docId-bearing OFD 不再需 `previewImage`；C2 删生产者前仍须保旧 session 兜底 + 回归守卫同步 |

### Print 双轨模型（Source 物理打印 vs Render 栅格打印）

> ⚠️ **重要澄清（13-B.5.1 执行前 review 修订，2026-07-25）**：Print 不是一个单一系统。"迁移到 Render Contract" 仅指 **Render Print 面**；**Source 物理打印面** 是另一条合法路径，不应被 Render Contract 吞并。

- **Source 物理打印（Sumatra 直送）**：`file.printPath` → `printSingleSourceFile` → IPC `print-source-file` → Sumatra 渲染**原生文件**。`previewImage` 无依赖，`/print` 无依赖。PDF/OFD 以矢量/原生能力直送打印引擎，**不经过 rasterization**。**保留，不纳入 Consolidation。**
- **Render 栅格打印（Raster Contract）**：`docId` → `PrintAdapter` → `fetchPrintRaster` → canvas 合成 → `window.print` / `printMergedImages`。`previewImage` 仅旧 session 兜底。`buildPrintJobItem` 是此面唯一正确模型（见 §11）。
- **Legacy producer（待删）**：`render_ofd_page_preview` 产出 `preview_image`，C2 gate 满足后删除。

→ 误读防护：本节**不**表示 "Print 已完全迁移到 Render Contract"。准确表述：Render 面已迁移；Source 面从未依赖 `previewImage`，且**不应**改为经栅格化（否则损失 PDF 矢量质量 / OFD 原生能力 / 文件级打印性能）。

### Migration Plan（keep / migrate / delete）

- **KEEP（不改）**：Source 管线（`file.printPath`→Sumatra）。它本就不依赖 `previewImage`，OFD 打印与旧链解耦。
- **MIGRATE（C1 ✅ 已完成）**：Legacy V2 canvas 路径把 OFD 源栅格从 `b64toBlob(f.previewImage)` 改为 `fetchPrintRaster(docId,1)`（`/print/{docId}` 端点，200dpi WebP，更贴合 Print Contract）；Image 保留 `read-file` 优先（保原图分辨率）+ `previewImage` 兜底。涉及 `usePrint.js`：
  - `renderFileToPrintImage` 单文件 OFD 分支 → `fetchPrintRaster(f.docId,1)`（docId-first），Image 保留 `read-file` 优先
  - `renderMergeGroupToPrintImage` 合并 OFD 分支（**merge 模式强制走此路，是 13-B.5 真正的硬约束**）→ 同上 docId-first
  - `parsedFiles` 过滤：OFD 可打印条件由 `!f.previewImage` 放宽为 `!f.docId && !f.previewImage`（docId 优先，previewImage 仅作 docId 缺失兜底，与 Viewer §4.1 一致）
  - `FileContext.jsx` OFD 可打印计数：同步放宽（OFD 有 `docId` 即计入）
  - 实际落点：`printAdapter.fetchPrintRaster(docId)` + `previewResourceResolver.resolvePrintUrl`（消除 orphan；`buildPrintJobItem` 的 `pages` 经 `resolvePrintUrl` 构建，13-B.5.1a 已迁移为 pages[] 富模型）
- **DELETE（✅ C2 已完成，2026-07-25）**：停止 `parse_ofd → render_ofd_page_preview` 产出 `preview_image`（`app.py:1289` / `import_batch_manager.py:393` 已停产），并删除 `render_ofd_page_preview`（ofd_page_render.py 函数体 / __init__.py 再导出 / _parser.py 调用全移除）。前端 print/preview 模块已零引用该 Producer（见 renderOfdLegacyProducer.test.js）。`preview_image` carrier 保留为业务预览兼容字段（来自 OFD 内嵌图），不依赖已删 Producer。

### Legacy Delete Gate — ✅ UNBLOCKED（13-B.5 C2 已完成，2026-07-25）

`render_ofd_page_preview` 旧链生产者（`preview_image` 字段）原被以下路径读取，**C1 已将主路径迁走、C2 已删生产者**：
1. ~~`usePrint.js:184` `renderFileToPrintImage`~~ → **C1 已迁**：OFD 改读 `fetchPrintRaster(f.docId,1)`（`/print` 端点）；`previewImage` 仅 docId 缺失兜底。
2. ~~`usePrint.js:253` `renderMergeGroupToPrintImage`（merge 强制）~~ → **C1 已迁**：同上，OFD docId-first。
3. `usePrint.js` `parsedFiles` 过滤 → **C1 已放宽**为 `!f.docId && !f.previewImage`（OFD 有 docId 即入队）。
4. `FileContext.jsx` 可打印计数 → **C1 已放宽**为 `!f.docId && !f.previewImage`（OFD 有 docId 即计入）。

→ **gate 现状（C2 后）**：docId-bearing OFD（所有正常导入文件）完全不依赖 `previewImage`；旧链 Producer 已删除，import 表面停产 `preview_image`；`previewImage` 仅作 docId 缺失旧 session 兜底（Print + Viewer usePreview.js，均已纳入边界守卫）。
→ **C2 已处理（2026-07-25）**：①旧 session / 未导入直接打开文件仍走 `previewImage` 兜底（有意保留，避免历史数据崩，非主路径）；②`previewImageBoundary.test.js` 反向锚点已同步为「仅兜底」，并扩展 `usePreview.js` 为合法 Viewer 兜底持有者；③`render_ofd_page_preview` 生产者已删除（app.py:1289 / import_batch_manager.py:393 停产）。
→ C2 顺序已执行：更新反向锚点 → 删生产者 → 跑全测试（全绿）。

### 风险（非阻塞，但 C2 前须确认）

- 💭 **Sumatra 是否原生渲染 OFD 未知**（handler 在 main 进程，本仓库不可见）。若不支持：active source 管线 OFD 打印可能本就非功能（独立于 previewImage）；此时 Legacy V2 canvas 路径（用 previewImage 栅格）反而是唯一可工作的 OFD 打印路径。**结论：C1 迁移 Legacy V2 到 docId 渲染是 OFD 打印保持可用的必要前提**，不可跳过直接删旧链。
- 💭 **`/print` 返回 200dpi WebP，Legacy V2 仍用 150dpi `PREVIEW_DPI` canvas 合成**：C1 取源栅格用 `/preview`(150) 即可（合成会重排）；若追求打印保真用 `/print`(200)。C1 决策点，非阻塞。

### Required Changes
**C1 已完成（2026-07-25）**：迁移 Legacy V2 canvas 路径(:184/:253/:259) 源栅格 → `fetchPrintRaster(docId)`（`/print` 端点，Render Contract）；放宽 `parsedFiles` 与 `FileContext.jsx` OFD 判定（`!docId && !previewImage`）；`printAdapter.fetchPrintRaster` 接入、`previewResourceResolver.resolvePrintUrl` 新增。gate 转 **PARTIALLY UNBLOCKED**。
**C2 已完成（2026-07-25）**：反向锚点同步（`previewImageBoundary.test.js` 扩展 `usePreview.js` 为合法 Viewer 兜底）+ 删 `render_ofd_page_preview` 生产者（ofd_page_render.py / __init__.py / _parser.py）+ import 表面（app.py:1289 / import_batch_manager.py:393）停产 `preview_image` + 新增 `renderOfdLegacyProducer.test.js`（前端）+ `test_render_ofd_legacy_producer.py`（backend 静态门禁）。Legacy Delete Gate → ✅ **UNBLOCKED**。

### 下一步
- **C1** ✅：迁移 `usePrint.js` Legacy V2 canvas 路径（:184/:253/:259）源栅格 previewImage → `GET /preview|print/{docId}?page=1`；放宽 `:372` 与 `FileContext.jsx:61` 的 OFD 可打印判定。
- **C2** ✅：`previewImageBoundary.test.js` 反向锚点同步（含 `usePreview.js`）；删除 `render_ofd_page_preview` + import 表面停产 `preview_image`；13-B.5 全链路收尾。
- 合并提交纪律：C0(doc) / C1(迁移) / 13-B.5.1a(pages 模型) / 13-B.5.1b(清理冻结) / C2(删旧链) 多个独立 commit，单职责，不 push。

## 11. Print Model Consolidation（13-B.5.1 C0 只读审计，2026-07-25）

> 只读审计：在 C1 完成、C2 删旧链之前，确认 Print 是否仍残留"两套调用模型"、多页能力是否一致、printAdapter 是否应 orphan→active。
> 来源：逐文件核实 `utils/printAdapter.js` / `hooks/usePrint.js` / `services/PrintService.js` / `config.js`。
> **不改代码**——仅冻结结论 + 定义 Legacy Producer Delete Gate，供 13-B.5.1 / 13-B.5 C2 引用。
> （注：§10 Q1 发现的 Legacy V2 行号/行为为 C1 前状态；C1 已按 §10 审计判定表迁移为 `fetchPrintRaster(docId)` 优先、previewImage 仅兜底。）

### 审计发现（关键：Print 实际存在"三套分派面"，非两套）

C1 把 `fetchPrintRaster(docId)` 接进了 `doPrint` 的 OFD 分支，但 `doPrint` 在 active config 下**仅合并模式可达**（`executePrint` merge→doPrint，`:762`；非合并走 `printAllSourceFiles`；legacy trigger 的 `PRINT_PIPELINE_V2` 未定义、`triggerPrint` 亦不被设置故休眠）。因此当前真实打印分派有 **三个面**：

1. **Source 面（active，非合并）**：`executePrint`(:769) → `printAllSourceFiles` → `printSingleSourceFile`（`PrintService.js:107`）→ IPC `print-source-file { filePath, fileFormat }`（`:126-130`）→ Sumatra 渲染**原生文件**。OFD 走 `file.printPath` 直送，**完全不碰 /print、不碰 previewImage**（§10 已记）。
2. **doPrint 面（merge / legacy-trigger）**：`doPrint`(:384) → `renderFileToPrintImage`(:165)/`renderMergeGroupToPrintImage`(:262) → `fetchPrintRaster(f.docId, 1)`（`:187`/`:279`）→ `/print` → canvas。C1 贡献，**仅 page=1**。
3. **buildPrintJobItem 面（ORPHAN → 13-B.5.1a 已激活）**：`printAdapter.buildPrintJobItem` 返回 `PrintJobItem.pages = doc.pages.map(...)`（**全页**走 /print，富对象 `{index,url}`，身份为 docId+index）；同文件的 `needsPerPageRender`/`getPageUrlsForPrint`/`validatePrintJob` grep 全仓零调用方（→ 13-B.5.1b 已删除）。

→ **核心矛盾（精确表述）**：orphan 面(#3) 拥有 **Render Print 子系统**唯一正确的"全页模型"（docId→逐页 /print），但无人调用；live 的 doPrint 面(#2) 用错了单页模型（`page=1`）；active Source 面(#1) 是另一条**合法的物理打印路径**（`file.printPath`→Sumatra，绕过 rasterization），**不应**被 Render Contract 吞并，也**不在** 13-B.5.1 范围内。

### Q1 — `buildPrintJobItem` 是否应成为 **Render Print 子系统**唯一入口？

**结论：应是 —— 但限定于 Render Print 子系统，而非整个 Print 系统。** ⚠️（13-B.5.1 执行前 review 修订）
- 它是 **Render Print 子系统**（merge 打印 / legacy canvas 打印 / 未来预览打印 / 批量合成打印）唯一以 `PrintJobItem` 表达"逐页 Render Contract 栅格"的模型，与 §2/§3 page 契约对齐。
- 它 **不服务** Source 物理打印面（`file.printPath`→Sumatra 直送，绕过栅格化，见 §10 双轨模型）。把 Source 面强行纳入会错误地把本可直接交打印引擎的 PDF/OFD 强制过一遍 rasterization，损失矢量质量与原生能力。
- 当前死因是 `doPrint` 把"取栅格"内联成了 `fetchPrintRaster(f.docId, 1)`，绕过了 `buildPrintJobItem`。

**模型修订（消费 `pages[]` 而非 `pageUrls[]`）**：`buildPrintJobItem` 应返回富对象 `pages: [{ index, url }]`（而非扁平 `pageUrls: string[]`），使渲染函数直接消费结构化页模型、page 契约仍由 adapter（`resolvePrintUrl`）管理：
```js
// PrintJobItem.pages: [{ index: 0, url: "/print/id?page=1" }, { index: 1, url: "/print/id?page=2" }, ...]
const job = buildPrintJobItem(f)   // Render Print 面唯一入口
for (const page of job.pages) {
  const blob = await fetchPrintRaster(job.docId, page.index + 1)  // Blob → ImageBitmap → canvas
}
```
**consolidation 落点**：`renderFileToPrintImage`/`renderMergeGroupToPrintImage` 改为消费 `buildPrintJobItem(f).pages`（修多页 OFD）；多页 Image/PDF 行为一并统一。

**长期方向（非 13-B.5.1 阻塞）**：`buildPrintJobItem` 入参当前是 `fileObj`（UI 生命周期对象）。Render Contract 核心身份是 `docId`/`Document`（Render 生命周期对象）。参考 Viewer 已完成的 `File → DocumentStore → Document → Render` 同化，Print 长期应收敛为 `buildPrintJobItem(document)`，由 `document` 派生 `docId` 与 `pages`。13-B.5.1 可暂保留 `fileObj` 入参（内部已 `getDocument(docId)`），但模型命名/职责应朝 `document` 演进。

### Q2 — 多页 OFD / PDF 当前模型是否一致？

| 格式 | Source 面(#1) | doPrint 面(#2, C1) | buildPrintJobItem(#3) |
| --- | --- | --- | --- |
| PDF | ✅ Sumatra 原生全页 | ✅ read-file→pdfjs 全页 | ✅ pages 全页 |
| OFD | ✅(若 Sumatra 原生支持) / ❌(见风险) | ❌ **`fetchPrintRaster(docId,1)` 仅第 1 页** | ✅ pages 全页（设计正确，13-B.5.1a 已激活为 Render Print 唯一模型） |

→ **不一致点**：多页 OFD 在 doPrint 面只打印第 1 页（C1 硬编码 `page=1`）。与 Source 面（全页）、buildPrintJobItem（全页）矛盾。PDF 三面对齐。
→ 此不一致**非 C1 引入**（旧链本就单 previewImage），但 Render Contract 已支持 `/print?page=N` 而 frontend consumer 未消费 → 暴露为潜在 bug。

### Q3 — `printAdapter.js` 是否应 orphan→active？

**结论：应，且已激活。** `fetchPrintRaster` 已被 `usePrint.js` import 并调用（#2 面活）；`buildPrintJobItem` 在 13-B.5.1a 被 `usePrint` 消费（`job.pages` 逐页渲染，#3 面激活）。printAdapter 现已成为**唯一 Render Print Model 模块**（不覆盖 Source 物理打印面，见 §10 双轨模型）：活的部分 `fetchPrintRaster` + `buildPrintJobItem` 保留；`needsPerPageRender`/`getPageUrlsForPrint`/`validatePrintJob` 在 13-B.5.1b 确认零调用方后删除（避免维护者误以为"全页 pages 已生效"）。

### 13-B.5.1 路线决策（回答"直接 C2 还是先合并"）

- **不先 C2**：删 `render_ofd_page_preview` 前须先消"Render Print 面两套调用模型"——否则删旧链后 doPrint 多页 OFD 仍只打第 1 页，且 buildPrintJobItem 死代码继续误导。
- **路线改为**：`13-B.5 C0 → 13-B.5 C1 ✅ → 13-B.5.1 Render Print Model Consolidation → 13-B.5 C2 Legacy producer removal`。
- **13-B.5.1 范围（精确，且不吞并 Source 面）**：
  - ① `buildPrintJobItem` 改 `pages[]` 富模型（见 Q1）；② doPrint 两 render 函数改消费 `job.pages`（修多页 OFD + 统一 Image/PDF 多页行为）；③ `printAdapter` 死函数接活或删；④**不碰 Source 面**（`file.printPath`→Sumatra，属 Render Contract 外、§10 确认不依赖 previewImage，且**不应**改为经栅格化）。
- **13-B.5.1 Commit 拆分（与 C2 严格隔离）**：
  - **Commit 13-B.5.1a — Promote PrintAdapter Render Model**（✅ 已完成：commit `0006deb2` / tag `13-B.5.1a-pages-model`）：`buildPrintJobItem` 改 `pages[]` 模型 + `usePrint` 接入 + 多页 OFD 修复 + 多页 Image/PDF 行为统一 + `flattenPrintData` 展开。测试：`printAdapter.test.js` / `multiPagePrint.test.js`。
  - **Commit 13-B.5.1b — Render Print Model Cleanup & Contract Freeze**（✅ 已完成）：删除 `needsPerPageRender` / `getPageUrlsForPrint` / `validatePrintJob`（确认零调用方）；`flattenPrintData` 加 `.flat()` 硬化；新增 `renderPrintCardinality.test.js` 锁 Page Cardinality Contract；本文档 §10/§11 同步。
  - 两个 commit 均不混入 C2 的"删旧链"改动。

### Legacy Producer Delete Gate（✅ C2 已完成，2026-07-25）

> **冻结范围（C2-A，用户拍板）**：C2 删除的是 **OFD Legacy Render Producer**（`render_ofd_page_preview` 函数体 + 调用 + 再导出），**不删除 `ParseResult.preview_image` carrier**。`preview_image` 保留为业务预览兼容字段（来自 OFD 内嵌图，不再经 CTM 重渲染），禁止作为 Render Print / Viewer 主路径（仅 docId 缺失旧 session 兜底）。此边界防止 C2 偷偷扩大成"发票预览系统重构"。

**backend（归零 / 停产）**
- `render_ofd_page_preview()` 函数体已删除（ofd_page_render.py / __init__.py 再导出 / _parser.py 调用全移除）。
- `app.py:1289` / `import_batch_manager.py:393` 不再 emit `preview_image`（import 表面停产）。
- `invoice_service` 仍消费 `preview_image`（来自 `parse_ofd` 内嵌图兜底），不依赖已删 Producer —— P3 发票预览保留。
- `preview_image` 字段不再被任何 `/metadata`/`/import` 响应写出。

**frontend（previewImage 仅 fallback）**
- 允许：`usePreview` 安全网（§4.1）；`usePrint`/`FileContext` 的 `previewImage` 仅 `docId` 缺失兜底分支。
- 禁止：`usePrint` 主渲染路径 primary 用 `previewImage`；`FileContext` primary gate 用 `previewImage`；`printAdapter` primary 用 `previewImage`。
- 注：`buildPrintJobItem` 无 doc 时 `pages=[]` 走兜底属预期，不视为 primary 依赖。

**C2 新增前置条件 — Render Print Page Cardinality Contract（取代原"多页闭环"）**
- 删 `render_ofd_page_preview` 前，必须确认 **Render Print 面** page cardinality 已成立：`1 task → N render outputs（buildPrintJobItem().pages 逐页 fetchPrintRaster → Uint8Array[]）→ runMergedPrintTasks.flattenPrintData 展开 → N 物理页`。
- 即 OFD page1…pageN 全部经 `docId → /print?page=N → canvas → print` 输出（`buildPrintJobItem().pages` 全页被消费），而非仅 page=1。否则删旧链后多页 OFD 打印功能倒退。
- Verified（13-B.5.1a/b）：①OFD page1..pageN 全页输出 ②PDF 行为不变（read-file 原生多页，未触 pages[] 展开）③Image 单页不退化（read-file/previewImage 兜底，未触 pages[]）④merge composition 行为不变（`renderMergeGroupToPrintImage` 保持 page=1 单页合成，slot 非 Document.pages）。
- Source 面多页由 Sumatra 原生处理，不在此条件范围（见 §10 双轨模型）。

**tests（已新增守卫，均通过）**
- ✅ 新增 `renderOfdLegacyProducer.test.js`（前端）：锁 `render_ofd_page_preview` 不被 print/preview 模块引用；`buildPrintJobItem` 产出 `pages[]`；usePrint OFD docId-first。
- ✅ 新增 `test_render_ofd_legacy_producer.py`（backend 静态门禁，stdlib 可跑）：锁 Producer 函数体删除 + `_parser.py` 无调用 + `__init__` 无再导出 + import 表面停产 `preview_image`。
- ✅ 既有 `previewImageBoundary.test.js` 反向锚点已扩展 `usePreview.js` 为合法 Viewer 兜底（"仅兜底"语义）。

**前置风险（C2 不解决，须记录）**
- ⚠️ Sumatra 原生 OFD 支持未知（main 进程，本仓库不可见）。若不支持，active Source 面 OFD 打印可能本就非功能——与 previewImage 无关，C2 删旧链不改变，须单独确认。

### Required Changes
- 13-B.5.1（✅ 已完成，拆 **13-B.5.1a** / **13-B.5.1b**）：`buildPrintJobItem` 改 `pages[]` 模型 + doPrint 两 render 函数消费 `job.pages`（修多页 OFD、统一 Image/PDF）+ `flattenPrintData` 展开 + 删 3 死函数 + 锁 Page Cardinality Contract。范围限定 **Render Print 子系统**，不碰 Source 面。
- **13-B.5 C2（✅ 已完成，2026-07-25，commit 待打 tag）**：反向锚点同步（含 `usePreview.js`）→ 删 `render_ofd_page_preview` 生产者（ofd_page_render.py / __init__.py / _parser.py）+ import 表面（app.py:1289 / import_batch_manager.py:393）停产 `preview_image` + 新增 `renderOfdLegacyProducer.test.js` / `test_render_ofd_legacy_producer.py` → 跑全测试（前端 6 测试文件全绿 + backend 静态门禁通过）。

### 下一步
- ✅ **13-B.5.1a**（commit `0006deb2` / tag `13-B.5.1a-pages-model`）：`buildPrintJobItem` 改 `pages[]` 富模型 + `usePrint` 接入 + 多页 OFD 修复 + `flattenPrintData` + `printAdapter.test.js`/`multiPagePrint.test.js`。
- ✅ **13-B.5.1b**（Render Print Model Cleanup & Contract Freeze）：删 3 死函数、`flattenPrintData` 加 `.flat()`、新增 `renderPrintCardinality.test.js` 锁 Page Cardinality Contract、本文档同步。
- ✅ **13-B.5 C2**（Legacy Producer Delete）：删 `render_ofd_page_preview` + import 表面停产 `preview_image` + 反向锚点同步（含 usePreview.js）+ 门禁测试。13-B.5 全链路收尾；Render Print 子系统经 `buildPrintJobItem().pages` → `fetchPrintRaster` → `flattenPrintData` → `printMergedImages` 完成多页闭环，旧 OFD 重渲染 Producer 退役。
