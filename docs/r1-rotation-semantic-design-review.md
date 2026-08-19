# R1 — Rotation Semantic Design Review

> 状态：**DRAFT（设计评审，非实现）**
> 日期：2026-08-19
> 分支：`rotation-b1-hardening`
> 基线：`df7debd`（Gate 3-4A，remote verified）
> 链：`df7debd → eb61c7e → 97e4a43 → aa1edef → 6aeceeb`（Gate 3-4B verify, remote）→ `06f9468`（local, pending push）
> 评审类型：**Rotation Semantic Design Review（docs-only，零生产代码改动）**
> 权威证据：`frontend/src/layout/Gate3-4B-SourceRotationOwnership.test.mjs`（B-2 矩阵可复现，1/1 PASS）
> 关联文档：`docs/gate3-4b-source-rotation-ownership-review.md`（迁移 Gate→验证 Gate 纠偏）、`docs/r1-merge-source-rotation-semantic-divergence.md`（R1 issue 记录）

---

## 0. 评审目标（Scope）

> 判断 Merge Path 与 Source Path 的 Rotation 语义是否需要统一；
> 如果需要，选择统一方向与实施边界。

**边界（冻结纪律）：** 本评审只产出设计结论，**不修改** `RotationResolver` / `PrintAutoRotationPolicy` / `usePrint.js` / `resolveContentPlacement` / `RenderLayoutFactory` / `Sumatra mapping` / OFD·PDF·Image pipeline。任何落地动作均须 R1 裁决后另立 gate。

---

## 1. Existing Frozen Contracts（当前冻结契约）

### 1.1 Merge Path Contract

```
fileRotations[f.key]
        │
        ▼
PrintGeometryBuilder
        │
        ▼
effectiveRotation
        │
        ▼
RenderCommand
```

定义：

```
effectiveRotation = normalize(autoRotation + userRotation)
```

语义：**userRotation 是物理页内旋转操作**。

特点：
- `autoRotation` 已由 `PrintAutoRotationPolicy` 算出（landscape×portrait → 270° canonical CW）。
- `userRotation` 可抵消 `autoRotation`（INV-D4-2：叠加物理旋转）。
- 输出已是最终旋转结果。
- 下游**禁止再次解析**（B-10 / Gate 3-4A：`effectiveRotation MUST NOT enter RotationResolver`）。

来源：`PrintGeometryBuilder.js`（Gate 3-1）+ `RenderLayoutFactory.buildRenderCommand`（Gate 3-4A，第 4 参消费 `printGeometry.effectiveRotation`，不 re-normalize）。

### 1.2 Source Path Contract

```
fileRotations[f.key]
        │
        ▼
contentRotation
        │
        ▼
resolveContentPlacement
        │
        ▼
placement
```

定义：

```
contentRotation = userRotation
```

语义：**userRotation 是用户方向意图**。

`resolveContentPlacement` 内部（`RotationResolver.js:152-153` 契约原文）：

```
contentRotation 由本函数内部施加，请勿预旋转后传入
contentRotation - 用户旋转角（0/90/180/270）
```

resolver 内完成：

```
contentRotation (user intent)
        +
paper geometry
        +
content geometry
        │
        ▼
layoutRotation ∈ {0, -90}   (逆时针纸面适配)
        │
        ▼
final placement rotation = contentRotation + layoutRotation
```

契约：**`contentRotation MUST NOT contain autoRotation`**（即禁止 `contentRotation = effectiveRotation`，已被 Gate 3-4B guard 永久禁止）。

---

## 2. Observed Divergence（实证，来自 B-2 矩阵）

来源：`Gate3-4B-SourceRotationOwnership.test.mjs` 实测输出（2026-08-19 重跑 1/1 PASS）。

| Case   | content   | paper     | user | merge | srcCur | srcNaive | R1 diff (merge−srcCur) | layersDiffer |
|--------|-----------|-----------|------|-------|--------|----------|------------------------|--------------|
| B-2.1  | portrait  | portrait  | 0    | 0     | 0      | 0        | 0°                     | false        |
| B-2.2  | portrait  | portrait  | 90   | 90    | 0      | 0        | **90°**                | false        |
| B-2.3  | landscape | portrait  | 0    | 270   | 270    | 270      | 0°                     | **true**     |
| B-2.4  | landscape | portrait  | 90   | 0     | 90     | 270      | **90°**                | **true**     |
| B-2.5  | portrait  | landscape | 0    | 90    | 270    | 90       | **180°**               | **true**     |
| B-2.6  | portrait  | landscape | 90   | 180   | 90     | 90       | **90°**                | **true**     |

列定义：
- `merge` = `buildPrintGeometry.effectiveRotation`（最终旋转，canonical CW）。
- `srcCur` = 当前 source path 净旋转 = `normalize(contentRotation + layoutRotation)`。
- `srcNaive` = 非法迁移 `contentRotation = effectiveRotation` 的净旋转（Gate 3-4B guard 对象）。
- `R1 diff` = `merge` 与 `srcCur` 之差（本评审核心：两条真实打印路径的最终输出是否一致）。
- `layersDiffer` = 两语义模型（M1/M2）中间层是否不同（即便最终输出重合）。

### 2.1 R1 发散结论

- **最终输出不一致（R1 diff ≠ 0°）**：B-2.2（90°）、B-2.4（90°）、B-2.5（**180° 上下颠倒**）、B-2.6（90°）——共 **4/6 用例**。
- **输出重合但语义层不同（layersDiffer=true）**：B-2.3（merge=srcCur=270，但 merge 走 `auto+user`、source 走 `user+layout`，路径不同）。
- 仅 B-2.1（portrait×portrait, user0）在输出与语义层均一致。

> **关键判定**：当前不是实现 bug，而是 **same input → different semantic model**。
> merge 把 `userRotation` 当作「物理旋转操作」叠加到 auto 上；source 把 `userRotation` 当作「方向意图」交给 resolver 再做纸面匹配。两种建模对同一 `userRotation` 的物理解释不同，故最终输出在 userRotation≠0 且存在纸张方向失配时发散。

### 2.2 与 Gate 3-4B guard 的关系

- `srcNaive` 列（非法迁移 `contentRotation=effectiveRotation`）在 B-2.4（90→270）、B-2.5（270→90）偏离 `srcCur` 达 180° → 证明迁移方案错误，guard 已锁死。
- R1 是**更上游**的问题：即使不迁移，`merge` 与 `srcCur` 本身已在 4 例发散。guard 防的是「用错误方式抹平」，R1 决定「是否应在模型层统一」。

---

## 3. Formal Rotation Model（两个语义模型）

### M1 — Physical Rotation Model（Merge）

```
Rfinal = A + U
```
- `A` = `Auto(content, paper)`：自动纸张方向修正（canonical CW，landscape×portrait → 270）。
- `U` = `userRotation`：物理页内旋转操作。
- 特点：user 作用于最终页面、可抵消 auto；输出直接可执行；RenderCommand 无需再解释。

### M2 — Orientation Intent Model（Source）

```
Rfinal = U + L(C, U, P)
```
- `U` = `userRotation`：用户方向意图。
- `L(C,U,P)` = `resolveContentPlacement` 的纸面适配修正（`layoutRotation ∈ {0,-90}`）。
- 特点：user 改变内容方向、resolver 再适配纸张；输入非最终旋转；placement 是最终结果。

### 核心冲突

```
M1:  userRotation ∈ 最终旋转域（result-space）
M2:  userRotation ∈ 输入意图域（intent-space）
```

同一符号 `userRotation` 在两模型中被分配到**不同语义层**——这是 R1 的根因，也是 Gate 3-4B 误迁移的认知来源。

---

## 4. Option Analysis

### Option A — Merge adopts Source semantics

目标：让 `PrintGeometryBuilder` 改为「user intent + paper correction」模型，取消 `effectiveRotation = auto + user`，使 merge 也走 `resolveContentPlacement` 式内部解析。

影响面（🔴 高）：
- `PrintGeometryBuilder`、`PrintAutoRotationPolicy`、`RenderCommand` 契约、`MultiTicketComposer`。

风险：
- Gate 3-4A 已冻结 `RenderCommand consumes final rotation`；改动即**使 Gate 3-4A 契约失效**。
- merge regression matrix（Gate 3-1/3-4A）全部重跑；多票布局需重新验证。

评价：**不推荐**——破坏刚建立的 merge seam，且未解决「符号混层」根因（只是把混层搬进 merge）。

### Option B — Source adopts Merge semantics

目标：`resolveContentPlacement` 接受 `effectiveRotation` 并停止内部 auto resolve。

表面优点：两边消费同一 `effectiveRotation`。

但 Gate 3-4B 已实证失败：

```
source resolver:  contentRotation + layoutRotation
若 contentRotation = effectiveRotation (= auto + user):
    = (auto + user) + layoutRotation   ← 重复纸面修正
```

风险（🔴 极高）：
- 已被 `Gate3-4B guard` 永久禁止（B-2.4/B-2.5 实测 180° 回归）。
- 影响 `RotationResolver` / Preview pipeline / OFD placement / source print 全链。

评价：**Rejected**。

### Option C — Explicit Rotation Layers（推荐进入设计重点）

新增显式分层：

```
RotationIntent ──▶ RotationResolver ──▶ RotationResult
```

输入层：

```js
// RotationIntent
{ userRotation: 90, autoPolicy: "landscape-fit" }
```

输出层：

```js
// RotationResult
{ effectiveRotation: 0, layoutRotation: -90, finalPlacement: ... }
```

结构：

```
                User UI
                   │
                   ▼
          RotationIntent (userRotation, intent-space)
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
 Source Resolver        Merge Builder
 (M2: intent→placement) (M1: intent→result)
        │                     │
        ▼                     ▼
 placement             RenderCommand
        │                     │
        └─────► RotationResult ◄──┘
```

优点：
1. 消除 `userRotation`/`effectiveRotation` 混名——意图与结果分属不同层。
2. 保留现有 seam：Merge 继续消费 `RotationResult`，Source 继续消费 `RotationIntent`。
3. 可渐进迁移，不需一次重写。

风险（🟡 中高）：
- 需新类型定义 + API 命名调整 + 测试扩展；但**不破坏现有输出**。

---

## 5. Regression Matrix Proposal（验收矩阵）

### 5.1 已验证（B-2，6 用例）

见 §2 表格，已由 `Gate3-4B-SourceRotationOwnership.test.mjs` 锁定。该测试同时承担：
- **Gate 3-4B guard**：`srcNaive` 偏离 `srcCur` 即失败（禁止迁移）。
- **R1 基线**：`R1 diff` / `layersDiffer` 列量化当前双路径发散。

### 5.2 扩展提案（16 用例，待 R1 裁决后实现）

维度：

```
content: portrait, landscape
paper:   portrait, landscape
user:    0, 90, 180, 270
→ 2 × 2 × 4 = 16 cases
```

验收层级：
- **Layer 1（Intent preservation）**：`userRotation` 输入不被静默改写。
- **Layer 2（Resolver correctness）**：Source `Intent → Placement` 正确。
- **Layer 3（Final output）**：Merge `Result` / Source `Placement rotation` 各自自洽。
- **Layer 4（Cross path）**：**当前不要求** merge 与 source 最终旋转强制一致；要求**同一语义定义**（即 Option C 落地后，二者对同一 `RotationIntent` 的解释可溯源、可对比）。

> 注：16 用例的**期望值不在本评审给出**（属实施阶段，须 R1 裁决后由对应 gate 计算并固化）。本评审只定义维度与验收层级。

---

## 6. Recommendation（推荐排序）

### 第一推荐 — Option C（Explicit Rotation Layer）

理由：当前问题不是「rotation algorithm wrong」，而是「rotation value naming collision / 语义层混用」。
- `userRotation` 有时是 intent、有时是 result → 导致 Gate 3-4B 误迁移、R1 发散、OFD 验证困难。
- C 显式分层能**解释**当前差异（M1/M2 各自合理），而非强行消灭差异。
- 渐进迁移，不破坏 Gate 3-4A 已冻结的 merge seam。

### 第二选择 — Option 0（Maintain Dual Model，仅强化命名与文档）

即 Merge = Physical Model、Source = Intent Model，**双模型并存**，但：
- 明确命名（intent-space vs result-space 不得互传）。
- 用类型/注释隔离，防未来再次误迁移。
- 接受「双路径最终输出可能不一致」为已知约束（B-2.2/4/5/6 偏差写入已知问题清单）。

### 不推荐

- **A**：破坏刚冻结的 merge seam（Gate 3-4A 契约失效）。
- **B**：已被 Gate 3-4B guard 实证否决（180° 回归）。

初步倾向（非终裁）：**C > Option 0 > A > B**。

---

## 7. Decision Required（待裁决）

R1 最终需裁决：

- **Option 0**：保持双模型，仅强化命名/文档/已知问题清单。最小改动，接受输出偏差为已知约束。
- **Option C**：引入 `RotationIntent` / `RotationResult` 显式分层，做长期架构收敛（🟡 中高迁移成本）。

**不建议进入**：Option A、Option B。

裁决后下一步（均不在本评审范围）：
1. 是否进入 **Gate 4**（Merge per-slot）。
2. 是否安排 **OFD/PDF/Image 统一回归**（OFD 属 source placement 体系，等待 R1 语义定调，不提前打补丁）。
3. 若选 C，是否建立 **Rotation Semantic Migration Gate**（独立于 Gate 4/5）。

---

## 附录 — Verification Evidence（可复现）

```
# 重跑命令（2026-08-19）
node --test frontend/src/layout/Gate3-4B-SourceRotationOwnership.test.mjs
→ # tests 1 / # pass 1 / # fail 0
```

B-2 矩阵数值来源同上，本评审 §2 表格逐行引用其输出，未做任何手工改写。

---

## Gate 状态（评审期间）

```
Gate 3-4A          ✅ CLOSED (df7debd, remote)
Gate 3-4B          ✅ CLOSED (6aeceeb, remote) — 验证 Gate + guard 已装
R1 Design Review   📝 DRAFT（本文档）— 待裁决 Option 0 / C
Production Code    ❄ 零改动
OFD                ⏸ waiting R1 decision
```
