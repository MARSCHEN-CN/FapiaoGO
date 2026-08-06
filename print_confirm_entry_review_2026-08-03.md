# 打印确认页入口审查报告（Step 0：确认别接错入口）

> 审查目标：在落 `PrintPreviewSpec` 之前，确认「打印确认页预留区域」当前对应的组件与数据流，
> 避免 PrintPreviewSimulator 接错上游（重演展示区安全边距污染）。
> 范围：`PrintConfirmModal.jsx` + `App.jsx` 调用点 + `usePrint`/`useSettings`/`usePreview`/`FileContext` 上游。
> HEAD：`41d1c96a`。

---

## 一、现状：预留区域到底是什么

**组件：`frontend/src/components/PrintConfirmModal.jsx`（打印确认弹窗，3:2 左右分栏）**

- 左侧 = `pcm-settings`：打印机 / 纸张 / 合并 / 页边距 / 方向 设置区（已可交互，写回 `settings`）。
- 右侧 = `pcm-preview`（**L368–L415**）：**纯静态 SVG 占位图** —— 硬编码画了一张假 A4 + 假发票线条。
  - **当前零数据流**：没有任何发票列表、图片 URL、RenderResource 被传入右侧。它就是一个视觉占位（L372 `预览区域（后续改造）`、L411 `预览区域占位`）。

**当前 props（L14–L26）：**

| prop | 来源（App.jsx:1207–1220） | 性质 |
|---|---|---|
| `settings` | `useSettings` → `settings` | ✅ PrintConfig 真值 |
| `saveSettings` | `useSettings` | 设置写回 |
| `printers` | electron | 打印机列表 |
| `totalFiles` | `printableCount`（FileContext） | ⚠️ **仅计数（数字），不是列表** |
| `mergeMode` | `isMergeMode(settings.mergeMode)` | ⚠️ 仅 footer badge 用 |
| `isOneNormalTwoSpecial` | `settings.extraSpecial` | PrintStrategy（任务队列，非布局） |
| `paperOrientation` | App `paperOrientation`（usePreview） | ✅ 视觉态（PreviewPaperState），已与打印参数分离 |
| `contentRotation` | `previewRotation`（App） | 🔴 单文件「显示旋转」，非每文件旋转 |
| `onConfirm` / `onCancel` | App | 关闭 + 触发打印 |

**结论：右侧预留区目前是一个空壳，完全没有消费打印数据。** 这正是你担心的「接错入口」的高危位置。

---

## 二、上游数据真相源（已逐一确认）

| 你要的东西 | 真实来源 | 现状 | 备注 |
|---|---|---|---|
| 纸张 paper | `settings.paperSize` + `settings.customPaper{widthMM,heightMM}` | ✅ 已在 `settings` | 见 `PrintConfirmModal.jsx:148–212` |
| 方向 orientation（视觉） | App `paperOrientation`（usePreview, L72） | ✅ 已分离传入 | 不影响 `settings.landscape` |
| 安全边距 safeMargin | `settings.margin{Left,Right,Top,Bottom}`(mm) + `marginPreset` | ✅ 已在 `settings` | 见 `PrintConfirmModal.jsx:230–332` |
| 单页多票 layout | `settings.mergeMode`(none/merge2/3/4) | ✅ 在 `settings` | 需映射成 `single/two-up/three-up/four-up` |
| 内容旋转 rotation | **`fileRotations`(key→deg)**（usePreview L65, 传给 usePrint L149） | 🔴 没传给 modal | modal 只拿到单值 `contentRotation=previewRotation` |
| 要模拟的发票列表 | `FileContext.files` / `ImportSessionStore.documents` | 🔴 没传给 modal | modal 只拿到 `printableCount` 计数 |
| 图片内容 RenderResource | `resolvePreviewUrl({renderDocId,index}, docId)`（App.jsx:178）/ `usePreview.previewUrl` | ⚠️ 存在但 modal 未接 | 只取内容，不取展示区 layout |
| 一普二专策略 | `settings.extraSpecial` | ✅ 已传 | 是任务队列策略，Preview 只显示 badge |

**关键判断：`settings` 已经是一个相当完整的 PrintConfig 真值源**（paper / orientation / safeMargin / layout / strategy 都在）。缺的是「枚举发票列表」和「每文件 rotation」—— 这俩是 Simulator 渲染逐页所必需的，而现在根本没进 modal。

---

## 三、接错入口的 6 个风险点

### 🔴 R1 — 模态拿不到「要模拟的发票列表」，只有计数
`PrintConfirmModal` 收到的是 `totalFiles={printableCount}`（**一个数字**，FileContext L83–96），不是文件数组。
右侧 SVG 占位因此无法知道「有哪些发票、分别画什么」。
**Why：** 没有列表，Simulator 无从逐页生成 `PrintPreviewPages[]`。
**Suggestion：** 给 modal 新增 `files`（或 `printPreviewDocuments`）prop，源头 `useFileContext().files` / `ImportSessionStore.documents`，按「可打印 + 勾选」过滤后传入。

### 🔴 R2 — `contentRotation` 是单值显示旋转，不是每文件旋转
打印旋转是 **per-file**：`fileRotations[key] = deg`（usePreview L65，传入 usePrint L149）。
但 modal 收到的 `contentRotation={previewRotation}`（App L1216）只是「当前在展示区看的那一个文件的旋转角」。
多页 / 单页多票场景下，所有 slot 会被套用同一个错误角度。
**Why：** 单值无法表达「A 旋转 90°、B 旋转 0°」。
**Suggestion：** 把 `fileRotations` 整张 map 传给 modal（或传给 `buildPrintPreviewSpec`），在 `items[]` 里按 `fileId` 取各自 rotation。

### 🔴 R3 — 「勾选的」selectedFiles 状态根本不存在
你要求「缩略图仅展示当前在文件列表中勾选的，直接消费 `ImportSessionStore → selectedFiles`」。
实测：`FileContext.jsx` 和 `ImportSessionStore.js` **都没有 `selected` / `checked` / `selectedFiles` 概念**（grep 零命中）。
当前打印流程是「打印 session 内全部可打印文件」，没有勾选过滤态。
**Why：** Step 3 的「只展示勾选的」目前无数据支撑，若硬接会退化成「全量预览」或凭空造状态。
**Suggestion：** 二选一，先决策 ——
- (a) Simulator 直接消费**全 printable 列表**（与真实打印一致，最简单）；
- (b) 先引入 `selection` state（`FileContext` 或 `ImportSessionStore` 增加 `selectedFileKeys`），再过滤。
**这是必须先和你确认的产品决策点。**

### 🟡 R4 — 严禁接 usePreview 的展示区渲染产物
`usePreview` 输出的 `previewUrl` / `previewCanvas` / `paperLayout` / `contentLayout` 是**展示区 Render**（如实看原文件，无 safeMargin、无打印纸张、无打印旋转）。
**Why：** 一旦 PrintPreview 复用这些，就会把「展示区不消费打印规则」的语义带进确认页 —— 正是你定义要隔离的那条边界。
**Suggestion：** PrintPreview 只消费 **RenderResource 的「图像内容」**（`resolvePreviewUrl({renderDocId, index}, docId)`，仅取像素），paper / safeMargin / layout / rotation 全部由 Simulator 自己按 PrintSpec 算。

### 🟡 R5 — fit/scale 仍是 Sumatra 黑盒，Preview 与 Printer 必须共用公式
`print_chain_review` 已确认：active 打印的 fit 委托 Sumatra `-print-settings fit`，JS 无公式。
**Why：** 若 Simulator 自己写一套 fit、Printer 走 Sumatra 另一套，必然所见非所得。
**Suggestion：** 在 `PrintPreviewSpec` 阶段一并抽出 `calculateFitTransform()`，Preview 渲染与 Printer 预处理（pdfMargin / Sumatra 参数）共用。

### 💭 R6 — layout / strategy 推导不要留在 modal 里算
`mergeMode` / `extraSpecial` 现在在 modal 里只做 footer badge（L422–431）。
**Why：** 布局类型推导属于 PrintSpec 构建，modal 应是纯消费方。
**Suggestion：** `settings.mergeMode → layout.type`（none→single, merge2→two-up, ...）、`extraSpecial → PrintStrategy` 都在 `buildPrintPreviewSpec()` 纯函数里完成，modal 只渲染。

---

## 四、正确的接入姿态（PrintPreviewSpec 该从哪拿）

```
FileContext.files  (或 ImportSessionStore.documents)   ← 枚举发票（R1）
   +
useSettings.settings                              ← PrintConfig 真值（paper/safeMargin/layout/strategy）
   +
usePreview.fileRotations (per-file)               ← 每文件旋转（R2，替换单值 contentRotation）
usePreview.paperOrientation (visual only)          ← 视觉方向
   │
   ▼
buildPrintPreviewSpec(files, settings, fileRotations, paperOrientation)   ← 新增纯函数（R6）
   │   输出：PrintPreviewSpec[]  = [{ paper, orientation, safeMargin, layout{type,slots[]}, items[{fileId,rotation}] }]
   ▼
PrintConfirmModal（替换 L368–415 的 static SVG）
   ├─ 复用 PageNavigator（currentPage / totalPages / onPrev / onNext / onJump）  ← 你要求复用
   └─ 每页按 layout.slots 渲染 SlotRenderer，slot 内 fit 发票图像（仅内容，R4）
       图像源 = resolvePreviewUrl({renderDocId, index}, docId)   ← 复用 RenderResource，不入展示区 layout
```

**selectedFiles 决策（R3）：** 若选 (a) 全 printable，则 `buildPrintPreviewSpec` 直接吃 `files`；若选 (b) 加 selection，则先过滤再吃。在写 `buildPrintPreviewSpec` 前必须定。

---

## 五、结论与下一步

- 预留区（`PrintConfirmModal` 右侧）目前是**空壳**，没有接任何打印数据 —— 这正是安全的改造起点，**还没有被污染**。
- `settings` 已经是合格的 PrintConfig 单一真值源；缺的是 **枚举发票列表（R1）** 与 **每文件旋转 map（R2）**，以及要决定的 **勾选态（R3）**。
- 最大陷阱不是 UI，而是 **R2（单值旋转误当每文件）** 和 **R4（误接展示区 Render）** —— 这两个会直接把 Simulator 变成「第二个 Viewer」。

**建议下一步（对应你的 Step 1）：先写 `buildPrintPreviewSpec()` 纯函数**，输入 `files + settings + fileRotations + paperOrientation`，输出 `PrintPreviewSpec[]`，不碰 UI。落地前请先确认 **R3：全量预览 vs 勾选态**。

> 未改动任何代码（纯审查）。push 由 UGit 接管。
