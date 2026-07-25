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
| Print `previewImage` | Legacy（独立链） | **13-B.5 独立** | Print Contract ≠ Viewer Contract，**不在 13-B.3 触碰** |
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
13-B.4  cache / etag / prefetch 审计（docId/page/dpi/format/rotation 防碰撞）
13-B.5  Print Contract 单独迁移（独立链）
```
