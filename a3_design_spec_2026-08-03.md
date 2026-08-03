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
