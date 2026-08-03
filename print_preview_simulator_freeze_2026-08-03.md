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

### 3.3 边界铁律(三个隔离)
```
ViewerRenderResource  ≠  PrintPreviewRenderResource  ≠  PrintExecution
```
三者**共享**:Document identity + content bytes/image + PrintConfig。

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
- **🟡 一普二专检测子串不匹配真实值（预存在 legacy 行为，A1 忠实镜像未引入）**：`executePrint` L824 与 `buildPrintExecutionPlan` L125 均用 `invoiceType?.includes('专票')` 判定专票。但系统规范判定值在 `FileList.jsx:68`/`utils.js:322` 为 `'专票'`，而 OCR/映射产物常为 `'增值税专用发票'`——`'增值税专用发票'.includes('专票')` 为 `false`（字序为「专用+发票」）。若生产 `invoiceType` 确为 `'增值税专用发票'`，则 **一普二专（round2）在产品里从不触发**，但代码/快照不会报错。A1/A1.5 仅证明「A1 == legacy」，不修此行为；若需修复，应归一化 `invoiceType` 或改用更稳判定（如 `includes('专用') || includes('专票')`）。已用规范值 `'专票'` 写样例使 round2 分支被测试覆盖。
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
- 一普二专 `includes('专票')` 问题与 OFD `printPath` 问题：A1.5 已正确暴露且保持边界（证明现状、不修现状），单独挂待办，不混入 Commit 2。

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
Commit 3  ⏸ 待做（doPrint 消费 MERGE Plan）
A2 Gate   ⏸ WAIT
A3 Canvas ⏸ WAIT
Phase B   ⏸ WAIT
```

