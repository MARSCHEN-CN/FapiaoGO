# A2-G1 Canvas vs Source 边距对比报告（第一份）

> 2026-08-03 · 冻结 §11/§12 · 采集：Electron dev devtools（用户实测）+ source 轨（node 采集器）
> 数据来源：`frontend/test/printGate/artifacts/{A1-rot0,A1-rot90}/source.json + canvas.json`

## 结论（一句话）

**Canvas 轨与 source 轨的边距严重不对齐（FAIL，最大差 74.5mm），但根因是「纸张语义不同」而非渲染 bug——这正是 G1 要暴露的核心架构风险，不是意外。**

## 数据

| Case | source 边距 mm (L/T/R/B) | canvas 边距 mm (L/T/R/B) | 最大差 | 判定 |
|---|---|---|---|---|
| A1-rot0 (PDF 基准) | 14.3 / 16.0 / 10.6 / 17.0 | **4.2 / 83.5 / 3.9 / 91.5** | **74.5mm** | 🔴 FAIL |
| A1-rot90 (旋转) | 14.3 / 16.0 / 10.6 / 17.0 | **74.8 / 47.8 / 74.2 / 49.3** | **63.6mm** | 🔴 FAIL |
| A2-rot0 (OFD) | 语义基线（无 bbox） | 未采集（G1-B） | — | ⏸ INCOMPLETE |

## 根因拆解（三层，全部实测+源码实读确认）

### 1️⃣ 纸张尺寸不同（最大根因）
- **source 轨**：`add-pdf-margins.py` **扩展页面尺寸**（L189「内容位置不变」）→ 纸 = 原发票纸 2717×1890px（**230×160mm 专用发票纸**）+ 四边 10mm → 内容留在原位置，边距 = 发票自身留白 + 10mm
- **canvas 轨**：`createLayout`（renderers.js:1183，`paperLayout=null` 时）按 `paperKey='A4'` 建纸 = **2480×3508px（210×297mm A4）** → 内容 contain-fit 到 A4

**同一文件，两种纸张 → 边距必然不同。** source 是「发票纸放大」，canvas 是「内容放进 A4」。

### 2️⃣ 内容缩放 vs 原始尺寸（第二根因）
- source 内容：2423×1500px（原图大小，**不缩放**）
- canvas 内容：2404×1483px（比率 ≈1.0，**也几乎不缩放**——`createLayout` 的 slot 按内容真实尺寸放置，A4 高度 3508px 远大于内容 1500px → 内容垂直居中，上下各留 ~1000px 空）

实测 canvas A1-rot0 bbox T=986 / B=2469：内容在 A4 内**垂直居中**，上下边距 83.5mm / 91.5mm（≈ A4 高 297 - 内容 125mm 的一半余量）。这是「内容原尺寸放进 A4」的典型几何。

### 3️⃣ 旋转处理位置不同（结构性）
- source 轨：rotation 由 **Sumatra 原生处理**（node 采集不到，A1-rot90 与 rot0 的 source 数据相同）
- canvas 轨：rotation 由 `renderMultipleItemsToCanvas` 的 rotations 参数处理 → **A1-rot90 canvas 确实旋转了**（bbox 从横变竖：rot0 宽 2404 高 1483 → rot90 宽 741 高 2404，方向正确）

**canvas 轨旋转生效 ✅（这是利好：A3 切轨后旋转语义反而更明确）**

## 判定解读（为什么这是「预期 FAIL」）

§12.2 冻结的 Gate 目标：`|canvas-source| ≤ 0.5mm`。**在「source=发票纸放大 / canvas=A4 原尺寸贴入」的纸张语义下，这个目标不可能达成**——不是 canvas 渲染错了，而是两轨的纸张契约不同。

这正面回答了 G1 的核心问题：

> **Canvas 轨能否替代 source 单文件轨而不改变用户看到的纸张结果？**
> **答：当前不能。差在纸张语义（专用纸 vs A4），不是渲染精度。**

## 对 A3 的直接含义（Gate 结论）

A3 切 Canvas 轨前必须解决「纸张语义统一」，候选方案：
1. **A3 接线时传 `printPaperLayout`（含 usableRect）给单文件分支**——这正是冻结 §11 头号风险「安全边距施加机制不一致」的落地：让 canvas 轨用与 source 相同的纸张尺寸 + 边距几何（renderers.js:1018 `paperLayout` 参数已就绪，走 MultiTicketComposer+buildRenderCommand 路径）
2. 或 gateCases 改用 `customPaper`（230×160mm）采集 canvas，验证「同纸张下边距是否对齐」——这是 A2 下一步可做的对照实验

## 采集链路验证（本报告附带的工程确认）

- ✅ IPC 契约：`window.electronAPI.ipcRenderer.invoke('read-file')` → `{success, data: Buffer}`（ipc-file-ops.js:85）→ `normalizeReadFileData` 三形态适配（ipcPayloadAdapter.mjs）
- ✅ makeItem 三分支：PDF read-file→_pdfData 走通
- ✅ 渲染链路：PDF bytes → renderMultipleItemsToCanvas（8 参与 usePrint.js:288-298 逐字一致）→ canvas → findContentBBox → marginsToMm
- ✅ rotation 参数生效（A1-rot90 方向正确）
- ⏸ OFD（A2）：G1-B 单独做（需 DocumentStore docId 运行时上下文）

## 冻结状态更新

```
A2-G1
  source 轨      ✅ (79d102e2)
  canvas 轨       ✅ 采集链路打通 + 第一份对比报告（本报告）
                  🔴 结论1：纸张语义不同（A4 vs 专用纸）→ FAIL（预期，非 bug）
                  🔴 结论2（G1-CANVAS-2）：renderPDFPageRaw customPaper 缺陷 → 双重 fit
  OFD (G1-B)     ⏸
A2-G2..G6 ⏸ | A3 ⏸（需先解决纸张语义统一）| Phase B ⏸
```

# 附录 A：G1-CANVAS-2 同纸张实验（2026-08-03 晚，commit `2478e660` case + 实测）

## 实验
新增 `A1-customPaper` case：`paperSize='Custom'` + `customPaper:{widthMM:230, heightMM:160}`（与 source 实测纸面 2717×1890px@300dpi 对齐），验证「同纸张下 canvas margin ≈ source margin ±0.5mm」。

## 实测结果（用户 DevTools）
| 项 | source | canvas (customPaper 230×160) |
|---|---|---|
| 纸张 | 2717×1890px（230×160mm） | 2717×1890px（230×160mm）✅ 同纸 |
| 内容尺寸 | 2423×1500px | **1296×799px（缩小到 53.5%!）** |
| 边距 mm (L/T/R/B) | 14.3/16.0/10.6/17.0 | **60.7/45.0/62.4/48.3** |

**FAIL（且比 A4 实验更差）——但根因不是纸张，是 renderPDFPageRaw 的 customPaper 缺陷。**

## 根因（源码实读 renderers.js:513-517 + layout.js:25）
```
renderPDFPageRaw(pdfData, dpi, fileKey, paperKey, isLandscape)
  if (paperKey) {
    const pixels = getPaperPixels(paperKey, dpi, isLandscape)   // ← L515 没传 customPaper!
    canvasW = pixels.width; canvasH = pixels.height
```
- `paperKey='Custom'` 时 `getPaperPixels('Custom', dpi, isLandscape)` **customPaper 参数为 null** → `PAPER_SIZE_MAP['Custom']` 不存在 → **回退 A4（2480×3508）**（layout.js:25-28）
- 于是：PDF 先渲染进 **A4 画布**（PDF 210×140mm 内容在 A4 内 1:1 居中）→ 该 A4 画布再被 createLayout fit 进 **230×160mm slot（2717×1890px）** → 双重 fit，`scale=1890/3508=0.539` → 内容缩到 53.5%（实测 0.535 吻合）

## 结论（比预期更有价值）
G1-CANVAS-2 把问题从「纸张语义不同（A4 vs 专用纸）」**推进到「渲染器缺陷：renderPDFPageRaw 不支持 customPaper 透传」**：
- A3 不仅要把 `settings.paperSize → PrintExecutionPlan.paperLayout`，**还得修 `renderPDFPageRaw` 让它按真实纸张渲染 PDF**（传 customPaper 或改用 PDF 原生页尺寸 + 纸面外扩，与 source 的 add-pdf-margins 语义对齐）
- 这也解释了为什么生产 merge 轨（A4 为主）没暴露：merge 都是 A4，paperKey 有效；单文件 source 轨走 Sumatra 不经此路径

## 后续
- 🟡 候选修复（A3 范畴，不在本 Gate）：`renderPDFPageRaw` L515 传 customPaper / 或单文件分支用 PDF 原生页尺寸（`paperKey=null` 分支，L518-524 已有）
- ⏸ G1-CANVAS-2 待「修复 renderPDFPageRaw 后重跑」验证同纸张对齐
