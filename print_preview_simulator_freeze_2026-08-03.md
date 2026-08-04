# 打印确认页 Print Preview Simulator — 架构冻结 + 打印链验证

**日期**: 2026-08-03 · **状态**: 架构冻结（Architecture Freeze）
**范围**: 打印确认页 Simulator 的模型边界、与真实打印链的契约、以及「Print 什么 ≠ Preview 什么」漂移风险的实测结论。
**前置审查**: `print_chain_review_2026-08-03.md` → `print_confirm_entry_review_2026-08-03.md` → `usePrint_buildPrintJobs_review_2026-08-03.md`

---

## 0. 一句话结论

打印链确实存在**双轨**:**多票合并打印已统一在 `createPlacement`**(Preview≡Print),**但单文件打印默认走 Sumatra 原生 fit(`PRINT_PIPELINE.mode='source'`),完全不经过 `createPlacement`**。

> 你之前标记的「必须验证 renderFileToPrintImage 是否消费 createPlacement」——答案是:**多票路径消费,单文件默认路径不消费**。因此在钉死 `PrintExecutionPlan` 契约前,必须先决定**单文件打印的几何真值源**,否则「Preview 什么,Print 什么」对占比最大的场景不成立。

---

## 1. 实测:四个计算点在打印链的真实落点

| 计算点 | 多票合并路径（active ✅） | 单文件路径（active 默认 ⚠️） | 真值源 |
|---|---|---|---|
| **rotation** | `createPlacement` / `buildRenderCommand` (`renderers.js:762,195`) | `print-source-file` → Sumatra `rotate=N` (`main.js:555` + `PrintService.js:62`) | 两边都有 ✅ |
| **safeMargin** | `computePaperLayout.usableRect` → `createPlacement` (`previewState.js:178`, `renderers.js:1150`) | `main.js` `pdfMargin.process` 烘焙进 PDF(**仅 PDF,OFD 被排除**) | **两套机制** ⚠️ |
| **layout / slot** | `MultiTicketComposer.composePlans` + `computeTicketSlots` (`renderers.js:1151-1152`) | 无(单文件独占一页) | 合并侧有 ✅ |
| **fit** | `createPlacement`(min-contain into usableRect) | **Sumatra `-print-settings fit` 黑盒** | **漂移** ⚠️ |

**关键代码路径**:
- 合并打印: `executePrint`(usePrint.js:812) → `doPrint`(L432) → `renderMergeGroupToPrintImage`(L310, L382 `renderMultipleItemsToCanvas`) → `_renderDirect`(renderers.js:1054) → `canUseSlotComposer`(L1150) → `MultiTicketComposer`+`buildRenderCommand`+`createPlacement`。几何烤进 canvas → `printMergedImages`(PrintService:154) → IPC `print-merged-images`(main.js:765) 写 PNG→PDF(MediaBox 取合并 PDF)→ 打印(不再 re-fit)。
- 单文件打印: `executePrint`(L809) → `PRINT_PIPELINE.mode==='source'`(L821) → `printAllSourceFiles`(L743) → `printSingleSourceFile`(L761) → IPC `print-source-file`(main.js:489) → `createBackend('sumatra')`(L555) + `pdfMargin.process`(PDF only)。

---

## 2. 🔴 门控发现:单文件打印默认不消费 createPlacement

`config.js:8-11`:
```js
export const PRINT_PIPELINE = {
  mode: 'source',    // 'source' | 'legacy'   ← 默认 source
  backend: 'sumatra',
}
```

`PRINT_PIPELINE.mode === 'source'` 时,`executePrint` 走 L821 分支,**绕过 `doPrint`/`renderFileToPrintImage`,直接把源文件丢给 Sumatra**。Sumatra 用自己的 `fit`(contain/actual)和 `rotate` 产出最终像素,JS 侧的 `createPlacement` 完全不参与。

而 Preview(Simulator 计划消费 `PrintExecutionPlan` 渲染)会走 `createPlacement` 的 min-contain-into-usableRect。**两者几何不一致**:
- 边距:Preview 用 `usableRect` 内缩;Sumatra 打印用 `pdfMargin` 只处理 PDF(OFD 漏边距,见 `print_chain_review` R4)。
- fit:Preview = `createPlacement` 公式;Sumatra = 其内部算法。
- 旋转:两边一致(都尊重 rotation)—— 这是唯一不漂的维度。

> **注意**:`renderFileToPrintImage`(usePrint.js:165)其实**已经实现并走 `renderMultipleItemsToCanvas`(createPlacement)**,只是没被 `executePrint` 的 source 默认分支调用(仅 legacy/merge 经 `doPrint` 到达)。即「统一几何」的能力已就绪,缺的是接线与取舍决策。

---

## 3. 冻结架构(用户修正整合版)

### 3.1 命名与职责
- ❌ `buildPrintJobs()` → ✅ **`buildPrintExecutionPlan()`**(避开与 Electron print job 混淆;它产出「打印前已确定的物理页面计划」,不是动作)。
- 消费关系(而非 PrintJobs 树):
  ```
  File List + PrintConfig + fileRotations + 一普二专策略
        ↓ buildPrintExecutionPlan()   [纯函数]
  PrintExecutionPlan
        ↓                    ↓
   Printer              PrintPreviewRenderer
  (CreatePlacement 轨)   (CreatePlacement 轨,共享几何层)
  ```

### 3.2 PrintExecutionPlan 结构(权威)
```js
{
  strategy: { oneNormalTwoSpecial: false },
  pages: [
    { pageType: 'single', paper: { size:'A4' }, printOrientation:'portrait',
      slots:[ { fileId, sourcePageIndex:0, rotation:90 } ] },
    { pageType: 'multi-ticket', paper:{ size:'A4' }, printOrientation:'portrait',
      slots:[ { fileId:'A', rotation:0 }, { fileId:'B', rotation:180 } ] },
  ]
}
```
- `pageType`: `single` | `multi-ticket`(n-up 由 slot 数量决定,不另立 `two-up` 类型)。
- `rotation` 属于 **slot**,不属于 paper/page(符合「旋转发票内容,不旋转纸张」)。

### 3.3 边界铁律（四层隔离，2026-08-03 补充第四层）
```
InvoiceIdentity  ≠  PrintExecution  ≠  PrintPreviewRenderResource  ≠  ViewerRenderResource
```
- 前三层（Viewer / PrintPreview / PrintExecution）**共享**:Document identity + content bytes/image + PrintConfig。
- **第四层 InvoiceIdentity ≠ PrintExecution**：`file.invoiceType` 等票种判定是 **FileList / InvoiceIdentity 层**职责，在流入 PrintExecutionPlan **之前**必须已是归一化稳定字段。PrintExecutionPlan / 打印确认页**只消费**已整理好的打印策略结果（如 `strategy.oneNormalTwoSpecial`），**不重新判定普票/专票**，也不关心 OCR 如何识别、FileList 如何归类。
- 打印确认页只关心：打印哪些文件 / 顺序 / 分组 / slot / rotation / paper·orientation；不关心发票业务字段是否正确、票种如何判定。

### 3.4 safeMargin 不进模型
- ❌ `PrintPreviewModel` 不保存 `{ safeMargin, usableRect }` 坐标。
- ✅ `PrintPreviewRenderer` 在渲染时实时 `computePaperLayout(paperSpec)` 算 usableRect。
- 理由:safeMargin 是**几何约束不是数据**;存坐标会在 A4→A5 / 横竖切换 / 自定义纸 / 改边距时产生 stale layout。

### 3.5 单页多票统一渲染(无 TwoUpPreview.jsx)
- 统一 `PrintPreviewPage → SlotRenderer → createPlacement()`。
- `slotCount=1`(single) / `2`(two-up) / `4`(four-up) 只是 slot 数量差异,几何全走 `computeTicketSlots`+`fitIntoSlot`(= `createPlacement`)。

### 3.6 预览旋转走 previewOverrides,不污染 Plan
- Plan = 打印事实(不可被预览交互改)。
- 预览中用户点旋转 → 写 `previewOverrides[p][slot].rotation`。
- 确认打印时 `ApplyPreviewOverrides(plan, overrides)` → Final Plan,**不可逆操作显式化**。

### 3.7 导航复用
- `PrintPreviewViewport = PreviewCanvas + PageNavigator`(`.page-navigator` 已验证绝对居中)。
- 不放 `PrintConfirmModal → PageNavigator`,而是 Viewport 包裹,展示区/确认页未来都可复用。

---

## 4. 🔴 对 Phase 计划的必要修正(基于实测)

你的 Phase 1 原话:「抽 `buildPrintExecutionPlan()`,**不改打印效果**」。

实测表明:若不先把单文件打印统一到 `createPlacement` 轨,`PrintExecutionPlan→Preview` 与 `PrintExecutionPlan→Print` 对单文件场景会**渲染不同结果**,契约无法钉死。

**修正后的 Phase 1(必须含几何统一)**:
1. 抽 `buildPrintExecutionPlan()`(统一过滤口径 + 顺序 + merge 分组 + 一普二专展开 + 每文件 rotation)。
2. **同步决策单文件打印几何真值源**(门控项,见 §5)。
3. 接线:让 `executePrint` 的单文件分支也走 `renderFileToPrintImage`(已存在的 createPlacement 轨)→ `printMergedImages` 同类机制,而非 Sumatra 原生 fit。

后续 Phase 不变:
- **Phase 2**:`PrintPreviewModel`(Plan → PreviewPage[],不渲染)。
- **Phase 3**:`PrintPreviewRenderer` 复用 `computePaperLayout` / `computeTicketSlots` / `createPlacement`。
- **Phase 4**:接入 `PrintConfirmModal`,替换静态 SVG。

---

## 5. 需要你拍板的一个决策(门控项)

**单文件打印的几何真值源**,二选一:

- **(A) 推荐:统一到 createPlacement 轨**。把 `executePrint` 单文件分支从 `printAllSourceFiles`(Sumatra 原生)改为走 `renderFileToPrintImage`(已实现的 Canvas/createPlacement)→ 合成图 → 打印。优点:Preview≡Print 几何完全一致,符合「看到什么打印什么」;能力已就绪,改动量小。代价:单文件打印从「Sumatra 矢量直送」变为「300dpi 栅格化后打印」,理论上矢量文字锐度略降(实际 A4/300dpi 通常无感)。
- **(B) 接受双轨,Preview 模拟 Sumatra fit**。Preview 侧为单文件专门复刻 Sumatra 的 `fit`/`pdfMargin` 逻辑。缺点:等于再写一套几何,且 Sumatra 版本升级即漂移,**强烈不推荐**。

> 我的建议(A):既然 `renderFileToPrintImage` 已存在且合并轨已验证可用,统一到 createPlacement 是低风险、契合你「共享几何层」主张的做法。merge 轨已证明这条路能打出来。

---

## 6. 下一步(A1 精确范围)

```
A1 = 抽 buildPrintExecutionPlan()  +  [决策 §5]  +  单文件打印接线到 createPlacement 轨
```
- 不改 UI、不碰 PrintConfirmModal 视觉。
- 抽完后 `executePrint` / `doPrint` / `buildPrintPreviewModel` 三方共消费同一 Plan,漂移消除。
- 验收:`verify_dual_track.mjs`(已存在,72 组合)应扩展覆盖单文件 Canvas 轨,确保 createPlacement 几何稳定。

---

## 7. 已确认的「绿地 / 已有」清单
- ✅ 已有(复用,勿重写):`PaperSpec` / `computePaperLayout`(previewState.js:178) / `computeTicketSlots`(SlotLayout.js:48) / `createPlacement`(composePlacement.js:65) / `fitIntoSlot` / `MultiTicketComposer` / `PageNavigator` / `renderFileToPrintImage`(待接线)。
- 🟢 绿地(待建):`buildPrintExecutionPlan()` / `PrintPreviewModel.js` / `PrintPreviewRenderer` / `PrintPreviewViewport` / `SlotRenderer` / `previewOverrides` 状态。
- ❌ 不存在:FileContext/ImportSessionStore 的 `selected/checked` 勾选态(若「只展示勾选的」需先建 selection state)。

---

## 8. A1 审查再确认（架构审查者复核审查报告，2026-08-03 二次通过 ✅）

### 8.1 结论
- **A1（commit `7e176794`）Approve ✅**，无需返工。
- 二次独立复核未推翻 A1，反而证明它满足**投影性质（projection）**：`buildPrintExecutionPlan` 是旧执行逻辑在「打印事实」维度上的同构映射，而非「看起来像抽象」。这是进入 Commit 2/3 的必要条件。

### 8.2 本次最有价值的补充 = orientation 等价性核验
- 最大不确定性已消除：`doPrint` 的 `forcedLandscape`(usePrint.js:491-495) ↔ `buildPrintExecutionPlan` 的 `orientation==='landscape'` **逐字等价**。
- 推论：`old doPrint semantic = new Plan semantic` 成立 → Commit 3 接线不会出现 `Plan != old execution`。
- 这是必须的验证，已在 §3.2 / MEMORY.md 记录。

### 8.3 `source.pageIndex:0` → 标记为 Phase B Gate（语义陷阱，非 A1 bug）
- 现状：A1 Plan 写 `source:{fileId, pageIndex:0}`。当前真实执行是 `Plan → renderer → file.pages[]`（发整文件全部页），所以 `pageIndex:0` 在 A1 阶段无害，但字段语义有歧义（表达「打印此文件」而非「打印第 0 页」）。
- Phase B 风险：若 `PrintPreviewModel` 直接 `plan.pages.map(p => render(p.source.pageIndex))`，5 页 PDF 预览只显第 0 页 → 典型 Preview≠Print 漂移。
- **决策（采用方案 b，改语义不删字段）**：Phase B 把 `pageIndex` 改为展开语义，例如 `source:{fileId, pageRange:'all'}` 或 `source:{fileId, expansion:'document-pages'}`。原因：未来还可能出现「指定打印页范围 / OFD 单页 / 合并文档指定 page」，不要把展开逻辑隐藏。A1 不动。

### 8.4 `_round` 暂不动（架构审查者决策）
- 现状：`extraPages:[{_round:2}]` 带执行语义泄露。
- 决策：**A1 阶段保留**。理由：`source` 打印分 round1(全 parsed) / round2(specialFiles)，属于「一普二专」执行策略的一部分；`strategy.oneNormalTwoSpecial:true` 只声明「存在该策略」而不声明「extraPages 是第二轮」，故 `_round` 当前不是坏设计。未来重构 executor 时可删。

### 8.5 A1.5 加固（Commit 2/3 前必做）
- **黄金快照**：`legacy_executePrint_snapshot.json`，真实业务组合 before/after，防重构只覆盖结构。
- **Execution Equivalence Test（结构等价，比黄金快照更进一步）**：测试 `Legacy Builder == buildPrintExecutionPlan`，而非只测 Plan 自己符合预期。输入相同 `files`，分别由旧逻辑生成 `legacyPages`、新逻辑生成 `plan.pages`，normalize 后比较 `{fileId, slots, orientation}`。
  - ⚠️ 落地点提示：旧逻辑目前内联在 `executePrint`/`doPrint`，无独立函数。最干净的做法是**先把旧逻辑抽成 `buildLegacyPrintPlan(files, settings, ...)` 纯函数**（它正是 Commit 2/3 要替换的部分），再由 equivalence test 与 shadow-mode compare 共同调用。即 A1.5 的抽取动作与 Commit 2 的替换动作共享同一中间产物。

### 8.6 Commit 2 建议：shadow mode（不先删旧逻辑）
- 不要直接删除旧逻辑。采用：`const plan = buildPrintExecutionPlan(...)` + `if(DEBUG_PRINT_PLAN_COMPARE){ compareLegacy(plan, oldResult) }`，仅开发阶段开启。
- 流程：旧逻辑照常执行；新 Plan 只生成、不执行；compare 核对 pages 数量 / 文件顺序 / extraPages / orientation 全部一致后，再删旧。
- 这样 Commit 2 风险最低。

### 8.7 更新后的冻结状态（A1.5 已落地 2026-08-03 commit `ef03951c`）
```
Print Preview Simulator

A1 buildPrintExecutionPlan
  ✅ extracted
  ✅ unit tests
  ✅ filter semantics preserved
  ✅ orientation/groupSize equivalence verified
  ✅ no routing change

A1.5 equivalence hardening
  ✅ golden snapshot (legacy_executePrint_snapshot.json)
  ✅ legacy/new compare (printExecutionEquivalence.test.mjs, 7 用例全过)
  ✅ shadow compare helper (compareLegacyPlan + printPlanCompareEnabled 守卫)

Commit 2  executePrint 替换为消费 Plan（✅ commit 5f92a4fc，shadow mode 守卫）
Commit 3  doPrint 替换为消费 Plan（待做）

A2 Gate
  ⬜ safeMargin
  ⬜ QR
  ⬜ rotation
  ⬜ OFD
  ⬜ small text

A3
  ⬜ single-file Canvas route

Phase B
  ⬜ PrintPreviewModel
```

### 8.9 A1.5 实测发现（非 blocker，记录待办）
- **📝 Observation（在 PrintPreview / PrintExecution 范畴之外）— 一普二专检测 `includes('专票')`**：`executePrint` L824 与 `buildPrintExecutionPlan` L125 均用 `invoiceType?.includes('专票')` 判定专票；`FileList.jsx:68`/`utils.js:322` 的规范判定值也是 `'专票'`，而 OCR/映射产物常为 `'增值税专用发票'`（字序「专用+发票」，`'增值税专用发票'.includes('专票')` 为 `false`）。**此问题归属 FileList / InvoiceIdentity 层的发票身份归一化，不属于 PrintExecutionPlan / 打印确认页范畴**——Plan 契约只要求 `file.invoiceType` 是已归一化稳定字段、输出 `strategy.oneNormalTwoSpecial`，不重新判定票种。A1.5 已用规范值 `'专票'` 写样例使 round2 分支被覆盖，**证明「现状==现状」即足够，无需在 A1/A2/A3 讨论该业务规则是否最优** → 已**移出当前 Gate**，单列 `PRINT-XXX: InvoiceType normalization audit`（FileList 层待办），不在打印确认页改造链路内。
- **💭 样例数据纪律**：真实解析后的 OFD 必有 `printPath`（非仅 `docId`）。`SOURCE_FILE_FILTER`(`printPath||path`) 与 `MERGE_FILE_FILTER`(`printPath`) 都要求 `printPath`，故黄金快照样例给 B.ofd 补了 `printPath`，分组才得 `[A,B],[C,D],[E]`。

### 8.8 下一步顺序（用户定稿）
1. 先补黄金快照 + legacy/new equivalence（A1.5）
2. 再 Commit 2（executePrint shadow 接线）
3. 再 Commit 3（doPrint）
> 保持「每一步都可证明」的节奏。

---

## 9. Commit 2 落地（2026-08-03 commit `5f92a4fc`）

### 9.1 审查结论采纳（用户 A1.5 review）
- A1.5 通过 ✅，进入 Commit 2。
- **Commit 2 目标严格收窄**：只替换 `executePrint` 的 source 分支消费路径。不碰 doPrint / Canvas routing / Sumatra 删除 / renderFileToPrintImage / safeMargin / Plan schema 调整 / invoiceType 修复。
- 边界纪律重申：一普二专 `includes('专票')` 问题是 **FileList / InvoiceIdentity 层票种归一化**范畴（打印确认页只消费 `strategy.oneNormalTwoSpecial`，不重新判定票种），已**移出当前 Gate**；OFD `printPath` 是输入契约观察（过滤器要求 printPath）。两者均保持「证明现状、不修现状」，不混入 Commit 2。

### 9.2 实际改动
- **新增 `frontend/src/print/deriveSourcePrintJobs.js`**（纯函数）：从 plan 派生真实执行 jobs。
  - `deriveSourcePrintJobs(plan, files)`：`round1 = plan.pages`、`round2 = plan.extraPages`，每个 page → `{ ...f, _jobKey: round===2 ? f.key+'_v2' : f.key, _round: round }`。
  - 与旧 `executePrint` L826-829 `mergedJobs` 的 `_jobKey`/`_round` 编码逐字一致（round1=f.key，round2=f.key+'_v2'）。
- **`frontend/src/hooks/usePrint.js` source 分支改写**：
  - `plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings, fileRotations })`
  - 经 `deriveSourcePrintJobs(plan, files)` → `printAllSourceFiles(planJobs)`，仍走 Sumatra 轨（`PRINT_PIPELINE.mode==='source'` 未动）。
  - `allParsed` 守卫保留；旧 `mergedJobs`/`specialFiles` 内联逻辑已固化在 `buildLegacyPrintPlan`（Oracle 文件），不在 executePrint 重复、不删除（待 Commit 3 + A2 Gate 前清理）。
  - DEV 守卫（`import.meta.env.DEV && localStorage.DEBUG_PRINT_PLAN_COMPARE==='1'`）下双重影子比较：① 模型级 `compareLegacyPlan`；② 消费序列级 `_jobKey` 比对（防 executor 漏消费 plan 字段）。
- **新增 `frontend/test/sourcePrintJobs.test.mjs`**（4 用例全过）：锁定源执行序列 `[A,B,D]`（非 extraSpecial）/ `[A,B,D,D_v2]`（extraSpecial）与 legacy 一致，验证 `_round`/字段透传/顺序。

### 9.3 ESM 纪律发现并修正
- 交叉校验抓到 import 路径 bug：初版把 `deriveSourcePrintJobs` 误从 `compareLegacyPlan` 导入（实际在 `deriveSourcePrintJobs.js`），Node ESM 会在加载时报 `does not provide an export named 'deriveSourcePrintJobs'`。因 node 测试不加载 React hook `usePrint.js` 而漏检，已修正并写一次性脚本验证 4 个 print 模块导出符号全部解析、`deriveSourcePrintJobs` 与 `compareLegacyPlan` 正确分离。

### 9.4 未改事项（守住边界）
- 打印路由（source/Sumatra）未变；`buildPrintExecutionPlan` 未动；`renderFileToPrintImage`、`safeMargin`、`invoiceType` 判定、Plan schema 均未触碰。
- 生产构建无 debug 分支（`printPlanCompareEnabled` 在 production 不可达）。

### 9.5 当前冻结状态
```
A1        ✅ DONE (7e176794)
A1 review ✅ DONE
A1.5      ✅ DONE (ef03951c)
Commit 2  ✅ DONE (5f92a4fc) — executePrint source 分支消费 plan + deriveSourcePrintJobs + 影子比较
Commit 3  ✅ DONE (adb7759e) — doPrint merge 分支消费 plan + deriveMergePrintJobs + 影子比较
A2 Gate   ⏸ WAIT
A3 Canvas ⏸ WAIT
Phase B   ⏸ WAIT
```

---

## 10. Commit 3 落地（2026-08-03 晚，commit `adb7759e`）

### 10.1 用户定稿边界（沿用 Commit 2 纪律）
- 只替换 `doPrint` 的 **merge 分支**消费路径；让 `doPrint` 使用已证等价的 MERGE Plan。
- **❌ 红线（全部属 A2/A3）**：不碰 `renderMergeGroupToPrintImage` / `renderMultipleItemsToCanvas` / `MultiTicketComposer` / `createPlacement`；不修 safeMargin；不切 `PRINT_PIPELINE.mode`='source'；不删除旧 merge 变量（固化为 Oracle 文件）。

### 10.2 实际改动
- **新增 `frontend/src/print/deriveMergePrintJobs.js`**（纯函数）：`deriveMergePrintJobs(plan, files)` → 对 `plan.pages` 每页按 `slots[*].fileId` 反查文件对象，输出 `[{ files:[A,B], groupIndex:0, orientation }, ...]`。分组顺序/成员/方向完全由 plan 决定（plan 已证与 doPrint L493-502 `parsedFiles.slice` 滑窗分组等价）。
- **`frontend/src/hooks/usePrint.js` merge 分支改写**：
  - `plan = buildPrintExecutionPlan(files, { filter: MERGE_FILE_FILTER, settings, fileRotations })`
  - `mergeJobs = deriveMergePrintJobs(plan, files)` → `printQueueRef.current.pending = mergeJobs.map(j => assignTaskId(j.files))`（仍 Canvas 轨；`renderFn` 用旧 `groupSize` 调用的 `renderMergeGroupToPrintImage(task.data, ipc, groupSize)` **未变**）。
  - `parsedFiles` 守卫 / `groupSize` / `forcedLandscape` 保留作不变量（分别用于状态更新、renderFn 调用参数、mergedPrintFn 方向）；旧 `parsedFiles.slice` 滑窗逻辑已固化在 `buildLegacyPrintPlan`（Oracle 文件），不在 doPrint 重复、不删除。
  - DEV 守卫（`import.meta.env.DEV && localStorage.DEBUG_PRINT_PLAN_COMPARE==='1'`）下复用 `compareLegacyPlan` 影子比较（merge 模式 `match=true`，只 warn 不 throw，绝不进 production）。
- **新增 `frontend/test/mergePrintJobs.test.mjs`**（10 用例全过）。

### 10.3 最关键等价测试（用户定稿）
> legacy doPrint executor input == new plan executor input

即旧 `parsedFiles.slice(i, i+groupSize)` 产生的分组参数序列，必须等于 `deriveMergePrintJobs(plan, files)` 产生的分组序列。测试以 `buildLegacyPrintPlan`（A1.5 Oracle）为唯一 legacy 基线（**不在测试里重写第二份旧逻辑**），断言两者 `fileIds`/`orientation`/`rotation` 归一化后逐组相等。

### 10.4 Merge Execution Snapshot（用户要求）
- `[A,B,C,D,E] merge2` → `[["A","B"],["C","D"],["E"]]` ✅
- `[A,B,C,D,E] merge4` → `[["A","B","C","D"],["E"]]` ✅
- 另覆盖 merge3、error 文件参与、OFD 需 docId、orientation(merge4→landscape)、groupIndex 连续、rotation 透传、compareLegacyPlan merge match。

### 10.5 未改事项（守住边界）
- 渲染/CANVAS 全链路未触碰；`PRINT_PIPELINE.mode` 未动；`renderFileToPrintImage` 未接线到 source（仍 Sumatra 轨）；生产构建无 debug 分支。
- 测试全过：merge 10 + 等价 7 + source 4 = **22/22**；ESM 交叉校验 8 个 import 符号全解析、`deriveMergePrintJobs` 与 `compareLegacyPlan` 正确分离。

### 10.6 当前冻结状态
```
A1        ✅ (7e176794)
A1.5      ✅ (ef03951c)
Commit 2  ✅ (5f92a4fc)
Commit 3  ✅ (adb7759e)

========= 中间层 PrintExecutionPlan 完成 =========

A2 Gate   ⏸ WAIT
A3 Canvas ⏸ WAIT
Phase B   ⏸ WAIT
```
> 到此 `executePrint` 与 `doPrint` 两条打印入口**都已消费同一个 PrintExecutionPlan**，中间层真正落成。下一步进 A2 Gate（验证 Canvas 接管条件：安全边距对齐 / QR / rotation / OFD / 小字可读），**不要提前碰 `renderFileToPrintImage` 路由**。

## 11. A2 Gate 设计冻结（2026-08-03 晚，用户定稿）

### 11.1 A2 定位（用户原话）
> A2 不是"验证 Canvas 能不能打印"，而是"**证明 Canvas 可以替代 source 单文件轨，而不会改变用户看到的纸张结果**"。
> Gate 先证明，A3 再切换。**先做 A2-G0：建立锚样本 + Gate 验收脚本框架，不改任何打印代码。**

### 11.2 验收子项结构（用户定稿）
```
A2 Gate
 |
 +-- G0 环境冻结（锚样本 + 验收脚本框架）          ← 本阶段
 +-- G1 safeMargin measurement（唯一架构风险，先测）
 +-- G2 rotation
 +-- G3 OFD
 +-- G4 QR
 +-- G5 small text
 +-- G6 multi-page
```
- **G1 必须最先测 safeMargin**：内容边界到纸边四边（left/right/top/bottom，单位 mm），目标 `abs(canvasMargin - sourceMargin) <= 0.5mm`。不要先测清晰度/QR/肉眼——边距是唯一架构风险（source 轨 pdfMargin 烘焙 vs Canvas 轨 createPlacement 两套机制）。
- 其余子项（清晰度/QR/肉眼）放 G1 之后，按矩阵顺序推进。

### 11.3 锚样本集（用户定稿 A1–A6）
| 锚 | 规格 | 来源盘点（2026-08-03 实测） |
|---|---|---|
| A1 | 普通 PDF 单页 | ✅ 现成：`test_fixtures/25952000000127675627.pdf` / `25312000000184209689.pdf` |
| A2 | OFD 单页 | ❌ **缺失**：工作区无任何 .ofd 文件 → 需用户提供真实样本 |
| A3 | PDF 多页 | ✅ 现成：`frontend/public/test.pdf` / `dist/test.pdf`（页数待 G1 标定） |
| A4 | 旋转 90° | ✅ **不需要独立文件**：rotation 是打印参数（`slot.rotation`），非文件属性 → 用 A1 文件 + rotation=90 |
| A5 | 二维码票 | ⚠️ 待标定：现有 4 个真实 PDF 中是否含二维码，G1 标定后确认；缺失则需用户提供 |
| A6 | 小字体票 | ⚠️ 同上 |

### 11.4 锚样本存放与入库策略（冻结）
- **真实发票不入库**：`.gitignore:15` `test_fixtures/`、`.gitignore:16` `**/tests/*` 已忽略真实 PDF/OFD。
- 锚样本留在 gitignored 目录（沿用 `test_fixtures/`），**Gate 框架引用路径，不复制文件**。
- 入库的只有：框架代码（`frontend/test/printGate/*.mjs`）+ manifest（`.mjs` 格式，避免 `*.json` gitignore 坑）。

### 11.5 Gate 从 Plan 出发（用户强调的关键架构点）
```
files
 ↓
buildPrintExecutionPlan        ← 唯一事实源（Commit 2/3 后已成）
 ↓
      ↙                 ↘
legacy executor       canvas shadow executor
      ↓                 ↓
 Sumatra output      Canvas output
      ↓                 ↓
     └──── compare（tolerance）────┘
```
> A2 Gate 的 shadow render **不应从 files 开始**——否则 Gate 自己又复制一套打印语义。必须从 `PrintExecutionPlan` 开始，legacy 与 canvas 双执行器共享同一 Plan 事实。

### 11.6 G0 交付物（本阶段，commit 后）
1. 冻结文档 §11（本文件）
2. `frontend/test/printGate/gateConfig.mjs` — 容差配置（`SAFE_MARGIN_TOLERANCE_MM=0.5`）+ 锚样本路径约定
3. `frontend/test/printGate/measureMargins.mjs` — 纯函数：内容包围盒 + 纸张尺寸 + 分辨率 → 四边 margin(mm)（G1 直接复用）
4. `frontend/test/printGate/anchorManifest.mjs` — 锚样本清单（A1-A6 规格/来源/缺失标记）
5. `frontend/test/printGate/gateFramework.test.mjs` — 框架自检（测量纯函数单测 + manifest 结构校验 + 双执行器比较管线结构）

### 11.7 边界（G0 红线）
- ❌ 不改任何打印代码（renderFileToPrintImage / renderMultipleItemsToCanvas / createPlacement / safeMargin / PRINT_PIPELINE.mode / usePrint.js 全部不碰）。
- ✅ G0 产出全部在 `frontend/test/printGate/`（测试目录，纯 node 可跑，不接 React/Electron）。
- ⚠️ 真实双轨输出采集（Sumatra vs Canvas 实际打印/渲染对比）需要 Electron 环境，属 G1 执行阶段，G0 只交付框架与纯函数。

### 11.8 当前冻结状态（更新）
```
A1        ✅ (7e176794)
A1.5      ✅ (ef03951c)
Commit 2  ✅ (5f92a4fc)
Commit 3  ✅ (adb7759e)
========= 中间层 PrintExecutionPlan 完成 =========
A2-G0     ✅ (8c6da15e) 锚样本盘点 + Gate 框架（A2 OFD 已补样本）
A2-G1     🔒 APPROVED / IN PROGRESS（safeMargin 第一测量）
A2-G2..G6 ⏸ WAIT
A3 Canvas ⏸ WAIT
Phase B   ⏸ WAIT
```

## 12. A2-G1 设计冻结（2026-08-03 晚，用户批准进入 G1）

### 12.1 目标（用户定稿）
> 验证：同一个 PrintExecutionPlan → source executor / canvas shadow executor → Sumatra 输出 / Canvas 输出 → 四边内容边界距离纸边 `|margin_canvas - margin_source| <= 0.5mm`。
> **只比较 content bbox（px→mm），不比像素。** 不改打印链，只增加 Gate 测量能力。

### 12.2 实测确认的采集落点（源码实读 2026-08-03）
| 侧 | 调用点 | 产出 |
|---|---|---|
| source | `electron/main.js:522-538` `pdfMargin.process(target.filePath, margins, isImage, orient)`（`imgExts` 含 pdf/png/jpg/bmp/tiff，**不含 .ofd**）| 烘焙边距后的 PDF（`marginResult.path`）→ 光栅化 → bbox |
| canvas | `usePrint.js:174` `renderFileToPrintImage`：PDF `ipc.invoke('read-file')`→`renderMultipleItemsToCanvas`（不传 paperLayout→createLayout 用 settings.margins）；OFD `fetchPrintRaster(docId, pageIndex)`+同款 canvas 渲染 | canvas → 像素 → bbox |

### 12.3 测量链路（纯函数，已实现+测试）
```
canvas/source 输出位图
  → findContentBBox(pixels, w, h)    像素矩阵→内容 bbox（新增，G1 核心）
  → measureMarginsPx(bbox, paperPx)  bbox→四边边距 px
  → marginsToMm(marginsPx, GATE_DPI) px→mm（GATE_DPI=300 与 Canvas 轨 PREVIEW_DPI 一致）
  → assertSafeMarginAlignment(canvasMm, sourceMm, 0.5)  四边 |diff| ≤ 0.5mm
```

### 12.4 第一批验收表（用户定稿，3 组）
| # | 文件 | 类型 | rotation | 目标 |
|---|---|---|---|---|
| 1 | A1 | PDF | 0 | 基准 |
| 2 | A2 | OFD | 0 | **OFD Canvas 路径验证**（两边不同源的关键项） |
| 3 | A1 | PDF | 90 | 旋转边距方向 |

### 12.5 OFD 样本的特殊意义（用户强调，记录在案）
- source：Sumatra + pdfMargin（**imgExts 不含 .ofd → source 轨 OFD 无安全边距，边距=0**）
- canvas：fetchPrintRaster(docId) + createPlacement（createLayout 用 settings.margins → 有边距）
- **A2 验证的不是"两边一致"，而是"Canvas 轨是否补足 source 轨没统一处理的 OFD 边距语义"**——它是能力验证，不是普通兼容测试。G1 预期：OFD 组可能 diff > 0.5mm 且这是**结构性预期**（source 0 vs canvas margins），结果解读须区分「对齐失败（真 bug）」与「OFD 语义补足（预期差异）」。
- 具体判定规则：OFD 组记录实测边距值并对比 settings.margins 设定值；若 canvas OFD 边距 ≈ settings.margins（±0.5mm）则视为 **补足成功**（A2 通过），而非与 source 对齐。

### 12.6 G1 执行约束（冻结）
- ❌ 不改任何打印代码（renderFileToPrintImage / renderMultipleItemsToCanvas / createPlacement / main.js / PRINT_PIPELINE.mode / usePrint.js 全部不碰）。
- ✅ G1 只新增：测量纯函数（已落地）+ 采集编排（需 Electron 环境，待执行）。
- 采集方式待用户确认：一次性 dev 脚本（Electron 内跑双轨渲染导出位图）vs 手动导出 PNG 后跑测量。

### 12.7 G1 采集器落地（commit `79d102e2`，2026-08-03 晚）
- 方案 A（用户批准）：`frontend/test/printGate/` 新增 `gateCases.mjs`（3 组）+ `collectGateOutput.mjs`（source 轨纯 node 可跑 / canvas 轨需 Electron）+ `rasterize_pdf.py`（fitz→RGBA）+ `README.md`；`.gitignore` 忽略 `artifacts/`。
- source 轨实现：**不 require 生产 pdf-margin-processor.js**（其依赖 temp-manager→electron app，纯 node 不可加载），改为**直接调 `scripts/add-pdf-margins.py`，execFile 参数与 pdf-margin-processor.js L237-245 逐字一致**（即与 main.js:536 生产调用等价），output 写 caseDir。
- **实测产出 3 个 source artifact，4 个生产语义确认（冻结）**：
  1. **A1 是专用发票纸** `paperActualPx=2717×1890@300dpi`（≈230×160mm，**非 A4**）——纸边必须用光栅化实际尺寸，不能假设 A4（初版假设 A4 导致 bbox 越界报错，已修正）。
  2. **source 边距非对称**：A1 L14.3/T16.0/R10.6/B17.0mm（settings 10mm + 发票内容自身页内非居中留白）——`add-pdf-margins.py` 语义 = **扩展页面尺寸、内容位置不变**（L189），非 contain-fit。非对称是真实语义不是 bug。
  3. **OFD source 轨无边距**（main.js:512 imgExts 不含 .ofd）+ fitz 不支持 OFD → A2 source bbox **需后端 Render Contract（fetchPrintRaster）补采**，node 侧仅语义基线。
  4. **source 轨 rotation 由 Sumatra 原生处理**（不在 PDF 内容中）→ node 采集的 bbox 不体现旋转；**A1-rot90 旋转方向验证必须走 canvas 轨**（renderMultipleItemsToCanvas rotations 参数）。
- 待办：canvas 轨采集需 Electron 环境注入（README 已写接入指引）；A2 source bbox 待后端补采。

### 12.8 当前冻结状态（更新）
```
A1/A1.5/Commit2/Commit3  ✅（中间层落成）
A2-G0     ✅ (8c6da15e)
A2-G1     source 轨 ✅ (79d102e2) — 3 source artifact + 4 生产语义确认
          canvas 轨 ✅ 采集器+分析器 (a76b11e6) — 待 Electron 环境执行产出真实 canvas artifact
          OFD 补采 ⏸ G1-B（待后端 Render Contract）
A2-G2..G6 ⏸ WAIT
A3 Canvas ⏸ WAIT
Phase B   ⏸ WAIT
```

## 13. A2-G1-CANVAS-1 落地（2026-08-03 晚，commit `a76b11e6`）

### 13.1 用户定稿边界（单变量纪律）
- 只闭环 canvas 主链（A1 PDF rot0 / rot90），**OFD 不并行**（变量混入风险，G1-B 单独做）。
- canvas 采集不做手动 DevTools 注入（参数漂移 + makeItem 隐藏风险），改为**固化 makeItem + 生产同款调用序列**的采集器。

### 13.2 交付
- `frontend/test/printGate/electron/collectCanvasOutput.js`：makePrintItem 固化 usePrint.js:180-278 三分支（PDF read-file→_pdfData / OFD buildPrintJobItem+fetchPrintRaster→_previewImageUrl / Image read-file→blob）；renderMultipleItemsToCanvas 8 参数调用序列与 usePrint.js:288-298 **逐字一致**（slotCount=1 / isPrint=false / showSafeMargin=false / layoutOptions）；产出 artifact(bbox+marginMm)+pngBytes；经 `globalThis.__GATE_REPO_ROOT__`（磁盘路径）+ `__GATE_WRITE__`（写盘）注入。
- `frontend/test/printGate/analyzeGateOutput.mjs`：canvas vs source 对比报告。**双判定**：PDF=对齐 `|canvas-source|≤0.5mm`；OFD=补足语义 `canvas≈settings.margins±0.5mm`（§12.5）。mock 验证 2/3（PASS/FAIL 检测正确）。
- 已确认：renderers.js 无 React 依赖、导出 renderMultipleItemsToCanvas 存在；printAdapter 导出 buildPrintJobItem/fetchPrintRaster 存在（ESM 交叉校验）。

### 13.3 运行方式（Electron dev）
1. `npm run dev`（vite:5173 + Electron）
2. devtools console：`globalThis.__GATE_REPO_ROOT__ = 'E:/print706/'`
3. `const { collectCanvasCases } = await import('/test/printGate/electron/collectCanvasOutput.js')`
4. `await collectCanvasCases()` → console 输出 bbox+marginMm，pngBytes 手动/`__GATE_WRITE__` 落盘
5. node 侧 `node analyzeGateOutput.mjs` 生成对比报告

### 13.4 已知限制（记录在案）
- `buildPrintJobItem` 依赖 DocumentStore（docId）→ OFD case 需应用内已解析该 OFD；纯文件流 OFD 无法走 canvas docId 分支（G1-B 处理）。
- vite `?url` import（pdf.worker）→ 采集器必须在 vite/Electron 环境，纯 node 不可加载 renderers.js。

## 14. A2-G1 第一份对比报告（2026-08-03 晚，`print_gate_g1_report_2026-08-03.md`）

### 14.1 结论（冻结）
**Canvas 轨 vs source 轨边距严重不对齐（0/2 PASS，最大差 74.5mm），根因=纸张语义不同，非渲染 bug。** 这正是 G1 要暴露的核心架构风险。

### 14.2 实测数据
| Case | source mm (L/T/R/B) | canvas mm (L/T/R/B) | 最大差 | 判定 |
|---|---|---|---|---|
| A1-rot0 | 14.3/16.0/10.6/17.0 | 4.2/83.5/3.9/91.5 | 74.5 | 🔴 FAIL |
| A1-rot90 | 14.3/16.0/10.6/17.0 | 74.8/47.8/74.2/49.3 | 63.6 | 🔴 FAIL |
| A2-rot0 | 语义基线 | 未采集（G1-B） | — | ⏸ |

### 14.3 根因三层（实测+源码实读）
1. **纸张不同**：source=`add-pdf-margins.py` 扩展页面尺寸（L189 内容位置不变）→ 专用发票纸 230×160mm+10mm；canvas=`createLayout`（renderers.js:1183）按 paperKey='A4' → 210×297mm。
2. **内容不缩放**：canvas 内容 2404×1483px ≈ source 原 2423×1500px（比率≈1.0）——createLayout 按真实尺寸贴入 A4 垂直居中（canvas T=83.5/B=91.5mm = A4 高余量的一半）。
3. **旋转位置不同**：source=Sumatra 原生（node 采不到）；canvas=rotations 参数 → **A1-rot90 canvas 方向正确 ✅（利好：A3 切轨后旋转语义更明确）**。

### 14.4 对 A3 的含义
A3 切 Canvas 轨前必须解决「纸张语义统一」，候选：
1. **A3 接线时传 `printPaperLayout`（含 usableRect）**——冻结 §11 头号风险落地，canvas 轨走 MultiTicketComposer+buildRenderCommand（renderers.js:1018 paperLayout 参数已就绪）
2. 或 gateCases 改用 `customPaper`(230×160mm) 采集 canvas 做「同纸张下边距对齐」对照实验（A2 下一步）

### 14.5 G1-CANVAS-2 同纸张实验（2026-08-03 晚，commit `2478e660` case + `814f24ad` 附录 A）
- **实验**：A1-customPaper（`paperSize='Custom'`+`customPaper{widthMM:230,heightMM:160}`）同纸张下验证 canvas≈source ±0.5mm。
- **实测 FAIL 且更差**：canvas 内容被缩到 53.5%（1296×799px），边距 60.7/45.0/62.4/48.3mm。
- **根因（源码实读 renderers.js:513-517 + layout.js:25）**：`renderPDFPageRaw` L515 `getPaperPixels(paperKey, dpi, isLandscape)` **未传 customPaper** → `paperKey='Custom'` 回退 A4（PAPER_SIZE_MAP 无 'Custom'）→ PDF 先渲染进 A4 画布 → 再被 createLayout fit 进 230×160 slot → **双重 fit scale=1890/3508=0.539**（实测 0.535 吻合）。
- **结论升级**：G1-CANVAS-2 把问题从「纸张语义不同」推进到「渲染器缺陷：renderPDFPageRaw 不支持 customPaper 透传」。A3 除 `settings.paperSize→PrintExecutionPlan.paperLayout` 外，**还需修 renderPDFPageRaw**（传 customPaper 或单文件用 PDF 原生页尺寸——L518-524 `paperKey=null` 分支已存在）。
- **解释未暴露原因**：生产 merge 轨全 A4（paperKey 有效），单文件 source 轨走 Sumatra 不经此路径 → 缺陷只在 Gate 的 customPaper 路径暴露。

### 14.7 G1-CANVAS-3A（2026-08-03 晚，DEV patch `5d899d18` + 附录 B `abfbe4ff`）
- **实验**：DEV-only 临时 patch renderPDFPageRaw 透传 customPaper（加第 6 参 + getPaperPixels 透传 L516 + 两调用点），重跑 A1-customPaper。
- **结果**：内容 53.5%→108%（`scale=min(2717/2480,1890/1654)=1.096` 与实测吻合）→ **customPaper 透传修复确认 ✅（3A 通过=画布尺寸恢复）**；但同纸张边距仍差 9.7mm（canvas L4.7/T9.8/R6.1/B12.7 vs source L14.3/T16/R10.6/B17）。
- **残余差异=内容放置语义**：canvas 是「PDF contain-fit 填满画布+居中」（renderers.js:544-556），source 是「内容原位+外扩 10mm」（add-pdf-margins L189）——**两种布局哲学，同纸张也无法对齐**。
- **结论升级（冻结）**：A3 仅「纸张语义统一」不够，还需「内容放置语义统一」= 单文件分支用 PDF 原生页尺寸渲染（paperKey=null 分支已有 L518-524）+ 纸面外扩。G1-CANVAS-3B（paperKey=null 原生渲染）是下一验证点。
- 注：此 patch 是验证用，**A3 决策后决定保留或回滚**（当前 DEV patch 已提交但标注临时）。

### 14.8 G1-CANVAS-3B（2026-08-03 晚，DEV patch `4d1284b8` + 附录 C `0578dc6f`）
- **实验**（用户定稿，最后一个纯验证实验）：`renderPDFPageRaw(paperKey=null)` native 渲染，单变量验证「尺寸恢复是 renderer 原生能力」；不做 +10mm 模拟/不建 source replica。
- **结果：3B PASS ✅**（用户实测 + analyzeNativeOutput）：
  - bitmap **2480×1654**（PDF 原生页 210×140mm，无扩展）
  - content ratio **w=1.0 / h=0.999**（native 内容 = source 内容 2423×1500，尺寸完美恢复）
  - bbox offset **dx=dy=-118px = 恰好 10mm 外扩（118.1px@300dpi）**
- **决定性推论（冻结）**：source 语义 = 「native 渲染 + 纸面外扩（内容不变）」= add-pdf-margins 语义（扩展 MediaBox 内容位置不变）。**A3 = 接线 native renderer**（paperKey=null 分支已有 L558）+ paperLayout 提供「原生页+边距」纸面几何（renderers.js:1018 已就绪）——**无需 RenderPlacementAdapter/PrintRenderContract 新模型**（那是 3B FAIL 才需要）。
- 架构收益（用户记录）：同一 ParseResource 两个 RenderResource 语义不同（source=扩页+原位 / canvas=纸画布+fit+居中）→ 正因如此 PrintRenderContract 原则必要，但 3B 证明 canvas 原生分支已满足 source 语义，A3 只接线不建新模型。

### 14.9 A2 Gate 完整结论（G0-G1-CANVAS-3B 全部完成）
```
A2-G0      ✅ 框架+锚样本（8c6da15e）
A2-G1      ✅ source 采集（79d102e2）+ canvas 采集链路 + 报告1（纸张语义 FAIL）
A2-G1-CV2  ✅ 同纸张实验（2478e660）→ 发现 renderPDFPageRaw customPaper 缺陷
A2-G1-CV3A ✅ patch 确认修复（5d899d18）→ 残余=内容放置语义
A2-G1-CV3B ✅ native 渲染 PASS（4d1284b8 + 0578dc6f）→ A3=接线 native renderer
A2-G2..G6  ⏸（QR/rotation/OFD/小字/多页——部分被 G1 系列覆盖，待 A3 后复验）
A3         ⏸ 接线：单文件分支 → native render + paperLayout（目标明确）
Phase B    ⏸
```

### 14.10 A2-G1 FINAL 冻结（2026-08-03 晚）+ A3 设计 Spec（`a3_design_spec_2026-08-03.md`，commit `d0141fb9`）
- **A2-G1 正式关闭**（用户定稿）：不是"测出来能跑"，而是把 source/canvas 两轨隐含 Render Contract 差异拆出并证明最小统一路径存在。
- **冻结契约**：
  - Source Contract = PDF native page + paper expansion（内容位置不变）
  - Canvas Target Contract = PDF native render + paperLayout placement（offset = margins）
  - 禁止：contain-fit PDF 到纸张 / renderer 内隐藏纸张转换 / 重复实现 margin expansion
- **DEV patch 处置**：✅ 保留 renderPDFPageRaw export（A3-2 需 native branch）；✅ 回滚 customPaper 透传（G1-CV3B 证明非最终方案，防 native+customPaper 歧义路径）——已执行（renderers.js 恢复 5 参签名）。
- **A3 Commit 拆分**：A3-1 接线层（usePrint 传 paperLayout，不改 renderer，snapshot 不变）→ A3-2 native single renderer（paperKey=null，验证 ratio≥0.99）→ A3-3 placement alignment（createLayout/compose，验证 margin≤0.5mm）。
- **最大风险**：rotation + paperLayout 未验证（G1 只验了 native 无旋转）→ A1 rot90 进第一批 Gate。
- **验收矩阵**：A1 0°（基线）/ A1 90°（rotation）/ A2 OFD（G1-B 后补）/ merge2 / merge4（不回归）。

### 14.11 A3-1 落地（2026-08-03 晚，commit `a896f50c`）
- **范围**（用户批准 + Spec §8）：`renderFileToPrintImage` 构造统一纸面几何（`computePaperLayout` 与 merge 轨 L382-389 同款），作为返回 job 的 `paperLayout` 携带——**数据链路贯通、bitmap 零变化**（未传 renderMultipleItemsToCanvas 第 10 参，渲染路径不动）。
- **Gate 验收**：A3-1-01（静态断言：构造+携带+单文件调用无 printPaperLayout）✅、A3-1-02（回归 55/55）✅、A3-1-03（无新 paperKey/customPaper 分支）✅。
- **红线守住**：未改 renderMultipleItemsToCanvas 算法 / pdfMargin / Sumatra / customPaper / 新 fit 逻辑。paperLayout 最小结构（computePaperLayout 输出）；coordinateSpace/sourceOrigin 预留 A3-3。
- 下一步：A3-2（native single renderer，paperKey=null，验证 ratio≥0.99；完成后立即测 A1 0°/90° rotation）。

### 14.12 A3-2 落地（2026-08-03 晚，Gate 工具 `171f850e` + 附录 D `55de9239`）
- **双 Gate PASS**（用户实测 + analyzeNativeOutput）：
  - A3-2-01 (rot0)：content ratio **w=1.0 / h=0.999**，bitmap 2480×1654（原生页）→ native renderer 复现 G1-3B ✅
  - A3-2-02 (rot90)：bitmap 1654×2480（宽高互换）、content ratio (swapped) **w=0.999 / h=1.0**、bbox 无负坐标 → **R1 rotation 风险解除 ✅**
- **结论**：native renderer 资源层正确（尺寸 + 方向），分层验证「先资源后放置」成立。
- **A3-3 路线确定**：native bitmap + paperLayout coordinateSpace/sourceOrigin（contract 预留）+ 10mm expansion offset = source 等价输出；无需 RenderPlacementAdapter。
- 状态：A3-1 ✅ → A3-2 ✅（R1 解除）→ **A3-3 ⏸ placement alignment（margin≤0.5mm）**。

### 14.13 A3-3 Design Spec 冻结（2026-08-03 晚，commit `cd937048` 追加 a3_design_spec §A3-3）
- **用户定稿**：A3-3 是首次改变「内容在纸面位置语义」，先定义 Placement Contract → Gate → 再接生产路径，不直接改 renderMultipleItemsToCanvas。
- **新增 PlacementAdapter 层**：`RenderResource(native bitmap) → PlacementAdapter(paper coordinate space) → draw command offset → Canvas`。原则 resource ≠ placement。
- **paperLayout contract 扩展**：`coordinateSpace:{name:"paper",origin:"top-left"}`（不重新定义坐标系）+ `sourceOrigin:{x:10,y:10,unit:"mm"}`（第一阶段只消费 sourceOrigin）。
- **坐标事实冻结**：paper = native + 20mm（10mm×2@300dpi=118px），内容偏移=(118,118)px。
- **三 Gate**：A3-3-01 offset（dx≈118px）/ A3-3-02 margin（四边≤0.5mm）/ A3-3-03 rot90 offset 坐标系（最大风险：rotation 后 sourceOrigin 可能需 (x,y)→(y,-x) 变换）。
- **三 Commit**：A3-3-1（只加 sourceOrigin 不消费）/ A3-3-2（PlacementAdapter rot0）/ A3-3-3（rotation transform）。
- 红线：不改 PDF renderer / renderPDFPageRaw / margin 生成 / Sumatra / MultiTicketComposer / createLayout 通用行为。

### 14.14 A3-3-1 落地（2026-08-03 晚，commit `a7cad7fc`）
- **范围**（用户批准，contract-only）：新增 `frontend/src/print/paperLayoutContract.js`（`extendPaperLayoutContract` 附加 `coordinateSpace{name:'paper',origin:'top-left',unit:'mm'}` + `sourceOrigin{x,y,unit:'mm'}`；`validatePaperLayoutContract` 自检）。usePrint 的 A3-1 构造点改经 contract 扩展（sourceOriginXMM/YMM 由 settings.marginLeft/Top 派生）。
- **⚠️ 语义区分冻结**：sourceOrigin = source 语义（原始 PDF 内容相对扩展纸面偏移）**非 margin**（布局约束）——数值可能相同（10mm）但语义不同，混淆会导致 A5/自定义票据/非对称扩边/裁切区域回归。
- **Gate**：A3-3-1-01 contract presence ✅ / A3-3-1-02 bitmap invariant（渲染调用仍无 paperLayout 第 10 参）✅ / A3-3-1-03 source semantic declaration + offset pending（未消费）✅。修复 A3-1-01 过时断言。
- 回归 58/58。未消费 sourceOrigin（A3-3-2 PlacementAdapter 才消费）。

### 14.15 A3-3-2 落地（2026-08-03 晚，commit `4f7d61ba`）
- **① PlacementAdapter 纯层**（`frontend/src/print/placementAdapter.js`）：`applySourceOriginPlacement` 生成 drawRenderCommand 兼容的 PlacementCommand（`placement.offsetX/Y`=sourceOrigin 位移、`scale=1`、`rotatedBounds`=原生尺寸、`contentRotation`、`clip=null`）；`assertPlacementOffset` 校验 dx/dy≤0.5mm；`mmToPxPlacement`（命名避 measureMargins.mmToPx 冲突）。
- **② usePrint 接入**：`renderFileToPrintImage` PDF 单文件分支改走 native（`renderPDFPageRaw(paperKey=null)`）+ PlacementAdapter → 扩展纸画布；**不进 renderMultipleItemsToCanvas**（不混 composer/slot 语义）；native 失败回退旧路径。
- **③ Gate 全绿（61/61）**：A3-3-2-01 placement offset（native.x51+118=169 ✅ dx/dy=0）/ A3-3-2-02 margin compare（placement 后四边 vs source L14.3/T16/R10.6/B17，均 ≤0.5mm ✅）/ A3-3-2-03 bitmap invariant（scale=1、rotation=0、像素不变只移位置 ✅）。A3-3-1-03 断言演进（声明→A3-3-2 起消费）。
- **红线守住**：未改 renderPDFPageRaw / rasterize / createLayout 通用 / MultiTicketComposer / 新 fit 算法；margin 未替代 sourceOrigin。rotation 未处理（A3-3-3）。

### 14.16 A3-3-3 Rotation Coordinate Contract 冻结（2026-08-04，spec-only，commit `53830dd6`）
- **背景**：A3-3-3 动代码前用户要求先冻结旋转坐标语义（spec-only，零代码改动）。源码实读事实链：
  - F1 `renderPDFPageRaw` 不旋转（native 分支 L558-566）——旋转在 placement 层（createPlacement rotatedBounds 宽高互换 + drawRenderCommand L53-55 中心支点）
  - F2 source 轨旋转 = Sumatra `contentOrientation`（纸面方向跟随内容）；canvas 现有 createPlacement 路径 = 纸固定内容在纸内旋转（A1-rot90 实测 A4 画布不变）——**两套旋转哲学并存**
  - F3 A3-2 采集器 = 画布旋转（Policy A 近似，canvas 2D 旋转整个画布，已验证数学吻合：rotate(90°) 变换 (dx,dy)→(-dy,dx)，实测 bbox (84,51) 验证通过）
- **Contract 冻结**：
  - **C2 Policy A（paper follows content）**：rot90 → 纸面 2717×1890 → **1890×2717**（回答用户隐藏坑：纸面跟随内容旋转，非固定）——依据 source/Sumatra 语义 + A3-2 采集器模型
  - C3 变换顺序：native → 施加 sourceOrigin（扩展纸面）→ **整体旋转**（paper+content 一体）；sourceOrigin 旋转前施加、随画布整体变换、不单独重算
  - C4 数学锚点：offset 随画布旋转（中心支点），非 `(x,y)→(y,-x)` 直接套用（会得负坐标 (-344,400) 类错误）
  - C5 预期 rot90：画布 1890×2717，内容 bbox (201,169,1500×2423)，边距 (17,14.3,16,10.6)mm（原 L14.3/T16/R10.6/B17 顺时针轮换）
  - C6 禁止：Policy B（纸固定）在单文件 source 语义 / rotation 单独作用于 resource 后重算 sourceOrigin / 改 renderPDFPageRaw、createPlacement 通用语义
- **待验证项（标记不阻塞）**：Sumatra 真实打印 rot90 纸面方向需真实打印对照确认（node 采集不体现旋转，Policy A 为推断+采集器模型验证）；若实测 Policy B 修订 contract
- **A3-3-3 Gate 预告**：A3-3-3-01 adapter rot90（画布 1890×2717 + rotatedBounds 互换 + offset 旋转）/ A3-3-3-02 margin vs C5 ≤0.5mm / A3-3-3-03 bitmap invariant（像素不变只旋转）

### 14.17 A3-3-3 落地（2026-08-04，commit `c7690257`/`99795974`/`75ba73f1` + spec 修正 `49ca40cc`）
- **⚠️ 实现模型修正（Gate 02/03 失败暴露，本轮最重要发现）**：`drawRenderCommand.contentRotation` 是 **Policy B 语义**（内容在**画布内**绕落盘中心旋转，renderDraw.js:52-56）——直接改 command 的 offset/rotatedBounds 走 cr 旋转会让内容旋转后**超出画布**（实测 bbox 320 vs C5 预期 201）。**Policy A 的正确实现 = 画布级旋转**：rot0 command 先绘制扩展纸面画布（2717×1890）→ `transformPaperRotation` 产 `rotateCanvasCommand`（把扩展纸面画布作为 source 居中旋转绘制到新画布 1890×2717）→ 与 A3-2 采集器同一数学。C4 表述修订：sourceOrigin 旋转阶段**完全不参与**（offset 不随旋转变换）。
- **Commit 1**（`c7690257`）：`transformPaperRotation` 纯函数（90/180/270 全覆盖 + 非法角度 fail-loud；返回 {canvasW,canvasH,rotateCanvasCommand|null}；不返回 bitmap——用户实现边界）
- **Commit 2**（`99795974`）：usePrint `renderFileToPrintImage` PDF 单文件分支两段式（rot0 绘制扩展纸面 → rotation≠0 画布整体旋转）；rotation 仍由 `fileRotations[f.key]` 派生；native 失败回退旧路径
- **Commit 3**（`75ba73f1`）：五 Gate 全绿（**66/66**）——01 rot90 画布 1890×2717 + rotateCanvasCommand 结构 / 02 bbox 宽高互换 1500×2423 无负坐标（C5 锚点 (201,169)）/ 03 四边 margin vs L17/T14.3/R16/B10.6 ≤0.5mm（顺时针轮换）/ 04 rot180/270 + rot0 + 非法角度 / 05 usePrint 静态接线断言
- **红线守住**：未改 renderPDFPageRaw / createLayout 通用 / MultiTicketComposer / 新 fit 算法；未绕过 command 层（画布旋转仍走 drawRenderCommand）；sourceOrigin 未被重新定义
- **待验证**（§14.16 延续）：Sumatra 真实打印 rot90 纸面方向需真实打印对照；canvas 轨 rot90 端到端 bitmap 需 Electron 采集验证（纯函数数学已验证，绘制路径接线待采集确认）

### 14.6 冻结状态
```
A2-G1 source ✅ | canvas 采集链路 ✅ + 第一份报告 🔴FAIL(预期)
A2-G1-CANVAS-2 同纸张实验 🔴 FAIL（renderPDFPageRaw customPaper 缺陷，双重 fit）
A2-G1 OFD (G1-B) ⏸ | A2-G2..G6 ⏸
A3 ⏸（需先解决纸张语义统一 + 修 renderPDFPageRaw）| Phase B ⏸
```

