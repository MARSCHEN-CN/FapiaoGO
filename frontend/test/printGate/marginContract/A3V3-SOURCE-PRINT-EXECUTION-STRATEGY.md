# A3-V3 — Source Print Placement Execution Strategy Audit（只读）

- 日期：2026-08-10
- 状态：**只读审计完成**（未改任何代码）
- 定位：裁决 C-2 Step 4-2 的「执行方式」——Plan placement 已到 electron executor 边界（Step 4-1 完成），本审计评估三方案成本，供 A3-V3 裁决
- 输入资产：A3-V2/RG-3 的 Sumatra 实测（7-case）、margin_contract.py（bake 栈，Gate 2 验证）、RotationResolver placement 输出

---

## 1. Sumatra Capability 矩阵（实测复核，A3-V2/RG-3 7-case）

| 能力 | 实测证据 | 结论 |
|---|---|---|
| paper command | RG-3 后 `disable-auto-rotation`→竖纸 / `landscape`→横纸（对照实验 4 组） | ✅ 纸向=命令决定，内容不参与 |
| rotate=N | A3-04/A3-07：旋转烤进内容，/Rotate=0 | ✅ content transform executor |
| noscale | A3-06：1:1 输出，内部 fit 关闭 | ✅ 可靠关闭 fit |
| fit | A3-05：同尺寸纸不抹 offset（Δ0.4mm） | ✅ 但**会二次 fit 内容**（A3-03 横票竖纸被缩进竖纸） |
| PDF page box | probe `cropbox_eq_mediabox`（A3-RF-02 CLOSED）：两引擎同渲 MediaBox@300 | ✅ MediaBox 是内容基准；CropBox 无歧义 |
| printer driver | Wondershare PDFCreator 落盘保留原文件名+`_N`；纸向经 /Rotate 交给驱动 | ✅ 可捕获、可测量（Gate 基础设施已建） |

**关键约束（Step 4-2 决策前提）**：
1. **fit 仍是 Sumatra 的 geometry 介入点**——只要命令含 `fit`，Sumatra 会二次适配内容（A3-03 横票竖纸被缩进竖纸就是证据）。
2. 要让 Plan placement 成为最终几何，**命令必须 `noscale`**（否则 Sumatra fit 覆盖 placement 语义）。
3. rotate=N 已可靠（content transform executor），可与 placement 的 layoutRotation 协同或由 bake 预烤。

---

## 2. PDF Transform 技术栈盘点（方案 A 现成资产）

| 能力 | 可用性 | 已验证程度 |
|---|---|---|
| **pikepdf** | ✅ backend/venv（10.10.0） | **margin_contract.py 完整验证**：`as_form_xobject` + 手写相似矩阵（INV-7a）+ `copy_foreign` + `add_resource` + `/Rotate=0` + G-1/G-2 运行时断言。Gate 2 三连（correct 8/8、phase1b 9/9、production 7 RED）背书 |
| **fitz (PyMuPDF)** | ✅ backend/venv（1.28.0） | probe/栅格化/边距测量全链使用；`show_pdf_page` 有 /Rotate 压方 bug（已知，绕开——用 pikepdf 不做） |
| **img2pdf** | ✅ | 图片→PDF 原始尺寸（72.009 dpi round 已修，B2 验证） |
| **PIL** | ✅ | fallback 路径（round(dpi) 对齐） |
| **qpdf** | ❌ 无独立二进制 | PDF24 自带 qpdf.exe 不可依赖；项目无调用 |
| **canvas 轨** | ✅ renderMultipleItemsToCanvas | A3 域独立几何（createPlacement），Step 4 已裁决不切 |

**结论**：方案 A（PDF pre-transform bake）的完整技术栈**已在仓库内且被 Gate 2 验证**——`apply_pdf(src, out, paper, margin, content_rotation)` 就是「把 geometry 烤进 PDF」的生产级实现。

---

## 3. 三方案成本对比

### 方案 A：PDF pre-transform bake（推荐候选）

```
source PDF ──→ pikepdf bake（placement→相似矩阵烤进）──→ temp PDF ──→ Sumatra noscale + paper command
```

| 维度 | 评估 |
|---|---|
| 复用 | ✅ **margin_contract.apply_pdf 现成**（Gate 2 验证），只需把「margin+contain-fit」扩展为「placement 全几何」（scale/offset/layoutRotation 映射 compute_transform） |
| 验证 | ✅ Gate 2 基础设施直接复用（probe + measureMargins + 0.5mm 容差） |
| Sumatra 角色 | ✅ 纯 executor（noscale + paper command，无 fit 介入）——C2-R3 达成 |
| 多页性能 | ⚠️ 每页一个 Form XObject 变换（pikepdf 内存内操作，单页毫秒级；多页 O(n) 无 IO 放大） |
| 中间文件 | ⚠️ 产生 temp PDF（pdf-margin-processor 已有 TEMP_DIR 先例） |
| 与 margin 链 | ✅ **与 add-pdf-margins.py 同一栈**——Step 4-2 可让 margin+placement 走同一 bake 路径（消除双语义） |

**关键洞察**：placement（RotationResolver）输出 `{scale, offset, placedRect, layoutRotation, canvasSize}` 与 margin_contract 的 `{contentBox, scale, phi}` **字段一一对应**：
```
placement.layoutRotation → phi（content_rotation）
placement.scale         → scale
placement.offset        → contentBox.x/y（+可用区起点）
placement.canvasSize    → paper_w_pt/paper_h_pt（px→pt，÷DPI×72）
```
只需一个薄 adapter（placement → apply_pdf 参数），**几何引擎（compute_transform）零改动**。

### 方案 B：Sumatra noscale + 外部 placement

```
PDF ──→ Sumatra noscale + paper command（无 fit）──→ 外部再叠 placement
```

| 维度 | 评估 |
|---|---|
| Sumatra 能力 | ❌ **Sumatra 无完整 placement API**（只有 fit/rotate/paper 命令）——A3-V2 实测无「指定 offset」能力 |
| 落地 | ❌ 需要另一层（渲染或驱动级）施加 placement——**等于回到方案 C 的复杂度但多绕 Sumatra** |
| 验证 | ⚠️ 无现成基础设施 |

**结论：否决**（Sumatra 不是 placement executor，A3-V2 已证其能力边界）。

### 方案 C：替换 source print executor（PyMuPDF render + compose）

```
source PDF ──→ fitz render ──→ placement compose（canvas/bitmap）──→ print bitmap
```

| 维度 | 评估 |
|---|---|
| 复用 | ⚠️ canvas 轨（renderMultipleItemsToCanvas）已有 compose 能力，但那是 **canvas 域**（A3 冻结不切） |
| 打印链路 | ❌ source 轨当前是 Sumatra 直送 PDF——切 bitmap 打印 = **打印语义大改**（PDF→图片，清晰度/驱动交互/双面全部变化） |
| 验证 | ⚠️ 全新链路，无 Gate 覆盖 |
| 风险 | 🔴 最高（替换核心 executor，影响所有打印） |

**结论：风险最高，仅作最后手段**。

---

## 4. 推荐：方案 A（PDF pre-transform bake）

### 理由
1. **技术栈 100% 现成且被 Gate 2 验证**（margin_contract.apply_pdf + compute_transform + 断言）。
2. **Sumatra 保持纯 executor**（noscale + paper command）——C2-R3「执行不决定」达成，且与 RG-3 的 authority 归属一致。
3. **与 margin 链同栈**——未来 margin+placement 可合一（消除双几何语义，正面回应「谁拥有几何」）。
4. **验证成本最低**：Gate 2 的 probe/measureMargins/0.5mm 容差直接复用，A3-03 Gate（竖纸+居中+对称 margin）可端到端断言。

### Step 4-2 前置决策点（供 A3-V3 裁决）
1. **placement → apply_pdf 的 adapter 归属**：新建 `scripts/placement_bake.py`（薄层：placement JSON → apply_pdf 参数）vs 扩展 margin_contract（合一）。建议**新建薄层**，margin_contract 保持契约纯净（B1 先例：几何契约不混业务）。
2. **noscale 迁移时机**：方案 A 要求命令 `noscale`（禁 fit 介入）——这触碰 D2 冻结（noscale 全量迁移）。需确认：**Step 4-2 是否同时切 noscale**（建议：A3-03 Gate 用 noscale 验证 bake 效果，但生产切 noscale 单独 commit 评估打印退化）。
3. **多页文档**：bake 逐页（每页 1 Form XObject），与 source 轨现有「多页逐页展开」语义一致（Plan 每文件=1 单元）。
4. **图片源**（非 PDF）：img2pdf 转 PDF 后同 bake 路径（复用 add-pdf-margins 的图片 adapter）。

---

## 5. 成本表（汇总）

| 方案 | 复用度 | 验证成本 | 打印语义风险 | 多页性能 | 与 margin 协同 | 推荐 |
|---|---|---|---|---|---|---|
| **A bake** | 🟢 高（margin_contract 现成） | 🟢 Gate 2 复用 | 🟢 低（Sumatra 仍直送 PDF） | 🟡 O(n) 内存内 | 🟢 同栈合一 | ✅ |
| B executor placement | 🔴 低（无 API） | 🔴 无基础设施 | 🟡 需新层 | 🟡 | 🟡 | ❌ |
| C render print | 🟡 中（canvas 域隔离） | 🔴 全新链路 | 🔴 高（PDF→bitmap） | 🟡 | 🟡 | ⚠️ 最后手段 |

---

## 6. 下一步建议（待用户裁决）

1. **批准方案 A** 作为 Step 4-2 执行方式。
2. **Step 4-2 拆两 commit**：
   - 4-2a：新建 `scripts/placement_bake.py`（placement JSON → apply_pdf 参数薄 adapter）+ A3-03 Gate（bake 后竖纸+居中+对称 margin，noscale 验证）——**不改生产接线**，纯 DEV 验证。
   - 4-2b：生产接线（print-backend 消费 ps.executionPlacement/executionPaper → 调 placement_bake → Sumatra noscale + paper command）——**含 noscale 迁移评估**（D2 触碰点，单独裁决）。
3. **A3-02 rotate=90 方案 A/B/C** 可并入 4-2a 验证（bake 后 rotate 语义由 Plan 决定，Sumatra 只 noscale）。

**冻结边界**：不改 RotationResolver / Plan schema / Sumatra 执行路径 / add-pdf-margins.py / Canvas-merge / DirectPrintHandler。
