# 打印确认页 Simulator — A1 冻结 / A 暂缓 / A2 Gate 审查

> 审查对象：用户在 `print_preview_simulator_freeze_2026-08-03.md` 基础上的修正——
> "冻结 A1（`buildPrintExecutionPlan`），但暂缓 A（单文件切 Canvas/createPlacement），新增 A2 Gate 验收"。
> 角色：代码审查。结论 = 方向认可 + 一处重大风险修正 + Gate 范围收紧建议。

---

## 0. 一句话结论

你的**分层决策正确**：`buildPrintExecutionPlan` 是无条件必做（消灭三套逻辑），而"单文件切 Canvas"是改变了打印输出特性的产品级行为变更，必须单独 Gate。

但我必须修正你风险评估里的一个前提：**A 方案的 Canvas 单文件轨不是新建，能力早已存在且已支持 OFD**。所以 A 的实际工作量 = "路由切换 + 安全边距对齐验证"，而不是"从零建栅格化管线"。你列的 3 个风险（清晰度 / 内存 / 速度）中，**内存与速度是已发布 merge 路径的固有特性，A 只是把单文件也纳入，并未引入新技术**。

---

## 🟢 已验证的好消息（降低 A 的风险）

### G1. 单文件 Canvas 轨 `renderFileToPrintImage` 已实现且全覆盖三种格式
- 定义：`usePrint.js:165`。
- PDF：`read-file` → `_pdfData` → `renderMultipleItemsToCanvas`（createPlacement）。（L173–181）
- OFD：`fetchPrintRaster(docId, page)` → `_previewImageUrl` → `renderMultipleItemsToCanvas`，带 `previewImage` 兜底。（L182–249，核心取栅格 L194）
- Image：`read-file` → `_previewImageUrl` → `renderMultipleItemsToCanvas`。（L250–265）
- **结论：OFD 在 Canvas 轨已经支持**。你测试矩阵里"OFD 兼容"这一项，在 Canvas 轨早已成立，不是 Gate 要补的能力缺口。

### G2. 该轨已在 Canvas 模式下真实接线（非死代码）
- `usePrint.js:532–534`：`processQueue` 内 `isMerge ? renderMergeGroupToPrintImage : renderFileToPrintImage`。
- 即 `PRINT_PIPELINE.mode !== 'source'` 时，单文件打印**已经**走 `renderFileToPrintImage` → createPlacement。
- 当前默认 `mode='source'`（`config.js:9`）才走 Sumatra。所以 A = 把默认分支也指向已存在的 `renderFileToPrintImage`（或翻转 mode），**不是写新函数**。

### G3. "Preview ≡ Print" 在 Canvas 轨是免费的
- `renderFileToPrintImage` 调用 `renderMultipleItemsToCanvas` 时 **`isPrint=false` + `PREVIEW_DPI`**（`usePrint.js:215, 286`）。
- 预览也用同一函数同参数。所以 **Canvas 模式下单文件 Preview 与 Print 像素级一致是结构性保证**，零新几何代码。
- 当前漂移只因默认 source 模式用 Sumatra。切 Canvas → 漂移消失。

### G4. 内存 / 速度风险已被现有架构缓解（与你模型相反）
- `PREVIEW_DPI = 300`（`config.js:88`）→ A4 = 2480×3508，峰值位图 ≈ 35MB/页。数学正确。
- **但这是 PER-PAGE 峰值**：`doPrint` 按 `for i+=groupSize` 逐组 `await`（`usePrint.js` 前轮 L498–502），每页只渲染 1–4 个 slot；`renderMultipleItemsToCanvas` 内的 `Promise.all` 也只覆盖**单页的 1–4 个 slot item**（renderers.js:1085），不是所有文件。
- 因此 1000 文件 = 1000 次顺序逐页渲染，每页渲染完 `toBlob` 后即释放。**峰值内存 = 一页，与当前 source 模式逐文件 IPC 同量级。**
- 你担心的 `Promise.all(files.map(render))` 爆内存 → **当前代码不是这么写的**，不会发生。
- 速度：栅格化 + PNG 编码 + 重新组 PDF 确实比 Sumatra 直送多 CPU 时间，但 merge 路径**已经在付这个代价**；A 只是把单文件也纳入，属已知代价，Gate 用基准测试量化即可。

---

## 🔴 你测试矩阵漏掉的头号 Gate 风险：安全边距应用方式不一致

这是 A 方案**真正的回归风险**，比二维码/清晰度更关键（安全边距正是你改造的初衷）：

| 轨 | 安全边距怎么来 | 对 OFD |
|---|---|---|
| **source / Sumatra** | `main.js:515–553` `pdfMargin.process` **烘焙进 PDF**，不进 createPlacement | ⚠️ `imgExts` 不含 `.ofd` → **OFD 在 source 模式完全没有安全边距** |
| **Canvas / createPlacement** | `renderFileToPrintImage` 调 `renderMultipleItemsToCanvas` 时 **`showSafeMargin=false` 且不传 `paperLayout`（传 null）**（usePrint.js:216, 288）→ 退回 `createLayout` 用 `settings.margins` | 可能经 createPlacement 施加边距（需核实） |

**问题**：两条轨的安全边距"施加机制"完全不同（PDF 预处理 vs 几何层 `usableRect`）。如果对齐不到位，A 会改变单文件打印的**边距位置**——这正是你明确要避免的"因架构正确而引入打印质量回退"。

**Gate 必加的第 0 项准则（取代你矩阵里的"清晰度"为首要）**：
> 同一源文件，Canvas 轨输出的安全边距内缩量（mm）必须落在 source 轨 `pdfMargin` 的 ±0.5mm 容差内；且 OFD 在 Canvas 轨应**补上** source 轨缺失的边距（属改进，但须显式确认而非顺带发生）。

**建议做法**：
1. 让 `renderFileToPrintImage` 单文件分支也传入 `printPaperLayout`（含 `usableRect`），与 `renderMergeGroupToPrintImage`（usePrint.js:392）一致，统一走 `computePaperLayout` 几何源，不再退回 `createLayout`。
2. Gate 用卡尺/脚本量 A4 内容框四边到纸边的 mm 数，对比两套输出。

---

## 🟡 Gate 方法论修正：你的"shadow render 对比实际打印链"定义不清

- 你计划第 4 步"用同一 Plan 生成 shadow render，对比实际打印链"。但 **Canvas 输出（createPlacement@300dpi）与 Sumatra 输出（原生栅格化）是两套不同栅格器**，像素级不可能一致，exact-diff 会误报。
- **修正**：不要像素精确比对，改为**基于准则的验收**（容差矩阵）：
  1. 安全边距位置 ±0.5mm（见 🔴）
  2. 旋转方向：90/180/270 与 source 一致（数内容朝向）
  3. 二维码可识别（用扫码库自动判定，非肉眼）
  4. 8pt 小字在 200% 放大下可读（抽样）
  5. 单页普通票 / OFD / 多页 / 旋转 90° 各取锚样
- **额外红利**：因为 G3，Canvas 轨 Preview 与 Print 已一致，shadow render 可直接以**预览输出为 oracle**，再单独确认与 Sumatra 在容差内——省一半对比工作。

---

## 🟡 A1 抽取的设计张力（必须先解决，否则 A1 会改行为）

你要求"A1 暂不改 source 打印"，即抽取须**忠实复刻**现有行为。但现有两入口过滤口径不一致：
- `executePrint`：`status === 'parsed'`（`usePrint.js` 前轮 L817）
- `doPrint`：`status === 'parsed' || 'error'`（前轮 L453）

若 `buildPrintExecutionPlan` 抽成"单一纯函数且忽略 mode"，会**无意中统一/改变**某一入口的文件集 → 违反"A1 不改行为"。

**建议签名**：
```js
buildPrintExecutionPlan(files, {
  filter,        // 传入各入口现有谓词，忠实保留不一致
  mode,          // 'source' | 'canvas' —— 仅影响渲染路由，不影响 Plan 内容
  settings,      // paperSize/landscape/margins/mergeMode/customPaper
  fileRotations, // 每文件 rotation map（非单值 contentRotation —— 见前轮 R2）
  strategy,      // 一普二专展开（前轮 L822–831 内联逻辑迁出）
})
// 返回 Pipeline 无关的 PrintExecutionPlan（pages[].slots[]）
```
Plan 内容（文件/顺序/分组/旋转/策略）**与 mode 无关**；mode 只决定 Printer 用哪条渲染轨。这样 A1 不改任何打印行为，A3 切 mode 时才统一到 Canvas。

---

## 💭 Nits

- `renderFileToPrintImage` 的 OFD 分支已逐页顺序渲染（`usePrint.js:191` for 循环），内存友好，Gate 无需为此加测。
- `PREVIEW_DPI=300` 对打印足够；若未来要更高保真，集中改 `config.js:88` 一处即可，勿散落。
- `executePrint` 的 2 分钟超时（usePrint.js:516）对 1000 页 Canvas 批量可能偏短，Gate 跑大批量时留意超时误杀（属独立问题，可后续调）。

---

## 冻结建议（追加到 simulator freeze 契约）

1. **A1 冻结**：抽 `buildPrintExecutionPlan(files, {filter, mode, settings, fileRotations, strategy})`，忠实复刻现有过滤/分组/旋转/策略，**不改任何打印行为**；`executePrint`/`doPrint`/`buildPrintPreviewModel` 三方共消费。
2. **A 暂缓**：单文件默认仍走 source/Sumatra；不切 `PRINT_PIPELINE.mode`。
3. **A2 Gate（范围收紧）**：验证 `renderFileToPrintImage` 接管单文件。验收矩阵 = **安全边距位置 ±0.5mm（首要）** + 旋转方向 + 二维码可识别 + 小字可读 + 锚样覆盖（PDF/OFD/多页/旋转）。用容差而非像素 exact-diff；OFD 应补边距。
4. **A3（Gate 通过才做）**：单文件改走 `renderFileToPrintImage`；确认 `renderFileToPrintImage` 单文件分支也传 `printPaperLayout`（统一几何源）；可保留 `print-source-file` 作回退而非立即删。
5. **三隔离铁律不变**：`ViewerRenderResource ≠ PrintPreviewRenderResource ≠ PrintExecution`。

---

## 下一步

建议落地顺序（低风险、不碰 UI）：
1. **先抽 A1** `buildPrintExecutionPlan`（按上面签名，纯函数，不改行为）。
2. **A1 落定后**，写 A2 Gate 脚本（锚样 + 容差验收，重点量安全边距）。
3. Gate 过 → 做 A3 路由切换 + 单文件补 `printPaperLayout`。
4. 最后才进 `PrintPreviewModel` / `PrintPreviewRenderer`（前轮 Phase B）。

要我现在动手抽 A1 吗？（纯函数、不碰 UI、不改打印行为，正好接你这份冻结）
