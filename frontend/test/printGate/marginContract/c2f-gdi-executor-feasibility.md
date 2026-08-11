# C-2-F 课题定义 — GDI Custom Paper Executor Feasibility

> 日期：2026-08-11 ｜ 状态：**立项（feasibility only，不改生产）** ｜ 前置：C-2-E CLOSED（EXECUTOR LIMITATION CONFIRMED）
> 顺序：C-2-E CLOSED → **C-2-F GDI feasibility** → 再决定是否替代 Sumatra → V-04-rot90 / Phase 1-B 清理 排后。

## 1. 背景与动机

C-2-E 对照证据（同一驱动、同一 DEVMODE、两条 executor 路径）：

```text
baked PDF
   ├── Sumatra   custom-size → A4 ❌（Sumatra 打印路径 DEVMODE 传递缺陷）
   └── GDI       custom-size → 240×140 ✅（CreateDCW + dmPaperSize=0 + W/L=2400/1400 实测）
```

Wondershare 驱动支持 custom paper DEVMODE（GDI 已实测）；GDI 是**已验证可行的候选替代 executor**。但「GDI 能打出 240×140 artifact」≠ production-ready——需要系统性 feasibility。

## 2. 目标（第一阶段，只做 feasibility）

确认 4 件事：

| # | 确认项 | 关键问题 |
|---|---|---|
| F1 | **GDI executor 能否稳定接受现有 PrintExecutionPlan** | 输入契约：PrintExecutionPlan → PrintService → GDI executor 的适配成本 |
| F2 | **PDF 如何进入 GDI** | GDI 非 PDF renderer——输入格式选型：raster image / EMF / XPS / Chromium 打印 / 其他中间格式 |
| F3 | **DEVMODE 能否完整承接现有打印参数** | paper size ✅（已证）/ orientation ✅ / copies / color-grayscale / duplex / margins |
| F4 | **现有 A3-01/02/03/04/07 + 横向凭证纸能否通过同一 executor** | 全 case 覆盖验收（含 sumatraLandscapeGate 验收语义迁移） |

## 3. 边界（冻结声明）

- **不改生产**：C-2 全部冻结（geometry / placement / RotationResolver / PrintExecutionPlan / placement bake / noscale）；GDI executor 仅实验原型。
- **不认定 production-ready**：F1-F4 全绿前，GDI 只是候选替代 executor，冻结在实验状态。
- 若 GDI feasibility 因 PDF rendering / 性能 / 双面 / copies 等原因不成立 → 不影响已完成的 C-2。

## 4. 方法

1. **F2 先决**：PDF → GDI 输入格式选型（raster 光栅化 / EMF / XPS / Chromium）
   - 最务实候选：**bake PDF → fitz 光栅化（300dpi）→ GDI StretchDIBits/SetDIBitsToDevice 打印**（复用现有 fitz 栈）
   - 对照：EMF（GDI 原生矢量，PDF→EMF 需转换器评估）
2. **F3**：DEVMODE 字段承接对照（copies=dmCopies / grayscale=dmColor / duplex=dmDuplex / orientation=dmOrientation——ctypes DEVMODEW 已能全字段控制）
3. **F1**：PrintExecutionPlan 字段 → GDI 调用的映射审计（paper / orientation / copies / grayscale / duplex / margins）
4. **F4**：GDI 原型跑 A3-01/02/03/04/07 + 凭证纸横向，几何断言复用（MediaBox==paper / /Rotate=0 / 内容 bbox 面积 ≥90%）

## 5. 交付物

- GDI 打印原型（`.out`，gitignored）
- C-2-F feasibility 报告（F1-F4 结论 + GDI vs Sumatra 对照矩阵 + 替代决策建议）

## 6. 当前状态

```
C-2 source print execution
   ├─ Geometry/Placement/Rotation/Plan/bake/noscale   🔒 FROZEN
   └─ Sumatra executor → custom paper ❌ capability limitation
GDI executor（候选替代）
   └─ custom DEVMODE → 240×140 ✅（已实测，实验状态冻结）
```
