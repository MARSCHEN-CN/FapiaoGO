# D2-0 Preview Fit Ownership Audit（只读，不改代码）

- **日期**：2026-07-19
- **阶段**：D2-0（read-only topology audit），为 D2-1 收敛铺路
- **目标**：找出所有"不是 RenderCommand / createPlacement 却能决定图片落点"的代码
- **结论**：用户的怀疑成立，但有重要修正 —— **Preview 已经在 RenderCommand 契约上，但它消费的 RenderCommand 由第二套 fit 函数（`calculateFitScale`）产出，而非 `createPlacement`**。两路数学今天等价，但代码独立 = 双源头风险，正是 D2 要消的 ownership 泄漏。

---

## TL;DR

| 项 | 状态 |
|----|------|
| Preview 是否在 RenderCommand 契约上 | ✅ 是（`usePreview` 消费 `buildRenderCommand` 的 `placement`） |
| Preview 落点是否由 `createPlacement` 算出 | ❌ 否，单文件预览 metadata/RE-URL 走 `calculateFitScale` |
| `calculateFitScale` 与 `createPlacement` 数学是否等价 | ✅ 今天等价（contain + 中心偏移，旋转/非旋转均一致） |
| 是否存在双几何源 | 🔴 是：单文件预览 = `calculateFitScale`（metadata）+ `createPlacement`（Canvas 像素）两份独立实现 |
| PDF 单文件是否有额外 fit | 🟡 是：`renderPDFPageRaw` 自算 PDF→纸张采样 fit（非落点泄漏，但属第二处 `Math.min`） |
| 视口 fit（paper→screen） | ✅ 合法：PreviewCanvas.jsx / usePreview 的 `paperScale` 属 ViewportTransform，不在泄漏范围 |
| 死 fit 代码 | 💭 `calculateRotatedBounds`、`rotateContentOnPaper` 零调用；D4 清理候选 |

---

## 1. 设计意图 vs 实际

### 1.1 设计意图（文档声明）

`compose/composePlacement.js` 的 `createPlacement` 是**声明的唯一几何 owner**，被以下路径共用：
- Compose 预览（Worker `_buildComposeCommands` → `createPlacement`）
- Print（`_renderDirect` → `_buildComposeCommand` → `createPlacement`）
- 单文件 Canvas 预览（`switchPreviewFile` / `switchPreviewImage` → `buildSingleFileRenderCommand` → `createPlacement`）
- Export（`exportRenderCommand` → `buildExportRenderCommands` / `buildSingleFileRenderCommand` → `createPlacement`）

`drawRenderCommand`（`layout/renderDraw.js`）是**唯一 executor**（Canvas + Worker）。

### 1.2 实际偏离

单文件预览存在**两条并行几何派生链**，最终都描述"内容在纸上的落点"，但实现不同：

```
usePreview
   └─ buildRenderCommand (RenderLayoutFactory.js)
        └─ calculateFitScale + calculateCenteredPosition   ← 第二套 fit（layout.js:145/155）
             ├─ 产出 placement → imageRect (on-screen 内容落点元数据)  usePreview.js:955-963
             ├─ 产出 paperLandscape + cache key             usePreview.js:1441-1442
             └─ 产出 RE URL spec (rotation/orientation)     usePreview.js:1498 (via buildRenderSpec)

switchPreviewFile / switchPreviewImage (renderers.js)
   └─ buildSingleFileRenderCommand → createPlacement        ← 第一套 fit（composePlacement.js:65）
        └─ 产出 Canvas 模式实际像素落点                      renderers.js:1389/1417 → drawRenderCommand
```

**D3 不变式"Preview≡Export 共用 RenderCommand 几何"今天成立，是因为两公式恰好相同** —— 但这是"运气/纪律巧合"，不是"单源"。任何对 `createPlacement`（Export/Print 修复）的改动都不会自动反映到 `calculateFitScale`，反之亦然。这正是 ownership 分裂。

---

## 2. 数学等价性核对（关键）

两套 fit 都是 "contain + 中心式偏移"，对 rotation ∈ {0,90,180,270} 逐字等价：

**`calculateFitScale` + `calculateCenteredPosition`** (layout.js)：
```js
fitScale = min(usableRect.w / rotatedBounds.width, usableRect.h / rotatedBounds.height)
offsetX = usableRect.x + (usableRect.w - rotatedBounds.width * fitScale) / 2
offsetY = usableRect.y + (usableRect.h - rotatedBounds.height * fitScale) / 2
// rotatedBounds = {width: natH, height: natW} 当 90/270 交换
```

**`createPlacement`** (composePlacement.js)：
```js
effectiveW = isRotated90 ? sourceHeight : sourceWidth   // 90/270 交换
effectiveH = isRotated90 ? sourceWidth : sourceHeight
scale = max(0, min(contentRect.w / effectiveW, contentRect.h / effectiveH))
offsetX = contentRect.x + (contentRect.w - effectiveW * scale) / 2
offsetY = contentRect.y + (contentRect.h - effectiveH * scale) / 2
```

| 情形 | calculateFitScale 输入 | createPlacement 输入 | 结果 |
|------|----------------------|---------------------|------|
| 0/180° | slot=usableRect, bounds={natW,natH} | contentRect=usableRect, sw=natW, sh=natH | ✅ 同 |
| 90/270° | bounds={natH,natW}（已交换） | effectiveW=sourceHeight=natH | ✅ 同 |

**唯一差异**：`createPlacement` 有 `Math.max(0, …)` 防御负 scale；`calculateFitScale` 无。输入恒为正，实践中不触发。

> ⚠️ 等价性前提：`usableRect`（buildRenderCommand 取 `paperLayout.usableRect`）与 `contentRect`（switchPreviewFile 取 `{x:marginL,y:marginT,width:contentW,height:contentH}`）必须是同一矩形。两者都从同一 margin 设置 + PREVIEW_DPI 推导，应一致，但**在 previewState.js 与 renderers.js 两处独立推导**，存在边距/取整漂移的可能（非 fit 函数本身问题，D2 收敛后自然消除）。

---

## 3. 次级 fit：`renderPDFPageRaw`（PDF 采样）

`renderers.js:521-527`：
```js
const scale = Math.min(canvasW / viewport.width, canvasH / viewport.height)
const offsetX = (canvasW - scaledViewport.width) / 2
const offsetY = (canvasH - scaledViewport.height) / 2
```
这是 **PDF→纸张光栅化的采样分辨率 fit**，不是落点 fit：下游 `createPlacement` 仍拥有落点。对单文件 PDF，可见落点 = `renderPDFPageRaw-fit ∘ createPlacement`（数学上等价于对 contentRect 单次 contain，但属双重计算）。

- **不影响 Export**：后端 PDF 走 `insert_pdf` 透传（矢量保全），无光栅化 fit。
- **风险**：渲染器内第二处 `Math.min` fit，若其 margin/DPI 逻辑与 `createPlacement` 漂移，Preview PDF 与 Export/Print 像素会不一致（仅 PDF 预览质量/对齐，非几何模型破坏）。
- **归类**：🟡 建议后续集中化（或明确标注"仅采样分辨率，非落点"），但**不阻塞 D2 收敛**，也不破 D3 不变式。

---

## 4. 合法视口 fit（非泄漏）

以下两处是 paper→screen 的 ViewportTransform（缩放/自适应显示），架构明确允许在 RenderCommand 之外：
- `PreviewCanvas.jsx:27` `scale = Math.min(availW/paperW, availH/paperH)` — 整纸 contain 到窗口
- `usePreview.js:942` `paperScaleBase = Math.min(availW/effW, availH/effH)` — 自适应缩放基线

两者都作用于"整张纸的显示尺寸"，不决定"内容在纸内的落点"，**不算 ownership 泄漏**。

---

## 5. 死 fit 代码（D4 候选，非活跃泄漏）

- `calculateRotatedBounds`（`layout.js:168`）—— 零调用者。
- `rotateContentOnPaper`（`canvasUtils.js:93`，自带 `Math.min` fit @ :121）—— 被 `usePrint.js:6`、`renderers.js:7` import，但**零调用点**（仅定义+import）。已被 `createPlacement → drawRenderCommand` 模型取代。
- `calculateFitScale` / `calculateCenteredPosition` —— D2-1 后只剩 `buildRenderCommand` 引用；收敛后可删。

---

## 6. 用户 D2-0 三问的答复

**Q1. `calculateFitScale` 所有调用点？**
仅一处：`RenderLayoutFactory.js:182-183`（在 `buildRenderCommand` 内）。`exportRenderCommand.js:14` 仅以"禁用"注释提及，非调用。

**Q2. 是否还有 `centerX/centerY/scale=min/contain/cover`？**
- 命名变量 `centerX/centerY`：无（居中内联为 `(w - scaledW)/2`）。
- `scale=min(…)` fit 全清单：
  - `calculateFitScale`（layout.js:149）— 单文件预览 metadata，🔴 第二源
  - `createPlacement`（composePlacement.js:76）— 主源，✅
  - `renderPDFPageRaw`（renderers.js:524）— 🟡 PDF 采样
  - `rotateContentOnPaper`（canvasUtils.js:121）— 死代码
  - `PreviewCanvas.jsx:27` / `usePreview.js:942` — ✅ 合法视口 fit
- `contain/cover`：仅 CSS `object-fit:contain`（合法）+ `calculateFitScale` 的 contain 语义；无 `cover` fit。

**Q3. Preview 最终消费 RenderCommand 还是 image+container+settings？**
- ✅ 消费 **RenderCommand**（`buildRenderCommand` 产物）。活跃路径不再由 `image+container+settings` 重算落点。
- ⚠️ 唯一例外：`usePreview.js:964-983` 的 `else` 分支仅在 `documentState` 未就绪（首帧/加载中）时回退旧 bitmap 拟合，**非稳态路径**，且 `renderCommandReady` 后即被门控跳过。
- **修正点**：Preview 的 RenderCommand 落点来自 `calculateFitScale`（旧 fit），不是 `createPlacement`（新 fit）。所以泄漏不是"Preview 绕过 RenderCommand"，而是"RenderCommand 的 placement 由第二套 fit 产出"。

---

## 7. D2-1 建议收敛（最小、additive，待审计通过后实施）

仅改 `RenderLayoutFactory.buildRenderCommand`（`RenderLayoutFactory.js:180-201`），把 placement 来源从 `calculateFitScale` 切换到 `createPlacement`，**保留 RenderCommand 其余字段不变**：

```js
// 旧（D2-1 前）：
const slot = { x: usableRect.x, y: usableRect.y, width: usableRect.w, height: usableRect.h }
const fitScale = calculateFitScale(slot, rotatedBounds)
const pos = calculateCenteredPosition(slot, rotatedBounds, fitScale)

// 新（D2-1 后）：单一几何源
const p = createPlacement({
  contentRect: usableRect,           // 已是 px，与旧 slot 同一矩形
  sourceWidth: natW,
  sourceHeight: natH,
  rotation: contentRotation,         // 90/270 交换由 createPlacement 内部处理
})
// 复用 p.scale / p.offsetX / p.offsetY / p.rotatedBounds / p.clip
```
- `buildRenderCommand` 仍组装完整 RenderCommand（`paper` / `paperRect` / `usableRect` / `paperLandscape` / `clip` 等字段不变），仅 placement 来源切换。
- `rotatedBounds`：`createPlacement` 已包含 90/270 交换（effectiveW/H），与旧 `rotatedBounds` 一致 ✅
- `clip`：`createPlacement` 返回 `contentRect`（= usableRect）= 旧 `clipRect`（同属安全区）✅
- import 改为 `import { createPlacement } from '../compose/composePlacement.js'`，删除 `calculateFitScale/calculateCenteredPosition` 引用。
- 收敛后 `createPlacement` 成为 **Preview(metadata+像素) / Compose / Print / Export / RE-URL** 的唯一几何 owner。

### D2-1 不应做（纪律红线，与用户确认一致）
- ❌ 不把 fit 移入 Canvas（不碰 `drawRenderCommand` / `renderDraw.js`）
- ❌ 不把 export 逻辑搬回前端（Export 仍走 D3 后端 `insert_pdf` / executor）
- ❌ 不给 RenderCommand 增字段（buildRenderCommand 输出形状不变，schema 冻结不变）
- ❌ 不引入 ViewportTransform 到 Export（`renderPDFPageRaw` 的 PDF 采样 fit 是 Preview-only，Export 透传不动）

### 验证计划
1. 新增"单源锁"测试：`buildRenderCommand(paperLayout, ds).placement` deep-equal `createPlacement({contentRect: usableRect, sourceWidth: natW, sourceHeight: natH, rotation}).placement`，覆盖 rotation 0/90/180/270（镜像现有 `singleFileRenderCommand.test.js:111` D1 同构锁）。
2. 回归：`RenderLayoutFactory.test.js` / `singleFileRenderCommand.test.js` / `composePlacement.test.js` / `exportRenderCommand.test.js` / `renderers` 测试。
3. 重跑 D3 same-sheet / export 测试，确认 Export 落点不受影响（Export 本就不经 buildRenderCommand）。
4. `createPlacement` 数学已冻结，D2-1 不引入新几何逻辑，仅路由——低风险。

---

## 8. 调用点地图（附录）

| 符号 | 位置 | 角色 | 归类 |
|------|------|------|------|
| `createPlacement` | compose/composePlacement.js:65 | 主几何源 | ✅ owner |
| `buildSingleFileRenderCommand` | layout/singleFileRenderCommand.js:54 | 单文件 → createPlacement | ✅ |
| `_buildComposeCommand` | renderers.js:739 | Compose/Print → createPlacement | ✅ |
| `exportRenderCommand` | layout/exportRenderCommand.js:78 | Export → createPlacement | ✅ |
| `mergeFactory` | layout/mergeFactory.js:88 | Merge → createPlacement | ✅ |
| `drawRenderCommand` | layout/renderDraw.js:24 | 唯一 executor | ✅ |
| `render.worker.js` | render.worker.js:33 | 纯执行（吃现成 command） | ✅ |
| `buildRenderCommand` | RenderLayoutFactory.js:111 | 单文件 Preview metadata/RE-URL | 🔴 用 calculateFitScale |
| `calculateFitScale` | layout.js:145 | 旧 fit | 🔴 第二源 |
| `calculateCenteredPosition` | layout.js:155 | 旧 居中 | 🔴 第二源 |
| `renderPDFPageRaw` | renderers.js:521-527 | PDF 采样 fit | 🟡 |
| `PreviewCanvas.jsx:27` | 视口 contain | 显示缩放 | ✅ 合法 |
| `usePreview.js:942` | 视口 adaptive | 显示缩放 | ✅ 合法 |
| `calculateRotatedBounds` | layout.js:168 | 死代码 | 💭 |
| `rotateContentOnPaper` | canvasUtils.js:93 | 死代码（零调用） | 💭 |
