# C-2-G 只读审计：Paper Direction 未进入 Execution Plan / Executor

> **性质**：只读审计（与 `c2g-inv-r-prediction-experiments.md`、E 实施同属 C-2-G 调查）。
> **本文件不动任何代码**。目标是回答三个精确问题，框定下一次解冻边界。
> **结论前置**：真机 T1~T4 暴露的失败**不是 E1/E1a 的 `contentRotation` 问题，而是更上游的「纸张方向」变量没有传导到 `executionPaper.orientation` / Sumatra 命令。E1+E1a+E2 **不应回退**。

---

## 1. 三个正交变量（与真机现象对齐）

| 变量 | 代码里的载体 | 真机证据 |
|---|---|---|
| **UI rotation（内容旋转）** | `fileRotations[f.key]` → `contentRotation` | 横纸×横向 0° 内容方向正确（E 几何未破） |
| **纸张类型（paper type）** | `paperSize` / `paper`：`PostScript`(240×140) / `A4`(210×297) | 横纸类型可被识别 |
| **纸张方向（paper direction）** | **仅 `settings.landscape` 布尔**（相对量，非绝对方向） | ❌ 横纸类型 + 纵向方向 → 仍 `landscape` |

> 关键认知：**纸张方向不是「再旋转内容」，而是把纸张坐标系本身交换**（横纸型 240×140 ↔ 140×240）。
> 真机证明：这个「交换」在 横纸型 + 纵向 时根本没发生。

---

## 2. Q1 — 用户选择的「纸张方向」字段到底是什么？

**答：打印链路上只有相对布尔 `settings.landscape`，没有绝对方向字段被传输。**

链路追踪：

1. UI 的「横向/纵向」选择落到 `settings.landscape`（布尔）。
2. `frontend/src/hooks/usePrint.js:762` `printOptions = { ...settings, landscape: forcedLandscape }`（合并模式也只传布尔）。
3. `frontend/src/services/PrintService.js:74` `landscape: !!userSettings.landscape` → 写入 IPC `settings`。
4. `PrintService.js:57-91` 的 `buildPrintSettings` **没有设置 `paperOrientation` 字段**（只透传 `landscape` + `paper` + `executionPaper`）。
5. electron `normalize`（`print-settings.js:200-204`）读 `src.landscape` / `src.paperOrientation` / `naturalOrient` —— 但 `src.paperOrientation` 在打印 IPC 上**永远是 undefined**（前端从不发），于是回退到 `naturalOrient`。

**结论**：`paperOrientation` 仅作为 legacy Fact 存在于 preview/docFacts（`docFacts.js:27`、`RenderLayoutFactory.js:147`），**未进入打印 IPC**。打印链上「方向」= 一个相对布尔 `landscape`，它能表达「A4 是否横打」，但**无法表达「横纸型要不要纵向」**——因为横纸型 natural 就是 landscape，`landscape=false` 被解读为「用固有方向」而非「我要 portrait」。

---

## 3. Q2 — 横纸 + 纵向 → 140×240 portrait 应在哪里发生却没发生？

**答：规范交换在「前端」算对了，但「electron `normalize` 重算时丢弃了它」，且布尔无法表达该请求。**

前端其实算对了：

- `frontend/src/print/paperSpec.js:58-60` `requestedPaperOrientation`：`landscape ? 'landscape' : 'portrait'`
- `paperSpec.js:88-91` `needSwap = orientation !== natural`；横纸型(natural=landscape) + 请求 portrait → `needSwap=true` → `widthMM=140, heightMM=240` ✅
- 该结果进入 `plan.paper`（`buildPrintExecutionPlan.js:275,319`）。

但真机命令来自 electron 侧的重算，**它不看前端的 plan**：

- `electron/print-service/print-settings.js:199-205`：
  ```js
  const naturalOrient = getPaperShapeOrientation(sizeName, customPaper)   // 横纸型 → 'landscape'
  const requestedOrient = src.landscape
    ? 'landscape'
    : (src.paperOrientation === 'landscape' || src.paperOrientation === 'portrait'
        ? src.paperOrientation
        : naturalOrient)                  // ← paperOrientation 永远 undefined → 落到 naturalOrient='landscape'
  const needSwap = requestedOrient !== naturalOrient   // landscape !== landscape → false → 不交换！
  ```
- `buildPrintSettings`（`print-settings.js:284-291`）据此发 `landscape` 基础旗 → Sumatra 收到 `landscape`。

**两处叠加缺陷（Facet A + Facet B）**：

- **Facet B（语义）**：`landscape` 布尔对横纸型不可表达 portrait。横纸型 `landscape=false` → `naturalOrient`(landscape) → 永远 landscape。
- **Facet A（传输/消费）**：前端 `buildPrintSettings`（`PrintService.js:89`）确实透传了 `executionPaper`（= `plan.paper`，含已交换的 `orientation`/`widthMM/heightMM`），但：
  - 源单文件路径里 `executionPaper = f?.paper ?? null`（`usePrint.js:954`），而 `f` 是原始 `parsedFiles` 项（`usePrint.js:728`），`plan.paper` 并未写回 `f.paper` → 实际多为 `null`；
  - 即便非 null，`normalize`（`print-settings.js:199-205`）**根本不读 `src.executionPaper.orientation`**，只用 `landscape`+`naturalOrient` 重算。

> 即：**Plan 算出的 140×240 在 IPC 边界被丢弃，electron 用布尔 + 固有方向重算回 240×140。**

---

## 4. Q3 — 安全边距在哪个坐标系计算，为什么横向正确、纵向错误？

**答：preview/Plan 边距在「纸张原生维度」坐标系（横纸型恒 240×140，landscape 坐标）计算；方向交换从未传播到执行器，所以纵向请求下边距仍按 240×140 算，与用户期望的 140×240 错位。**

- `frontend/src/previewState.js:178-233` `computePaperLayout`：
  ```js
  const paper = resolvePaper(paperSize, customPaper)        // 横纸型 → {widthMM:240, heightMM:140}
  const paperW = paper.widthMM, paperH = paper.heightMM
  const innerW = paperW - mLeft - mRight                    // 在 240×140 坐标系内缩边距
  const innerH = paperH - mTop - mBottom
  ```
- **横向方向**：执行纸 = 240×140（native），边距在 240×140 算 → 正确。
- **纵向方向**：因 Q2 的交换被丢弃，执行纸仍是 240×140，边距仍在 240×140 算。用户期望的是物理 140×240 纸，其上下/左右边距方向已交换；系统却按 landscape 坐标布局 → 用户看到「边距错」「内容未正确适配纵向纸」。

**正确契约**（供下次解冻参考，本次不改）：

```
基础纸型(240×140) → 应用纸张方向(纵向) → 最终物理纸(140×240) → 在最终纸坐标系内算 margin → content fit
```

当前实现等价于「基础横纸 → 先算 margin → 末尾并未把纸交换成 portrait」，故横向对、纵向错。这与 Q2 是**同一上游错误的两个表现**，不能单独修 margin。

---

## 5. 证据索引（file:line）

| 现象 | 位置 |
|---|---|
| 方向仅由 `landscape` 布尔驱动 | `usePrint.js:762` / `PrintService.js:74` |
| 打印 IPC 不传 `paperOrientation` | `PrintService.js:57-91` |
| 前端规范交换算对（plan.paper） | `paperSpec.js:88-91` / `buildPrintExecutionPlan.js:275,319` |
| electron 重算忽略 executionPaper，回退 naturalOrient | `print-settings.js:199-205` |
| 横纸型固有方向 = landscape | `print-settings.js:76-82`（LANDSCAPE_PAPERS 含 PostScript/invoice） |
| 边距在原生维度坐标系计算 | `previewState.js:182-199` |
| executionPaper 来源 raw file，未写回 plan | `usePrint.js:954,728`；`placement-bake-processor.js:23` 注释意图但未在源单文件路径接线 |
| E2 读取 executionPaper.orientation（但 normalize 已先重算错） | `main.js:563` |

---

## 6. 更新后的问题树（C-2-G）

```
C-2-G = BLOCKED
 ├─ G1 纸张类型        横纸 ✅（240×140 识别）
 ├─ G2 纸张方向        ❌ 横纸×纵向：execution=landscape / expected=portrait
 │     └─ 根因：landscape 布尔不可表达横纸型 portrait + normalize 丢弃 executionPaper.orientation
 ├─ G3 内容 rotation   由 E1/E1a 修复（contentRotation 进入 bake）✅ 数值+横纸×横向真机通过
 └─ G4 executor        landscape → rotate=90 ✅ 真机验证（E2）
```

**状态记录**：`C-2-G = BLOCKED`（卡在 G2 Paper Direction）。E IMPLEMENTED 部分（G3/G4/横纸×横向）保持有效，**E1+E1a+E2 不回退**。

---

## 7. 下一次解冻边界建议（仅描述，本次不实施）

修复 G2 的最小改动面（待用户批准）：

1. **electron `normalize`（`print-settings.js:199-205`）**：当 `src.executionPaper?.orientation` 有效时，以其为权威（不再用 `landscape`+`naturalOrient` 重算）；或新增绝对 `paperOrientation` 字段优先于 `landscape` 布尔。
2. **前端源单文件路径**（`usePrint.js`）：把 `plan.paper` 写回 `f.paper`（或 IPC `settings.executionPaper` 直接取自 plan），让交换后的 140×240 真正传到 executor。
3. **UI「纸张方向」语义**：把相对布尔升级为绝对请求方向（portrait/landscape），对横纸型同样可表达纵向。

**冻结边界保持不动**：E1/E1a/E2（`e23107b`）、16 表 resolver、`RotationResolver`、`paper`/`noscale`、其他打印路径。G2 修复与 E 正交，独立 commit。
