# V17 纸张方向契约（paperLandscape 模型）

> 状态：**PROPOSED / 解冻中** — 本文件是 V16 冻结契约（`v16-architecture-target.md` v1.1）的**演进补充**，
> 将渲染方向模型从「内容旋转进固定纸」切换为「纸张方向随内容（paperLandscape）」。
> 按冻结文档治理条款（第 3 / 183–191 行）：本变更**改变了 DAG 末端的布局语义**，
> 故先以本文件作为 thaw + 新契约记录，再实施代码改动（Strangler Fig 分步迁移，非一次性重写）。
> 日期：2026-07-13 | 作者：架构评审（用户 + Code Reviewer 共同确认）

---

## 〇、为什么改（Why）

### 旧模型（V16 rotation=90）的问题
```
Document(landscape)
      │
      ▼
renderLayout.rotation = 90        ← 把内容旋转 90° 进竖纸
      │
      ▼
竖 A4 纸张 + 旋转内容
```
- Canvas / RE / Print 三端**各自重算一次 rotation**（css rotate / fitz.prerotate / 打印 orientation），
  永远对不齐（Legacy 最大病灶，B-2.2 调试中反复出现「多文件切换方向跳变」）。
- 日志铁证：`DS=landscape / PL=portrait → rotation=90` 即「拿 rotation 补偿纸方向不匹配」。

### 产品事实（决定性）
- **用户已不再设置纸张横竖**（无 orientation 输入）。纸张方向 = 程序内部实现细节。
- 既然横纸/竖纸不是用户输入，就不该让 `rotation=90` 承担「自动顺应」职责。

### 新模型（paperLandscape）
```
Document(landscape)
      │
      ▼
paperLandscape = true            ← 纸变横 A4
      │
      ▼
横 A4 纸张 + 内容自然方向(rotation=0)
```
> **唯一规则：纸张方向自动匹配内容方向，内容永远保持自然方向（rotation=0）。**
> 横向发票 → 横 A4；竖向发票 → 竖 A4；内容永不旋转。

---

## 一、Old → New 映射

| 概念 | Old (V16 rotation) | New (V17 paperLandscape) |
|------|--------------------|---------------------------|
| 内容方向 | 隐含于 `renderLayout.rotation` (90/270) | `DocumentState.pageOrientation` 直接决定 |
| 纸张方向 | 固定（PaperSpec 决定） | `RenderLayout.paperLandscape` 由内容推导 |
| 内容绘制 | 旋转 90/270 进纸 | **自然方向（rotation=0）** |
| Canvas 回退 | `switchPreviewFile(rot=currentRotation)`，横内容落竖纸 letterbox | `viewport(rotation=0)`，横内容落横纸 |
| RE 后端 | `fitz.prerotate(fitz_rot)` 旋转内容 | 画布尺寸按 `paper_landscape` 交换，内容自然 |
| Print | 各自算 orientation | 读 `paperLandscape` 设打印机 orientation |
| CSS | `transform: rotate(angle)` | **已删除** |

---

## 二、RenderLayout 新契约

```text
RenderLayout
├── paper      = PaperLayout
├── placement
│     ├── scale
│     ├── offsetX
│     ├── offsetY
│     └── (rotation 字段保留但恒为 0，deprecated，Phase 3 删除)
├── paperLandscape   ★ 新增：有效纸张是否横向（内容方向 + 手动旋转推导）
└── clip             # paperLandscape 时交换宽高
```
- **`paperLandscape` 推导**（在唯一 Factory `buildRenderLayout` 内，满足 F2/F3）：
  ```js
  const totalRot = normalizeRotation(swapRotation + fileRotation)  // swapRotation 来自 doc/paper 方向差
  const paperLandscape = totalRot === 90 || totalRot === 270
  ```
- **`rotation` 字段保留、恒为 0**（deprecated）。三端不得再消费它做几何；仅作为兼容占位，Phase 3 删除。
- **有效纸张尺寸**：`paperLandscape` 时，fit / offset / clip 均按**交换后的宽高**计算（纸随内容）。
  这是与旧模型唯一的语义差异点：旧模型旋转内容、新模型翻转纸张。

---

## 三、RenderSpec 新契约

```text
RenderSpec
├── paper { width, height }      # 同前（仍来自 paperRect，Phase 3 可改为有效纸张尺寸）
├── placement { scale, offsetX, offsetY }
├── rotation                     # deprecated，恒 0
├── paperLandscape               ★ 新增：随 URL 发往 RE
├── margin / clip / dpi          # 同前
```
- `wireFieldsOf` 新增 `paper_landscape=1|0`（后端当前忽略→Step 4 消费；Phase 1 已消费）。
- `rotation` 仍序列化（`?rotation=0`），保证旧 URL 形态兼容，Phase 3 移除。

---

## 四、各 Consumer 契约

### Preview（RE `<img>` 路径）
- RE 返回**已按 paperLandscape 定向的图**（横内容→横图）。
- `PreviewCanvas` **删除** `rotate/swap/angle`；`<img>` 以容器尺寸 `objectFit:contain` 自然显示。
- 容器方向由 `usePreview` 依 `paperLandscape` 计算（`contentLayout.swapped` 改读 `renderLayout.paperLandscape`）。

### Preview（Canvas 回退路径）
- `switchPreviewFile` 传 `rotation=0`（内容自然）。
- `getGlobalPreviewCanvas(effectiveLandscape=renderLayout.paperLandscape)` → 横内容落横 Canvas。
- 与 RE 路径像素级一致（Phase 1 已对齐）。

### RE 后端（`engine.py _render_spec_page`）
- **删除 `fitz.prerotate`** 及 `_rotation_to_fitz_arg`（Phase 3 删函数）。
- 读 `spec.paper_landscape`；为 `True` 时交换画布宽高（横纸），内容 `get_pixmap(matrix=scale)` 自然绘制。
- `placement.scale/offsetX/offsetY` 仍逐字使用（已由 Factory 按有效纸张算出）。
- fitz 1.27 旋转 pixmap 空白的 PNG roundtrip hack 已无需（内容不再旋转）。

### Print（Phase 3，本期不动）
- 源文件 → SumatraPDF → 打印机（独立链路）。
- 与 Preview 共享**同一布局决策** `paperLandscape`：PrintService 读 `paperLandscape` 设打印机 orientation。
- 实现线路可与 Preview 不同，但几何结果必须一致（Preview 显示 == Sumatra 打印）。

---

## 五、缓存键（Cache Key）

- 当前 cacheKey 含 `rotation`（`_r0@...`）。Phase 3 将 `rotation` 段替换为 `paperLandscape` 段（`_L@` / `_P@`）。
- Phase 1 暂不改 cacheKey（rotation 仍=0，键稳定）；切换后旧缓存自然失效重算。

---

## 六、迁移步骤（Strangler Fig）

| 阶段 | 范围 | 改动 | 验证 |
|------|------|------|------|
| **Phase 1（已实施 2026-07-13）** | Preview + RE 单链路 | ① `buildRenderLayout` 加 `paperLandscape`、`rotation` 恒 0、按有效纸张重算；② `buildRenderSpec`/`wireFieldsOf` 发 `paperLandscape`；③ `engine.py` 删 prerotate、按 `paper_landscape` 交换画布；④ `PreviewCanvas` 删 rotate；⑤ `usePreview` 容器/`effectiveLandscape`/ASSERT 改读 `paperLandscape` | `vite build` + `node --test` 全绿；浏览器：单文件/多文件点击零跳变、方向一致 |
| **Phase 2（契约固化）** | 文档 + 消费者迁移 | 各模块 Consume 全面改读 `paperLandscape`；更新 `v16-architecture-target.md` 冻结条款（第 91 行 rotation → paperLandscape） | 审计无 `renderLayout.rotation` 参与几何 |
| **Phase 3（收尾）** | 清理 | 删 `rotation` 字段（RenderLayout/RenderSpec/URL/cacheKey）；删 `_rotation_to_fitz_arg`；cacheKey 改 `paperLandscape`；PrintService 改读 `paperLandscape` | 全测试绿；Preview==Print 几何一致验收 |

---

## 七、删除计划（Deprecation Timeline）

1. **现在（Phase 1）**：`rotation` 字段保留、值恒 0；所有几何改读 `paperLandscape`。
2. **Phase 2**：确认无 Consumer 读 `rotation` 做几何后，代码注释标记 `@deprecated`。
3. **Phase 3**：`git rm` 删除 `rotation` 字段 + 相关 URL 参数 + cacheKey 段 + `_rotation_to_fitz_arg` 函数。

> Strangler Fig 原则：**先让旧接口失效（值恒 0、不被消费），再逐步移除**，避免一次性爆破 17 个测试 + 缓存键。

---

## 八、治理声明

本文件是对 `v16-architecture-target.md` v1.1 的方向语义演进（非推翻 DAG / F1–F6 / I1）。
- F1–F6 / I1 全部保持有效；`paperLandscape` 仍由唯一 Factory `buildRenderLayout(paperLayout, documentState)` 纯函数推导（满足 F2/F3/F5）。
- 仅将「方向表达」从 `placement.rotation`（内容旋转）迁移到 `paperLandscape`（纸张方向）。
- 任何进一步偏离须回到本文件评审。
