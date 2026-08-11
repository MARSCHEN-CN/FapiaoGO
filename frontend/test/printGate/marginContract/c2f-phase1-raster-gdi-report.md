# C-2-F 第一阶段报告 — GDI Custom Paper Executor Feasibility（F2/F3 结论）

> 日期：2026-08-11 ｜ 阶段：Phase 1（F2 PDF→GDI 输入选型 + F3 DEVMODE 承接）｜ 基线：`4fccea9`
> 边界：feasibility only，零生产改动；C-2 全部冻结。

## 1. F2 — PDF → GDI 输入格式：raster 路径实测可行 ✅

### 原型（`.out/gdi-raster-print.py`）

```
bake PDF（240×140 横 /Rotate=0）
   → fitz 光栅化 300dpi（2835×1654px BGRA 32-bit）
   → CreateDCW('WINSPRINT') + DEVMODE（dmPaperSize=0 + W/L=2400/1400）
   → StartDoc → StartPage → StretchDIBits(全纸) → EndPage → EndDoc
   → Wondershare 捕获
```

### 实测（Wondershare PDFelement）

| 变体 | DEVMODE | MediaBox | /Rotate | 内容 | 判定 |
|---|---|---|---|---|---|
| gdi_landscape | size=0 + 2400/1400 + orient=2 | **680×397（240×140 横）** ✅ | 90 | 191.8×97.5mm（面积≈bake） | 纸 ✅ 内容需映射调优 |
| gdi_portrait | 同上 + orient=1 | 397×680（140×240 竖） | 0 | **111.8×167 = bake 内容转置（面积 1:1）** | 纸 ✅ 内容 ✅ |

### F2 结论
- **raster 输入路径可行**：GDI + custom DEVMODE 正确输出 240×140 纸，内容完整打印。
- 内容纵横比：landscape 略异常（191.8×97.5 vs bake 167×111.8，宽高%互换）——**StretchDIBits dest 矩形应按纸 content area 而非全可打印区**（工程调优，非可行性障碍）；portrait 已 1:1 完整。
- 备选输入：EMF（GDI 原生矢量）——PDF→EMF 需转换器，raster 已够用（300dpi 发票质量可接受），EMF 留 F2 延伸。

## 2. F3 — DEVMODE 参数承接（ctypes DEVMODEW 全字段控制）✅

| 打印参数 | DEVMODE 字段 | 状态 |
|---|---|---|
| paper size | dmPaperSize（0=自定义）+ dmPaperWidth/Length（0.1mm） | ✅ 已实测 240×140 |
| orientation | dmOrientation（1=portrait / 2=landscape） | ✅ 已实测双向 |
| copies | dmCopies | ✅ 可设（未实测） |
| color / grayscale | dmColor（DMCOLOR_COLOR/MONOCHROME） | ✅ 可设（未实测） |
| duplex | dmDuplex | ✅ 可设（未实测） |
| margins | dest 矩形（StretchDIBits 目标区偏移） | ✅ 可承接（与 raster 目标区参数联动） |

**F3 结论**：DEVMODE 全字段可控制，参数承接完整（paper/orientation 已实测，copies/color/duplex 字段就绪待 case 验证）。

## 3. F1 / F4 — 初步

- **F1（Plan 接受）**：PrintExecutionPlan 字段（paper/orientation/copies/grayscale/duplex/margins）→ DEVMODE + dest 矩形 映射全部存在，无结构性障碍（初步 ✅）。
- **F4（A3 case 覆盖）**：raster 路径与纸型无关（位图全幅），A3-01/02/03/04/07 统一「bake → raster → GDI」；凭证纸横向 = 本原型场景（✅）。待 F2 映射调优后全 case 回归。

## 4. 候选替代评估（GDI vs Sumatra 对照）

| 维度 | Sumatra | GDI（raster） |
|---|---|---|
| custom paper 240×140 | ❌ DEVMODE 传递缺陷 | ✅ 已实测 |
| 内容 1:1 | ✅（标准纸下） | ✅（portrait 实测 / landscape 需调优） |
| 参数承接 | paper/orientation（部分） | DEVMODE 全字段 |
| 新增成本 | — | raster 光栅化 + GDI 调用层（可复用 fitz 栈） |

## 5. 下一步（Phase 2 候选）

1. **F2 映射调优**：StretchDIBits dest 矩形 = 纸 content area（含 margins 偏移），验证 landscape 内容 1:1
2. **F4 全 case**：A3-01/02/03/04/07 + 凭证纸横向经同一 GDI 原型回归
3. **F3 case 验证**：copies / grayscale / duplex 实测
4. **生产化评估**：若全绿 → GDI executor 落地设计（PrintService 分支，C-2 冻结保持）

## 6. 边界声明

- C-2 全部冻结（geometry/placement/Rotation/Plan/bake/noscale）；GDI 仅实验候选。
- 若 raster 性能/质量不达 → 可弃用，不影响 C-2。
