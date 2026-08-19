# Print Pipeline Convergence — Design Input

> 状态：**DRAFT（设计输入，非实现；独立于 R1 与 Gate 4）**
> 日期：2026-08-19
> 分支：`rotation-b1-hardening`
> 依赖：R1 CLOSED（Option 0 + Future C，`docs/r1-decision-record.md` §9 / §10 / §12）
> 触发：R1 裁决完成 + PDF/Image/OFD 三格式回归后，由独立 **Print Pipeline Convergence Gate** 评估
> 评审类型：**Print Pipeline Architecture Design（docs-only，零生产代码改动）**
> 与 R1 的边界：**本设计改变 Print Pipeline，不改变 R1 的 Rotation Ownership。**

---

## 0. Scope 与边界

本设计输入处理「OFD/Image 是否统一进入 image→PDF→Sumatra 打印链」的方向问题。它**不是 R1 的一部分**，也**不阻塞 Gate 4**。

明确边界：
- **R1** = rotation ownership 语义（`userRotation` 混名），已由 Option 0 冻结，Future Option C。
- **Gate 4** = merge per-slot geometry，消费已有 `effectiveRotation`。
- **本设计** = 打印执行器收敛（PDF/Image/OFD 是否走同一物理打印链），独立 Gate。

> 关键纪律：本设计**不修改 RotationResolver / effectiveRotation / contentRotation / resolveContentPlacement**，不影响 Gate 4。它把 OFD 从 R1 的「特殊问题」降级为普通 Render Resource 问题。

---

## 1. 当前隐含模型（Implicit Current Model）

导入层已经统一：

```
导入层
  │
  ├── PDF
  ├── OFD
  └── Image
          │
          ▼
     统一展示资源
          │
          ▼
     WebP Preview Resource
```

但打印层仍是三条 seam：

```
PDF:   原 PDF ──▶ Sumatra
Image: WebP/Image ──▶ Image→PDF ──▶ Sumatra
OFD:   ? （当前走 Canvas placement pipeline）
```

---

## 2. 提议模型（Proposed Model）

OFD 在打印阶段不再作为 OFD 打印，而是作为**已经渲染完成的图片资源**打印：

```
OFD
  │
  ▼
Render
  │
  ▼
WebP (Image Resource)
  │
  ▼
WebP → PDF
  │
  ▼
Sumatra
```

即：**OFD 打印 = 已渲染图片资源的打印**，与 Image 打印同链。

---

## 3. 可行性理由（Feasibility）

### 3.1 展示资源已证明 OFD 可图片化

```
OFD ──▶ Render Engine ──▶ WebP ──▶ Preview
```

- OFD 页面已可正确 rasterize；
- 页面尺寸已存在；
- rotation / placement 已可作用于 render result。

打印只是把 `WebP` 换成 `PDF container`，链路天然存在。

### 3.2 三种输入最终统一

```
PDF / OFD / Image
        │
        ▼
   Render Resource
        │
        ▼
   Page Image (WebP)
        │
        ▼
   Print PDF
        │
        ▼
   Sumatra
```

PDF 原文件仍保存（`SourceDocument.pdf`），但打印不一定必须使用它。

### 3.3 最大收益：旋转语义更简单

当前 R1 根因 = PDF/Image/OFD 有不同打印 seam。

若 OFD 进入图片管线，打印只剩：

```
Render Resource ──▶ Placement ──▶ Image PDF ──▶ Printer
```

旋转只需作用于 `RenderResult`，而非 `PDF source rotation` / `OFD placement rotation` / `Image rotation` 三者纠缠。显著减少 `sourceRotation` / `effectiveRotation` / `contentRotation` 之间的耦合。

---

## 4. 工程问题（须提前确认）

### 问题 1 — 打印质量（DPI）

展示用 WebP ≠ 最佳打印资源。若直接：

```
96 DPI WebP ──▶ PDF ──▶ 打印   ❌ 质量损失
```

正确做法：OFD 应有两条 render 路径：

```
OFD
 ├── Preview Render ──▶ WebP 96/150 DPI
 └── Print Render   ──▶ PNG/WebP 300 DPI ──▶ PDF
```

**虚拟源文件应基于 Print Render Resource，不直接复用 Preview WebP。**

### 问题 2 — UI Preview 不得成为打印源

不要设计成 `用户看到的 WebP ──▶ 打印`：

- 用户可能缩放；
- 可能缓存低 DPI；
- preview cache 生命周期不同。

应为：

```
RenderResource
      ├── PreviewCache
      └── PrintResource
```

与既有原则 **Render Resource 与 Print Resource 分离** 一致。

### 问题 3 — PDF 是否也应统一？

当前 `PDF ──▶ 原 PDF ──▶ Sumatra` 合理（PDF 本身就是高质量 Print Resource）。两策略：

**策略 A（推荐）** — 保留 PDF 特权：

```
PDF:   原 PDF → Print
Image: Render → PDF → Print
OFD:   Render → PDF → Print
```

优点：PDF 不损失；改动小。

**策略 B（完全统一）** — 全部渲染：

```
PDF/OFD/Image ──▶ Render Image ──▶ PDF ──▶ Print
```

优点：单一路径。缺点：PDF 矢量损失；大 PDF 渲染成本高。**当前不建议**。

---

## 5. 推荐最终模型（Recommended Final Model）

```
Input Format Layer
  PDF / OFD / Image
        │
        ▼
Render Layer
  PDF:   optional render
  OFD:   render required
  Image: render required
        │
        ▼
Resource Layer
  PreviewResource: WebP
  PrintResource:  300dpi Image
        │
        ▼
Print Assembly
  PrintResource ──▶ Image→PDF ──▶ Sumatra

PDF 可走 shortcut: PDF source ──▶ Sumatra
```

---

## 6. 对 R1 的影响（R1 Impact）

- 本方案**进一步支持 R1 Option 0 冻结**：当前 rotation ownership 分散于 PDF source / OFD placement / Image；未来 image-backed print path（OFD、Image）统一为 PrintResource 后，rotation ownership 减少。
- **但**：不需要修改 RotationResolver；不需要修改 effectiveRotation；不影响 Gate 4。
- 应作为独立 **Print Pipeline Convergence Gate** 处理，与 R1 / Gate 4 解耦。

---

## 7. 关键定义修正（Definition Clarification）

不要表述为：

> OFD 使用展示时的 WebP 转 PDF 打印

应定义为：

> **OFD 渲染后的 Image Resource 作为 Virtual Print Source，打印阶段生成 Print PDF。**

展示 WebP 与打印图片可共享同一 Render Resource，但**不直接复用 Preview WebP 文件**。这样未来架构不会被低 DPI preview 绑死，且正好把 OFD 从 R1 的「特殊问题」降级为普通 Render Resource 问题。

---

## 8. 待 PPC Gate 处理的事项（Open Items）

- Print Render Resource 的 DPI / 格式规范（300 DPI 候选）；
- PreviewCache 与 PrintResource 的生成与生命周期隔离；
- PDF 策略 A vs B 终裁；
- OFD/Image 统一 print seam 后，三格式回归矩阵设计；
- 与 Option C（RotationIntent / RotationResult）的协同时点。

---

## 9. 命名纪律与冻结约束（PPC Sign-off）

> 本节约 R1 收盘后架构确认时追加，作为 PPC 的命名纪律与冻结约束锚点（docs-only，不改变 R1 / Gate 4）。

### 9.1 状态确认

提交 `c8dd9c2`（PPC 设计输入）**未越界**：它不是 R1 补丁，也不是 Gate 4 前置改造。

```
R1 Rotation Semantic ──CLOSED──▶ PPC Design Input ──OPEN DESIGN ONLY──▶ Future PPC Gate
```

### 9.2 OFD 重新定位（核心原则）

OFD 身份跨层：

| 层 | 身份 |
| --- | --- |
| Import | OFD |
| Parse | OFD |
| Render | Image Resource |
| Preview | WebP |
| Print | Print PDF |
| Executor | Sumatra |

**核心原则（PPC Gate 核心）**：

> **OFD 是第三种输入格式，不是第三种打印模式。**

### 9.3 三个必须冻结的点

1. **Preview WebP 不能直接成为打印源** — 保持 `PreviewResource ≠ PrintResource`。否则会出现：预览 DPI 改动影响打印、cache 生命周期污染、用户打开预览才生成打印资源等隐式依赖。正确：`RenderResource → Preview Renderer + Print Renderer`。
2. **OFD 虚拟源文件应是 Print Resource** — 不要 `VirtualSourceFile = preview.webp`，而应是结构化 `VirtualPrintSource { origin: "ofd", pages: [{ image, dpi, width, height }] }`。后续合并打印 / 多票布局 / margin contract 都消费同一种物理页面资源。
3. **PPC 不应重新打开 Rotation Ownership** — PPC 只做 RenderResource / PrintResource / Executor 收敛，**不是 rotation semantic migration**，否则重新进入 R1。

### 9.4 命名纪律（消歧）

建议未来正式 PPC Gate 文档区分两个名字，避免 `Image Resource` 既代表展示图片又代表打印图片：

- **RenderImage** = 渲染结果（如 `OFD → RenderImage`）；
- **PrintPDF** = 打印执行载体（如 `RenderImage → PrintPDF`）。

更清晰的模型：

```
SourceDocument
       │
       ▼
RenderResource
       │
       ├───────────────┐
       ▼               ▼
PreviewResource   PrintResource
   (WebP)          (300dpi Image)
                        │
                        ▼
                    PrintPDF
                        │
                        ▼
                     Executor
```

> 注：本文 §2 / §5 使用的 "Image Resource" 在正式 PPC Gate 文档中应统一替换为 `RenderResource` / `PrintResource` 以消歧，遵循本节命名纪律。

### 9.5 对 Gate 4 的影响

**无影响。** 顺序维持：

```
R1 CLOSED → Gate 4 (Merge per-slot) → 三格式回归 → PPC Gate
```

PPC 只作为未来输入约束：

> Gate 4 不得依赖 OFD 特殊路径，不得增加 OFD 专属 rotation workaround。

---

## Gate 状态（本设计输入阶段）

```
R1                      ✅ CLOSED（Option 0 + Future C）
Gate 4                  ⏸ 待启动（Merge per-slot geometry）
Print Pipeline Convergence  📝 DRAFT design input（本文档）— 待独立 Gate
Production Code         ❄ 零改动
```
