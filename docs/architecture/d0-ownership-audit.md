# D0 Ownership Topology Audit

> D 阶段第一提交：`docs(audit): D0 ownership topology audit`
> 本文件为**只读拓扑审计**，无代码 / 测试变更。
> 目标：回答「还有哪些地方没接入 `RenderCommand`」，不再重新证明 C 阶段所有权公理（C1–C4 为既成事实）。
> 纪律：轻量化（不考古），但保留拓扑确认（D0 重点从「架构是否正确」转为「谁还没接入」）。

## 准入确认

- C 阶段已封板：`HEAD=73187379`，C1 Geometry / C2 contentRect / C3-1 mergeFactory / C3-2 executor 为既成事实。
- 无 D 启动阻塞：geometry ownership 已冻结、`RenderCommand` 契约稳定、`executor` 已统一（`drawRenderCommand`）、merge/export 方向明确。
- 本审计按冻结纪律执行：仅拓扑确认，不考古、不改代码、不清理、不优化 fit、不删 legacy。

## Q1 — 哪些绘制路径没经过 `RenderCommand → drawRenderCommand`？

| 路径 | geometry owner (生产者) | executor | 是否经过 RenderCommand |
|---|---|---|---|
| Preview(merge/compose) | `_buildComposeCommands`（renderers.js:762，用 `createPlacement`） | `drawRenderCommand` | ✅ |
| Preview(单文件 canvas) | `switchPreviewFile` / `switchPreviewImage`（renderers.js:1387 / 1419 / 1430） | 原生 `ctx.drawImage` | ❌ |
| Preview(RE/V17) | `buildRenderCommand`（RenderLayoutFactory.js:111） | RE 后端按 spec 出图（`buildRenderSpec`，renderSpec.js:137） | ✅（RenderCommand 经 URL 传给 RE） |
| Print(全部子路径) | `renderMultipleItemsToCanvas` → `_renderDirect`/`_renderViaWorker` → `_buildComposeCommand` | `drawRenderCommand` | ✅（renderModel 层是包装，叶子执行者共享） |
| Export(PDF) | 后端 `/api/export-pdf`（useExport.js:231） | 后端 Python 重渲染 | ❌（完全脱离前端 RenderCommand） |

**结论**：未接入 `RenderCommand` 的两条路径 = **单文件 canvas 预览** + **Export(PDF)**。

## Q2 — 三条业务路径当前位置

- **Preview**：`hooks/usePreview.js`。分支（L745）：`isMerge || isImageOrOfd || previewFile._pdfData` → canvas 分支；其中 `isMerge` → `renderMultipleItemsToCanvas`（✅），单文件 → `getGlobalPreviewCanvas` + `switchPreviewFile`/`switchPreviewImage`（❌）。另 RE 路径用 `buildRenderCommand` → `buildRenderSpec` → URL → `<img>`（✅）。
- **Print**：`hooks/usePrint.js` → `renderMultipleItemsToCanvas`（含 `renderModel` 包装层：buildRenderModel→renderPrintContent→renderMultipleItemsToCanvas）。最终 `_renderDirect` → `drawRenderCommand`（✅）。
- **Export**：`hooks/useExport.js` → `fetch(/api/export-pdf)` → 后端。前端无任何 `RenderCommand` 参与（❌）。

## Q3 — 现存 raw canvas operation 与归属判定（triage）

> 纪律：在 Renderer 出现 `drawImage/translate/rotate` 时，默认先判「属于 `RenderCommand→Executor` 内部，还是 Renderer 自推几何？」

- 🔴 `renderers.js:1387` `ctx.drawImage(bitmap, offsetX, offsetY, ...)`（`switchPreviewFile`）：Renderer 内联算 `scale`/`offset`/`rotation`（L1357–1361 含 fit+居中）。**Leakage（Renderer 自推几何）**。
- 🔴 `renderers.js:1419 / 1430` `ctx.drawImage` + `:1426 ctx.translate` + `:1427 ctx.rotate`（`switchPreviewImage`）：**Renderer 自推几何**。**Leakage**。
- ✅ `renderers.js:697` `ctx.drawImage(bitmap, 0, 0)`（Worker 结果回写 L2 缓存）：仅 bitmap→canvas 拷贝，无几何推导。合法（source cache blit）。
- ⚠️ `renderers.js:528` `ctx.translate`（`renderPDFPageRaw`）：pdf.js 光栅到源位图，属 source rasterization（Worker item 预取路径），非 compose 几何。非泄漏，但留在 renderers 内，D4 观察项。
- ✅ `PreviewCanvas.jsx:59` `ctx.drawImage(previewCanvas, 0, 0)`：仅把已渲染全局 canvas blit 到 DOM canvas，无几何推导。合法（display adapter）。
- ⚠️ `canvasUtils.rotateContentOnPaper`（L127 含 translate/rotate/drawImage）：内容级旋转工具；`renderers.js`/`usePrint.js` 已 import 但 grep 无调用点（疑似 dead）。D4 清理候选。

## Q4 — Export 当前缺口与最小接入点

- **现状**：Export(PDF) 完全由后端 `/api/export-pdf` 重渲染并合并，前端 `RenderCommand` 不参与。
- **关键事实**：生产级 `RenderCommand` 生产者 `mergeFactory.buildMergeRenderCommands`（C3-1 产出）当前**仅 test 引用、无 production caller**（grep 确认：仅 `mergeFactory.js` 定义 + `mergeFactory.test.js` 引用）。生产预览实际走 `renderers.js` 内的 `_buildComposeCommand`（L733/762/860/1123），同样用 `createPlacement`。
- **最小接入点（D3 待定，本审计只定位）**：让 Export 复用前端的 `RenderCommand → drawRenderCommand` 渲染结果（与 Print 同画布），而非后端重渲染；或至少让 `buildMergeRenderCommands` 成为 Export 的生产 caller，使其 `clip === slot.contentRect`（C1/C4）。具体接线方式在 D3 实施前再 freeze boundary（遵守 backlog 红线：不得为 Export 另写一套 geometry）。

## Q5 — D1 边界（Preview 统一）

目标：单文件 canvas 预览也走 `RenderCommand → drawRenderCommand`，消灭 `switchPreview*` 内联几何。

建议拆子项（每子项一个 ownership 变化 + 一个验证目标 + 一个 atomic commit）：

- **D1-1** 单文件 preview command 创建改走 `createPlacement` / `_buildComposeCommand`（与 merge 同源），不再在 `switchPreview*` 内联算 `scale`/`offset`/`rotation`。
  touch：`renderers.js`（`switchPreviewFile`/`switchPreviewImage`）、`usePreview.js`（单文件分支）。
- **D1-2** 用 `drawRenderCommand(ctx, cmd, source)` 替换 `switchPreview*` 内原生 `ctx.drawImage`；保留 `drawSeparators` 语义（layout 装饰）。
  touch：`renderers.js`。
- **D1-3** 清理：单文件全局 canvas 旧桥接代码、`PreviewCanvas.jsx` blit 适配校验（确认只做 display，无几何）。
  touch：`renderers.js` / `PreviewCanvas.jsx`。

（D1 红线：不重写 preview 生命周期、不把 compose placement 泄漏进 preview —— 遵守 backlog。）

## Current State（拓扑汇总）

```
source
  → consumer
    → geometry owner
      → executor

Preview(merge) : usePreview → _buildComposeCommands(createPlacement) → drawRenderCommand   ✅
Preview(single): usePreview → switchPreview* (inline geometry)        → ctx.drawImage       ❌
Preview(RE)    : usePreview → buildRenderCommand → buildRenderSpec(URL)→ RE backend          ✅
Print          : usePrint   → renderMultipleItemsToCanvas → drawRenderCommand                ✅
Export(PDF)    : useExport  → /api/export-pdf (backend)               → (no RenderCommand)  ❌
```

## Ownership Leakage（清单）

1. 🔴 `renderers.js:1387, 1419, 1430` — 单文件预览 Renderer 自算 fit/rotation + 原生 `ctx.drawImage`（D1 消除）。
2. 🔴 `useExport.js` + 后端 `/api/export-pdf` — Export 脱离前端 `RenderCommand`（D3 接入）。
3. ⚠️ `renderers.js:528` `renderPDFPageRaw` — source rasterization 留在 renderers（D4 观察）。
4. ⚠️ `canvasUtils.rotateContentOnPaper` — 疑似 dead import（D4 清理）。

## Target Ownership

```
Layout    owns geometry
Placement owns transform      (createPlacement 唯一几何来源)
Executor  owns pixels         (drawRenderCommand 唯一执行者)
Renderer  consumes only       (不再自推 fit/margin/rotation/dpi)
```

D1/D3 后：Preview(single) 与 Export 也进入 `RenderCommand → drawRenderCommand`，三路共享 executor，达成 Preview ≡ Export ≡ Print。

## Migration Boundary

**touch**：

- `frontend/src/renderers.js`（`switchPreviewFile` / `switchPreviewImage` / `_buildComposeCommand` 区域）
- `frontend/src/hooks/usePreview.js`（单文件分支）
- `frontend/src/components/PreviewCanvas.jsx`（blit 适配校验）
- `frontend/src/hooks/useExport.js` + 后端 export（D3，接线方式待 freeze）

**do not touch**（D0 阶段）：

- `layout.js` 的 `calculateFitScale` / `calculateCenteredPosition`（D2 范畴，后置）
- `mergeFactory.buildMergeRenderCommands` 的契约本身（D3 只接 caller，不改几何）
- `drawSeparators`（layout 装饰，保留）
- 任何 C 阶段已封板的所有权链（C1–C4）

## No-regression Contract

- **Preview output == Export output == Print geometry**：三条路径最终像素几何必须一致（`clip === slot.contentRect`，C1/C4）。
- 单文件预览迁移后，视觉输出（缩放 / 居中 / 旋转）与现状像素级等价，不得引入 fit/rotation 差异。
- D1/D3 每步通过：几何链路测试（composeSlotRasterContract + composePlacement + mergeFactory）绿 + `vite build` 绿。
- 不触碰后端 export 既有的合并 / 分页行为（D3 仅换前端渲染来源，不改后端输出契约）。

## 压缩验证记录

- D0 仅拓扑确认，无代码 / 测试变更。
- 未发现需回 C 修复的事项。
- 下一步：D1-1（按上述边界开工，先 freeze D1 boundary 再改）。
