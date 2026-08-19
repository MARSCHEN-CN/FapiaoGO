# Gate 4.3 — Regression Matrix（回归护栏设计）

> 阶段：**Gate 4.3（回归矩阵设计）**
> 日期：2026-08-19
> 分支：`rotation-b1-hardening`
> 性质：**docs-only 设计文档，零生产代码改动**
> 冻结纪律（来自 R1 + PPC 已封存边界）：本 Gate **不触碰**
> `RotationResolver` / `sourceRotation` / `contentRotation`(定义) / `effectiveRotation`(定义) / OFD 打印路径 / `VirtualPrintSource` / `PrintResource` 生命周期 / `mergeFactory` 实现。
> 唯一验证目标：**把 Gate 4.2 已证明的「架构 seam 正确」冻结为可重复验证的回归护栏**——不是找方向，是把正确性锁成可重复断言。

---

## 0. 本文档定位

| Gate | 性质 | 产出 |
| --- | --- | --- |
| 4.1 Seam Map | 取证 | `gate4-merge-geometry-seam-map.md`（已 PASS） |
| 4.2 Contract Audit | 取证 | 同上 §4 三禁止规则全部 PASS；Path B divergence 标为观察点 |
| **4.3 Regression** | **设计** | **本文档：Put 路径双覆盖 + merge2/4 几何 + PDF/Image/OFD 输入矩阵 + 横竖 + rotation-once + RenderCommand 契约断言** |
| 4.4 Fix | 待触发 | 仅当 4.3 发现越界缺陷时最小修复（当前预期 NO-OP） |

Gate 4.2 已证明「架构 seam 正确」。Gate 4.3 的任务不是再论证方向，而是**把正确性冻结成可重复验证的回归护栏**：未来任何人改 `mergeFactory` / `MultiTicketComposer` / `SlotLayout` / `createPlacement` / `drawRenderCommand`，都能被这些用例立刻拦下。

---

## 1. 验证对象与冻结边界（recap）

### 1.1 验证对象（允许被测试消费，不允许被改动）

```
[Path A]  MultiTicketComposer.composePlans
              └─ RenderLayoutFactory.buildRenderCommand
[Path B]  mergeFactory.buildMergeRenderCommands
              └─ （共用）composePlacement.createPlacement
[共用]    renderDraw.drawRenderCommand   ← 唯一旋转落盘点
[共用]    RenderLayoutFactory.validateRenderCommand  ← 契约校验
[几何]    SlotLayout.computeSlots        ← 票位几何唯一来源
```

### 1.2 冻结边界（本文档不触碰，仅引用）

- `RotationResolver` / `sourceRotation` / `contentRotation`(定义) / `effectiveRotation`(定义)：属 R1 冻结区，仅作为**输入事实**进入生产者。
- `mergeFactory.js` 实现：禁止修改；本文档只对其**行为**做断言。
- OFD 打印路径 / `VirtualPrintSource` / `PrintResource` 生命周期：属未来 PPC Gate，Layer C 只验「producer 格式盲」，不实现 OFD。

### 1.3 可观察但不可改

- Path B 的 rotation 来源（原始 `rotations[id]`，无 autoRotation）：§7 以**观察性断言（Guard）**记录，不统一、不修复。

---

## 2. 三禁止规则 → 回归断言映射

（来自 `gate4-merge-geometry-seam-map.md` §4，转为可重复断言）

| 禁止规则 | 对应回归断言 | 落点 |
| --- | --- | --- |
| 禁止 1：重新解释 rotation（double rotation） | Layer A 断言 `contentRotation` 仅由 producer 设一次；`placement` 无内嵌旋转；executor 仅 `ctx.rotate` 一次 | §4 / §8 |
| 禁止 2：composer 读取 source orientation | Layer C 静态断言零 `if(pdf)`/`if(ofd)`/`if(image)`/`file.type` 分支；行为断言三格式产出深相等 | §6 |
| 禁止 3：slot geometry 修改 content geometry | Layer B 断言 `slot.contentRect` 与 `contentRotation` 输入无关；`RenderCommand.clip === slot.contentRect` | §5 |

---

## 3. 测试资产与 Harness 入口（grounded）

> 仅列出真实存在的函数签名，供回归用例直接 import。不改任何源码。

### 3.1 生产者 / 几何 / 执行入口

| 角色 | 函数 | 签名（关键参数） |
| --- | --- | --- |
| Path A 生产者 | `MultiTicketComposer.composePlans` | `({ paperLayout, plans, ticketCount, strategy, gridCols, gridRows })` → `[{ plan, renderCommand }]` |
| Path A 几何挂载 | `composePagePlan.fileObjToComposePagePlan` | 产出 `plan.printGeometry.effectiveRotation`（canonical，上游冻结） |
| Path B 生产者 | `mergeFactory.buildMergeRenderCommands` | `(layout, contentMeta, rotations, { isLandscape })` → `RenderCommand[]` |
| 票位几何 | `SlotLayout.computeSlots` | `(paperLayout, { count, strategy, gridCols, gridRows })` → `slots[]`（含 `contentRect`） |
| 唯一几何 owner | `composePlacement.createPlacement` | `({ contentRect, sourceWidth, sourceHeight, rotation })` → `{ scale, offsetX, offsetY, rotatedBounds, clip, contentRotation }` |
| 契约校验 | `RenderLayoutFactory.validateRenderCommand` | `(cmd)` → `true` / throw |
| 唯一执行 | `renderDraw.drawRenderCommand` | `(ctx, cmd, source, contentW, contentH, ratio)` — 唯一消费 `cmd.contentRotation` 旋转落盘 |

### 3.2 固定 Fixture（建议锁定）

- **纸张**：A4 @ 300dpi，`usableRect = { x:0, y:0, w:2480, h:3508 }`，`slotMarginPx = 0`（去除边距变量，专测分区公式）。
- **横向纸张**：`isLandscape = true` → `usableRect = { x:0, y:0, w:3508, h:2480 }`（验证 `paperLandscape` 标志 + `slotToLandscape` 约定）。
- **内容像素**：`natW × natH`（如 `1240 × 1754`，等价于半页 A4），三格式（PDF/Image/OFD）使用**相同**像素尺寸，仅来源标签不同。
- **Path A plan 构造器**：`plan = { documentState: { pageSize:{w:natW,h:natH}, pageOrientation }, printGeometry: { effectiveRotation }, source:{ docId, pageId } }`。

### 3.3 运行约定

- 用例文件建议落位：`frontend/test/printGate/gate4Regression.test.mjs`（与现有 `gateFramework.test.mjs` 同目录）。
- 运行命令（遵守既有纪律，勿跑 `node --test test/`）：
  `node --test frontend/test/printGate/gate4Regression.test.mjs`
- 本文档只设计矩阵，**不编写该测试文件**（docs-only 纪律）。

---

## 4. Layer A — RenderCommand Contract（双路径 contentRotation 保真）

目标：证明 **Path A 与 Path B 最终生成同一种 contract**——`contentRotation` 由 producer 设一次且值正确。

### 4.1 用例表

| Case | Path | Input Rotation | Expected `contentRotation` | 关键断言 |
| --- | --- | --- | --- | --- |
| A1 | A | 0 | 0 | `validateRenderCommand` PASS；`placement` 有限数；`rotatedBounds>0` |
| A2 | A | 90 | 90 | 同上；`rotatedBounds` 交换 natW/natH |
| A3 | A | 180 | 180 | 同上；`rotatedBounds` 不交换 |
| A4 | A | 270 | 270 | 同上；`rotatedBounds` 交换 |
| B1 | B | 0 | 0 | 同上 |
| B2 | B | 90 | 90 | 同上 |
| B3 | B | 180 | 180 | 同上 |
| B4 | B | 270 | 270 | 同上 |

### 4.2 通用断言（每个 Case 必过）

```
1. validateRenderCommand(cmd) === true
2. cmd.version === 1
3. typeof cmd.contentRotation === 'number'
4. Number.isFinite(cmd.placement.scale) && Number.isFinite(cmd.placement.offsetX) && Number.isFinite(cmd.placement.offsetY)
5. cmd.rotatedBounds.width > 0 && cmd.rotatedBounds.height > 0
6. cmd.rotation === 0                                    // [LEGACY Wire] 旋转不进 placement
7. drawRenderCommand 是唯一消费 cmd.contentRotation 的位置（见 §8 rotation-once）
```

### 4.3 Path A 专属断言（B-10a：禁止第二 resolver）

> `buildRenderCommand` 在收到 `printGeometry` 时**直接赋值** `contentRotation = printGeometry.effectiveRotation`，不二次 normalize。

```
assert(cmd.contentRotation === plan.printGeometry.effectiveRotation)   // 引用同一 canonical 值，证明无重算
```

辅助反向用例（可选，强化 B-10a）：构造 `printGeometry.effectiveRotation = 90`，再测 `cmd.contentRotation === 90`（不因其「已 canonical」而被任何函数改写）。

### 4.4 Path B 专属断言（snap 语义）

> `mergeFactory` 对原始 `rotations[id]` 做一次 `normalizeRotation`（snap 到 90° 倍数），非对已旋转 RenderCommand 的二次旋转。

```
assert(cmd.contentRotation === normalizeRotation(rotations[id]))
```

主矩阵用 canonical 输入（0/90/180/270，snap 恒等）；另设负面用例：`rotations[id] = 45` → `cmd.contentRotation === 90`（验证 snap，不验证方向正确性——方向正确性属 R1 语义，不在 Gate 4）。

---

## 5. Layer B — Slot Geometry Contract

目标：证明 `slot geometry + RenderCommand = physical placement`，且 **slot 几何与 rotation 输入解耦**。

### 5.1 固定分区期望（A4@300dpi，`usableRect` 全页，`slotMarginPx=0`）

**merge none（count=1）**：退化为整页单票
```
slot[0].contentRect = { x:0, y:0, width:2480, height:3508 }
```

**merge2 vertical（count=2, strategy='vertical'）**：竖向等分，余数落末位
```
slot[0].contentRect = { x:0, y:0,    width:2480, height:1754 }
slot[1].contentRect = { x:0, y:1754, width:2480, height:1754 }
```
（公式：`baseH = floor(3508/2) = 1754`；`height[last] = 3508 - accY`）

**merge4 grid（gridCols=2, gridRows=2, strategy='grid'）**
```
slot[0] = { x:0,    y:0,    width:1240, height:1754 }   (col0,row0)
slot[1] = { x:1240, y:0,    width:1240, height:1754 }   (col1,row0)
slot[2] = { x:0,    y:1754, width:1240, height:1754 }   (col0,row1)
slot[3] = { x:1240, y:1754, width:1240, height:1754 }   (col1,row1)
```
（公式：`baseW=floor(2480/2)=1240`，`baseH=floor(3508/2)=1754`，末列/末行收口）

### 5.2 几何断言

对每个 merge 配置（none / merge2 / merge4）+ 每个 orientation（portrait / landscape）：

```
G1. computeSlots 输出 slot[i].contentRect 严格等于 §5.1 期望（px 值逐字段相等）
G2. 对同一 merge 配置，遍历 contentRotation ∈ {0,90,180,270}，断言 slot[i].contentRect 完全一致
    → 证「slot 几何不受 rotation 输入影响」（禁止 3 的核心）
G3. 由该 slot 产出的 RenderCommand.clip === slot.contentRect（ownership 锁，防邻票渗色 / 防未来 slot.x+margin 重算）
G4. RenderCommand.placement 完全来自 createPlacement，producer 未覆盖 placement/offset/scale
G5. orientation=landscape 时：
      - cmd.paperLandscape === true
      - slot 坐标遵循 slotToLandscape 约定（portrait (x,y,w,h) → landscape (mL+(y-mT), mT+(x-mL), h, w)）
      - 物理页尺寸交换（paperRect.w/h 互换），内容旋转语义不变
```

> 注：§5.1 数值基于 `SlotLayout.computeSlots` 冻结分区公式（与 `composeSlotRasterizer` 同源）。若未来有人改分区公式，G1 立即失败——这正是回归护栏的价值。

---

## 6. Layer C — Format Independence（PPC 边界，不进入实现）

目标：沿 PPC 边界验证「同一 RenderCommand contract 不因 PDF/Image/OFD 来源产生 composer 分支」。

### 6.1 静态断言（零格式分支）

对以下文件做 grep（大小写不敏感），断言**零命中**：
`MultiTicketComposer.js` · `SlotLayout.js` · `mergeFactory.js` · `RenderLayoutFactory.js` · `composePlacement.js` · `renderDraw.js`

```
pattern: \b(if\s*\(\s*(pdf|ofd|image)|file\.type|source\.format|\.rotate\b|exif)
预期:  0 命中
```

> 这是「禁止 2」的可机器验证形式。任何在 producer 内新增的格式分支都会立刻被该 grep 用例拦下。

### 6.2 行为断言（格式盲）

构造三个 `contentMeta` mock，仅来源标签不同（pdf / image / ofd），**像素尺寸与 rotations 完全一致**：

```
contentMeta_pdf   = Map([['id1', {width:1240, height:1754}]])
contentMeta_image = Map([['id1', {width:1240, height:1754}]])
contentMeta_ofd   = Map([['id1', {width:1240, height:1754}]])
rotations         = { id1: 90 }
```

对 Path B 执行 `buildMergeRenderCommands(layout, contentMeta_X, rotations, {isLandscape})`，断言：

```
assert.deepStrictEqual(cmd_pdf, cmd_image)
assert.deepStrictEqual(cmd_image, cmd_ofd)
```

→ 证 producer 对来源格式**完全盲视**，同一几何+旋转产出逐字节相同的 RenderCommand。

### 6.3 边界声明（重要）

- ✅ 本层只验证「producer 格式盲」。
- ❌ **不验证** `OFD → VirtualPrintSource`（那是未来 PPC Gate 的实现，当前冻结）。
- ❌ 不引入 OFD 像素源、不修改任何 OFD 相关代码。
- 行为断言中的 `contentMeta_ofd` 仅作「格式标签占位」，证明**即便未来 OFD 以相同像素契约进入 producer，也不改变输出**——这是契约层面的前瞻保护，非实现。

---

## 7. §4 新增 Guard — Path B divergence 观察性断言（非修复）

针对 `gate4-merge-geometry-seam-map.md` §5.1 的观察点，增加一个**观察性断言**，目的不是修复，而是**未来若有人偷偷改 Path B 的 rotation 来源，能被立刻发现**。

### 7.1 Guard G-PATHB-1（来源纯净性）

```
// Path B：contentRotation 必须仅来自原始用户旋转输入 rotations[id]
assert(cmd.contentRotation === normalizeRotation(rotations[id]))
// 静态：Path B 调用图不得引用 effectiveRotation / PrintGeometryBuilder / PrintAutoRotationPolicy
grep pattern: \b(effectiveRotation|PrintGeometryBuilder|PrintAutoRotationPolicy)\b
expect: 0 命中（在 mergeFactory.js 及其直接 import 内）
```

### 7.2 Guard G-PATHB-2（负面检测器 / double-normalize 预警）

用户提出的防护式断言的形式化：

```
assert(
  producer !== 'PathB' ||
  cmd.contentRotation === normalizeRotation(declaredUserRotation)
)
```

语义：
- 当前 Path B：`declaredUserRotation = rotations[id]` → 断言通过（观察点保持「⚠ observation」）。
- 若未来有人把 `rotations[id]` 偷偷改成 `effectiveRotation`（即 `normalize(autoRotation + userRotation)`），再喂给 `normalizeRotation`，则当 `autoRotation ≠ 0` 时：
  `normalizeRotation(effectiveRotation) !== normalizeRotation(userRotation)`
  → G-PATHB-1 / G-PATHB-2 立即失败，**暴露「effectiveRotation → normalizeRotation → effectiveRotation」的 double-normalize 风险**。

> ⚠️ 纪律重申：这两道 Guard 是**检测**，不是**统一**。把 Path B 的 `rotations[id]` 升级为 `effectiveRotation` 是 **R1 Option C / Future Rotation Semantic Migration Gate** 的议题，**不在 Gate 4 范围**。Guard 只负责「变了就响」，不负责「变了就改」。

---

## 8. rotation-once 不变量（跨层，独立成节）

用户清单第 5 项。该不变量横跨 Layer A/B/C，单独锁死：

```
INV-ROTATE-ONCE：
  (1) producer 设 contentRotation 恰好一次：
        Path A: cmd.contentRotation = plan.printGeometry.effectiveRotation  （直接赋值）
        Path B: cmd.contentRotation = normalizeRotation(rotations[id])        （一次 snap）
  (2) RenderCommand.placement 不含任何旋转（rotation:0 legacy；placement = 纯 scale+offset）
  (3) executor drawRenderCommand 仅 ctx.rotate(cmd.contentRotation) 一次
  (4) 中间层（composePlans / buildMergeRenderCommands / createPlacement）不施加任何额外旋转
  (5) contentRotation 从 producer 到 executor 不被任何层 mutation
```

回归断言：
```
R1. 对 Path A/B 任一用例：cmd.rotation === 0 且 cmd.placement 无 rotation 字段
R2. 在不依赖真实 canvas 的前提下，静态证明 drawRenderCommand 内 ctx.rotate 调用计数为 1
    （可由代码评审 + 单测 mock ctx 记录 rotate 调用次数 === 1 验证）
R3. 对比「producer 输出 cmd.contentRotation」与「executor 实际 rotate 角度」：二者恒等，
    且全链路无第二处旋转变换。
```

---

## 9. 完整矩阵汇总（可追溯）

维度：`Path(A/B) × InputRotation(0/90/180/270) × Merge(none/2/4) × Format(PDF/Image/OFD) × Orientation(portrait/landscape)`

| ID | Path | InRot | Merge | Format | Orient | 期望 contentRotation | 几何断言 | 不变量 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | A | 0 | none | pdf | P | 0 | G1/G3 | R1/R3 |
| A2 | A | 90 | none | pdf | P | 90 | G1/G3 | R1/R3 |
| A3 | A | 180 | none | pdf | P | 180 | G1/G3 | R1/R3 |
| A4 | A | 270 | none | pdf | P | 270 | G1/G3 | R1/R3 |
| A5 | A | 90 | 2 | pdf | P | 90 | G1/G2/G3 | R1/R3 |
| A6 | A | 90 | 4 | pdf | P | 90 | G1/G2/G3 | R1/R3 |
| A7 | A | 90 | 2 | pdf | L | 90 | G5 | R1/R3 |
| A8 | A | 90 | 4 | pdf | L | 90 | G5 | R1/R3 |
| B1 | B | 0 | none | image | P | 0 | G1/G3 | R1/R3 |
| B2 | B | 90 | none | image | P | 90 | G1/G3 | R1/R3 |
| B3 | B | 180 | none | image | P | 180 | G1/G3 | R1/R3 |
| B4 | B | 270 | none | image | P | 270 | G1/G3 | R1/R3 |
| B5 | B | 90 | 2 | image | P | 90 | G1/G2/G3 | R1/R3 |
| B6 | B | 90 | 4 | image | P | 90 | G1/G2/G3 | R1/R3 |
| B7 | B | 90 | 2 | image | L | 90 | G5 | R1/R3 |
| B8 | B | 90 | 4 | image | L | 90 | G5 | R1/R3 |
| C1 | B | 90 | 2 | pdf   | P | 90 | deepEqual(C1,C2,C3) | 静态 6.1 |
| C2 | B | 90 | 2 | image | P | 90 | deepEqual(C1,C2,C3) | 静态 6.1 |
| C3 | B | 90 | 2 | ofd   | P | 90 | deepEqual(C1,C2,C3) | 静态 6.1 |
| G-PB1 | B | any | any | any | any | `=== normalizeRotation(rotations[id])` | 静态 7.1 | — |
| G-PB2 | B | any | any | any | any | `!== effectiveRotation-derived` | 静态 7.2 | — |

> 矩阵刻意覆盖 **Path A + Path B 双生产者**（A*/B*），而非只验 Path A——避免漏掉 Path B 的语义分裂（§5.1 观察点）。

---

## 10. 执行与验收

### 10.1 用例落位

- 新文件：`frontend/test/printGate/gate4Regression.test.mjs`（本文档不创建，仅设计）。
- 复用现有 harness：`gateFramework.test.mjs` / `gateConfig.mjs` / `gateCases.mjs` 的测试骨架（与 `sumatraCommandResolver.test.mjs` 等并列）。

### 10.2 运行命令（遵守既有纪律）

```
node --test frontend/test/printGate/gate4Regression.test.mjs
```

> ⚠️ 勿跑 `node --test test/`（会捞到依赖 `import.meta.env` 的技术债，见项目记忆）。

### 10.3 验收判定

- Layer A（A1–A4 / B1–B4）：全部 PASS → `contentRotation` 双路径保真。
- Layer B（A5–A8 / B5–B8 + G1–G5）：全部 PASS → slot 几何正确且与 rotation 解耦。
- Layer C（C1–C3 + 静态 6.1）：全部 PASS → producer 格式盲。
- Guard（G-PB1 / G-PB2）：当前**允许「观察性通过」**（Path B 仍用原始 `rotations[id]`），但若未来来源被改则失败响铃。
- `rotation-once`（R1–R3）：全部 PASS → 旋转只应用一次。

### 10.4 Gate 4.4 触发条件

**仅当上述任一断言发现真实越界缺陷时**（double rotation / source 格式分支 / slot 篡改 content geometry），才进入 4.4 最小修复——且修复严格限定在「RenderCommand 消费 + slot 几何」两层，不触碰 rotation ownership。

依据 Gate 4.2 结论（三禁止全 PASS），**当前预期 4.4 为 NO-OP**。

---

## 11. Gate 状态更新

| Gate | 状态 |
| --- | --- |
| Gate 4.1 Seam Map | ✅ PASS |
| Gate 4.2 Contract Audit | ✅ PASS |
| Path A | ✅ canonical |
| Path B | ⚠ observation（Guard 已就位，仅观察不改） |
| Rotation Ownership | 🔒 R1 frozen |
| PPC Boundary | 🔒 frozen |
| Gate 4.3 Regression | ▶ **designed（本文档）** |

---

## 12. 提交说明

- 本文件 `docs/gate4-regression-matrix.md` 为 **docs-only**，零生产代码改动。
- 提交命令（docs/ 被 gitignore，需 `-f`）：
  `git add -f docs/gate4-regression-matrix.md && git commit -m "docs(print): Gate 4.3 regression matrix design (dual-path A/B, merge2/4 geometry, PDF/Image/OFD format-blind, rotation-once, Path B observation guard)"`
- 远程同步由用户本机手动 `git -c lfs.locksverify=false push origin rotation-b1-hardening`（沙箱无凭据，不代 push）。
- 下一步：用户确认矩阵后，可落位 `frontend/test/printGate/gate4Regression.test.mjs` 实现（属 4.3 实现阶段，不在本文档范围内）。
