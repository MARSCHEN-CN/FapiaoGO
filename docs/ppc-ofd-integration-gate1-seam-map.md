# PPC-OFD Integration Gate 1 — Seam Map（docs-only）

> **性质**：docs-only，纯取证 + seam 收敛分析。**不修改任何生产代码**，不提前实现 OFD renderer，不重开 R1 / PPC / Gate 4。
> **目标（单一验证命题）**：在 PPC 已定义的 PrintResource ownership 下，OFD 是否可作为一种**输入来源**，被转换为统一 RenderResource，进入现有 Preview / Print pipeline，而**无需新增 OFD 专用打印路径**。
> **状态**：🔒 **Gate 1 = PASS（收敛点已存在，非从零构建）** —— 见 §7。

---

## 0. Scope Lock

| 项 | 状态 |
| --- | --- |
| R1 Rotation Ownership | 🔒 CLOSED — 未触碰 |
| PPC Architecture | ✅ RATIFIED — 未触碰 |
| Gate 4 (merge geometry) | 🔒 CLOSED — 未触碰 |
| OFD 输入格式身份 | 确认存在（`getFileFormat('.ofd')→'ofd'`） |

**Gate 1 不验证（边界纪律）**：
- ❌ OFD 标准完整支持 / 文本提取准确性 / 排版重构
- ❌ OFD 专用打印按钮 / 专用 merge composer / 专用 rotation resolver
- ❌ 修改 `RenderCommand` contract
- ❌ 实现 `VirtualPrintSource` 终态（仅确认其已**部分实化**）

---

## 1. Current OFD Ingestion Path（P0 输入识别）

**事实**：OFD 已是前端的 first-class 输入格式，识别点在 `getFileFormat`。

| 位置 | 证据 | 结论 |
| --- | --- | --- |
| `frontend/src/utils.js:53` | `if (ext === 'ofd') return 'ofd'` | `.ofd` → format `'ofd'` |
| `frontend/src/utils/renderModelValidator.js:25` | `VALID_FILE_FORMATS = new Set(['pdf','ofd','image'])` | OFD 与 pdf/image 同级 |
| `frontend/src/utils.js:66` | `MAP['ofd']='application/ofd'` | MIME 已映射 |
| `frontend/src/utils/detectOrientation.js:14` | `@param {'pdf'\|'image'\|'ofd'}` | 类型系统在 doc |

**Ingestion 收敛点**：`buildFileObj(file, name, ...)`（`fileHelpers.js:23`）注入 `fileFormat: getFileFormat(name)` → 单文件 OFD 默认 `instanceId=key`、`pageCount=1`、`pages:[{index:0,...}]`。**与 Image 完全相同的入口** —— 无 OFD 专用导入分支。

---

## 2. Current OFD Rendering Capability（P1 渲染器，后端已存在）

**关键发现**：OFD→Image 栅格化**已在后端实装**，不是待建模块。

| 模块 | 证据 | 职责 |
| --- | --- | --- |
| `backend/ofd_parser/ofd_page_render.py:26` | `→ WebP → /preview\|/print` 注释 | OFD 页 → WebP 栅格 |
| `backend/render_engine/api.py:201` | `@render_bp.route("/print/<doc_id>")` `print_page()` | `GET /print/{doc_id}?page=N`，print preset 200dpi |
| `backend/render_engine/registry.py:213,242` | `doc.adapter` 优先（OFD 等），无 sniff | 格式专属渲染器注册 |
| `backend/render_engine/engine.py:716` | 「All image rendering paths (preview/thumbnail/print) share this function」 | 预览/缩略图/打印共享栅格函数 |
| `backend/tests/test_preview_ofd_contract.py` | 文件存在 | OFD preview/print contract 契约测试 |
| `backend/tests/test_ofd_render_samples.py:121` | 「R-DPI Gate：requested DPI → raster pixel 线性缩放」 | OFD 栅格 DPI 回归 |

**输入/输出契约（后端 Render Engine）**：
```
输入  : doc_id（content-only sha256[:24]，Identity v1.1）+ page(N 1-based) + preset(print)
处理  : doc.adapter(OFD parser) → 栅格(WebP/PNG, 200dpi print preset)
输出  : Blob（image/*）→ 前端经 fetchPrintRaster / buildPreviewUrl 消费
```

→ OFD renderer 输出**已是统一 `RenderResource`（栅格图像）**，未携带任何 OFD 专属几何/打印语义。✅ 满足 PPC「输出必须统一为 RenderResource」。

---

## 3. RenderResource Convergence Point（核心收敛点）

用户设想：
```
PDF Renderer ─┐
Image Loader ─┼─> RenderResource ─> ...
OFD Renderer ─┘
```

**实测现状**：三者已在 `drawRenderCommand` 这一**唯一执行器**收敛（Gate 4 锁定的唯一旋转/placement 落盘点 `renderDraw.js:38`）：

| 输入格式 | 源获取 | 进入执行器的方式 |
| --- | --- | --- |
| PDF | `read-file` IPC → `_pdfData` 字节 | `renderPDFPageRaw` → `buildSingleFileRenderCommand` → `drawRenderCommand`（`renderers.js:1462`） |
| Image | `previewImage` / blobUrl | `switchPreviewImage`（`renderers.js:1507`）→ `buildSingleFileRenderCommand` → `drawRenderCommand` |
| **OFD** | `fetchPrintRaster(docId,page)` Blob → blobUrl（`usePrint.js:213`） | 同一 `renderMultipleItemsToCanvas` → `drawRenderCommand`（与 Image 同路径） |

**`_renderDirect` 混合能力**（`renderers.js:1059` 注释原文）：
> 「渲染多个项目到一张 Canvas（等分纸张，支持 PDF/图片/OFD 混合）」

循环内唯一分支是 `if (item._pdfData)`（PDF 需 pdf.js 栅格化）vs else（image/ofd 作为已加载图像）——**这是 `if(pdfData)` 而非 `if(ofd)`**，不违反 Gate 4 Layer C「禁止 `if(ofd)` 格式分支」。

→ **收敛点已存在且稳定**：OFD 不需要新打印引擎，它产生的栅格与 Image 在 `drawRenderCommand` 层完全等价。

---

## 4. Preview Seam（P2 预览接缝）

**现状**：OFD 预览与 Image 共享同一条 image-URL → Canvas 路径。

| 步骤 | 证据 |
| --- | --- |
| 输入识别 | `usePreview.js` `isImageOrOfd` 把 OFD 当 Image 的近 peer |
| URL 构建 | `USE_RENDER_ENGINE_PREVIEW` 下 `buildPreviewUrl(docId, page)`（`usePreview.js:1280+`） |
| Canvas 渲染 | `switchPreviewImage`（`renderers.js:1507`）→ `buildSingleFileRenderCommand` → `drawRenderCommand` |
| 兜底 | 旧 session 无 docId 时回退 `previewImage` base64 |

→ Preview 接缝**已收敛**，OFD 不引入预览专用分支（仅是 `isImageOrOfd` 集合成员）。✅

---

## 5. Print Seam（P3 打印接缝）

**现状**：OFD 打印走「Render Print 面」（raster/Canvas 管线），**非** Source 物理打印面（Sumatra 直送）。

| 步骤 | 证据 | 位置 |
| --- | --- | --- |
| ① 识别 | `f.fileFormat === 'ofd'` 分支 | `usePrint.js:202` |
| ② 取页模型 | `buildPrintJobItem(f)` → `doc.pages[]`（需 `docId` + DocumentStore） | `printAdapter.js:60` |
| ③ 取栅格 | `fetchPrintRaster(docId, page.index+1)` → Blob | `usePrint.js:213` / `printAdapter.js:104` |
| ④ 渲染 | `renderMultipleItemsToCanvas([pageItem], ..., {[f.key]:rotation}, 1, false, ...)` | `usePrint.js:227` |
| ⑤ 落盘 | `canvasToUint8Array(canvas)` → buffers → 物理页 | `usePrint.js:242` |

**关键纪律证据**：`usePrint.js:202` 注释原文：
> 「OFD：无前端可读字节，必须走 Render Contract（docId → /print 逐页）」
> `usePrint.js:910-917`：「OFD == Image」「OFD single-file printing must stay on the raster/canvas pipeline」「Do not route OFD to print-source-file」

→ OFD 打印**已收敛于** `renderMultipleItemsToCanvas` → `drawRenderCommand`（与 Image 同一执行器）。❌ 未走 Source 面 Sumatra 直送（符合 PPC 双轨原则：OFD 是 VirtualPrintSource 候选，非 NativePrintSource）。

**唯一值得注意的分支**：`usePrint.js:202-268` 是 OFD **源获取分支**（因 OFD 无本地文件字节，必须 fetch 后端）。这是 *source-acquisition* 分支，**不是 print-execution 分支**。它合法（与 PDF `read-file` / Image `previewImage` 的源获取差异同源），且收敛于同一执行器。`printAdapter.js` 注释已明确 Render Print 面 / Source 物理打印面双轨职责边界。

---

## 6. Ownership Analysis（所有权分析）

| 轴 | 结论 | 证据 |
| --- | --- | --- |
| **R1** Rotation Ownership | 🔒 未触碰。OFD 旋转来自 `rotations[f.key]`（userRotation），传入 `renderMultipleItemsToCanvas`，与 Image 完全一致。无 OFD 专用 rotation resolver。 | `usePrint.js:232` `{[f.key]: rotation}` |
| **PPC** PrintResource Ownership | ✅ 未触碰。后端 `doc.adapter` 把 OFD 产出栅格注册为 `RenderResource`；前端通过 `fetchPrintRaster` 消费。这**正是 `VirtualPrintSource` 的已实化形态**（「非直接文件打印，而是已生成打印像素的资源来源」）。 | `registry.py:213` adapter 优先 / `usePrint.js:202` 注释 |
| **OFD Adapter** | 已存在且分层清晰：后端 `ofd_parser`+`render_engine` 是 producer；前端 `buildPrintJobItem`+`fetchPrintRaster` 是 client binding。**无需新建 OFD Print Path**。 | 见 §2/§5 |

**两层模型位置**：
```
                 R1 (rotation ownership)
                          │
                          ▼
              RenderPlacementResult (contentRotation)
                          │
                          ▼
                 PPC (print resource ownership)
                          │
            ┌─────────────┼─────────────┐
         PDF source   Image source   OFD adapter (doc.adapter → raster)
                          │
                          ▼
              RenderResource (raster blob)
                          │
                          ▼
              drawRenderCommand (Gate 4 锁定唯一执行器)
```

---

## 7. Decision（Gate 1 Verdict）

### 🔒 Gate 1 = PASS

**理由**：验证命题已成立 —— 现有 OFD 输入能力**已以最小边界接入 `RenderResource`，并复用已封存的打印链**：

1. **P0 识别** ✅：OFD 是 first-class 输入格式（`getFileFormat` / `VALID_FILE_FORMATS`）。
2. **P1 渲染** ✅：后端 `ofd_parser`/`render_engine` 已产出统一栅格 `RenderResource`（WebP/200dpi），有契约测试守护。
3. **P2 预览** ✅：与 Image 共享 `buildPreviewUrl` → `switchPreviewImage` → `drawRenderCommand`。
4. **P3 打印** ✅：与 Image 共享 `renderMultipleItemsToCanvas` → `drawRenderCommand`；仅源获取分支合法差异。
5. **所有权** ✅：R1 / PPC / Gate 4 三轴均未越界；OFD 收敛于 `drawRenderCommand`，无第二打印引擎。

### 关键澄清（回应用户前序担忧）

> Gate 4 说「不引入 OFD」= 不把 OFD **混进 Gate 4 验证命题**（避免 merge 几何 + OFD renderer 两变量绑死、无法定位 bug），**不是放弃 OFD**。

实测证明：OFD 集成**已完成大半**（预览完全收敛、打印收敛于执行器），剩下的是**收敛一致性打磨**，不是架构重建。

### 留给后续 Gate 的观察点（非 Gate 1 blocker）

| 观察点 | 性质 | 归属 |
| --- | --- | --- |
| `usePrint.js:202-268` OFD 源获取分支可统一为 `fetchRenderRaster(docId,page)` 共享 API（pdf/image/ofd 同源获取） | 一致性打磨，非缺陷 | **PPC Consolidation Gate**（后续） |
| `VirtualPrintSource` 抽象是否需显式命名（当前以 `doc.adapter` + `fetchPrintRaster` 隐式实化） | 命名/形态澄清 | **PPC Gate**（后续） |
| OFD 多页在 `merge2/4` 下的物理位置已可由 `_renderDirect` 混合能力覆盖（renderers.js:1059） | 已具备，待 E2E 验证 | **PPC-OFD Integration Gate 3 (Print E2E)** |

> ⚠️ 上述观察点**不得在本 Gate 1 实现**，也不得借机重开 R1 / PPC / Gate 4。它们是下一阶段 Gate 的输入。

---

## 8. Negative List（反模式 — 本阶段严禁）

| 禁做 | 原因 |
| --- | --- |
| ❌ 新建 OFD → PDF 转换链作为长期方案 | 与 PPC「OFD→RenderResource→复用打印链」原则冲突（仅可作 fallback） |
| ❌ OFD 专用打印按钮 | 破坏统一打印入口 |
| ❌ OFD 专用 merge composer | Gate 4 已锁 merge seam 格式盲 |
| ❌ OFD 专用 rotation resolver | R1 CLOSED，rotation ownership 冻结 |
| ❌ 修改 `RenderCommand` contract | Gate 4 已锁 contract |
| ❌ 借 Gate 1 统一 `usePrint.js` OFD 分支 | 属 PPC Consolidation Gate，不在本范围 |

---

## 9. 后续 Gate 草图（仅占位，不展开）

```
Gate 1  Seam Map ....... PASS（本文档）
   │
   ▼
Gate 2  OFD RenderResource Adapter 收口
        （统一 fetchRenderRaster API / 显式 VirtualPrintSource 命名 / 多页页模型对齐）
   │
   ▼
Gate 3  Print E2E（OFD single + merge2/4 物理输出验证，复用 gate4Regression 护栏）
```

> Gate 1 输出：把「OFD 已天然接入打印链」这一事实**冻结为可引用基线**，供 Gate 2/3 作为前置条件。
