# C-2-G · UI Rotation 产品语义审计（只读，零代码改动）

日期：2026-08-12
状态：**C-2-G = PAUSED**；resolver / 16 表 / 横纸 executor / 竖纸链 / bake / geometry 全部继续冻结。
本轮改动：**0 行生产代码**（仅新增本报告）。

---

## 0. 结论摘要（TL;DR）

1. **产品语义在代码与文档中从未被显式声明**。现存证据是分裂的：UI 文案与 Viewer JSDoc 指向「视觉增量旋转」，而系统位置（per-doc 持久化 Fact / 文档级 fan-out / 传播到打印与导出）指向「文档方向属性」。
2. 但**冻结契约已经给出唯一权威语义**——`RotationResolver.js:4-10` 权限表 + `L35` 净视觉公式：
   `最终视觉 = contentRotation(烤入内容) + layoutRotation(纸面适配)，二者串行不互相修正`。
   按此契约，用户诉求（预览=打印=正向）在「横票 90° + 横纸」上**自动成立**（90 + (−90) = 0）。
   → **不需要新增 canonical orientation 层**。用户提出的 C 的目标语义，已经是既定契约。
3. 🔴 **真正根因不是「UI rotation 污染 Print Geometry」**。cr 从未作为最终几何旋转量进入 bake：
   `placement_bake.py` 只烤 `layoutRotation`，**从不消费 contentRotation**。
   cr 的唯一执行通道是 `sourceRotation` → Sumatra `rotate=N`；`main.js:559-562`（C-2-G）在横向纸把该通道**覆盖**成常量 90 → **cr 项被丢弃**。
4. 🔴 `bakeLandscapeMatrixGate.mjs` 的 8/8 是**伪绿**：fixture 自造 bake 时用 `show_pdf_page(..., rotate=rot)` 把 cr 烤进了内容，而生产 bake 不烤 cr。Gate 复制了生产并不具备的语义（违反 Gate 红线「禁止 Gate 复制打印语义」），断言退化为自指同一性。
5. 本审计提炼出本质不变式 **INV-R**（见 §5），并据此给出方案裁决：**推荐 E（bake 烤 finalRotation）**，D（命令层叠加）只治方向不治几何，A/C 均不达标。

---

## 1. 范围与方法

只读追踪：UI 点击入口 → 状态 → 持久化 → 四个消费方 → 执行链落地。
读取文件（未修改）：`FileList.jsx` / `App.jsx` / `usePreview.js` / `useViewerState.js` / `InvoiceDocument.js` / `RotationResolver.js` / `usePrint.js` / `PrintService.js` / `exportSnapshotBuilder.js` / `print-settings.js` / `placement-bake-processor.js` / `placement_bake.py` / `main.js` / `docs/rotation-refactor-verification-guide.md` / `docs/margin_contract_vectors.json` / `bakeLandscapeMatrixGate.mjs`。

---

## 2. UI 入口链（事实）

```
用户点击文件卡片旋转按钮
  FileList.jsx:45-53  handleRotate（document group → fan-out 到所有分页 _pages）
  FileList.jsx:100    title = `旋转 (${fileRotations[key] || 0}°)`，图标 = 顺时针环箭头
    ↓ App.jsx:1003 onRotate / :984 handleRotate
  usePreview.js:366-399 handleRotate
    :369  deg = ((fileRotations[key] || 0) + 90) % 360      ← 累加循环，无目标方向选择器
    :370  setFileRotations
    :374-377 documentStateRef.contentRotation = deg（+ legacy rotation 镜像）
    :393-397 saveDocFacts(factKey, { requestedPaperOrientation, contentRotation: deg })
    ↓
  四个消费方（全部同一个值）
    ① 展示区 Viewer   useViewerState.js:101-105  contentRotation → viewRotation
    ② 打印预览        usePreview.js:582 buildRenderCommand({ contentRotation: previewRotation })
                     PrintPreviewModel.js:291   resolveContentPlacement
    ③ 打印几何        usePrint.js:528-558        resolveContentPlacement（同一 resolver）
                     usePrint.js:886-888        sourceRotation = fileRotations[file.key]
    ④ 导出            exportSnapshotBuilder.js:88 rotation = fileRotations[f.key]
```

---

## 3. 产品语义证据（分裂，需裁定）

### A 侧 —— 指向「视觉增量旋转」

| 证据 | 位置 |
|---|---|
| 按钮文案仅「旋转 (N°)」，全仓库无「校正 / 纠正 / 正向 / 归正」任何文案 | `FileList.jsx:100` |
| `(prev + 90) % 360` 累加循环，无「目标方向」选择器、无自动检测建议 | `usePreview.js:369` |
| JSDoc「`rotateRight` - 顺时针旋转 90°」「`viewRotation` - 用户**临时查看**旋转」 | `useViewerState.js:60` / `InvoiceDocument.js:110` |
| Architecture Law D1：`effectiveRotation = sourceRotation + viewRotation` —— 用户旋转是叠加在源 `/Rotate` 上的**增量**，不是绝对正向声明 | `InvoiceDocument.js:104-115` |
| 验收文档 Gate B 预期：「发票内容显示为**横向**（因为用户旋转了 90°）」 | `docs/rotation-refactor-verification-guide.md:182` |
| `contentRotation` 定义为「Policy A 业务内容**旋转 theta**」 | `docs/margin_contract_vectors.json:46` |
| 冻结契约：「把用户旋转动作**物化为内容几何**」 | `RotationResolver.js:16` |

### B 侧 —— 指向「文档方向属性 / 方向校正」

| 证据 | 位置 |
|---|---|
| 这是**唯一**能修正源文件方向的入口 | 全仓库无第二入口 |
| 自动方向检测只比较宽高比，**原理上无法判定语义正立**（0° vs 180° 不可分；竖幅扫描件文字侧躺不可分） | `RotationResolver.js:84-86` |
| per-doc 持久化为 DocFacts `contentRotation`，切文件再切回会恢复（验收场景：旋转 90° → 切走 → 切回仍 90°） | `usePreview.js:378-397` / `:1574-1582`；`guide:100-102`；git `2d29ae1` |
| 与 `requestedPaperOrientation` 同属一个 Fact 记录 = 「该文档如何上纸」 | `usePreview.js:393-396` |
| document group 旋转 **fan-out 到全部分页** → 文档级批属性，非单页查看变换 | `FileList.jsx:48-49` |
| 传播到 Print 与 Export → 被当作**输出方向权威** | `usePrint.js:888` / `exportSnapshotBuilder.js:88` |
| 字段语义注释：「`sourceRotation` = 用户**原始旋转意图**」 | `PrintService.js:64` |

### 裁定

**「方向校正」是唯一合理的用户目标**（B 侧证据决定用途：持久化、文档级、进输出、且是唯一修正手段）；
**「增量旋转」是其机制表达**（A 侧证据描述实现方式）。
二者不冲突 —— 「累加 90° 直到看起来正」本身就是方向校正的通用交互。
**因此不需要引入 canonical orientation 抽象**：cr 参与「求有效方向」+ layoutRotation「纸面适配」，这两步在数学上已经等价于用户想要的 canonical fit。

---

## 4. 冻结契约的净视觉公式 + 四象限推导

`RotationResolver.js:4-10` 权限表（Commit 2-C 冻结）：

| 模块 | 可以修改 | 不可修改 |
|---|---|---|
| Viewer | contentRotation | paper |
| PrintPreview | requestedPaperOrientation | **contentRotation** |
| PrintPipeline | 执行 placement | **决定旋转** |

`L35` / `L238`：`最终视觉 = contentRotation(烤入缩略图) + layoutRotation(SVG transform)，二者串行不互相修正`
`L137-141`：`layoutRotation = 0（方向匹配）| −90（不匹配）`
`L216-219`：先按 cr 交换宽高求 effective，再检测方向 → 决定 layoutRotation
`L242-243`：`placedRect` = 施加 cr **与** layoutRotation **之后**的最终包围盒

推导（cr = 用户旋转；预览 = Canvas 烤 cr + SVG 施 layoutRotation；打印 = bake 烤 layoutRotation + Sumatra `rotate=sourceRotation`）：

| # | 内容 | cr | 纸 | effective | layoutRot | 契约净视觉 | 预览实际 | 打印实际 | delta |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 横票 | 0 | 横 | landscape | 0 | 正向 | 正向 | 正向 ✅ | 0 |
| 2 | 横票 | 90 | 横 | portrait | −90 | 0 = 正向 | 正向 | **−90 侧躺 ❌** | **−cr** |
| 3 | 横票 | 180 | 横 | landscape | 0 | 180 = 纠正倒置 | 正向 | **0 仍倒置 ❌** | **−cr** |
| 4 | 横票 | 270 | 横 | portrait | −90 | 180 | 正确 | **反向侧躺 ❌** | **−cr** |
| 5 | 竖票 | 0 | 横 | portrait | −90 | −90 | −90 | −90 ✅ | 0 |
| 6 | 竖票 | 90 | 竖 | landscape | −90 | 0 = 正向 | 正向 | 正向 ✅ | 0 |

**定理（delta 定律）**：`打印结果 = 预览结果 再旋转 (−cr)`，**当且仅当 cr 通道被覆盖时成立**（= 横向纸 bake 路径）。竖纸路径通道未被覆盖 → delta = 0。

这一条定律**一次性解释了全部三个现象**：
- 现象 1「横票 0° 正常」= case 1，cr=0 → delta=0；
- 现象 2「横票 90° 打印侧躺」= case 2，delta=−90；
- 现象 3「97% 高度 / 47% 面积 / 裁切风险」= `placedRect` 按「cr 已烤」计算（`L242-243`），而执行链实际未烤 cr → **内容实际方向与 placedRect 期望方向差 cr → 几何错配**（fit 尺寸与居中都按错误方向算），不是「横纸容量不足」。

同时它也解释了「竖纸链零回归」为何成立：**该结论只在 cr=0 子空间被验证过**，cr≠0 的竖纸路径靠通道未被覆盖而偶然正确。

---

## 5. 🔴 缺陷定位（三处）+ 本质不变式

### INV-R（本审计提炼的本质不变式）

> **执行链实际施加到内容的总旋转，必须恒等于 `placement.contentRotation + placement.layoutRotation`。**

任何方案只要违反 INV-R，`placedRect`（几何）与实际内容方向就会错配 → 方向错 + fit 错 + 触边/裁切。
当前执行链实际施加 = `layoutRotation`(bake) + `sourceRotation`(Sumatra) + `−90`(landscape 隐含)，其中横纸路径 `sourceRotation` 被常量 90 覆盖 → **cr 项缺失 → 违反 INV-R**。

### 🔴 D-1 Blocker · executor 补偿「覆盖」了业务旋转通道

`electron/main.js:559-562`
```js
const execOrient = settings?.executionPaper?.orientation
if (execOrient === 'landscape') {
  printSettings = { ...printSettings, sourceRotation: 90 }   // ← 覆盖，非叠加
}
```
`sourceRotation` 是 cr 的唯一执行通道：
- `PrintService.js:68` `sourceRotation: fileRotation`（= cr）
- `print-settings.js:183` `contentRotation = src.sourceRotation ?? src.rotation ?? 0`
- `print-settings.js:293` `parts.push('rotate=' + orientResult.contentRotation)`

**Why**：landscape executor 的隐含 −90 补偿与业务内容旋转被塞进**同一个字段**。覆盖写法让「机械补偿」吃掉了「业务语义」。竖纸分支未覆盖 → cr 幸存 → 这正是横纸失败而竖纸正常的机械原因。

### 🔴 D-2 Blocker · Gate fixture 复制了生产不具备的语义（伪绿）

`frontend/test/printGate/marginContract/bakeLandscapeMatrixGate.mjs`（`makeBake`）
```python
page.show_pdf_page(rect, src, 0, rotate=rot)   # ← fixture 自己把 cr 烤进内容
```
而生产 bake **只烤 layoutRotation**：
- `placement-bake-processor.js:87` 只校验 `layoutRotation`；`:148` 只透传 `layoutRotation`
- `placement_bake.py:95-100` / `:138-141` `phi` 仅由 `layoutRotation` 派生，**全文无 contentRotation**

**Why**：Gate 断言是「artifact vs 自造 bake 模板」的 IoU，而模板已含 cr → 断言退化为「Sumatra 没有再额外转」，与「发票是否正立」无关。ROTS 表面覆盖 `[0,90,180,270]`，实际覆盖的是**另一条不存在的链**。这直接违反 Gate 工程红线「验收必须从 Plan 出发，禁止 Gate 复制打印语义」。

### 🟡 D-3 Suggestion · 一字段两语义

`sourceRotation` 同时承担「业务内容旋转量」与「executor 隐含旋转补偿」。
**建议**：拆为 `contentRotation`（业务，来自 placement）+ `executorRotationOffset`（机械，来自纸/驱动能力），在 `buildPrintSettings` 内部相加。这样 D-1 类覆盖事故在类型层面不可能再发生。

### 💭 D-4 Nit · 命名域碰撞

`sourceRotation` 在 Viewer 域 = PDF 固有 `/Rotate`（`InvoiceDocument.js:114`、`docs/render-contract.md:19-24`），在 Print 域 = 用户 UI 旋转（`PrintService.js:68`）。同名反义，建议在 `docs/render-contract.md` 增补一行域标注。

---

## 6. 可实测预测（不改任何代码即可验证 D-1 定位）

| ID | 场景 | 预测 | 判据 |
|---|---|---|---|
| P-180 | 横纸 + cr=180 | 倒置**未被纠正**，视觉与 cr=0 完全相同 | 通道被覆盖，cr 丢失 |
| P-270 | 横纸 + cr=270 | 反向侧躺 | 同上 |
| P-PORTRAIT | 竖纸 + cr=90 / 180 | **正确**（正向 / 倒置已纠正） | 通道未被覆盖 |
| P-DELTA | 横纸任意 cr | 打印 = 预览再旋转 (−cr) | delta 定律 |
| P-GEOM | 横纸 + cr=90 | 面积利用率显著低于 cr=0，高度接近触边 | placedRect 方向错配 |

**若 P-PORTRAIT 通过而 P-180 / P-270 失败 → D-1 定位成立。**
这是一个纯实测、零改码的判决实验，建议作为解冻前的门控。

---

## 7. 方案裁决

| 方案 | 内容 | 满足 INV-R | 保留 180° 纠正能力 | 修方向 | 修几何(fit/触边) | 改动面 | 结论 |
|---|---|---|---|---|---|---|---|
| **A** | bake 消除用户旋转 | ✅（cr 恒 0） | ❌ **永久失去** | — | ✅ | 中 | ❌ 违反 `RotationResolver.js:35` 契约 + `guide:182` 文档期望；倒置发票再也打不正 |
| **C** | 上游 canonical orientation 归一 | ❌ 仍需某处施加旋转 | ⚠️ 180° 与 0° 同解会丢 | 部分 | ❌ | **大**（Viewer/Preview/Print/Export 四消费方） | ❌ 过度设计：目标语义已是既定契约，新增抽象层不解决 INV-R |
| **D** | 命令层**叠加**：`sourceRotation = (cr + 90) % 360` | ⚠️ 方向满足、几何不满足 | ✅ | ✅ | ❌ placedRect 仍按「cr 已烤」算 | **1 行**，纯命令层 | ⚠️ 只治一半，不建议单独收口 |
| **E** | bake 烤 `finalRotation = cr + layoutRotation`，Sumatra 只留常量 90 补偿 | ✅ | ✅ | ✅ | ✅ | 小（`placement_bake.py` phi 表达式 + processor 传参 + 恢复 main.js 常量语义） | ✅ **推荐最终形态** |

**为什么 E 是「最小且正确」**：`placedRect`（`RotationResolver.js:242-243`）本就定义为「cr 与 layoutRotation 都施加后」的包围盒。让 bake 施加 `cr + layoutRotation`，内容实际形状即与 `placedRect` 恒等 → INV-R 成立 → 方向、fit、居中、触边一次性自洽。`placement` 对象已携带 `contentRotation`（`RotationResolver.js:277`），bake 拿得到，**无需任何上游改动**。

**为什么 D 不够**：命令层旋转发生在 bake 之后、由 executor 施加，无法回溯修正 bake 已烤错的 `scale` 与居中。D 只能把「侧躺」转正，`P-GEOM` 的面积/触边问题会原样保留。

> ⚠️ E 需要用户批准**解冻 `placement_bake.py` 的一个 phi 表达式**（严格限定：只改 `layoutRotation` → `contentRotation + layoutRotation`，不动 contain-fit、不动 `/Rotate=0`、不动输出契约 R-1~R-3）。本轮不实施。

---

## 8. 需用户裁决事项

1. 是否接受把裁决从 **C** 改为 **E**（理由：C 的目标语义已是既定契约，真实缺口在执行链违约，不在上游语义污染）。
2. 是否先跑 §6 的 P-180 / P-PORTRAIT 判决实验（零改码）再决定解冻。
3. `bakeLandscapeMatrixGate` fixture 需重构为**消费生产 `placement_bake.py`** 而非自造（属 Gate 工程，不解冻生产代码）。在重构前，其 8/8 结论应降级标注为「仅覆盖 Sumatra 对已烤内容不再额外旋转」。
4. 16 表适用域建议显式标注「直打模型 only，不适用 bake 路径」（已在 `main.js:556-557` 注释中，建议同步进冻结文档）。

---

## 9. 冻结状态（不变）

- **C-2-G = PAUSED**
- 冻结继续：`sumatra-command-resolver.js` 16 表 / 横纸 executor 结论 / 竖纸 golden baseline / `placement_bake.py` / `RotationResolver.js` / geometry / noscale
- 本轮生产代码改动：**0 行**
