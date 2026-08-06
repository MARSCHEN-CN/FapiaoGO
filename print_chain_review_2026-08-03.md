# 打印链审查报告（Step 1：摸清"打印到底按什么规则跑"）

> 范围：为设计 **Print Preview Simulator（打印确认页 / Print Preview Canvas）** 做准备，
> 先审查真实打印链，定位 4 个关键计算点（rotation / safeMargin / 单页多票 / fit），
> 评估「PrintSpec 作为 Printer 与 Preview 的单一真相源」是否成立。
>
> 审查对象：`electron/print-service/*`、`electron/main.js`（`print-source-file` handler）、
> `frontend/src/services/PrintService.js`、`frontend/src/hooks/usePrint.js`。
> 时间：2026-08-03（HEAD `41d1c96a`）。

---

## 一、一句话结论

你担心的"打印链与预览链脱离"**确实存在，而且比"两套代码"更根本**：

> 当前打印链对 Simulator 需要的 4 个概念，**有 2 个压根不在打印链里、1 个被委托给 Sumatra 黑盒、只有 rotation 是真正生效的**。

- ✅ **rotation** —— 真实生效（active 路径 `buildPrintSettings` → `rotate=N`）。
- ⚠️ **safeMargin（安全边距）** —— 真实打印**有**边距，但是通过 `main.js` 里的 **PDF 侧预处理**(`pdfMargin.process`) 烘焙进 PDF 的，**不在 PrintSpec 里**，且 **OFD 漏掉**。
- 🔴 **单页多票（two-up / 一页两票）** —— **active 打印路径完全没有组合逻辑**，一票=一物理页。two-up 只活在 **legacy Canvas 渲染路径**（`buildRenderModel slotCount`）。
- 🔴 **fit/scale** —— 直接委托给 **SumatraPDF 内部算法（`-print-settings fit`）**，JS 侧无公式，Preview 无法像素级复现。

**并不存在"一个被 Printer 和 Preview 共同消费的 PrintSpec"。** 真实情况是：打印参数在 3~4 个地方被**分散重建**（前端 `PrintService.buildPrintSettings` → IPC → `main.js` margin 步骤 → `print-backend.buildPrintSettings` → 另有一条 `OsLauncherBridge.toSumatraArgs` 并行路径）。

**所以你"先看打印、再设计 Preview"的顺序完全正确——而且结论很明确：在定义 `PrintPreviewModel` 之前，必须先定义"一个真正的、共享的 PrintSpec"，否则 Simulator 只能自己发明 safeMargin / two-up / fit，必然与打印漂移。**

---

## 二、当前打印真实规则（数据流）

```
[前端] usePrint.executeSourcePrint / executePrint
   │  fileRotations[key]  →  每文件旋转
   │  settings.marginLeft/Right/Top/Bottom (默认 3mm)
   ▼
[前端] PrintService.buildPrintSettings(file, userSettings, fileRotations, detectFn)
   │  产出 ps = { rotation, paper, fit, contentOrientation, marginLeft/Right/Top/Bottom, ... }
   │  ⚠️ ps 里没有 layout / slots / items[] / safeMargin 字段
   ▼  IPC: print-source-file { target{printer,filePath,fileFormat}, settings: ps }
[electron/main.js] print-source-file handler  (L498-560)
   │  ① pdfMargin.process(filePath, margins, isImage, orient)   ← 边距在这里烘焙进 PDF
   │     ⚠️ 只对 pdf/png/jpg/bmp/tiff/tif 生效，OFD 跳过
   │  ② createBackend('sumatra') → SumatraBackend.print
   ▼
[electron/print-service/print-backend.js] buildSumatraCommand → buildPrintSettings(normalizedSettings)
   │  ⚠️ 这里重新读 rotation/contentOrientation，但不读 margin（边距已烤进 PDF）
   │  产出 Sumatra -print-settings 字符串
   ▼
[SumatraPDF.exe] 真正出纸（fit/旋转/纸张 全由 Sumatra 内部决定）
```

**关键事实：PrintSpec（`OsLauncherBridge.js:208` typedef）不是 active 序列化器。**
active 序列化器是 `print-service/print-settings.js: buildPrintSettings`，由 `print-backend.js` 调用。
`OsLauncherBridge` 是**另一条并行桥**（见下方 🔴-4），它的 `toSumatraArgs` 把 `desiredRotation` 写成 `0`。

---

## 三、四个关键计算点定位

### 1. 旋转 rotation —— ✅ 真实生效，但位置分散
- **生效路径**：`frontend/src/services/PrintService.js:56 buildPrintSettings` 把 `fileRotations[file.key]` 写进 `ps.rotation` → IPC → `main.js` → `print-backend.js:143 buildPrintSettings`（`print-settings.js:151`）→ `resolveOrientationCommands(...)`（`print-settings.js:34`）→ `rotate=N`。
- **语义**：前端 `fileRotations[key]` 是**每文件**旋转态，经 IPC settings 传到 Sumatra。这与你设计的 `InvoiceContent.rotation` 模型一致 ✅。
- **坑**：`buildPrintSettings` 判断 `hasOrient = contentOrientation && paperOrientation`，但 IPC settings 里**没有 `paperOrientation`**（只有 `contentOrientation`），所以恒走 `else` 分支：`disable-auto-rotation` + `rotate=N` 直出。`resolveOrientationCommands` 那张内容方向×纸张方向 lookup 表**实际没被 active 路径用上**——纯旋转能过，但"智能方向"逻辑失效。
- **另一条桥**：`OsLauncherBridge.toSumatraArgs`（`OsLauncherBridge.js:300`）调用 `resolveOrientationCommands(pdfOrientation, spec.orientation, 0)` —— 第三个参数硬编码 `0`，**rotation 被丢弃**，方向只由 PDF MediaBox 推导。

### 2. 安全边距 safeMargin —— ⚠️ 真实打印有，但不在 PrintSpec，且 OFD 漏
- **位置**：`electron/main.js:515-553`。`settings.marginLeft/Right/Top/Bottom`（默认 3mm，来自 `usePrint.js:676-679`）→ `pdfMargin.hasMargins` → `pdfMargin.process()` 生成**带边距的新 PDF**，再交给 Sumatra。
- **关键**：边距是**烘焙进 PDF 像素**的（物理平移内容），不是 Sumatra 参数。所以 `PrintSpec` / `buildPrintSettings` 里**没有 margin 概念**——`buildPrintSettings`（`print-settings.js:151-238`）根本不读 `marginLeft`。
- **🟡 漂移风险 1（OFD）**：`main.js:522` 限定 `imgExts = ['.pdf','.png','.jpg','.jpeg','.bmp','.tiff','.tif']`，**不含 `.ofd`**。OFD 源打印**不走边距处理** → PDF/图片有边距、OFD 无边距，同一设置两种结果。
- **🟡 漂移风险 2（Preview 无真值源）**：safeMargin 值活在 `settings`，没有结构化的 `safeMargin` 字段可供 Preview 消费。Simulator 若想"所见即所得"，必须自己实现一套 PDF 边距烘焙逻辑的等价物——而那套逻辑在 `pdf-margin-processor`（Python/PDF 操作）里，Preview（JS/Canvas）要复刻，易漂移。

### 3. 单页多票（two-up / 一页两票）—— 🔴 active 路径完全没有
- **active 路径**：Sumatra 一次打一个文件 = 一物理页。`print-service/` 内 grep `slot|two-up|nup|compose|multi-ticket` **全无结果**。
- **two-up 只存在于 legacy Canvas 路径**：`usePrint.js:911-919` `buildRenderModel({ items, rotations, slotCount:1 })` → `renderPrintContent` → `submitPrintIntent`（iframe/window.print）。`slotCount` 是 legacy 渲染器的概念。
- **一普二专是 PrintStrategy，不是布局** ✅：`usePrint.js:822-841` 把普票作第 1 轮、专票作第 2 轮（带 `_jobKey+'_v2'`）生成**任务队列**，物理上仍是每票一页。你的架构判断完全正确——它必须留在任务生成层，不进 Preview。
- **🔴 漂移结论**：你设计的 `PrintLayout { slots:[{x,y,width,height}] }` 在 **active 打印路径无法复现**。若 Simulator 显示 A4 两票，active 打印机打不出 → 必然"看到 ≠ 打印"。**这是 Step 4（接单页多票）之前必须解决的架构缺口**：要么给打印管线加真正的 two-up 组合（把 N 个源文件合成一页再送 Sumatra），要么明确"two-up 仅预览、打印走分票"并让用户知情。

### 4. fit/scale —— 🔴 委托 Sumatra 黑盒，Preview 不可像素复现
- **位置**：`buildPrintSettings`（`print-settings.js:175-186`）把 `fit` 映射成 Sumatra `fit`/`noscale`/`stretch`，写进 `-print-settings`。**JS 侧没有任何 fit 数学**。
- **后果**：Sumatra 内部的"fit to paper"算法对 Preview 不透明。Simulator 用 Canvas 画 `fit`，只能**近似** Sumatra 的 fit，无法保证像素一致。
- **对比**：legacy Canvas 路径的 fit 是 JS 算的（`printRenderer.js`），那条路径 Preview 倒能复用——但 active 路径不是。两条路径 fit 算法本就不同 → 又一个潜在漂移源。

---

## 四、单一真相源（PrintSpec）评估 —— 🔴 当前不存在

| 你期望 PrintSpec 含的字段 | 当前真实状态 |
|---|---|
| `paper` | ✅ 有（分散在多处重建） |
| `orientation` | ⚠️ 由纸张硬编码 + PDF MediaBox 推导，无统一字段 |
| `safeMargin` | 🔴 **无**（活在 `settings.margin*`，烘焙进 PDF） |
| `layout` / `slots` | 🔴 **无**（two-up 只在 legacy renderer） |
| `items[]`（每票 file+rotation） | 🔴 **无**（rotation 按 `fileRotations[key]` 散落在前端 state） |
| `rotation` | ⚠️ 在 `ps` 里但不进 `OsLauncherBridge` 的 PrintSpec typedef |
| `scale/fit` | ⚠️ 有，但委托 Sumatra 黑盒 |

**结论**：没有"一个对象跨 Printer/Preview 边界"的 PrintSpec。参数在 前端 / IPC / main.js / print-backend / OsLauncherBridge **5 处重建**。这正是"脱离"的根。

---

## 五、Preview / Print 漂移风险清单（按你的担忧排序）

🔴 **R1 — two-up 不可打印**：Simulator 显示多票/两票，active 打印路径无法组合 → 必然不一致。必须在 Step 4 前补打印管线的组合能力，或显式降级为"预览专用"并披露。
🔴 **R2 — 无共享 PrintSpec**：不先定义单一真值源，Simulator 必自创 safeMargin/layout/fit → 与打印漂移。先做 Step 2 的 `PrintPreviewModel = PrintSpec` 契约。
🟡 **R3 — OFD 无边距**：`main.js:522` 漏 `.ofd`，与 PDF 行为不一致。要么补 OFD 边距，要么在 Preview 里也按"OFD 无 safeMargin"建模并对齐。
🟡 **R4 — 两条旋转序列化路径分歧**：`print-backend.buildPrintSettings`（吃 rotation，active）vs `OsLauncherBridge.toSumatraArgs`（rotation 写死 0，L334）。若任一切换到后者，旋转静默失效。建议删死路径或加 guard。
🟡 **R5 — fit 黑盒**：active 路径 fit 由 Sumatra 决定，Preview 只能近似。建议把 fit 计算提到 JS（可复用 legacy `printRenderer` 的 fit），让 Printer 与 Preview 共用同一函数。
💭 **R6 — 一普二专不要进 Preview**：`usePrint.js:822` 已正确作为任务策略。Simulator 只渲染"当前选中 PrintItem"，不消费轮次逻辑。保持。
💭 **R7 — orientation 智能表失效**：active 路径因缺 `paperOrientation` 跳过 `resolveOrientationCommands` 方向表，纯 `rotate=N`。若以后要"内容方向感知"，需把 `paperOrientation` 补进 settings 并打通。

---

## 六、对 Step 2 / Step 3 的约束建议

**Step 2 必须先做"PrintSpec 契约"，而不是先画 UI：**

```js
// 建议的单一真值源（Printer 与 Preview 都消费它）
PrintSpec = {
  paper:        'A4',                 // 统一枚举，复用 resolvePaper 值对象
  orientation:  'portrait',           // 视觉态由 PreviewPaperState 单独持有，不写回这里
  safeMargin:   { left:3, right:3, top:3, bottom:3, unit:'mm' },  // 替代散落 settings.margin*
  scale:        'fit',                // fit|noscale|stretch —— 决定 Preview 与 Printer 同义
  layout: {
    type: 'single' | 'two-up' | ..., // 单页布局
    slots: [ { x, y, width, height, rotation } ]  // 每票位置+旋转（替代 fileRotations[key]）
  },
  items: [ { file, rotation } ]       // 每物理页的票清单
}
```

- **safeMargin 进 Spec**：让 `pdfMargin.process`（打印）和 Simulator（预览）都读 `spec.safeMargin`，并修 R3（OFD 也消费）。
- **rotation 进 `slot.rotation`**：消除 `fileRotations[key]` 散落，Preview 与 Printer 同一来源。
- **scale 同义**：Preview 的 fit 实现必须与 Printer 最终行为对齐（最好共用一个 JS fit 函数，解决 R5）。
- **orientation 视觉态分离**：`PreviewPaperState { paper, orientation }` 只控视觉，绝不写回 `PrintSpec`（你第七点的设计，正确）。

**Step 3（单文件预览）可独立做**，前提是 safeMargin/fit 已按上面契约对齐——这步风险最低。
**Step 4（单页多票）必须先补"打印管线 two-up 组合"**，否则 Preview 永远对不上打印（R1）。
**Step 5（一普二专）只动任务队列生成，Preview 不感知**（R6 已满足）。

---

## 七、处理顺序建议

1. **定义 `PrintSpec` 契约**（Step 2 前置，阻塞一切）—— 解决 R2。
2. **修 R4**：删除/guard `OsLauncherBridge.toSumatraArgs` 旋转写死 0 的并行路径，避免误切换。
3. **safeMargin 结构化**：进 Spec + 修 OFD 边距（R3）。
4. **fit 共用 JS 实现**（R5），让 Preview≈Printer。
5. **Step 3 单文件预览**（低风险，可并行）。
6. **Step 4 前补打印管线 two-up 组合**（R1，架构缺口，最大风险）。

---

## 八、审查文件清单

| 文件 | 角色 | 与 Simulator 的关系 |
|---|---|---|
| `electron/print-service/print-settings.js` | active 序列化器（rotation/fit/paper → Sumatra 串） | Preview fit/rotation 应对齐此处 |
| `electron/print-service/OsLauncherBridge.js:208` | PrintSpec typedef（**残缺**，无 margin/layout/items） | 需升级为上面的契约 |
| `electron/print-service/OsLauncherBridge.js:300` | `toSumatraArgs`（rotation 写死 0 的并行路径） | 🔴 R4 死路径 |
| `electron/print-service/print-backend.js:143` | `buildSumatraCommand` 调 `buildPrintSettings` | active 路径入口 |
| `electron/main.js:498-560` | `print-source-file` handler，含 `pdfMargin` 边距预处理 | safeMargin 真实落点 + OFD 缺口 |
| `electron/main.js:22` | `pdfMargin = require('./print-service/pdf-margin-processor')` | 边距烘焙模块（Preview 需等价物） |
| `frontend/src/services/PrintService.js:56` | 前端 `buildPrintSettings`（产 ps.rotation/margin） | rotation 来源 |
| `frontend/src/hooks/usePrint.js:615-842` | `executeSourcePrint` / `executePrint` / 一普二专 | rotation/margin 组装 + 任务策略 |
| `frontend/src/layout/resolvePaper.js` | Preview 侧纸张单一真值源（**独立守卫**） | 印证"Preview 修 Preview，不共享打印守卫"纪律 |
| `frontend/src/hooks/usePrint.js:911-919` | legacy `buildRenderModel({slotCount})` | two-up 仅此路径有（R1） |

---

## 九、总体评价

打印链工程质量本身不差：`PrintService` 分层清晰、IPC 超时/清理到位、`resolveOrientationCommands` 有表格验证、Preview 侧 `resolvePaper` 已做到"单一真值源 + 独立守卫"。**但它是为"一票一页直通 Sumatra"设计的，不是为"模拟器"设计的**——safeMargin 藏在 PDF 预处理里、two-up 只在 legacy 渲染器、fit 甩给 Sumatra 黑盒。

你的边界定义（展示区≠打印确认页、二者彻底隔离）和 Step 顺序（先看打印再设计 Preview）都对。唯一要补的认知是：**问题不是"两套代码写重了"，而是"打印链本身就缺 Simulator 需要的 safeMargin/layout/items 真值，且 two-up/fit 对 Preview 不可复现"**。先把 `PrintSpec` 契约钉死，后面才不会重蹈安全边距污染的覆辙。

> 本次为纯审查，未改动任何代码。下一步若同意，我可以先落地「Step 2 PrintSpec 契约 + 修 R4 死路径」，再进入 Step 3 单文件预览。
