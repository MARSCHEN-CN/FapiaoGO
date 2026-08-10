# C-2 Step 4-2a — PlacementBakeAdapter + A3-03 DEV Gate

- 日期：2026-08-10
- commit：`0fd825b`（已推送 GitHub `rotation-b1-hardening`）
- 状态：**COMPLETED** — 方案 A（PDF pre-transform bake）adapter 层 + 端到端验证
- 范围：DEV 验证，**零生产接线**（4-2b 暂缓，noscale 迁移 D2 单独 commit）

---

## 1. 交付内容

### 1.1 `scripts/placement_bake.py`（PlacementBakeSpec adapter contract 层）

用户冻结的输入契约：`{source_pdf, paper, placement, output_pdf}`——**不暴露 margin_contract 内部结构**。

关键设计决策（实测修正）：
- 复用 `margin_contract.compute_transform`（INV-7a 相似矩阵）做 PDF 机械组装——几何引擎零改动
- **不采用 renderTransform**：实测发现 Preview SVG 的 `translate(tx,ty) scale rotate(cx,cy)` 是**近似**（绕中心 rotate 后 translate 无法精确固定左上角，偏差 ~570px）。改用 **placement 精确几何**（offset + placedRect + layoutRotation）——这是 RotationResolver 的最终结果，含 scale 与 layoutRotation。
- 输出契约断言：MediaBox==paper / CropBox==paper / /Rotate=0（与 margin_contract 的 G-1/G-2 同源）

### 1.2 `placementBakeGate.mjs`（A3-03 DEV Gate）

端到端闭环验证：
```
resolveContentPlacement（真实 Plan 几何，与 usePrint 同源）
  → placement_bake.py（PlacementBakeSpec）
  → Sumatra noscale + paper command（纯执行）
  → 断言 artifact：竖纸 + 居中（|L-R|<1.5mm |T-B|<1.5mm）
```

---

## 2. A3-03 Gate 实测结果（GATE PASS ✅）

```
placement: layoutRotation=-90 scale=1.3861 offset=(94,35)
bake OK: MediaBox=595.2756,841.8898 /Rotate=0 phi=270
artifact: 209.97x297.1mm /Rotate=0
边距: L16.26 T8.30 R17.70 B9.14
对称性: |L-R|=1.44mm |T-B|=0.84mm（容差 1.5mm）
GATE PASS ✅ 横票竖纸 → 竖纸 + 内容旋转 90° + 居中 + 正确 margin
```

**关键升级**：从 RG-3 的「纸向正确但内容被 Sumatra fit 缩进竖纸」→ 现在「内容 placement 完全由 Plan 决定，Sumatra 纯执行 noscale」。C2-R3「执行不决定」达成。

---

## 3. 实施中的关键发现（3 个数学坑）

| 坑 | 现象 | 修正 |
|---|---|---|
| renderTransform 是 SVG 近似 | `translate(tx,ty) scale(s) rotate(deg,cx,cy)` 绕中心 rotate 后 translate 无法固定左上角，偏差 ~570px | 改用 placement 精确几何（offset+placedRect+layoutRotation） |
| px→pt 单位 | renderTransform 是 px@PREVIEW_DPI | 统一 `px * 72/dpi` 换算 |
| CLI placement-file 语义 | 需读完整 spec 而非 placement 对象 | CLI 直接读 spec 文件当 spec（与 bake(spec) 签名一致） |

---

## 4. 验收（零生产接线）

| 项 | 结果 |
|---|---|
| placementBakeGate（端到端） | **PASS**（A3-03 闭环） |
| placementHandoff | 6/6 |
| executionPlanPaperGeometry | 10/10 |
| printSpecNormalize | 13/13 |
| paperOrientationFreezeGate | 全绿 |
| margin Gate phase1b | 9/9 GREEN |
| 四 guard（rotation/spec/shell/placement） | PASS |

---

## 5. 冻结边界（延续用户裁决）

- ✅ 未动：RotationResolver / PrintExecutionPlan schema / add-pdf-margins.py / Sumatra 执行路径 / Canvas-merge / DirectPrintHandler
- ⏸ **4-2b 暂缓**：生产接线（print-backend 消费 `executionPlacement` → placement_bake → Sumatra noscale）——noscale 迁移（D2）单独 commit，避免「placement bug + noscale 行为变化」混合无法定位
- ⏸ 待 A3-V3 后裁决：A3-02 rotate=90 方案 A/B/C

---

## 6. 下一步（4-2b 前置）

- **4-2b-1**：source print 检测 placement required → 产出 baked temp PDF，仍 Sumatra fit——只验证 bake 正确
- **4-2b-2**：单独 `fit → noscale` 迁移，重跑 A3-01/02/03/04/07

数据链现状：`plan → job → printSingleSourceFile → ps.executionPlacement/executionPaper → IPC → electron`（Step 4-1 已通），electron 消费（调 placement_bake）属 4-2b。
