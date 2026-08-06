# A1 代码审查报告 — `buildPrintExecutionPlan` 提取

> 审查对象：commit `7e176794`
> 文件：`frontend/src/print/buildPrintExecutionPlan.js` + `frontend/test/printExecutionPlan.test.mjs`
> 角色：Code Reviewer 独立复核（用户已先给"通过"结论，本次复核确认 + 补遗漏点）
> 结论：**A1 通过 ✅** — 边界严守、行为不变量锁定、可安全进入 Commit 2/3

---

## 一、总评

A1 成功把"打印事实描述（Execution Plan）"从"打印动作（Execution Routing）"中剥离，**且未偷偷改变任何现有打印行为**。这是当前阶段最重要的目标，达成度很高。

最关键的验收点——**Commit 2/3 接线后"打印输出不变"是否可证**——本次独立核实为 **是**：`buildPrintExecutionPlan` 的 `orientation`/`groupSize` 计算与 `doPrint`（usePrint.js L491–495）**逐字等价**，过滤谓词与 `executePrint`/`doPrint` **逐字符一致**。这意味着后续接线是机械替换，不引入行为变量。

---

## 二、🔴 等价性核验（命门，独立复核）

### orientation / groupSize 等价
| 项 | doPrint（L491–495） | buildPrintExecutionPlan（L70–79） | 结论 |
|---|---|---|---|
| mergeMode | `settings.mergeMode \|\| 'none'` | 同 | ✅ |
| isMerge | `isMergeMode(mergeMode)` | 同 | ✅ |
| groupSize | `parseInt(mergeMode.replace('merge','')) \|\| 2` | `isMerge ? (parseInt(...) \|\| 2) : 1`（仅 isMerge 分支消费） | ✅ 等价 |
| 方向 | `forcedLandscape = isMerge ? getForcedLandscape(mergeMode, settings.landscape) : settings.landscape` | `orientation = isMerge ? (getForcedLandscape(...) ? 'landscape':'portrait') : (settings.landscape ? 'landscape':'portrait')` | ✅ `orientation==='landscape' ⟺ forcedLandscape===true` |

`getForcedLandscape` 内部（mergeMode.js L12–24）：`none→userLandscape`、`groupSize===4→true`、其余 `false`。A1 单文件分支直接用 `settings.landscape`，与 `getForcedLandscape('none', settings.landscape)` 等价。**完全一致。**

### 过滤谓词等价
- `SOURCE_FILE_FILTER` = `f.status==='parsed' && (f.printPath||f.path)` ↔ executePrint L817 ✅
- `MERGE_FILE_FILTER` = `printPath && (parsed||error) && (ofd 需 docId||previewImage)` ↔ doPrint L453–459 ✅

### 分组滑窗等价
doPrint `for(i+=groupSize) parsedFiles.slice(i,i+groupSize)` ↔ A1 L88 同构 ✅

**结论：Plan 是 executePrint/doPrint 的忠实投影，接线不改输出。**

---

## 三、👍 做对的地方（认同用户的评审点）

1. **未提前接线** — 不碰 executePrint/doPrint、不改 `PRINT_PIPELINE.mode`、不删 Sumatra、不统一 filter、不修 safeMargin。单变量验证纪律保持干净。
2. **Plan 不含 geometry** — 无 `x/y/width/height/scale/usableRect/transform`。层级正确，避免污染 `PrintExecution`。
3. **rotation 属于 slot** — `slots:[{fileId, rotation}]`，支持 merge2/4 异向旋转，单文件=slotCount 1 自然统一。
4. **保留 source/merge 过滤差异** — `SOURCE_FILE_FILTER`/`MERGE_FILE_FILTER` 导出且测试锁定，过渡设计正确。
5. **多页展开留在渲染层** — Plan 每文件=1 单元，与 executePrint/doPrint 当前粒度一致，不提前展开避免改变队列/策略/分组语义。
6. **不变量测试到位** — Case 7（merge 忽略一普二专）、Case 8（source/merge 过滤差异）是防止未来"顺手优化"的关键锁。

---

## 四、🟡 建议（不阻塞 A1，留给后续阶段）

### 🟡-1 `source.pageIndex` 恒为 `0` 对多页文档是误导性字段（影响 Phase B Preview）
**位置**：L117、L132 — `source: { fileId: f.key, pageIndex: 0 }`。

**Why**：对 5 页 PDF/OFD，真实打印经 `renderFileToPrintImage` 循环 `doc.pages` 发出**全部页**，但 Plan 写 `pageIndex: 0` 暗示"仅第 0 页"。A1 阶段因不接线、展开在渲染层，无碍；但 **Phase B 的 PrintPreviewModel/Preview 会直接消费这个字段**，若按 `pageIndex:0` 渲染，预览将只显示第 0 页 → 与打印不符（恰好踩你最想避免的"展示/打印漂移"）。

**Suggestion**（Phase B 处理，不阻塞 A1）：
- 方案 a：删 `pageIndex`，渲染/预览层按 `fileId`(docId) 自行展开全部页；
- 方案 b：改为显式 `pageRange: 'all'` 或 `pages: null` 表意"全部页"，与单页语义区分。
- 现 L115–116 注释已说明，但字段名仍易误导，建议 Phase B 落地时一并改。

---

## 五、💭 Nits（可选，不影响正确性）

1. **`_round: 2`（L135）冗余** — `extraPages` 数组本身已表"第 2 轮"，`_round` 是把执行次序又烤进数据，轻微违反"Plan 描述打印什么、不描述执行次序"。可删，由 executor 从 `strategy.oneNormalTwoSpecial` + 结构（`pages` vs `extraPages`）推导轮次。当前无害。

2. **`options.mode` 文档/实现不符（L51）** — JSDoc 称 `mode` "仅作注释/未来"，但函数体从未解构/读取它。要么删签名与文档，要么注明"reserved, unused"。纯文档一致性问题。

3. **`merge1` 无测试覆盖** — `merge1` → `type:'multi-ticket'` + 1 slot，逻辑忠实于 doPrint，但 10 项测试未含此分支。若 UI 暴露 merge1 选项，补一 Case 更稳。

4. **无 `f.key` 防护** — 纯函数依赖调用方保证 `file.key` 存在；缺 `key` 时 `slot.fileId` 为 `undefined` 静默失败。可加 `f.key ?? f.path` 兜底或早抛。低优先级（调用方契约明确）。

---

## 六、验收清单（对照用户 A1 验收标准）

| 标准 | 状态 |
|---|---|
| 单 PDF → 1 page / 1 slot | ✅ Case 1 |
| 多页（N 文件）→ N pages | ✅ Case 2 |
| merge2 → 2 slot/page | ✅ Case 3 |
| merge4 → 4 slot/page | ✅ Case 4 |
| 一普二专 → strategy 展开 | ✅ Case 5/7 |
| rotation → slot.rotation | ✅ Case 6 |
| Plan 不含 geometry | ✅ 代码 + 冻结注释 |
| 不接线 / 不改行为 | ✅ 未 import 进 executePrint/doPrint |
| 过滤差异保留 | ✅ Case 8 + 导出 filter |
| 入参不污染 | ✅ Case 10 |

用户建议的"Commit 2/3 前加黄金快照 `legacy_executePrint_snapshot.json`"——**同意，建议落地**：用真实业务组合（A.pdf parsed / B.ofd parsed / C.pdf error / D.pdf parsed special，merge2+extraSpecial）记录 before/after 文件序列，防未来重构只覆盖结构不覆盖业务组合。

---

## 七、下一步建议（保持单变量纪律）

**Commit 2：只接 `executePrint`**（消费 `SOURCE_FILE_FILTER` 生成的 Plan），证明文件数/顺序/extraSpecial/source path/routing 全不变，**不动 `PRINT_PIPELINE.mode`**。

**Commit 3：再接 `doPrint`**（消费 `MERGE_FILE_FILTER` 生成的 Plan），重点证明 `[A,B,C,D,E]` merge2 → `[[A,B],[C,D],[E]]` 与现滑窗完全一致。

两步走，每次只变一个入口，回归可精确定位。
