# A3 Design Spec — 单文件打印切 native renderer + paperLayout

> 2026-08-03 晚 · 基于 A2 Gate G0→G1-CANVAS-3B 全链证据 · 设计冻结后实施（Commit A3-1/2/3）

## 1. 当前调用链（现状）

### 单文件 source 轨（生产默认，`PRINT_PIPELINE.mode='source'`）
```
executePrint (usePrint.js:809)
  → buildPrintExecutionPlan (SOURCE_FILE_FILTER)     [A1 已完成]
  → deriveSourcePrintJobs                              [Commit 2 已完成]
  → printAllSourceFiles → printSingleSourceFile
  → electron print-source-file (main.js:490)
      → pdfMargin.process → scripts/add-pdf-margins.py（扩展 MediaBox，内容原位）
      → Sumatra 打印
```

### 单文件 canvas 轨（A3 目标，当前 `renderFileToPrintImage` 已实现但未接 source）
```
renderFileToPrintImage (usePrint.js:174)
  → makeItem（PDF read-file→_pdfData / OFD fetchPrintRaster→_previewImageUrl / Image）
  → renderMultipleItemsToCanvas (renderers.js:1015)
      → renderPDFPageRaw(paperKey='A4'|'Custom', ...)  ← contain-fit 进纸张（G1 证据：语义偏移源）
      → createLayout / MultiTicketComposer            ← slot-fit + 居中（G1 证据：二次偏移源）
```

## 2. G1 证据链（A2 Gate 全链实测）

| 实验 | 结果 | 结论 |
|---|---|---|
| G1-CV1 (A1 A4) | canvas 边距 83.5/91.5 vs source 16/17mm，max 74.5mm | 纸张语义不同（A4 vs 230×160 专票纸） |
| G1-CV2 (customPaper 230×160) | 内容缩 53.5% | renderPDFPageRaw L515 漏传 customPaper → 'Custom' 回退 A4 → 双重 fit |
| G1-CV3A (patch 透传) | 内容 53.5%→108%（scale=1.096 吻合）| customPaper 透传修复确认；残余=fit-填满-居中 vs 原位-外扩 |
| **G1-CV3B (native paperKey=null)** | **bitmap 2480×1654、content ratio 1.0/0.999、offset=-118px=10mm 外扩** | **尺寸恢复是 renderer 原生能力；source = native + 纸面外扩** |

### 证据链决定性推论
```
source 语义 = PDF native page + page expansion（内容位置不变）
canvas 目标 = PDF native render + paperLayout placement（内容位置 = margins 偏移）
两者在 native bitmap 层完全一致（ratio 1.0），只差「外扩偏移」（10mm = 118px@300dpi）
```

## 3. 目标 Render Contract（冻结）

### Source Contract（现状，不变）
```
Input:  PDF
Output: expanded page（MediaBox 四边 +10mm）+ original content coordinate
```

### Canvas Target Contract（A3 目标）
```
Input:  PDF
Output: native page bitmap + paperLayout placement（offset = margins）
```

### 禁止项（冻结）
- ❌ contain-fit PDF 到纸张（renderPDFPageRaw paperKey 路径对单文件弃用）
- ❌ renderer 内隐藏纸张转换（纸张描述必须显式经 paperLayout）
- ❌ 重复实现 margin expansion（不复制 add-pdf-margins.py 逻辑；native + offset 天然等价）

### paperLayout 结构（唯一纸面描述，Source/Canvas 共同理解）
```js
{
  widthMm, heightMm,          // 纸面（= 原生页 + 边距）
  margins: { top, right, bottom, left },  // mm，打印边距
  usableRect: { x, y, width, height },    // mm，可打印区（原生页位置）
}
```

## 4. Commit 拆分（三个 commit，单变量）

### A3-1：Render Contract 接线层
- **改**：`usePrint.js` 单文件分支——传递 `paperLayout`（从 Plan/settings 派生，`computePaperLayout` 现有函数）
- **不改**：renderer（renderMultipleItemsToCanvas / renderPDFPageRaw / createLayout）
- **验证**：现有 snapshot 不变（buildPrintExecutionPlan / deriveSourcePrintJobs 测试 53/53）

### A3-2：native single renderer
- **改**：单文件 PDF 走 `renderPDFPageRaw(paperKey=null)`（native branch L558 已有）
- **验证**：G1 A1 重新达到 content size ratio ≥ 0.99（复用 gateFramework 测量链路）

### A3-3：placement alignment
- **改**：createLayout / compose command——native bitmap + paperLayout → source 等价输出
- **验证**：margin diff ≤ 0.5mm（复用 assertSafeMarginAlignment）

## 5. 风险矩阵

| 风险 | 等级 | 缓解 |
|---|---|---|
| **rotation + paperLayout 未验证**（G1 只验证了 native 无旋转）| 🔴 高 | A1 rot90 进第一批 Gate；rotation 属 slot.rotation，A3-3 接线时确认 |
| OFD 单文件：native branch 是 PDF 专用（renderPDFPageRaw），OFD 走 fetchPrintRaster 路径 | 🟡 中 | OFD 保持现有 canvas 路径（renderFileToPrintImage OFD 分支已实现），A3 只切 PDF；OFD 补边距语义留 G1-B |
| merge 轨不回归（merge 仍走 createLayout A4）| 🟡 中 | merge2/merge4 进 Gate 矩阵 |
| paperLayout 派生准确性（margins→usableRect 换算）| 🟡 中 | computePaperLayout 已有 + mm→px 纯函数测试 |
| Image 单文件 | 🟢 低 | 保持现状（无 paperLayout 需求） |

## 6. Gate 验收矩阵（A3 后）

| Case | 目的 | 判定 |
|---|---|---|
| A1 PDF 0° | 基线 | margin diff ≤ 0.5mm |
| A1 PDF 90° | **rotation（最大风险）** | margin diff ≤ 0.5mm + 方向正确 |
| A2 OFD | Render Contract 后补 | G1-B 单独（canvas ≈ settings.margins）|
| merge2 | 不回归 | snapshot 不变 |
| merge4 | 不回归 | snapshot 不变 |

## 7. DEV patch 处置（冻结决策）
- ✅ **保留**：`renderPDFPageRaw` export（A3-2 需要 native branch）
- ✅ **已回滚**：customPaper 透传 patch（G1-CV3B 证明 customPaper 非最终方案，防 native+customPaper 歧义路径）——本轮已执行（renderers.js 恢复 5 参签名，保留 export）

## 8. 边界（A3 红线）
- ❌ 不改 renderMultipleItemsToCanvas 整体算法（G1 证明渲染器没坏）
- ❌ 不复制 add-pdf-margins.py（native + offset 天然等价）
- ❌ 不进 Phase B（PrintPreviewModel/Preview UI）
- ❌ 不碰 OFD 单文件（G1-B 范畴）

# A3-3 Design Spec — Placement Alignment（2026-08-03 晚用户定稿，追加）

> A3-1（contract 携带）/ A3-2（native 资源验证）已冻结，A3-3 是首次改变「内容在纸面上的位置语义」，风险等级更高——先定义 Placement Contract → Gate → 再接生产路径。

## 1. 已知坐标事实（冻结，G1-3B + A3-2 实测）
```
native bitmap: 2480×1654px ≈ 210×140mm @300dpi（内容 2424×1499）
source paper:  2717×1890px ≈ 230×160mm（内容偏移 +118px,+118px）
差异: 2717-2480≈237px / 1890-1654≈236px ≈ 10mm×2 @300dpi（左右/上下各 118px）
结论: paper = native + 20mm；内容偏移 = sourceOrigin(10mm) = (118px,118px)
```

## 2. 目标
```
Canvas Output = PDF Native Bitmap + Paper Expansion Geometry + Source Origin Offset
              = source 语义（native page + 10mm top/left expansion）
验收: margin diff ≤ 0.5mm
```

## 3. 不做什么（红线，继续冻结）
- ❌ 不改 PDF renderer / renderPDFPageRaw / PDF margin 生成逻辑
- ❌ 不改 Sumatra source path / MultiTicketComposer 算法 / createLayout 通用行为
- 原因：否则无法证明「placement 问题，而不是 renderer 问题」

## 4. 改动目标：新增 PlacementAdapter 层
```
RenderResource (native bitmap)
        ↓
PlacementAdapter (paper coordinate space)
        ↓
draw command offset
        ↓
Canvas
```
原则：**resource ≠ placement**（A3-1/2 验证的架构原则延续）。单文件 branch 改为：
```
renderFileToPrintImage → native resource → applyPlacement(native, paperLayout) → canvas
```

## 5. paperLayout contract 扩展（A3-1 预留字段补全）
```js
paperLayout = {
  paperRect, usableRect,
  coordinateSpace: { name: "paper", origin: "top-left" },  // contract，不重新定义坐标系
  sourceOrigin: { x: 10, y: 10, unit: "mm" },              // A3-3 第一阶段只消费这个
}
```

## 6. Gate 设计
| Gate | 输入 | 检查 | 预期 |
|---|---|---|---|
| A3-3-01 Placement Offset | A1-native + paperLayout 230×160 + sourceOrigin 10mm | native bbox + offset = source bbox | dx≈118px, dy≈118px |
| A3-3-02 Margin | canvas vs source | 四边 margin | 均 ≤0.5mm |
| A3-3-03 Rotation Regression | rot90 + placement | bbox rotation correct + offset correct | R1 已解除，复验 placement 后偏移 |

## 7. 最大风险：rotation 后 offset 坐标系
- rot0：offset = (+x, +y)，简单
- rot90：sourceOrigin 可能需旋转变换（(x,y) → (y,-x)）→ **A3-3-03 必须保留**

## 8. Commit 拆分（单变量）
| Commit | 内容 | Gate |
|---|---|---|
| A3-3-1 | 只加 paperLayout.sourceOrigin 字段，不消费 | contract pass |
| A3-3-2 | PlacementAdapter，只支持 rot0 | margin ≤0.5mm |
| A3-3-3 | rotation transform | rot90 pass |

# §7.1 Rotation Coordinate Contract（2026-08-04 用户定稿前置冻结，spec-only）

> A3-3-3 动代码前先冻结旋转坐标语义。基于源码实读（2026-08-04），非猜测。

## 1. 事实链（源码实读）

| # | 事实 | 证据 |
|---|---|---|
| F1 | `renderPDFPageRaw` 本身**不做旋转**（native 分支 L558-566 无 rotate） | renderers.js:558 |
| F2 | 旋转发生在 **placement 层**：`createPlacement({rotation})` 算 rotatedBounds（90/270 时宽高互换，composePlacement.js:68-69）+ `drawRenderCommand` **以落盘包围盒中心为支点旋转**（offset 是旋转后内容左上角） | composePlacement.js:65-101 / renderDraw.js:52-56 |
| F3 | **source 轨旋转语义 = 纸面方向跟随内容**：Sumatra 经 `contentOrientation`（portrait/landscape）表达，add-pdf-margins 只扩展 MediaBox（内容位置不变），Sumatra 打印时按 orientation 调纸张方向 | main.js:525,544-547 / add-pdf-margins.py:62-74 |
| F4 | **canvas 现有 createPlacement 路径 = 纸固定、内容在纸内旋转**（A1-rot90 实测：A4 画布 2480×3508 不变，内容 bbox 741×2404 在画布内旋转） | G1-CANVAS-1 A1-rot90 artifact |
| F5 | **A3-2 采集器模型 = 画布旋转（Policy A）**：canvas 2D 旋转整个画布 → bitmap 1654×2480（宽高互换），内容 bbox (84,51,1499×2424) 无负坐标 | collectCanvasOutput.js:221-232 + A3-2-02 实测 |

## 2. Contract（冻结）

### C1 Resource Rotation（内容旋转）
- 作用于 native bitmap，宽高互换：2480×1654 → 1654×2480
- 旋转中心 = 内容中心（drawRenderCommand 中心支点，与 A3-2 采集器一致）
- 已由 A3-2-02 验证 ✅（content ratio 0.999/1.0）

### C2 Paper Rotation Policy —— **冻结 Policy A（paper follows content）**
- **纸面方向跟随内容旋转**：rot90 → 纸面 2717×1890 → 1890×2717
- 依据：F3（source/Sumatra 语义）+ F5（A3-2 采集器模型，已验证）
- **Policy B（纸固定内容旋转）仅限现有 A4/merge 路径，不是 source 复刻目标**——A3-3-3 单文件分支禁用

### C3 Transform Order（变换顺序）
```
native resource → 施加 sourceOrigin（扩展纸面，内容 offset 好）
               → 整体旋转（paper + content 一体，以扩展纸面中心为支点）
```
- **旋转的是「扩展纸面」而非「resource 单独」**——与 Sumatra 旋转扩展后 MediaBox 一致（F3）
- **sourceOrigin 在旋转前施加，旋转时随画布整体变换，不单独重算**

### C4 SourceOrigin Transform（数学锚点，canvas 坐标 y 向下，rotate(θ>0)=顺时针）
- 变换公式：相对画布中心的偏移 `(dx,dy)`，rotate(90°) → `(-dy, dx)`（canvas 2D 实际行为，A3-2 实测验证：内容中心相对偏移 (23,-6.5) → (6.5,23)，新 bbox (84,51) 吻合）
- **rot0**：offset=(118,118) 直接施加（A3-3-2 已验证 ✅）
- **rot90**：offset 随画布旋转——实现 = 创建旋转后画布（1890×2717），把「扩展纸面 command」按中心支点旋转绘制（等价 A3-2 采集器 canvas 2D 旋转，**生产路径复刻同一数学**）

### C5 预期 rot90 结果（数学推导，供 Gate 判定）
```
源（rot0）: 画布 2717×1890，内容 bbox (169,189,2423×1500)，边距 L14.3/T16/R10.6/B17 mm
rot90    : 画布 1890×2717，内容 bbox (201,169,1500×2423)，边距 L17/T14.3/R16/B10.6 mm
           （原边距顺时针轮换——四边 10mm 语义在旋转后交换位置）
```

### C6 禁止项
- ❌ 单文件 source 语义下用 Policy B（纸固定内容旋转）
- ❌ rotation 单独作用于 resource 后再重算 sourceOrigin（错误模型，会产生负坐标：`(x,y)→(y,-x)` 直接套用 offset 会得 (-344,400) 类结果）
- ❌ 修改 renderPDFPageRaw / createPlacement 通用语义 / MultiTicketComposer

## 3. 待验证项（标记，不阻塞 contract 冻结）
- **Sumatra 真实打印的 rot90 纸面方向**：当前 node 采集不体现旋转（冻结事实「source rotation 由 Sumatra 原生处理」），Policy A 基于 contentOrientation 语义推断 + A3-2 采集器模型，**需真实打印对照确认**；若实测 Sumatra 为 Policy B，修订本 contract
- A3-3-3 Gate 预告：A3-3-3-01 adapter rot90（画布 1890×2717 + rotatedBounds 互换 + offset 旋转）、A3-3-3-02 margin（四边 vs C5 ≤0.5mm）、A3-3-3-03 bitmap invariant（像素不变只旋转）
