# Merge Final Artifact 架构设计（Preview = Print Artifact，2026-08-14 · v2 定稿）

> 本轮转向：**停止"打印结果 → 预览"的反向拟合。**
> 架构原则升级为硬边界：**打印预览就是最终打印制品的唯一视觉真值源；预览看到什么，提交给打印机的 PDF/图片就是什么。**
> 本文档是纯代码审查 + 架构设计，**不含任何代码改动**。v2 已按用户终审收紧，作为本轮实现的总契约（frozen）。

---

## 〇、冻结边界（本轮最高优先级约束 · v2 定稿）

### 只允许修改（Merge Mode 闭环）
```
Merge Plan
  → renderMergeFinalArtifact()            ← 新增，Merge 专用封装
  → renderMultipleItemsToCanvas()         ← 共享、不动
  → FINAL CANVAS（唯一视觉真值）
       ├─→ Merge Print Preview（显示 Canvas + Guide overlay）
       └─→ Merge Print（Canvas → PNG → PDF → Sumatra）
```
对应 `merge2 / merge3 / merge4`。

### 明确禁止触碰（视为只读）
- 非合并打印：`renderFileToPrintImage()`、非 merge `processQueue`、单文件 PDF/OFD/image 打印、现有非 merge `PrintSpec`、非 merge 的 `isPrint` 行为 / Sumatra 参数 / margin / fit / rotation / PDF 生成链路。
- **公共 Renderer 语义**：`renderMultipleItemsToCanvas()` 算法与签名不得修改（Merge/Normal 共用，改它=连坐普通打印）。
- 现有 `PrintPreviewModel` / `PrintPreviewCanvas` 的**非 merge 消费**保持现状（含其内部 `previewPaperLayout` 本地实现——那是 Normal 预览的几何源，本轮不碰）。

### 硬约束 1 · Merge 模式彻底单源（v2 核心收紧）
> **`PrintPreviewModel` 不得再作为 Merge 模式的几何真值源。**

Merge 模式必须彻底变成：
```
一次生成 Final Artifact → 预览消费它 → 打印消费它
```
- Merge Preview **不再**走 `PrintPreviewModel`+缩略图自己算一遍 fit/slot/rotation；
- Merge Preview **直接消费** `renderMergeFinalArtifact()` 产出的 Final Canvas；
- Merge Print **消费同一个** Artifact，绝不重新调用 `renderMergeGroupToPrintImage()` 再渲染一次。
⇒ 几何 / fit / slot / rotation / margin 在 Merge 模式内**只算一次**，从根上消除"预览对、打印又重算一遍"的漂移。

### 硬约束 2 · Final Artifact 不得包含任何 UI Guide（v2 新增）
> **Final Artifact = 用户最终希望打印的像素内容。**

不得在 Final Canvas 中绘制 / 包含以下任何元素：
```
- 分割线（merge split line）
- 安全边距线（safe-margin guide）
- slot 边界线
- debug overlay
- 任何 Preview-only 标记
```
Guide 是 **UI 层（Preview overlay）** 职责，不是 Artifact 层职责。这样任何人看到 `renderMergeFinalArtifact()` 都明确：这是"最终制品生成器"，不是"预览画布生成器"。

（注：`render.worker.js:35-71` 当前 `slots.length>1` 无条件把分割线画进 Canvas，属确定性违规，必须在 Phase M2/M3 闭环内修掉——否则即使 Preview/Print 统一，Artifact 仍携带 UI 辅助元素。）

### 隔离要求（入口显式分叉）
```js
if (isMergeMode) { return renderMergeFinalArtifact(...) }   // 新 Merge 专用闭环
// ↓↓↓ 以下完全保持现状，Normal 不进入任何新代码 ↓↓↓
return existingNormalPrintPath(...)
```
**禁止**改 `renderMultipleItemsToCanvas` 让所有调用者跟着变；**禁止**把 Merge 新路径渗回 Normal 链路。

### 提交边界
- Commit A `98a865fb`（read-file ArrayBuffer 修复）：不动。
- 当前 P1-2（`main.js` `margins={left:0,right:0,top:0,bottom:0}`）：**暂不提交、暂不继续修**；待 Final Artifact 链路确定后判其命运（见 §六）。
- 探针（P0 / P1-1）：保留至验证通过后统一 Commit B。

---

## 一、现状代码实证（5 问，带文件:行）

### Q1 — `PrintPreviewModel` 目前算了哪些几何
纯几何描述模型（mm 单位），**不渲染像素**。算的几何：

| 几何 | 实现位置 | 说明 |
|---|---|---|
| 纸张 `paperRect` + `usableRect` | `previewPaperLayout` L80-109 | **本地重实现** `computePaperLayout`（注释自认"与 computePaperLayout 同构"），margins 内缩 |
| 方向 / needSwap | L186-206 | 用 `plan.paper`（已 needSwap 归一）或 fallback `page.orientation` 交换 |
| slot 等分 | `computeSlots`（共享）L220-223 | count/strategy/grid 由 `resolveMergeSpec(mergeMode)` 决定 |
| 内容 fit / rotation | `resolveContentPlacement`（RotationResolver，共享）L291-335 | 把 slot 当 mini-paper 喂入，产 `scale/offset/renderTransform` |
| 输出 | L225-383 | `pages[].slots[{x,y,width,height, placement.renderTransformMM, thumbnailUrl}]` |

关键：模型自己**重算了一套纸张几何**（`previewPaperLayout`），与打印用的 `computePaperLayout` 是两份独立维护的代码。

### Q2 — `PrintPreviewCanvas` 显示的实际 slot/content 是什么
`PrintPreviewCanvas.jsx` 渲染 SVG（viewBox=mm）：
- 纸 rect（L403）+ **安全边距虚线 overlay**（L405-417，纯 SVG，不进 canvas）；
- 每 slot `<image href={slot.thumbnailUrl}>` + `placement.renderTransformMM`（translate/scale/rotate）摆放（L108-151）。

`thumbnailUrl` 来自后端 `/thumbnail/{docId}` 或 `previewImage`（PrintPreviewModel L167-178）。
⇒ **预览"看到的内容" = 后端缩略图（可能低分辨率、不同栅格路径）经模型几何摆放**，不是 Print 的高分辨率真实栅格。

> v2 收紧：上述 Q1/Q2 描述的几何链，**对 Merge 模式不再作为真值源**（硬约束 1）。它是 Normal 模式的预览实现，本轮保持现状。

### Q3 — 哪部分已经可以直接复用为 Final Canvas（关键发现）
主窗口 merge 预览（`usePreview.js:860-876`）**已经**调 `renderMultipleItemsToCanvas`，传 `paperLayout`（V16 slotted path），产出几何与 Print 同源的真实高分辨率 Canvas。

⇒ **Final Canvas 早已存在且正确。** 漂移只发生在**打印确认弹窗**（`PrintPreviewModel` + 缩略图）这一处——它没用 Final Canvas，自己又算了一遍几何 + 用缩略图代替真实内容。

可直接复用（不改）：`renderMultipleItemsToCanvas`（共享渲染器）+ 其产出的 `canvas`。

### Q4 — `renderMultipleItemsToCanvas` 与 Preview 的 geometry 重复计算
- **共享**：`computeSlots`（slot 等分）、`RotationResolver`/`resolveContentPlacement`（内容 fit/rotation）——Preview 模型与 Print 都调用。
- **分叉（漂移根）**：
  1. 纸张几何：`previewPaperLayout`（本地重实现，L80-109）vs 打印 `computePaperLayout`（`previewState.js`）——两份独立维护，注释靠"同构"自证，无编译期约束；
  2. 内容源：Print = 真实栅格（`read-file`/`previewImage`）走 `MultiTicketComposer`+`createPlacement`；Preview = 缩略图 + 模型几何（不重渲染内容）。
- 即"几何派生点"部分共享，但**纸张几何两套实现 + 内容渲染两套来源** → 预览与打印可漂移。

### Q5 — 如何把 Preview 最终视觉变成唯一 Final Canvas
Merge 模式建立闭环：**只算一次**（硬约束 1）。
```
Merge Plan
 → renderMergeFinalArtifact(group)        // 调共享 renderMultipleItemsToCanvas 一次
 → Final Canvas
    ├─→ Preview：显示该 Canvas（降采样 <img> 或复用 canvas）+ Guide overlay
    └─→ Print：该 Canvas → PNG → PDF → Sumatra
```
Preview 不再走 `PrintPreviewModel`+缩略图；公共 renderer 语义零改动；非 merge 路径保留原样。

---

## 二、目标架构（Merge 专用闭环 · v2 定稿图）

```
                    Merge Plan
                       │
                       ▼
             renderMergeFinalArtifact()
                       │
                       ▼
          renderMultipleItemsToCanvas()        ← 共享、不改
                       │
                       ▼
                 FINAL CANVAS
              （唯一视觉真值 · 含纯打印内容，无 Guide）
                  │                │
             ┌────┘                └────┐
             ▼                         ▼
       Print Preview                Print
             │                         │
       + Guide Overlay                PNG
       (safe-margin /                   │
        split-line /                    ▼
        slot-boundary)                 PDF
             │                         │
             ▼                         ▼
        用户看到的图                 Sumatra

   Guide Overlay ↑ 只存在于 Preview UI，绝不进入 Final Canvas / 打印制品
```

几何 / fit / slot / rotation / margin **只算一次**（在 `renderMergeFinalArtifact` 内通过共享 renderer 单次产出）。

### 辅助线边界（干净语义 · 硬约束 2）
```
Final Canvas   = invoice content + fit + margin + rotation
Preview UI     = Final Canvas + Guide Overlay(safe-margin / split-line / slot-boundary)
Print Export   = Final Canvas（绝不含任何 Guide）
```
即：**预览界面可显示辅助线；最终打印图片/PDF 绝不含辅助线。**

---

## 三、实施草案（Phase M1 → M2 → M3 · 待授权再写代码）

> 原则：**先建立单源 Artifact，再让 Preview/Print 消费它；公共 renderer 不动；每步独立小提交 + Normal Print Regression Gate。**

### Phase M1 — 建立 Merge Final Artifact（只新增封装）✅ 已完成（2026-08-14）
- 新增 `frontend/src/print/mergeFinalArtifact.js` → 导出 `renderMergeFinalArtifact(validItems, opts)`：
  - 签名：`renderMergeFinalArtifact(validItems, { paperSize, dpi=PREVIEW_DPI, forcedLandscape, fileRotations, groupSize, paperLayout, layoutOptions, showSafeMargin=false, isPrint=false })`。
  - 内部**只调一次** `renderMultipleItemsToCanvas(validItems, paperSize, dpi, forcedLandscape, fileRotations, groupSize, isPrint, showSafeMargin, layoutOptions, paperLayout)` —— 与现 `renderMergeGroupToPrintImage` 既有调用**完全等价**（同参数、同 `isPrint=false`/`showSafeMargin=false`）。
  - 返回 `{ canvas, dataURL }`（`canvas.toDataURL('image/png')`）。共享 renderer 内部已有 L2 缓存，`renderMultipleItemsToCanvas` 相同参数直接命中 → 天然保证「Merge 内几何只算一次」。
- **公共 renderer 零改动**：未修改 `renderMultipleItemsToCanvas` 签名/算法（硬边界守住）。
- `frontend/src/hooks/usePrint.js` 的 `renderMergeGroupToPrintImage` 已**内部委托**该封装（移除内联的 `getPrintRenderers()`+`renderMultipleItemsToCanvas` 调用，改为 `await renderMergeFinalArtifact(...)`，取 `artifact.canvas` 继续 `toBlob` → `_pngBytes`，返回 shape 完全不变）。项加载仍在调用方，符合 M1 范围。
- 语法校验：`node --check` 两文件均通过。
- **验收结论**：M1 为纯封装/委托，行为零变化；打印路径输出与改造前逐字节一致（共享 renderer L2 缓存命中同一 canvas）。下一步进入 Phase M2。

### Phase M2 — Merge 打印预览改为直接消费 Final Artifact（核心）
- 打印确认弹窗的 **merge 分支**改为消费 `renderMergeFinalArtifact()` 产出的 Final Canvas（`<img src={dataURL}>` 或复用同一 canvas 节点）。
- **彻底停止** merge 分支走 `PrintPreviewModel`+缩略图自算几何（硬约束 1）——Merge 预览的票据位置/缩放/旋转完全由 Final Canvas 决定。
- 安全边距线 / 分割线 / slot 边界作为 **SVG/overlay** 叠加在 Final Canvas 之上显示，不写进 canvas（硬约束 2）。
- 非 merge 弹窗预览**保持** `PrintPreviewModel`+`PrintPreviewCanvas` 现状。

### Phase M2 — 代码取证（2026-08-14，仅审查未改代码）

**① Merge 打印确认弹窗入口（entry point）**
- `PrintConfirmModal.jsx:381-390` 渲染 `<PrintPreviewCanvas preview={previewModel} grayscale marginSettings={...}/>`。
- `previewModel` = `usePrint.js:591-610` 的 `printPreviewModel`（useMemo → `buildPrintPreviewModel(plan, {files, settings, currentSelection, backendUrl})`）。
- `buildPrintPreviewModel`（`PrintPreviewModel.js:126`）即 Merge 预览当前几何真值源：内部 `previewPaperLayout`（L80-109 **本地重实现** computePaperLayout）+ 共享 `computeSlots`（L220）+ 共享 `resolveContentPlacement`（L291）；每个 slot 经 `getThumbnailUrl(f,0,userRotation)`（L372）取**后端缩略图**代替真实栅格。
- ⇒ Merge 确认弹窗当前确实走 `PrintPreviewModel` 第二套几何 + 缩略图，正是 M2 要消灭的"Merge 预览第二套几何"。主窗口预览（`usePreview.js:860-876` 已调 `renderMultipleItemsToCanvas`）不受影响。

**② Final Artifact 生命周期（当前）**
- `renderMergeFinalArtifact` **唯一调用点** = `renderMergeGroupToPrintImage`（`usePrint.js:493`），后者仅在 `processQueue`（`usePrint.js:785`）**打印执行时**被调用。
- ⇒ artifact 现在**只存在于打印函数内部作用域**，不进任何 state、不暴露给 modal/preview。
- 返回形态（`mergeFinalArtifact.js:37-70`）：`{ canvas, dataURL }`（`canvas.toDataURL('image/png')`）。`dataURL` 可直接给 `<img>`。

**③ Merge 预览当前需要的 UI 数据：Artifact vs Metadata 二分**
`PrintPreviewCanvas.jsx:335-438` 实际消费：
- **来自 Artifact（M2 后由 Final Canvas 像素取代，不再自算）**：`page.slots[]` 的 `thumbnailUrl` + `renderTransformMM`/placement（L421 → SlotImage 用缩略图 + SVG transform 画发票）。
- **UI Metadata（可保留，不属于几何）**：
  - `preview.valid` / `preview.reason`（L339/366 无效占位）
  - `page.paperSizeMM.{widthMM,heightMM}`（L382 → SVG viewBox，可改由 `settings.paperSize`+landscape 直接派生，不依赖 artifact）
  - `preview.currentPageIndex`（L349 初始翻页）
  - `total`（page count，merge 恒 1 页）
  - 安全边距线（L405-417 SVG overlay，由 `marginSettings` 驱动，**非 artifact**）
  - 页码导航 `PreviewPageNav`（L427）
- ⇒ M2 后 Merge 弹窗 = `<img src={artifact.dataURL}>`（含 fit/rotation/margin 已烤进像素） + 纸张比例容器（宽高来自 settings） + safe-margin overlay（来自 marginSettings） + 1/1 导航；几何零重算。

**④ Preview 用 `<img>` 还是复用 Canvas**
- `renderMergeFinalArtifact` 已返回 `dataURL` → 推荐 **`dataURL`/`Blob URL` + `<img>`**：预览仅展示像素，不需操作 Canvas DOM；规避 React/Canvas 所有权纠缠。
- 若需叠加 guides：相对定位容器包 `<img>` + 绝对定位 SVG overlay（按纸张宽高比缩放），safe-margin 线叠加其上，不进 img 像素。

**M2 静态 Gate 预判（待实施时逐一核对）**
- Gate M2-A：Merge 预览不再以 `buildPrintPreviewModel`/`resolveContentPlacement`/`computeSlots`/`thumbnailUrl` 为几何源 → 需在 `PrintConfirmModal` 对 merge 分支短路该消费，改走 artifact。
- Gate M2-B：Merge 预览图片源 = `renderMergeFinalArtifact()` 的 `dataURL`。
- Gate M2-C：Normal Preview（`PrintPreviewModel`+`PrintPreviewCanvas`）零 diff → merge 用新 path；`PrintPreviewModel.js`/`PrintPreviewCanvas.jsx` 文件本身可仅加"若存在 artifactURL 则渲染 img"的非 merge 分支（非 merge 永远走旧 path），不引入 merge 逻辑。
- Gate M2-D：`renderMultipleItemsToCanvas` 零 diff（M2 不触碰）。
- Gate M2-E：Final Artifact 不含 UI Guide → `renderMergeFinalArtifact` 已满足（`isPrint=false`/`showSafeMargin=false`；分割线来自 worker 无条件绘制，属 Gate B，M2 不混入）。

**M2 接线决策（用户已锁定 · 2026-08-14）**
- 生成时机：Merge 打印确认预览**打开时**生成 artifact（非打印时），存入 `usePrint` 的 Merge-only state `mergeArtifacts`，**不进公共 `printPreviewModel`**。
- 项加载：`loadMergePrintItems()` = Merge-only helper（从 `renderMergeGroupToPrintImage` 抽取，行为/IO 1:1 等价），仅服务 Merge，Normal 不调用。
- modal 改法：**采用 (a)** —— 新增 `MergeFinalArtifactPreview.jsx` 专消费 artifact；Normal 继续走 `PrintPreviewCanvas` 不改。否决 (b)（不在公共组件加 `artifactURL` 分支）。

### Phase M2-1 — 抽 `loadMergePrintItems()` ✅ 已完成（2026-08-14）
- `frontend/src/print/mergeFinalArtifact.js` 新增 `export async function loadMergePrintItems(group, ipc)`：从 `renderMergeGroupToPrintImage` 内联加载块 1:1 抽取（pdf/ofd/image → `_pdfData`/`_previewImageUrl`），返回 `{ validItems, blobUrls }`。仅服务 Merge。
- `usePrint.js` 的 `renderMergeGroupToPrintImage` 改为 `await loadMergePrintItems(group, ipc)` 委托，移除内联加载；`localBlobUrls`→`blobUrls` 改名，finally 仍回收。
- 验证：语法 `node --check` 通过；diff 仅 `usePrint.js`（委托+导入）+ 新增 `mergeFinalArtifact.js`；Normal Regression Gate（`PrintPreviewModel.js`/`PrintPreviewCanvas.jsx`/`renderers.js`/`pdf_tool.py` 全 0 diff）；公共 renderer 零改动；`getPrintRenderers` 仍被 Normal 路径使用非死代码。未提交。

### Phase M2-2 — 建立 Merge Artifact 生命周期 ✅ 已完成（2026-08-14）
- `usePrint.js` 新增 Merge-only state `mergeArtifacts`（默认 null，Normal 恒 null）+ `prepareMergeArtifacts()`：
  - 仅当 `isMergeMode(settings.mergeMode)` 时执行；用 `createPrintPlanInput`→`buildPrintExecutionPlan`→`deriveMergePrintJobs` 派生 merge 组；逐组 `loadMergePrintItems`+`renderMergeFinalArtifact`（参数与 M1/打印路径一致）→ 存 `{key, artifact}` 数组。
  - 加载产生的 blob URL 在渲染完成后立即 `URL.revokeObjectURL` 回收（canvas 已栅格化，无需保留）。
- `handlePrintShowConfirm` 改为 async：merge 模式下 `await prepareMergeArtifacts()` 后再 `setPrintConfirmModal(true)`，避免预览首帧空白。
- `usePrint` 返回值新增 `mergeArtifacts` 暴露给 `PrintConfirmModal`（M2-4 消费）。
- 验证：语法通过；diff 仅 `usePrint.js`（state+函数+return 字段+handlePrintShowConfirm 改 async）；冻结文件 0 diff；Normal 路径零改动。未提交。
- **未做**：M2-3（`MergeFinalArtifactPreview` 组件）、M2-4（`PrintConfirmModal` merge 分叉）待用户授权进入。

### Phase M3 — Merge Print 改为消费同一个 Artifact（比 Preview 更关键）
- 同一 job 生命周期内：
  ```js
  const artifact = await renderMergeFinalArtifact(...)   // 只算一次
  previewArtifact = artifact
  printArtifact   = artifact
  ```
- 打印只负责 `Canvas → PNG → PDF → Sumatra`，**绝不重新计算 slot / fit / rotation**，不再二次调用 `renderMergeGroupToPrintImage()`。
- 至此真正满足：**Preview = Print Artifact**。

### Gate B 并入闭环（实施中不可遗漏）
- 分割线属 Preview guide，从 Final Canvas 绘制逻辑移除（`render.worker.js:35-71` 的 `slots.length>1` 无条件画线）。
- 引入 `showGuides` 语义参数：`Preview → true` / `Print → false`（非 `if(isPrint)` 分支，避免把"打印"与"显示辅助线"绑定）。
- 安全边距线（SVG overlay）本就不进 canvas，维持；若实际打印件出现该线，须经 P1 取证确认是哪条，不盲目改 safe-margin 渲染。

---

## 四、Normal Print 隔离边界（v2 硬化）

```
                 doPrint()
                    │
          ┌─────────┴─────────┐
          │                   │
      Merge Mode          Normal Mode
          │                   │
          ▼                   ▼
 Merge Final Artifact    原有打印链路
          │                   │
          ▼                   ▼
 Preview + Print         Preview + Print
```

**Normal Mode 不进入任何新的 Final Artifact 代码。** 明确冻结清单：
- `renderFileToPrintImage()` 不动
- normal `processQueue` 不动
- normal `PrintSpec` 不动
- normal Sumatra 参数不动
- normal PDF 链路不动
- `renderMultipleItemsToCanvas()` 不动
- 非 Merge 的 `PrintPreviewModel` / `PrintPreviewCanvas` 不动

这满足：**不能修好 Merge 又把 Normal 搞坏。**

### Normal Print Regression Gate（提交前反向保护）
代码级确认普通打印未被连坐：
- 非 merge 文件**不进入**新 Merge Renderer（`isMergeMode` 分支之外零调用）；
- 非 merge `renderFileToPrintImage` **无 diff**；
- 非 merge `PrintPreviewModel` / `PrintPreviewCanvas` **无 diff**；
- 非 merge `PrintSpec` / PDF / Sumatra 参数 **无 diff**；
- `renderMultipleItemsToCanvas` 签名与算法 **无 diff**；
- 新增仅限 Merge 专用文件/分支 + Gate B 的 `showGuides` 参数。
验收手段：提交前 `git diff` 仅含 Merge 专用新增 + 必要 Guide 参数；附现有 merge 测试 + 普通打印冒烟清单。

---

## 五、与既有审计的关系（避免重复造轮子）

- `print_preview_simulator_freeze_2026-08-03.md` 已把"PrintPreviewModel = PrintSpec / 预览即打印"定为契约 —— 本设计是其 Merge 落地。
- `COMPOSE_ARCHITECTURE_REVIEW_V2.md:17` 已确认 Preview/Print 几何派生点同工厂 —— 与 Q3/Q4 一致。
- `print_chain_review_2026-08-03.md:26` 已断言"定义单一 PrintSpec 前 Preview 必自创 fit → 漂移" —— 本设计用"Merge Preview 直接显示 Final Canvas"消除该自创。
- 不扩大为整个 Print Architecture 重构（用户定稿：仅解决 Merge Mode 的 Preview=Print Artifact）。

---

## 六、P1-2 处置（暂挂 · v2 维持）

`main.js` 当前 `margins={left:0,...,bottom:0}` **暂不提交、暂不继续修**。
理由：若 Final Artifact 架构落地，PDF 层应退化成"Canvas 物理尺寸 = PDF 页"，`pdf_tool.py` 的 margin 外扩本就不该发生；届时 P1-2 那行是否还需要，待 Final Artifact 确定后一起判定（避免先提交一个"治标"再回退）。
P0 根因已修（Commit A），不影响本设计推进。

---

## 七、下一步（待用户授权后按序实施）

1. **Phase M1**：新增 `renderMergeFinalArtifact()` 封装（仅 merge 调用，调共享 renderer 一次），不碰公共 renderer；
2. **Phase M2**：Merge 打印预览改消费 Final Artifact，停止走 `PrintPreviewModel` 自算几何；
3. **Phase M3**：Merge Print 消费同一 Artifact，移除二次渲染；
4. **Gate B**：分割线从 Final Canvas 剥离，引入 `showGuides`；
5. 每步独立小提交 + Normal Print Regression Gate；
6. 全部闭环后，**才进行一次** merge2/merge3/merge4 完整验收（架构验收，而非试错）；
7. 最后再判 P1-2 `margins=0` 是否保留。

> 测试策略转变：**从"不断试错"变为"架构验收"**——先完成代码架构闭环，再一次性验证。
