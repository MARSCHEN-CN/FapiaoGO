# Print Auto Rotation Contract v1（FROZEN）

> 状态：**FROZEN**（2026-08-18 签署，Gate 0 通过）。本文件是「打印层内容方向 → 纸张方向」自动对齐契约的唯一权威定义。
> 来源：OFD 单文件打印横向发票在竖向 A4 上不自动旋转（P1 旋转议题）。
> 根因定级：**非 OFD 缺陷，是 Print Geometry Policy 缺失**——所有走 canvas 打印的格式
> （image / pdf-raster / ofd）当前只做 contain-fit，不消费内容方向语义。
> 与 `f87901b`（OFD Raster 收敛）、`f33fc83`（OFD 死路径清理）独立；本契约不回退它们。
>
> 相关：`docs/print_margin_contract.md`（几何 Margin 权威）、
> `docs/rotation-refactor-verification-guide.md`（三层旋转模型验证）。

---

## 0. 冻结裁决表

| 编号 | 议题 | 裁决 | 状态 |
|---|---|---|---|
| **D1** | 适用范围 | 所有走 canvas 打印的格式：**image / pdf-raster / ofd**。原生 PDF 直打路径（`isSinglePdfNative`，`/Rotate` 已烤入栅格）**不在此契约内**，保持不变 | 🔒 冻结(提案) |
| **D2** | 是否自动旋转 | **开启，但仅纠正式**：仅当 `contentOrientation ≠ requestedPaperOrientation` 时施加 `autoRotation` | 🔒 冻结(提案) |
| **D3** | autoRotation 方向矩阵 | 见 §1.2 四格 | 🔒 冻结(提案) |
| **D4** | 用户手动旋转优先级 | **叠加式**：`effectiveRotation = normalize(autoRotation + userRotation)`；`autoRotation` 仅由**原始内容几何**（contentOrientation）与目标纸张几何计算，禁止把 effectiveRotation 回流重算（防循环）。用户旋转是最终控制权，但在 canonical rotation space 叠加 | 🔒 冻结 |
| **D5** | 合并（merge）模式 | 同样适用：在 V16 `createPlacement` 以 **per-slot**（ticket content 层）消费同一 resolver 输出，不在 V16 外另算；autoRotation 作用于「单张内容原始几何 vs 共享纸张方向」，不在 D4 之外混入 merge 语义 | 🔒 冻结 |
| **D6** | preview / print 一致性 | **统一**：preview 与 print 共用同一 `PrintAutoRotationPolicy`；同步**放宽** `detectOrientation.js:5-6` 冻结不变量（§4） | 🔒 冻结 |
| **D7** | resolver 落点 | 新增纯函数 `resolvePrintAutoRotation(...)`，由 `renderFileToPrintImage` 在构造 `rotations`/`paperLayout` **前**调用；**不得**放进 `RotationResolver`、`renderMultipleItemsToCanvas` 或任何 renderer | 🔒 冻结(提案) |
| **X-1** | 既有 `RotationResolver` / `PrintPreviewModel` | 不动。本契约的 autoRotation 与「Viewer `contentRotation` / PrintPreview `requestedPaperOrientation`」是不同关注点，互不引用 | 🔒 冻结(提案) |

---

## 1. 数学模型

### 1.1 输入

```
contentWidth, contentHeight   ← 栅格固有像素尺寸（img.naturalWidth/Height，对所有格式可见）
paperOrientation              ← requestedPaperOrientation（用户纸张选择）
userRotation                  ← fileRotations[f.key]（默认 0）
```

```
contentOrientation = (contentWidth > contentHeight) ? 'landscape' : 'portrait'
```

### 1.2 autoRotation 矩阵（D3）

| contentOrientation | paperOrientation | autoRotation |
|---|---|---|
| landscape | landscape | 0° |
| landscape | portrait | −90° |
| portrait | landscape | +90° |
| portrait | portrait | 0° |

> 语义：当内容长边与纸张长边不一致时，旋转内容使长边对齐纸张长边（**纠正式**，非任意旋转）。

### 1.3 输出

```
effectiveRotation        = normalizeDeg(autoRotation + userRotation)      // mod 360，autoRotation 来自原始内容几何
effectiveContentWidth    = (effectiveRotation % 180 == 90) ? contentHeight : contentWidth
effectiveContentHeight   = (effectiveRotation % 180 == 90) ? contentWidth  : contentHeight
```

> ⚠️ **`autoRotation` 只由「原始 contentOrientation + paperOrientation」计算一次**（INV-D4-1）；无论用户后续如何旋转，`effectiveRotation` 都**不得**回流成为下一次 `autoRotation` 的输入，否则会循环旋转。
> Canvas / V16 **仅消费** `effectiveRotation` 与 effective 内容尺寸；不再各自判断宽高方向。

---

## 2. 不变量（INV）

- **INV-1**：`autoRotation` 只在 content↔paper 方向不一致时非 0；一致时恒 0（避免「小图也被旋转」）。
- **INV-2**：本契约**只改变内容旋转与有效内容尺寸**，**不改变纸张方向**、不切换 Policy A 的 `outputPaper` 交换逻辑。
- **INV-3**：`effectiveRotation` 是打印路径对内容方向的**唯一**决策出口；`renderMultipleItemsToCanvas` / `createLayout` / `_buildComposeCommands` 不得再各自推断宽高方向。
- **INV-4**：与 Margin Contract 正交——autoRotation 作用于 placement 的 rotation 输入，margin 仍由 Margin Contract 单独施加（单层几何，互不重算）。
- **INV-5**：preview 与 print 消费同一 resolver（D6 成立后）；二者输出视觉一致。
- **INV-D4-1（旋转循环防护）**：`autoRotation` 仅由 `sourceContentGeometry + targetPaperGeometry` 计算；**禁止**将 `effectiveRotation` 或其作用后的内容方向再次输入 `autoRotation`，避免循环旋转。
- **INV-D4-2（用户最终控制权）**：用户旋转不覆盖自动旋转，而是在 canonical rotation space 叠加（`effective = auto + user`）；用户旋转具有最终控制权，但语义为「在自动对齐的基线上微调」。

---

## 3. 责任划分 / resolver 签名

```
PrintAutoRotationPolicy.resolvePrintAutoRotation({ contentWidth, contentHeight, paperOrientation, userRotation })
  → { autoRotation, effectiveRotation, effectiveContentWidth, effectiveContentHeight }
```

**调用方（唯一）**：`renderFileToPrintImage`（usePrint.js）

- **单文件**：算出 `effectiveRotation` → 注入 `rotations={[f.key]: effectiveRotation}`（替代当前仅 `fileRotations[f.key]||0`）。
- **合并**：把 `{contentOrientation, paperOrientation, userRotation}` 喂给 V16 `createPlacement` 的输入，由 V16 内部调用同一 resolver。

**不调用方**：`RotationResolver`（Viewer/PrintPreview 域）、`renderMultipleItemsToCanvas`、各 renderer。

---

## 4. 与既有冻结的关系（关键 gate）

当前 `detectOrientation.js:5-6`：

> `detectDocumentOrientation` 仅用于预览画布方向决策，**不参与打印决策**；
> 打印层永远由 `disable-auto-rotation + fit + paper` 锁定。

**采用 D6（preview/print 统一）即直接放宽该不变量。** 本契约落地时须同步将该句改为：

> 打印层由 `PrintAutoRotationPolicy` 统一消费内容方向（纠正式自动对齐），不再「禁用自动旋转」。

这是一处**冻结不变量变更**，须走 §6 变更流程并显式记录被推翻条款。

---

## 5. 禁止清单

```
OFD renderer 内联旋转                  ❌
fetchPrintRaster 改动                  ❌
renderMultipleItemsToCanvas 内偷判断宽高旋转  ❌
RotationResolver 复用 / 改造            ❌
Sumatra 旋转参数改动                   ❌
print-target 行为契约改动              ❌
IPC 协议改动                          ❌
autoRotation 与 margin 混算            ❌
```

---

## 6. 实施 Gate 序列（独立轨道，冻结后另开）

| Gate | 动作 | 通过判据 |
|---|---|---|
| **0** | 本契约签署（D4 / D5 / D6 确认） | doc 标记 **FROZEN** |
| **1** | 新增 `PrintAutoRotationPolicy.js` 纯函数 + 向量集（4 格 + 叠加用例） | 单测 GREEN |
| **2** | `renderFileToPrintImage` 单文件接入 resolver | 横票+竖纸 → −90° 落 Canvas，打印铺满竖纸 |
| **3** | 放宽 `detectOrientation.js:5-6` 不变量 + 同步 preview 复用同一 resolver | preview / print 视觉一致 |
| **4** | V16 merge 接入 per-slot resolver | 合并多票方向各自正确 |
| **5** | 回归：OFD guard 3/3、Gate A 77/77、新增 auto-rotation 向量集 | 全绿 |

---

## 7. 变更流程

本文件为冻结契约（签署后）。变更须满足：提案单独成文 → 说明被推翻的不变量 → 同步向量集 → 单测 → 版本递增。

### 7.1 变更记录

| 版本 | 日期 | 变更 | 来源 |
|---|---|---|---|
| v1.0 | 2026-08-18 | 初始冻结（Gate 0 签署）：D4 叠加式 + INV-D4-1/INV-D4-2，D5 合并 per-slot，D6 preview/print 统一并放宽 detectOrientation.js:5-6 | OFD 横向发票直打暴露的 Print Geometry 缺口 |
