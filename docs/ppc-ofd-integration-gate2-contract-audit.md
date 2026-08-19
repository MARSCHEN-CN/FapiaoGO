# PPC-OFD Integration Gate 2 — RenderResource Contract Audit（docs-only）

> **性质**：docs-only，纯取证审计。**不修改任何生产代码**，不重开 R1 / PPC / Gate 4。
> **目标（单一验证命题）**：OFD raster 输出是否满足现有 Image RenderResource contract（即「OFD 作为 RenderResource 后，与 Image/PDF 等价地进入已封存打印链」的前置契约）？
> **状态**：🔒 **Gate 2 = PASS（后端 RenderResource 契约满足）** —— 见 §8，含 1 个移交 Gate 3 的验证项。

---

## 0. Scope Lock

| 项 | 状态 |
| --- | --- |
| R1 Rotation Ownership | 🔒 CLOSED — 未触碰（仅审计，不改动） |
| PPC Architecture | ✅ RATIFIED — 未触碰 |
| Gate 4 (merge geometry) | 🔒 CLOSED — 未触碰 |
| Gate 1 (Architecture Seam) | ✅ PASS（前置条件已满足） |

**Gate 2 不验证**：真实打印物理输出（→ Gate 3 E2E）；merge2/4 物理位置（→ Gate 3）；前端 rotation 端到端 single-application（→ Gate 3 验证项）。

---

## 1. 现有 Image RenderResource Contract（审计基准）

前端打印链对「栅格 RenderResource」的契约期望（由 `renderers.js` / `renderMultipleItemsToCanvas` / `buildSingleFileRenderCommand` 推导）：

| 契约点 | 期望 |
| --- | --- |
| 像素源 | 已栅格化的图像（image element / bitmap），前端消费 `naturalWidth/Height` |
| 方向 | **source 取向**（旋转不烤入像素），旋转由前端 placement 施加 |
| 尺寸 | 提供 width/height 供 layout 估算（实际 placement 用 natural size） |
| 多页 | 每页独立可索引、稳定有序 |
| 缓存 | 渲染确定性（同 doc_id+page+preset → 同输出） |

**审计策略**：逐项比对 OFD 后端实现与 Image / PDF 两条既有路径在该契约上的行为，确认 OFD 无偏离、无 `if(ofd)` 特殊分支。

---

## 2. width / height

**✅ PASS**

| 格式 | 来源 | 证据 |
| --- | --- | --- |
| Image | `_pages_from_image`：`img.width/height`（EXIF transpose 后原生像素） | `api.py:304-318` |
| PDF | `_pages_from_pdf`：`p.rect.width/height`（pt） | `api.py:287-301` |
| **OFD** | `ofd_page_dimensions` → `{index,width,height,sourceRotation}`（按 dpi 线性缩放的像素） | `ofd_page_render.py:116-189` |

OFD 的 width/height 在 300dpi 基线计算（`ofd_page_dimensions(dpi=300)`），实际 `/print` 渲染按 200dpi preset——**这是 metadata 估算值 vs 实际 raster 像素的常规差异**，与 PDF 报告 pt（非渲染像素）同理；前端 placement 一律用 `image.naturalWidth/Height`（实际 raster），故 benign。

---

## 3. dpi

**✅ PASS（一致机制）**

`render_ofd_page(raw_bytes, page_index, dpi=300)`（`ofd_page_render.py:192`）；`/print` 走 `print` preset（200dpi），`/preview` 走 preview preset；均经 `doc.adapter.render(page_idx)` → `render_ofd_page` 的 `dpi` 参数。与 Image/PDF 的 preset 机制同构，无 OFD 专属 dpi 处理。

---

## 4. orientation（显式 + source 取向）

**✅ PASS**

| 格式 | raster 取向 | 旋转元数据 |
| --- | --- | --- |
| Image | EXIF 已烤入像素（`ImageOps.exif_transpose`） | `rotation=0` |
| PDF | **source 取向**（pdf.js `getViewport({rotation:0})`） | `rotation=/Rotate` |
| **OFD** | **source 取向**（`render_ofd_page` 无 rotation 参数） | `rotation=sourceRotation` |

三者统一为「raster source 取向 + 旋转元数据外置」模型。OFD 与 PDF 同构（source 取向 + 旋转元数据），与 Image 差异仅在 Image 已把 EXIF 烤入像素→`rotation=0`。**无 `if(ofd)` 分支**：`api.py:282` `_pages_from_adapter` 仅做 `sourceRotation → rotation` 映射，API 不感知格式。

---

## 5. rotation — 无隐藏旋转（本 Gate 最关键项）

**✅ PASS（raster 层 double-rotation 风险已消除）**

逐层取证旋转是否在任何环节被烤入 OFD 像素：

| 层 | 证据 | 结论 |
| --- | --- | --- |
| `render_ofd_page` | 函数签名无 rotation 参数，仅 `renderer.render(root)` → `img.save(WEBP)` | raster 不烤旋转 |
| `OFDAdapter.render` | 透传 `render_ofd_page(...)` | 不烤旋转 |
| `engine._render_adapter_page` | `image = doc.adapter.render(page_idx)`（`engine.py:456`），仅返回，不旋转 | 不烤旋转 |
| `vs.rotation` | `engine.py:500`：退役字段「恒 0」，被 contentRotation 取代，本路径不读 | 不烤旋转 |
| `_pages_from_adapter` | `rotation = p.get("sourceRotation", 0)`（`api.py:282`） | 旋转仅作**元数据**外置 |

→ **OFD raster 是纯 source 取向像素，页内 `Rotate` 仅以 `sourceRotation` 元数据形式暴露，绝不烤入像素**。因此「OFD renderer rotate 90 + RenderCommand rotate 90 = 180 bug」的 double-rotation 风险**在 raster 层不存在**。

> ⚠️ 移交 Gate 3 的唯一验证项（见 §7）：前端是否把 `sourceRotation`（= `page.rotation` 元数据）与 `fileRotations`（用户旋转）**合并施加一次**到 canvas。后端契约已确保 raster 无隐藏旋转，该合并施加机制对 PDF 已成立，需确认 OFD 走同一路径（无第二处旋转）。这属 R1 ownership 端到端验证，非本 Gate 2 后端契约缺陷。

---

## 6. page index 稳定性（多页）

**✅ PASS**

`list_ofd_page_paths`（`ofd_page_render.py:95`）：按 `OFD.xml → Document.xml → Content.xml` 顺序枚举，回退自然排序（`_natural_key`：`Page_0<Page_1<...<Page_10`）。`OFDAdapter` 缓存 `_page_paths`/`_dims` 于 doc 实例（`ofd_adapter.py:42-50`），多页索引稳定、可复现。`_render_adapter_page` 越界→`ValueError`→404 确定语义（`engine.py:452-455`）。

---

## 7. cache key 稳定性

**✅ PASS**

- 每 doc 实例缓存路径/尺寸（`ofd_adapter.py` 懒加载缓存）。
- `engine.render` → `_render_and_respond` 带 ETag / 304（`api.py:380-392`），同 `(doc_id, page, preset)` 输出确定、可缓存。
- 渲染无随机性（纯 XML/CTM 解析 → 确定性 WebP）。

---

## 8. preview resource == print resource 一致性

**✅ PASS**

`/preview` 与 `/print` 均经 `engine.render → _render_adapter_page → doc.adapter.render(page_idx)`（`engine.py:420-456`）。**同一 source 取向渲染函数**，仅 preset（dpi/quality）不同。无 OFD 专属预览/打印分叉。

→ OFD 的预览栅格与打印栅格取向、内容完全一致（仅分辨率差异，符合既有 Image/PDF 行为）。前端 `usePreview.js isImageOrOfd` → `buildPreviewUrl` 与 `usePrint.js:202` → `fetchPrintRaster` 共用此源。

---

## 9. Decision（Gate 2 Verdict）

### 🔒 Gate 2 = PASS（后端 RenderResource 契约满足）

| 用户检查项 | 结果 | 证据 |
| --- | --- | --- |
| width/height 存在 | ✅ | `ofd_page_dimensions` → `{width,height}` |
| dpi 一致 | ✅ | `render_ofd_page(dpi)` + preset 机制 |
| orientation 显式 | ✅ | source 取向，与 pdf/image 同模型 |
| rotation 无隐藏旋转 | ✅ | 渲染链零烘焙，`sourceRotation` 仅元数据 |
| page index 稳定 | ✅ | 有序枚举 + adapter 缓存 |
| cache key 稳定 | ✅ | 懒加载缓存 + ETag |
| preview==print 一致 | ✅ | 同一 `adapter.render` 路径 |

**关键结论**：OFD raster 是**合格的 source 取向 RenderResource**，与 Image/PDF 在契约层等价；OFD 接入打印链**不引入格式专属分支、不烤旋转、不破坏 R1 ownership**。

### 移交 Gate 3 的 1 个验证项（非 blocker）

| 项 | 性质 | 归属 |
| --- | --- | --- |
| 前端把 OFD `sourceRotation` 与 `fileRotations` **合并施加一次**到 canvas（同 PDF 路径，无第二处旋转） | 端到端 R1 ownership 验证 | **PPC-OFD Gate 3 (Print E2E)** |

> ⚠️ 该验证项**不得在本 Gate 2 实现**，也不得借机重开 R1/PPC/Gate4 或改动 `mergeFactory`/rotation resolver。它是 Gate 3 E2E 的输入。

---

## 10. Negative List（反模式 — 本阶段严禁）

| 禁做 | 原因 |
| --- | --- |
| ❌ 改 `render_ofd_page` 烤入旋转 | 破坏「source 取向 + 元数据外置」契约，制造 double-rotation |
| ❌ 在 `_pages_from_adapter` / `engine` 加 `if(ofd)` 分支 | 违反格式盲契约（Gate 4 Layer C 精神） |
| ❌ 新建 OFD→PDF 链 | 与 PPC 原则冲突 |
| ❌ 借 Gate 2 统一 `usePrint.js` OFD 分支 | 属 PPC Consolidation Gate |
| ❌ 改 `RenderCommand` contract | Gate 4 已锁 |

---

## 11. 状态更新

```
[R1 CLOSED]
[PPC RATIFIED]
[Gate 4 CLOSED]

[PPC-OFD Integration]
Gate 1: PASS (Architecture Seam Verified)
Gate 2: PASS (RenderResource Contract Audited)   ← 本文档
Gate 3: Pending (Print E2E Validation — 含 rotation single-application 验证)
```
