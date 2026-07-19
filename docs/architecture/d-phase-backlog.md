# D 阶段 Backlog（FROZEN，2026-07-19）

> 状态：**规划冻结，未实现。** C 阶段（Compose 几何与执行所有权收敛，见 `v16-architecture-target.md` 第十二节）已封板。本文件仅记录 D 阶段待办范围与红线，不展开实现。进入任一 D 子项前必须先做 **ownership audit**（与 C 阶段纪律一致：先冻结事实，再迁移 ownership）。

## 入口约束（继承 C 阶段）
- 每一步只改变 ownership，不改变行为。
- 每子项独立 commit，不 squash 前序。
- 实施前先做只读 audit，确认事实再动手。
- C 阶段几何/执行所有权链（C1–C4）为既成事实，D 阶段不得破坏。
- 验收：几何链路测试（composeSlotRasterContract + composePlacement + mergeFactory）绿 + `vite build` 绿。

## D1 — Preview Render Path Consolidation
- **范围**：`usePreview.js` 单文件预览（pdf/image）仍走旧 direct path，与 compose 的 `RenderCommand → drawRenderCommand` 是两套系统。
- **目标**：单文件预览也产出 `RenderCommand` 并交由 `drawRenderCommand`（或统一由 PreviewService / DocumentEngine 接管）。
- **红线**：不把 compose 几何/placement 逻辑泄漏进 preview；不重写 preview 生命周期。
- **注**：原称 C3-3，因已超出 compose ownership 范畴，重定位于 D。

## D2 — Fit Primitive Consolidation
- **现状**：`calculateFitScale` + `calculateCenteredPosition`（layout.js）与 `createPlacement`（compose/composePlacement.js）公式等价、无 live divergence，但双实现。
- **目标**：收敛为唯一 `fitIntoRect`（或让 `createPlacement` 委托 `calculateFitScale`），消灭第二套 fit 数学。
- **红线**：数学必须等价（D2 是优化非修复，禁止引入视觉变化）；C2 raster contract test 须仍绿。
- **注**：原称 C3-4，延期至 D（属架构优化，非 ownership 修复）。

## D3 — Export Pipeline Connection
- **范围**：将 `mergeFactory.buildMergeRenderCommands` 接入真实 Export 路径（目前 mergeFactory 仅 test 引用，无 production caller）。
- **目标**：Export 与 Preview/Print 共用 `slot.contentRect → createPlacement → RenderCommand → drawRenderCommand`，达成 Preview ≡ Export。
- **红线**：Export 的 `clip` 必须 `=== slot.contentRect`（C1/C4）；不得为 Export 另写一套 geometry。

## D4 — Legacy Renderer Removal
- **范围**：删除旧 `layout.js` 中 compose 前的 legacy 分区 / 单文件 preview 的 direct draw 路径（在 D1/D2/D3 完成后）。
- **目标**：renderer 仅保留「生成 RenderCommand + 委托 drawRenderCommand」。
- **红线**：删除前确认无 production caller 依赖旧路径；保留 `drawSeparators`（Layout decoration）。

## 提交链预期（规划）
```
... C3-2 (578ac5a2) 封板
D1  preview render path consolidation
D2  fit primitive consolidation
D3  export pipeline connection
D4  legacy renderer removal
```

## 验收纪律（每子项）
1. audit 报告（只读，落 `docs/architecture/` 或 `.workbuddy/`）
2. 实施（严格范围）
3. 几何链路测试（rasterContract + placement + mergeFactory）绿
4. `vite build` 绿
5. 独立 commit（不 squash 前序）
