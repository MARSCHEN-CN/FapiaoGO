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
| previewImage Dependency | ❌ FAIL | Legacy V2 canvas 路径（`usePrint.js:184/253/259`）+ `parsedFiles` 过滤(:372) + `FileContext.jsx:61` 仍要求 OFD `previewImage` |
| Migration Plan | keep / migrate / delete | 见下 |
| Legacy Delete Gate (`render_ofd_page_preview`) | 🔴 **BLOCKED** | 见下 |

### Migration Plan（keep / migrate / delete）

- **KEEP（不改）**：Source 管线（`file.printPath`→Sumatra）。它本就不依赖 `previewImage`，OFD 打印与旧链解耦。
- **MIGRATE（C1）**：Legacy V2 canvas 路径把 OFD/Image 源栅格从 `b64toBlob(f.previewImage)` 改为 `fetch GET /preview/{docId}?page=1 → blob`（或 `/print/{docId}` 取 200dpi 更贴合 Print Contract）。涉及 `usePrint.js`：
  - `renderFileToPrintImage`(:184) 单文件 OFD/Image 分支
  - `renderMergeGroupToPrintImage`(:253 OFD / :259 Image) 合并分支（**merge 模式强制走此路，是 13-B.5 真正的硬约束**）
  - `parsedFiles` 过滤(:372)：OFD 可打印条件由 `!f.previewImage` 放宽为 `!f.docId && !f.previewImage`（docId 优先，previewImage 仅作 docId 缺失兜底，与 Viewer §4.1 一致）
  - `FileContext.jsx:61` 可打印计数：同步放宽（OFD 有 `docId` 即计入）
  - 建议接 `printAdapter.buildPrintJobItem(f).pageUrls`（已有 `resolvePreviewUrl` 映射），消除 orphan。
- **DELETE（C2，gate 解锁后）**：停止 `parse_ofd → render_ofd_page_preview` 产出 `preview_image`（`app.py:1289` / `import_batch_manager.py:393`），并删除 `render_ofd_page_preview`。前提：全仓 `previewImage` 对 OFD 的读取归零（C1 完成 + 两 gate 放宽）。

### Legacy Delete Gate — 🔴 BLOCKED

`render_ofd_page_preview` 当前被以下路径读取（删除前必须全部归零）：
1. `usePrint.js:184` `renderFileToPrintImage`（legacy 普通模式，当前 config 不触发，但 legacy 配置/兜底可达）
2. `usePrint.js:253` `renderMergeGroupToPrintImage`（**merge 模式强制**，任何 config 都可达 → 真正 blocker）
3. `usePrint.js:372` `parsedFiles` 过滤（doPrint 内，OFD 无 previewImage 即被剔除）
4. `FileContext.jsx:61` 可打印计数（OFD 无 previewImage 不计）

→ C1 完成（legacy V2 改读 docId 渲染）+ 放宽 #3/#4 后，gate 转 **UNBLOCKED**，C2 才安全。

### 风险（非阻塞，但 C2 前须确认）

- 💭 **Sumatra 是否原生渲染 OFD 未知**（handler 在 main 进程，本仓库不可见）。若不支持：active source 管线 OFD 打印可能本就非功能（独立于 previewImage）；此时 Legacy V2 canvas 路径（用 previewImage 栅格）反而是唯一可工作的 OFD 打印路径。**结论：C1 迁移 Legacy V2 到 docId 渲染是 OFD 打印保持可用的必要前提**，不可跳过直接删旧链。
- 💭 **`/print` 返回 200dpi WebP，Legacy V2 仍用 150dpi `PREVIEW_DPI` canvas 合成**：C1 取源栅格用 `/preview`(150) 即可（合成会重排）；若追求打印保真用 `/print`(200)。C1 决策点，非阻塞。

### Required Changes
**none（只读审计，不改代码）。** 但 gate 为 BLOCKED：C2 删除旧链**必须**等 C1（迁移 Legacy V2 canvas 路径 + 放宽两 gate）落地且 `previewImageBoundary.test.js` 反向锚点同步更新。

### 下一步
- **C1**：迁移 `usePrint.js` Legacy V2 canvas 路径（:184/:253/:259）源栅格 previewImage → `GET /preview|print/{docId}?page=1`；放宽 `:372` 与 `FileContext.jsx:61` 的 OFD 可打印判定。
- **C2**：`previewImageBoundary.test.js` 反向锚点（`usePrint.js`/`FileContext.jsx` 仍持有 previewImage）改为「仅当 `docId` 缺失兜底」；然后删除 `render_ofd_page_preview` + 停产 `preview_image`。
- 合并提交纪律：C0(doc) / C1(迁移) / C2(删旧链) 三个独立 commit，单职责，不 push。
