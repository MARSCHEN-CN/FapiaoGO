# usePrint 打印任务列表审查（PrintPreviewModel 输入确认）

> 目标（用户收尾指令）：先审查 `usePrint` 实际打印消费的「文件顺序 / 过滤规则 / 单页多票生成入口」，
> 再定 `PrintPreviewModel` 的输入，确保「Preview 什么，Print 什么」。
> 范围：`usePrint.js`（executePrint / doPrint / renderFileToPrintImage）、`printAdapter.buildPrintJobItem`、
> `composePagePlan.js`、`MultiTicketComposer.js`、`SlotLayout.js`、`previewState.computePaperLayout`。
> HEAD：`41d1c96a`。

---

## 一、结论速览

1. **没有 `buildPrintJobs()` 纯函数** —— 真实打印任务列表是 **`executePrint` / `doPrint` 里内联拼装**的。这是「Preview 想消费真实打印列表」的最大障碍：不抽出就必然 re-derive → 漂移。
2. **两条打印入口的过滤规则不一致**（🔴）：`executePrint` 只取 `status==='parsed'`，`doPrint` 取 `parsed || error`。同一按钮不同路径消费不同文件集。
3. **单页多票有两个不同含义**，都要进 `PrintPreviewModel.pages[]`：
   - **多页文档**（1 文件 → N 物理页）：`buildPrintJobItem.pages[]`（`doc.pageCount`）。
   - **多票合一**（N 文件 → 1 物理页）：`doPrint` 按 `groupSize` 分组（`merge2=2/3/3/4/4`）。
4. **几何层早已存在且可复用**（好消息）：`PaperSpec` + `computePaperLayout`(产出 safeMargin 的 `usableRect`) + `computeTicketSlots` + `createPlacement`(fit) + `MultiTicketComposer.composePlans`。`PrintPreviewModel` 应**组合**这些纯函数，而非重写 fit/边距/slot。

---

## 二、文件顺序与过滤规则（你要确认的核心）

### 2.1 Source 管道（`executePrint`，L817 / L822–841）
```
allParsed = files.filter(f => f.status === 'parsed' && (f.printPath || f.path))   // L817
```
- 过滤：仅 `status==='parsed'` 且存在 `printPath||path`。
- 顺序：`files` 数组顺序（无显式排序）。
- 一普二专（L822–831）：
  ```
  specialFiles = allParsed.filter(f => f.invoiceType?.includes('专票'))
  mergedJobs = [...allParsed(round1), ...specialFiles(round2, _jobKey+'_v2')]
  ```
  → **PrintStrategy 在此内联生成**（任务队列语义，非布局），正确，但耦合在 `executePrint` 里。

### 2.2 Merge 管道（`doPrint`，L453–507）
```
parsedFiles = files.filter(f => f.printPath &&
    (f.status==='parsed' || f.status==='error') &&           // ⚠️ 与 2.1 不一致
    !(ofd && !f.docId && !f.previewImage))                    // L453–459
...
groupSize = parseInt(mergeMode.replace('merge','')) || 2      // L493  merge2/3/4 → 2/3/4
forcedLandscape = getForcedLandscape(mergeMode, settings.landscape)  // L495  merge4→横向, 其余→竖向
for (i=0; i<parsedFiles.length; i+=groupSize)
    groups.push(parsedFiles.slice(i, i+groupSize))            // L498–502  ← 单页多票分组入口
```
- **单页多票生成入口就在这**：文件按 `groupSize` 滑窗分组，每组 = 1 物理页、N 个 slot。
- `forcedLandscape` 决定整页方向（**打印方向**，非 previewOrientation）。

### 🔴 R1 — 两条打印入口过滤不一致
`executePrint` 取 `parsed`；`doPrint` 取 `parsed || error`。同一「打印」概念两种口径。
**Why：** 用户点「确认打印」走哪个分支取决于 `mergeMode`/`PRINT_PIPELINE.mode`（L811、L821），Preview 若只对齐其中一种，另一分支就漂移。
**Suggestion：** 把过滤抽进 `buildPrintJobs()`，单一真值：`filterPrintable(files)` 统一口径（建议取 `printPath && (parsed||error)` + OFD docId/previewImage 兜底），`executePrint`/`doPrint` 都消费它。

---

## 三、单页多票生成入口（你要定位的）

| 含义 | 入口 | 产物 |
|---|---|---|
| 多页文档（1→N 页） | `printAdapter.buildPrintJobItem` (L58) → `doc.pages.map(...)` | `pages[]`（每页 1 slot，0-based index） |
| 多票合一（N→1 页） | `doPrint` 滑窗分组 (L498–502) | `groups[]`（每组 groupSize 文件 = 1 物理页 N slot） |
| slot 几何 | `SlotLayout.computeTicketSlots(paperLayout, count)` (L48) | `slots[]`（竖向等分 band，已内缩 `slotSafeInset`） |
| 每票 fit | `fitIntoSlot` → `createPlacement` (SlotLayout L93) / `MultiTicketComposer.composePlans`(L68) | `RenderCommand`（min-contain + 居中 + clip） |

**关键：slot 几何与 fit 已是唯一几何源**（`createPlacement` 被 `fitIntoSlot` 与 `buildRenderCommand` 共用）。这是你要的 `calculateContainTransform` —— **已经存在**，不要重写。

---

## 四、每文件旋转（R2 from 上一份报告，此处确认有源）

- `fileRotations` map（usePreview L65）已传入 `usePrint`（App L149）并在 `renderFileToPrintImage` 用：`rotation = fileRotations[f.key] || 0`（L166）。
- `composePagePlan.fileObjToComposePagePlan` 也按 `rotations[id] || it.rotation` 取每文件角（L46–47）。
- **结论：每文件 rotation 有真值源**，PrintPreviewModel 直接吃 `fileRotations` + 各文件 `key` 即可，slot.rotation 正确。

---

## 五、几何层已存在的积木（PrintPreviewModel 应组合而非重写）

| PrintPreviewModel 字段 | 现有可复用纯函数 | 位置 |
|---|---|---|
| `paper` (size/widthMM/heightMM) | `resolvePaper` | resolvePaper.js |
| `safeMargin` (mm) | `PaperSpec.margins` → `computePaperLayout` 产 `usableRect` | previewState.js:178 / L219 |
| `layout.slots[]`（bounds） | `computeTicketSlots(paperLayout, count)` | SlotLayout.js:48 |
| per-slot fit transform | `createPlacement` via `fitIntoSlot` | composePlacement.js / SlotLayout.js:93 |
| slot.rotation | `fileObjToComposePagePlan`(rotations) | composePagePlan.js:46 |
| 内容图像源 | `resolvePreviewUrl({renderDocId,index},docId)` / `fetchPrintRaster` | App.jsx:178 / printAdapter.js:99 |

**含义**：`PrintPreviewModel` 不需要自己算比例/边距/slot/fit。它只需要：
1. 一个 `buildPrintJobs()` 把「打印实际消费的任务列表」算出来（缺，🔴）；
2. 把每个物理页映射成 `{ PaperSpec, slots:[{fileId,rotation}] }`，复用上面的纯函数渲染。

---

## 六、给 PrintPreviewModel 的输入定义（建议）

```
buildPrintJobs(files, settings, fileRotations)   ← 抽出（缺，🔴）
   │  统一过滤 + 顺序 + merge 分组 + extraSpecial 展开 + 每文件 rotation
   ▼
PrintJob[] = [
  { pageIndex, paperSize, customPaper, landscape(打印向), margins(safeMargin),
    slots: [ { fileId, rotation, pageIndexInDoc? } ] }   // 多票合一
  // 或多页文档：1 文件 → N 个单 slot 页
]

buildPrintPreviewModel(printJobs, previewOrientation)   ← Step 1 要建
   │  纯函数；previewOrientation 只影响视觉，不进 printJobs
   ▼
PrintPreviewPage[] = [
  { paper{size,widthMM,heightMM,orientation:previewOrientation},
    safeMargin,
    layout{type, slots:[{index, bounds, fileId, rotation}]} }
]
```

**三个隔离（你强调的）守住：**
- `ViewerRenderResource`(展示区) ≠ `PrintPreviewRenderResource`(仅内容图像，resolvePreviewUrl) ≠ `PrintExecution`(executePrint/doPrint)。
- 三者共享：`Document identity`(docId/pageId) + `content image` + `PrintConfig`(settings)。

---

## 七、行动项（按优先级）

### 🔴 A1 — 抽出 `buildPrintJobs()` 纯函数（阻塞项）
把 `executePrint`(L817–841) 与 `doPrint`(L453–507) 的「过滤+顺序+merge 分组+extraSpecial 展开+每文件 rotation」抽成单一纯函数。
`executePrint`/`doPrint` 改消费它；`buildPrintPreviewModel` 也消费它 → 真正「Preview 什么 Print 什么」。
**这是本阶段唯一阻塞项**，比先写 `PrintPreviewModel.js` 更前置（否则模型没正确输入）。

### 🔴 A2 — 统一过滤口径（R1）
`filterPrintable` 单一实现，消除 `parsed` vs `parsed||error` 漂移。

### 🟡 A3 — 复用几何层，禁止重写 fit/边距/slot
`PrintPreviewModel` + `SinglePageRenderer`/`TwoUpRenderer` 直接调 `computePaperLayout`/`computeTicketSlots`/`createPlacement`，与 `MultiTicketComposer` 同几何源。

### 🟡 A4 — previewOrientation 与打印方向解耦
模型里 `previewOrientation`(视觉) 与 `printJobs[].landscape`(打印向) 分开存；旋转按钮改 `previewOrientation` 绝不写 `settings.landscape`。

### 💭 A5 — 两类「多」语义在模型里区分
`pages[]` 中显式标记来源：`{kind:'multi-ticket', group:[fileId...]}` vs `{kind:'multi-page-doc', docId, pageIndex}`。

---

## 八、下一步建议

**先落 A1（`buildPrintJobs` 抽取）**，再建 `PrintPreviewModel.js`（Step 1，纯数据，不碰 UI）。
这样模型的输入 = 真实打印任务列表，从根上杜绝漂移。几何层（A3）直接复用，不动。

> 未改动代码（纯审查）。push 由 UGit 接管。
