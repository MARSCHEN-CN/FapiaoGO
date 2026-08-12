# C-2-G / G2-R1 镜像回归只读审计（portrait-native + landscape）

> 审计性质：**只读 + 零代码实验**。不改任何生产代码。
> 触发：用户裁决「竖纸型(原生竖向) + 横向方向 = 裁切」升级为 G2 新 blocker，
> 要求先零代码定位「到底是谁仍然持有旧的 portrait paper geometry」再决定是否 G2-2。
> 决策背景：c39ae14（G2-1）仅 `frontend/src/services/PrintService.js` `buildPrintSettings` 补传
> `paperOrientation`，与 `resolvePaperSpec` 共用 `requestedPaperOrientation` 单一来源。

---

## 0. 结论速览（一句话）

**c39ae14 在「竖纸×横向」组合下对 `normalize` 的 change-delta = 0（完全惰性，实证），故它**不是**该组合裁切的「触发修改」。
四象限 Plan == normalize Single Paper Truth 全 PASS；G2-1 唯一改变的是「横纸×纵向」（G2 主修复）。
但：是否「裁切早于 c39ae14」目前**无法判定**——本审计只有代码/数值证据，缺该组合的修改前后真机 A/B 证据；该问题只能由 T5 真机闭环回答（见 `c2g-physical-print-gate.md` §3.3）。**

---

## 1. 方法（零代码，只读生产函数）

- 直接 import 真实生产函数，不复制打印语义：
  - `frontend/src/print/paperSpec.js` → `resolvePaperSpec` / `requestedPaperOrientation`（Plan 单一解析点）
  - `electron/print-service/print-settings.js` → `normalize`（C-1 唯一解释层）
- 复现的 IPC 载荷与 `buildPrintSettings(G2-1)` 完全一致：
  `{ paper, landscape, paperOrientation: requestedPaperOrientation({landscape}) }`
- 逐层静态追踪：Plan → buildPrintExecutionPlan → buildPrintSettings(IPC) → normalize →
  source/Sumatra 命令 → canvas/merged(buildRenderCommand) 交换决策源。
- 实验脚本：`frontend/test/printGate/.out/c2g-r1-mirror-experiment.mjs`（可复跑）

---

## 2. 四象限实证（G2-R1 实验输出）

| Paper Type | Direction | Plan(paperSpec) | normalize(G2-1) | normalize(legacy) | Plan==norm | G2-1 影响 |
|---|---|---|---|---|---|---|
| 竖纸 A4 | 纵向 | 210×297 portrait | 210×297 portrait | 210×297 portrait | ✅ | **惰性** |
| **竖纸 A4** | **横向** | **297×210 landscape** | **297×210 landscape** | **297×210 landscape** | ✅ | **惰性** |
| 横纸 PostScript | 纵向 | 140×240 portrait | 140×240 portrait | 240×140 landscape | ✅ | **改变（修复）** ⚠️ |
| 横纸 PostScript | 横向 | 240×140 landscape | 240×140 landscape | 240×140 landscape | ✅ | 惰性 |

**关键读数：**
- **竖纸×横向**：`landscape=true` 早已让 `normalize` 走 `'landscape'` 分支（print-settings.js:200
  `requestedOrient = src.landscape ? 'landscape' : (src.paperOrientation ?? naturalOrient)`），
  G2-1 补传的 `paperOrientation:'landscape'` 与之**完全一致**，故 c39ae14 对该组合零行为变化。
- **横纸×纵向**：legacy 因 `landscape=false` + `paperOrientation=undefined` 回退 `naturalOrient='landscape'`
  → `needSwap=false` → 240×140（错误）；G2-1 补传 `paperOrientation:'portrait'` → 140×240（正确）。
  **这是 c39ae14 唯一改变的组合**，即 G2 主修复场景（真机 T2）。

---

## 3. 逐层追踪：竖纸×横向 谁持旧 portrait 几何？

### 3.1 Plan 层 — `resolvePaperSpec` ✅ 正确
`paperSpec.js:86-91`：`natural=paperShapeOrientation('A4')='portrait'`；
`orientation=requestedPaperOrientation({landscape:true})='landscape'`；
`needSwap='landscape'!=='portrait'=true` → `widthMM=297, heightMM=210`。
Plan.paper = 297×210 landscape。

### 3.2 buildPrintExecutionPlan 层 ✅ 正确
`buildPrintExecutionPlan.js:274` 直接消费 `paperSpec`（=resolvePaperSpec 产物）；
每个 page `paper:{...paperSpec}` → 297×210 landscape。Plan 即唯一事实源。

### 3.3 IPC 层 — `buildPrintSettings`(G2-1) ✅ 正确
`PrintService.js:79`：`paperOrientation: requestedPaperOrientation(userSettings)` = `'landscape'`；
同时 `landscape:true`。两字段语义一致，无矛盾。

### 3.4 normalize 层（source/Sumatra 轨）✅ 正确
`print-settings.js:199-213`：`naturalOrient='portrait'`；
`requestedOrient = src.landscape(true) ? 'landscape'` → `'landscape'`；
`needSwap='landscape'!=='portrait'=true` → `widthMM=297, heightMM=210`。
`buildPrintSettings`(electron, L274-291) → `"landscape,fit,paper=a4"`。
Sumatra 在 297×210 物理纸上 `fit` 缩放竖发票(210×297 native) → scale=0.707，居中，**不裁切**。

**→ source/Sumatra 轨：竖纸×横向 全链路 297×210 一致，无任何人持旧 210×297。**

### 3.5 canvas/merged 轨 — `buildRenderCommand` 交换决策源（⚠️ 结构风险点）
- `computePaperLayout`(previewState.js:178-233) **故意只产出竖纸型原生坐标**（A4→210×297），
  方向 swap 推迟到 `buildRenderCommand`（注释 L172/L231：swap 属于 RenderCommand，Stage 1）。
  **这不是“旧几何 bug”，是 Policy B 设计**：sheet 在 portrait-native 空间，横向由内容旋转/轴交换实现。
- `buildRenderCommand`(RenderLayoutFactory.js:147-157) 交换决策源 =
  `documentState.paperOrientation || documentState.pageOrientation`（**不是** `normalize` 的
  `landscape`/`paperOrientation`）。竖纸×横向：`paperLandscape=true, nativeLandscape=false`
  → `needSwap=true` → `effPaperRect={w:297,h:210}`，`usableRect` 轴交换，`createPlacement` 在 297×210
  内 contain-fit 竖发票 → **不裁切**。
- 合并打印入口 `usePrint.js:472` 用 `forcedLandscape=getForcedLandscape(mergeMode,landscape)`
  直接驱动 `renderMultipleItemsToCanvas`（**又一套权威**，非 `documentState.paperOrientation`）。
  `usePrint.js` 全文 grep `buildRenderCommand`/`paperOrientation` = **0 命中** → canvas 轨实际交换由
  `forcedLandscape` 经 `renderMultipleItemsToCanvas` 施加，与 source 轨 `normalize` 是**两套独立权威**。

**→ canvas 轨：最终 effPaperRect 也是 297×210（交换后），不持旧 210×297；但交换权威与 source 轨不统一。**

---

## 4. 问答：到底是谁仍持旧的 portrait paper geometry？

| 路径 | 是否持 210×297 旧几何 | 是否导致竖纸×横向裁切 | 与 c39ae14 关系 |
|---|---|---|---|
| source/Sumatra 轨（默认 mode='source'） | 否（normalize→297×210） | 否（fit 不裁切） | **c39ae14 惰性，零影响** |
| canvas/merged 轨 computePaperLayout | 持 210×297 但**设计如此**（swap 推迟） | 否（effPaperRect 交换后 297×210） | 不消费 paperOrientation，c39ae14 无关 |
| canvas 轨交换权威 | `forcedLandscape` / `documentState.*Orientation` | 仅当该权威未随 landscape=true 翻转时可能错位 | c39ae14 未触及此路径 |

**结论：当前所有活跃路径都没有"持旧 portrait 几何且裁切"的层；c39ae14 的 change-delta=0，故它**不是**竖纸×横向裁切的「触发修改」（已证）。**
关于"根因是否早于 c39ae14"——**本审计不能断言**：目前只有代码/数值证据，缺该组合的修改前后真机 A/B 证据。若 T5 真机确有裁切，只能先排除 c39ae14 为触发点；根因时点与位置须由 T5 FAIL 后的独立只读调查（**G2-R2 / Canvas Paper-Direction Authority Divergence**，见物理 Gate 协议 §8/§10）定位。
可能来源（按概率，供 G2-R2 调查参考，非定论）：
1. **misattribution / 既有多轨未对齐**：canvas 轨交换权威(`forcedLandscape`)与 source 轨(`normalize`)
   是两套来源，历史上未统一；但二者对竖纸×横向都应为 'landscape'，故正常不应分叉。
2. **既有问题（与 c39ae14 无关）**：c39ae14 不改变该组合，故任何该组合既有缺陷都不由其引入；
   但"是否早于 c39ae14"需 A/B 真机证据，本审计不判定。
3. **T 用例缺口**：现有 T1~T4 **不含**「竖纸×横向」物理用例（见物理 Gate 协议 §3.1），故该组合从未被真机闭环验证。

---

## 5. 行动项（只读，未改码）

1. **不回退 c39ae14** — 实验证明其对竖纸×横向惰性，回退无益且会撤销 G2 真修复（横纸×纵向）。✅ 与用户裁决一致。
2. **向物理 Gate 协议追加 T5 = 竖纸(A4) × 横向**（已写入 `c2g-physical-print-gate.md` §3.3）。
   T5 验收：真机纸面 = 297×210；竖发票内容正立；四周留 3mm 边距；裁切 = 0（四件同时看，不只看裁切）。
   - T5 PASS → 关闭"G2-1 导致竖纸×横向回归"的怀疑（c39ae14 清白，change-delta=0 已证）→ 状态升 **C-2-G PASS**。
   - T5 FAIL → 裁切真实存在；c39ae14 已证非触发（change-delta=0），但**不据此断言早于 c39ae14**；
     进入独立只读调查 **G2-R2 / Canvas Paper-Direction Authority Divergence**（定位 canvas 轨
     `forcedLandscape`/`documentState.*Orientation` 与 source `normalize` 两套方向权威分叉），
     **不回退 c39ae14**，与 G2-2 无关，单独开 issue。
3. **不宣布 G2 PASS 直至 T5 物理闭环**（维持用户裁决）：数值四象限 PASS 不足以放行，真机优先级高于数值模拟。
4. **结构债（非 blocker）**：canvas 轨交换权威（`forcedLandscape` / `documentState.*Orientation`）
   与 source 轨 `normalize` 是两套来源。建议未来统一为单一 `paperOrientation` 事实源（单独排期，不混入 G2）。

---

## 6. 与用户四象限表的对应

| Paper Type | Direction | 预期执行纸 | 本审计结论 |
|---|---|---|---|
| 竖纸 | 纵向 | 210×297 | Plan==norm PASS（原 PASS 维持） |
| 竖纸 | **横向** | **297×210** | **Plan==norm PASS；c39ae14 惰性；需 T5 真机闭环** |
| 横纸 | 横向 | 240×140 | Plan==norm PASS（原 PASS 维持） |
| 横纸 | 纵向 | 140×240 | Plan==norm PASS（**G2-1 修复，原 FAIL**） |

> 真机优先级高于数值模拟：数值已证明 Plan==normalize 全一致，但「竖纸×横向」缺真机 T 用例，
> 故 BLOCKER 状态保留至 T5 物理闭环，而非因数值 PASS 即放行。
