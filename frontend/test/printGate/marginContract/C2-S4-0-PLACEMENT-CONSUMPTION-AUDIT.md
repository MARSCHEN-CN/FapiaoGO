# C-2 Step 4-0：Placement Consumption Audit（只读，重新锁点）

- 日期：2026-08-10
- 状态：**只读审计完成**（未改任何代码）
- 背景：RG-3 已完成「谁决定什么」（纸向权/内容旋转权分离）；Step 4 是「谁消费 geometry」。Step 3-A 审计后调用链已变（RG-3 改了 print-backend/OsLauncherBridge/PrintService），本报告**重新锁点，不假设沿用旧结论**。

---

## 1. 4 条消费路径矩阵（RG-3 后重新确认）

| 轨 | 路径 | plan.slots[].placement 消费 | 几何来源 | 结论 |
|---|---|---|---|---|
| **Preview** | usePrint placements → PrintPreviewModel.pageToModel | ✅ 消费（C-2 Step 2 统一） | resolveContentPlacement（RotationResolver） | **✅ 已接线** |
| **Canvas/merge** | doPrint → deriveMergePrintJobs → renderFileToPrintImage → renderMultipleItemsToCanvas | ❌ 不消费 | `_buildComposeCommand` → `createPlacement`（A3 独立几何，Compose 域） | **❌ 独立几何** |
| **Sumatra source** | executePrint → deriveSourcePrintJobs → printAllSourceFiles → printSingleSourceFile → buildPrintSettings(ps) → IPC | ❌ **映射时丢失** | Sumatra fit + rotate（electron 侧零消费） | **❌ 断链点（主战场）** |
| **Direct** | print-file-direct → DirectPrintHandler → printJob → OsLauncherBridge | ❌ 无 placement 字段 | Sumatra fit + rotate | **❌ 无接线** |

---

## 2. Sumatra source 轨断链点（Step 4 主战场，精确到行）

```
buildPrintExecutionPlan（plan 完备）
  page.paper = {size, orientation, widthMM, heightMM, ...}   ✅ 数据在
  page.slots[].placement = {scale, offset, placedRect, layoutRotation, ...}  ✅ 数据在（C-2 Step 1）
        ↓
deriveSourcePrintJobs.toJob（L31-43）🔴 断链
  return { ...f, _jobKey, _round }
  ⚠️ page.paper 未映射 / page.slots[].placement 未映射
        ↓
printSingleSourceFile(f, printSettings)（usePrint L983）
  ⚠️ f 是 job（含文件对象），printSettings 是用户设置——placement 无处可去
        ↓
printSingleSourceFile → PrintService.buildPrintSettings（L57-86）
  placement: placement || null   ← L85 参数可接，但调用方传 null
        ↓
ps.placement → IPC 'print-source-file'
        ↓
electron main.js / print-backend / OsLauncherBridge
  ⚠️ placement 零消费（RG-3 后重新确认：全仓 grep 仅注释提及）
  Sumatra fit + rotate 自决几何（RG-3 后纸向已由命令决定，但内容放置仍 Sumatra fit）
```

**核心结论**：Plan 有完整 geometry 事实（paper 几何 + placement），但 `deriveSourcePrintJobs` 是唯一映射点，它把 placement 丢了。**接线点 = deriveSourcePrintJobs + printSingleSourceFile 的 placement 透传**。

---

## 3. 各轨最小接线路径

### 3.1 Sumatra source 轨（Step 4 主战场）

```
A. deriveSourcePrintJobs.toJob：
   job._placement = page.slots[0]?.placement ?? null
   job._paper = page.paper   （含 orientation/widthMM/heightMM——RG-3 后 paper 命令来源）

B. printAllSourceFiles → printSingleSourceFile(f, printSettings, placement?)：
   从 job._placement 取 placement 传入

C. PrintService.buildPrintSettings（L85 已支持 placement 参数）：
   ps.placement = placement（已通，只需调用方传值）

D. electron 消费（⚠️ 本轮不接——属于 C-2 Step 4-2 render transform 域）：
   placement → PDF content bake（旋转/缩放/offset 烤进）或
   placement → Sumatra noscale + 已烤内容
   （依赖 A3-V3 裁决：方案 A/B/C + noscale 迁移）
```

### 3.2 Canvas/merge 轨

```
现状：_buildComposeCommand 用 createPlacement 自算（A3 域几何，冻结）
C-2 Step 1 已把 plan 的 placement（resolveContentPlacement 同 resolver）算好。
⚠️ 决策点：canvas 轨是否切到 plan.slots[].placement？
   - 若切：renderMultipleItemsToCanvas 需接收 plan placement 替代 createPlacement
   - 冻结约束：a3_design_spec 红线「不改 renderMultipleItemsToCanvas 算法」
   → 建议：canvas 轨保持 createPlacement（A3 已验证），仅 source 轨接线
     （两轨几何同源 resolveContentPlacement，数学等价，不必物理共用）
```

### 3.3 Direct 轨

```
printJob 无 placement 字段（DirectPrintHandler L170-185）
⚠️ 决策点：direct 轨（print-file-direct）是否接 placement？
   - 现状：direct 轨走 Sumatra fit（几何 Sumatra 决定）
   - 建议：本轮不接（direct 轨是旧批量路径，executePrint 主入口已走 source 轨；
     C-2 Step 4 后单独评估，避免扩大战场）
```

---

## 4. A3-03 Gate 验收定义（Step 4-2 目标态）

输入：横票内容（259520 型）+ A4 竖纸 + 用户无旋转

```
当前（RG-3 后，Step 4 前）：
  命令 disable-auto-rotation,fit,paper=a4
  → 竖纸 /Rotate=0，内容被 Sumatra fit 缩进竖纸
  → 边距 L≈4mm R≈0mm T/B 巨大（内容横放竖纸，占位错误）❌

目标（Step 4-2，placement 接线后）：
  plan.slots[0].placement = { scale: s, offset, layoutRotation: -90 }
  → 内容旋转 90° 烤进（或 render transform）→ 竖纸 + 居中 + 正确 margin
  → 边距对称（≈10mm 级），内容「读得清」✅
```

**验收断言**（延续 margin Gate 的 0.5mm 容差）：
1. artifact MediaBox = A4 竖（595×842 视觉）
2. 内容边距 L≈R≈T≈B（对称，±0.5mm）
3. layoutRotation=-90 已生效（内容旋转 90° 烤进，/Rotate=0）
4. 与 Preview 的 resolveContentPlacement 输出数学一致（round-trip）

---

## 5. 建议的 Step 4 顺序（待用户裁决）

| 步骤 | 内容 | 依赖 |
|---|---|---|
| **Step 4-1** | deriveSourcePrintJobs 透传 placement + paper 到 job；printSingleSourceFile 传递 | 无（纯数据链） |
| **Step 4-2** | electron 消费 placement：PDF content bake 或 Sumatra noscale + 已烤内容 | **A3-V3 裁决**（方案 A/B/C + noscale） |
| **Step 4-3** | A3-03 Gate（上节验收定义） | Step 4-1 + 4-2 |
| **Step 4-4** | 回归全量（RG-3 guard / A3 matrix / executionPlanGeometry / margin Gate） | 前序 |

⚠️ **Step 4-1 可独立先行**（纯数据链，不碰 Sumatra/渲染算法，无 A3-V3 依赖）——符合「Plan truth → Executor consumption」方向且风险最低。

---

## 6. 本轮冻结边界（延续用户裁决）

- ✅ 不动：RotationResolver / PrintExecutionPlan schema / paper orientation / Sumatra command authority
- ✅ 不做：Step 4-2 的 electron render transform（等 A3-V3）
- ❓ 待裁决：canvas 轨是否切 plan placement（建议不切，A3 域已冻结）；direct 轨是否接线（建议 Step 4 后）
