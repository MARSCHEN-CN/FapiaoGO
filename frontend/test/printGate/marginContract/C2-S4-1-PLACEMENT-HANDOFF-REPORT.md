# C-2 Step 4-1 — Plan → source job → IPC Geometry Handoff

- 日期：2026-08-10
- commit：`a096d01`（已推送 GitHub `rotation-b1-hardening`）
- 状态：**COMPLETED** — 纯数据透传，零几何行为改变
- 范围：让 executor 有机会看到 Plan truth；**未做** Sumatra 消费/rotate/fit-noscale/PDF bake/Canvas-merge/DirectPrintHandler（Step 4-2 等 A3-V3）

---

## 1. 关键现状发现（S4-1-0 精确缺口）

**placement 数据链其实已通，但来源不是 Plan truth**：

```
现状：
placements useMemo（resolveContentPlacement 独立重算）⚠️ 再算一份
  ↓ L951
printSingleSourceFile → filePlacement = placements[f.key]
  ↓
buildPrintSettings → ps.placement → IPC

目标（Step 4-1）：
plan.slots[].placement（Plan truth，C-2 Step 1 已携带）
  ↓ deriveSourcePrintJobs 搬运
job.placement（同引用，不重算）
  ↓ usePrint 优先消费
printSingleSourceFile（f?.placement ?? placements 回退）
  ↓
buildPrintSettings → ps.placement + ps.executionPaper → IPC
```

**executor 应从 Plan 拿 geometry，而非独立重算**——这正是「authority handoff」的语义。

---

## 2. 交付内容

| 文件 | 改动 |
|---|---|
| `deriveSourcePrintJobs.js` | toJob 增加 `paper`（page.paper 同引用）+ `placement`（page.slots[0].placement 同引用）；注释明示「禁重新派生/计算」 |
| `usePrint.js` | printSingleSourceFile 优先 `f?.placement ?? placements[f.key]`（Plan truth 优先，placements state 回退）；透传 `executionPaper = f?.paper` |
| `PrintService.js` | printSingleSourceFile/buildPrintSettings 增加 `executionPaper` 参数；输出 `executionPaper` 独立字段（execution* 前缀 = Plan geometry，与用户 PrintSettings 生命周期分离） |
| `placementPreservationGuard.mjs`（新） | G-C2-S4：toJob 携带 placement/paper（handoff exists）✓ 禁重算 ✓ usePrint 优先消费 ✓ executionPaper 输出 ✓ |
| `placementHandoff.test.mjs`（新） | 6/6：同引用搬运 / paper 几何 / 横打 needSwap / executionPaper 契约 / resolvePaperSpec 一致性 |

---

## 3. 验收（零行为变化）

| 测试 | 结果 |
|---|---|
| placementHandoff | 6/6 |
| executionPlanPaperGeometry | 10/10 |
| buildPrintPreviewModel | 7/7 |
| normalizePrintSources | 15/15 |
| printSpecNormalize | 13/13 |
| paperOrientationFreezeGate | 全绿 |
| margin Gate phase1b | 9/9 GREEN |
| 四 guard（rotation/spec/shell/placement） | PASS |

---

## 4. 数据链最终形态（Step 4-1 后）

```
PrintExecutionPlan
  page.paper（needSwap 后物理纸几何）
  page.slots[].placement（resolveContentPlacement 输出）
       ↓ deriveSourcePrintJobs（同引用搬运）
job.paper / job.placement
       ↓ usePrint（f?.placement 优先）
printSingleSourceFile(f, ..., placement, executionPaper)
       ↓ PrintService.buildPrintSettings
ps.placement / ps.executionPaper（独立字段，不混入 userSettings）
       ↓ IPC 'print-source-file'
electron（⚠️ 尚不消费——Step 4-2 接线）
```

**Plan truth 已到达 executor 边界**。下一步（Step 4-2）决定「执行方式」：Sumatra 消费 placement（PDF bake / noscale）——**依赖 A3-V3 裁决**。

---

## 5. 冻结边界（延续）

- ✅ 不动：RotationResolver / PrintExecutionPlan schema / paper orientation / Sumatra command authority / Canvas-merge / DirectPrintHandler
- ⏸ 待 A3-V3：Step 4-2（electron consume placement → PDF content bake / noscale）
- ⏸ 待裁决：A3-02 rotate=90 方案 A/B/C；direct 轨 authority audit（Step 4-D）
