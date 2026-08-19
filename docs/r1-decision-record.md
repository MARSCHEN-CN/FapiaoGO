# R1 — Decision Record

> 状态：**CLOSED（裁决已记录，docs-only，零生产代码改动）**
> 日期：2026-08-19
> 分支：`rotation-b1-hardening`
> 基线：`0b7eb8a`（R1 Design Review, local）+ 链 `… → 6aeceeb`（Gate 3-4B, REMOTE）
> 关联文档：`docs/r1-rotation-semantic-design-review.md`（设计评审，本文档引用其结论与 B-2 证据）、`docs/r1-merge-source-rotation-semantic-divergence.md`（R1 issue 记录）、`docs/gate3-4b-source-rotation-ownership-review.md`（迁移 Gate→验证 Gate 纠偏）、`docs/print-pipeline-convergence-design.md`（PPC 设计输入，§0–§13 含联合 R1/PPC 边界 ratification：R1=几何语义轴 / PPC=打印资源轴，交叉点唯一为 `RenderPlacementResult`）
> 评审类型：**Architecture Review / Decision（不进入代码、不改变冻结状态）**
> 补充：本文档 §9 含 OFD 架构澄清（展示路径 / 打印执行路径分离；OFD = 第三种输入格式而非第三种打印模式）

---

## 0. 终裁摘要（Verdict）

```
R1 Design Review

Architecture diagnosis:   PASS
Option B rejection:       PASS
Option A rejection:       PASS
Option C recommendation:  PASS

Implementation timing:    postpone

Current decision:         Option 0 + Future C
Status:                   CLOSED (decision recorded)
```

---

## 1. 架构诊断（Architecture Diagnosis — PASS）

**结论：当前不是 rotation algorithm 错误，而是同一个字段 `userRotation/fileRotations` 被两个 domain model 消费。**

```
userRotation
    │
    ├──▶ Merge Path
    │        Physical Rotation Model
    │        user = operation
    │        output = RotationResult
    │
    └──▶ Source Path
             Orientation Intent Model
             user = intent
             output = Placement Result
```

两个模型本身都可成立。真正的问题是：

```
同一变量名  +  不同语义层  +  缺少类型边界
```

导致的可见后果：
- Gate 3-4B 初始迁移假设错误（误用 `effectiveRotation` 喂 `contentRotation`）；
- R1 B-2 矩阵暴露跨 seam 差异（4/6 用例最终输出不一致）；
- OFD/PDF/Image 验证容易误判为单点 bug。

根因（与设计评审 §3 一致）：`userRotation` 在 M1 属 **result-space（最终旋转域）**，在 M2 属 **intent-space（输入意图域）**——同一符号被分配到不同语义层。

---

## 2. Option B 否决（Rejected — PASS）

不是因为实现困难，而是**架构方向错误（layer inversion）**。

Gate 3-4B 已证明链路：

```
effectiveRotation → contentRotation → resolveContentPlacement
```

会造成：

```
RotationResult
    ↓ 被当成
RotationIntent
    ↓ 再次 resolver
```

典型 layer inversion。

证据（B-2 矩阵，`Gate3-4B-SourceRotationOwnership.test.mjs` 实测，1/1 PASS）：

```
B-2.5: 非法迁移下净旋转偏离 180°
        （srcCur = 270°  ↔  srcNaive = 90°，上下颠倒级）
```

180° 翻转作为**永久否决证据**。`Gate3-4B guard` 已锁死该迁移。

---

## 3. Option A 不推荐（Not recommended — PASS）

A 不像 B 那样违反契约，但代价是**破坏刚建立的 merge seam**。

Gate 3-4A 刚完成并冻结：

```
PrintGeometryBuilder
    │
    ▼
effectiveRotation
    │
    ▼
RenderCommand
```

A 会重新打开：

```
Geometry resolution
    ↓
RotationResolver
    ↓
Render command
```

后果：
- merge 重新进入 content placement 领域；
- per-slot geometry 与 rotation resolver 重新耦合；
- Gate 3-1 / 3-4A 的价值下降。

---

## 4. Option C 评估（Architecture Correct Direction — 但推迟）

C（RotationIntent / RotationResult 分层）是**架构正确方向**，但**不应立即实施**。

原因：当前阶段刚完成 Gate 3-4A、Gate 3-4B，核心目标是**打印 seam 收敛**。若立刻引入

```
RotationIntent
RotationResult
RotationPlacement
```

会扩大 blast radius，冲击正在稳定的打印路径。

---

## 5. 修订后的推荐路线（Revised Recommendation）

不是 `C > Option 0`，而是分阶段：

```
Phase Current:
    Option 0 + C preparation
        ↓
    Gate 4
        ↓
    Rotation Semantic Migration Gate
        ↓
    Option C implementation
```

### 当前阶段

采用：

```
Option 0
Maintain Dual Model
+
Explicit naming contract
```

作为**冻结状态**。

### 后续阶段

单独启动：

```
Rotation Semantic Migration Gate
```

实施 C。

---

## 6. 推荐冻结模型（Frozen Model Definition）

当前正式模型定义（当前 Gate 阶段的 rotation ownership 边界）：

```
                    FileRotationInput
                           │
                           │
             ┌─────────────┴─────────────┐
             │                           │
             ▼                           ▼

    MergeRotationInput          SourceRotationInput

    semantic:                   semantic:
    PhysicalOperation           OrientationIntent


             │                           │
             ▼                           ▼

    PrintGeometryBuilder         resolveContentPlacement


             │                           │
             ▼                           ▼

    RotationResult               PlacementResult
```

**重点约束**：不要让 `FileRotationInput` 直接叫 `userRotation`——该名字已造成污染（result-space 与 intent-space 混名）。两下游输入须以语义明确的类型/命名区隔。

---

## 7. R1 最终裁决（Final Decision）

若现在投票：

### 当前 Gate 阶段 — 选择 ✅ Option 0

理由：
- 零生产风险；
- 不破坏 Gate 3-4A；
- 不触碰冻结模块；
- 保持 OFD/PDF/Image 回归路径稳定。

### 架构演进方向 — 记录 Future: Option C

作为长期目标，由独立的 **Rotation Semantic Migration Gate** 评估实施。

---

## 8. 对 Gate 4 的约束（Gate 4 Impact）

R1 **不阻塞** Gate 4，但增加一个约束：

Gate 4 **不允许**：
- 新增 rotation resolver；
- 新增 effectiveRotation 转换；
- 修改 source rotation ownership。

Gate 4 **只允许**：
- Merge per-slot geometry；
- 消费已有 `PrintGeometry.effectiveRotation`。

---

## 9. OFD 状态重新确认 + 架构澄清（OFD Status & Architecture Clarification）

> 本节约 R1 收尾时补充：把 OFD 的**展示路径**与**打印执行路径**分开看，是本阶段的关键澄清。

### 9.1 展示路径与打印执行路径必须分开

前面 R1 讨论容易把 OFD 的两条路径边界混在一起。当前架构下，OFD 必须分看：

```
OFD
 │
 ├── 展示 Preview
 │      ↓
 │   RenderImage / Canvas
 │      ↓
 │   <img> 展示
 │
 └── 打印 Print
        ↓
    渲染成图片
        ↓
    图片转 PDF
        ↓
    Sumatra 打印
```

### 9.2 为什么之前把 OFD 单独提出来

排查时发现 OFD 走的是 **Canvas placement pipeline**：

```
OFD
 ↓
renderFileToPrintImage()
 ↓
placement
 ↓
resolveContentPlacement()
```

而 PDF/Image source 走的是 **source pipeline**：

```
PDF/Image source
 ↓
Sumatra source print
 ↓
sourceRotation
```

所以 R1 里提 OFD，根因是：

> OFD 当前实现上更接近「渲染后打印」，不是因为 OFD 格式本身需要特殊打印。

### 9.3 统一为「图片转 PDF 打印」的方向（推荐长期目标）

单文件 OFD 完全可以走和图片一样的打印链路：

```
PDF   ┐
Image ├── Render → Bitmap
OFD   ┘
        ↓
       bitmap
        ↓
       image → PDF
        ↓
       Sumatra
        ↓
       打印
```

最终进入**同一个物理打印执行器**。这更符合既有架构方向——**Render Resource 与 Print Resource 分离**：

```
Source Format
(PDF/Image/OFD)
        │
        ▼
Render Resource
(bitmap)
        │
        ▼
Print Resource
(PDF)
        │
        ▼
Printer
```

### 9.4 对 R1 的影响

如果未来采用该方向，R1 问题会进一步缩小。

当前 R1 的多 rotation ownership：

```
Source PDF/Image ── sourceRotation ──┐
                                     ├── (multiple rotation ownership)
OFD ── placement ────────────────────┤
                                     │
merge ── effectiveRotation ──────────┘
```

若全部走：

```
任何格式 → Render → Placement → Bitmap → PDF → Print
```

则打印阶段只剩**一个物理结果** `RenderPlacementResult`，Rotation 只需要在 Render/Placement 阶段解决一次。多个 rotation ownership 收敛为单一入口，R1 暴露的语义分裂随之缩小。

### 9.5 注意点 / 正确顺序（不能马上改）

不能简单说「OFD = 图片，所以马上改」。OFD 已验证：
- OFD 无 TextObject 时，本质就是图形内容；
- RenderEngine 能输出正确图片；
- 但它**依赖 placement contract**。

正确顺序仍然：

```
R1 裁决
 ↓
确定 rotation ownership
 ↓
统一 placement
 ↓
PDF/Image/OFD 三格式回归
 ↓
再决定是否全部 image→PDF
```

### 9.6 当前阶段裁决（OFD 打印路径先不动）

> 单文件 OFD 可以和图片格式一样图片转 PDF 后打印吗？

**可以，而且架构上更推荐这么做。**

但当前 Gate 3-4B/R1 阶段**先不要动**——因为改动会改变 source seam 的边界，需要作为 **R1 后的独立 Print Pipeline 收敛事项**处理（不属于 Gate 4 范围，也不属于 R1 的 Option C rotation 语义迁移；是第三条独立收敛线，见 §10）。

---

## 10. 后续收敛事项清单（Future Convergence Backlog）

R1 CLOSED 后，长期架构收敛分**三条独立线**（互不阻塞）：

| 项 | 内容 | 触发条件 | 范围 |
|----|------|----------|------|
| **Gate 4** | Merge per-slot geometry，消费已有 `effectiveRotation` | 立即（遵守 §8 约束） | 仅 merge per-slot |
| **Option C** | RotationIntent / RotationResult 显式分层（消除 `userRotation` 混名） | Rotation Semantic Migration Gate | 类型/命名，不破坏输出 |
| **Print Pipeline Convergence** | PDF/Image/OFD 统一为 `Render → Image → PDF → Sumatra` 单一打印模式；OFD 由「第三种打印模式」降级为「第三种输入格式」 | R1 裁决 + 三格式回归后 | 重写 source seam 边界 |

> 三者关系：Gate 4 是当前即做的打印 seam 收敛；Option C 是 rotation 语义层收敛；Print Pipeline Convergence 是打印执行器收敛。三条线互不阻塞，但都依赖 R1 先定调 rotation ownership。

> Print Pipeline Convergence 的设计输入见 `docs/print-pipeline-convergence-design.md`（OFD→Image Resource→Image→PDF→Sumatra；含 DPI / Preview 不复用 / PDF 策略 A·B 约束；明确改变 Print Pipeline 而非 R1 Rotation Ownership）。

---

## 11. 下一步（Next Steps / Closure）

```
R1 CLOSED (decision recorded)
        │
        ▼
Gate 4 start (遵守 §8 约束)
```

### 落地动作（本裁决文档）
- 创建 `docs/r1-decision-record.md`（本文档）——R1 正式 CLOSED。
- 不修改任何生产代码、不触碰任何冻结层。
- OFD 打印路径在当前 Gate 阶段保持不变（§9.6）；其统一收敛列入 §10 独立事项。

### 后续
- 进入 **Gate 4**（Merge per-slot geometry，遵守 §8 约束）。
- OFD/PDF/Image 统一回归在 R1 语义定调、三格式回归完成后，由 **Print Pipeline Convergence** 事项评估是否全部 image→PDF（不提前打补丁）。
- 长期：视时机启动 **Rotation Semantic Migration Gate** 评估 Option C；并行推进 **Print Pipeline Convergence**。

---

## 12. 冻结状态确认（R1 Sign-off）

> 本节约 R1 收尾架构确认时由评审方追加，作为**冻结状态唯一锚点**，供 Gate 4 及后续收敛线引用。

### 12.1 根因定性（再确认）

```
R1 Rotation Semantic Divergence
          │
          ▼
不是算法错误
不是单 resolver bug
不是 OFD 特殊问题
          │
          ▼
字段语义污染：
userRotation 同时承担 intent / result 两种角色
```

### 12.2 三个关键裁决确认

1. **Option B 永久否决 ✅** — `effectiveRotation → contentRotation → resolveContentPlacement()` 违反 `contentRotation = user intent（非 final result）`，导致 `auto + effectiveRotation 内已有 auto + resolver 再匹配 = double rotation`；B-2.5（90→270，180° 翻转）为强拒绝证据。纪律：**不允许任何未来优化以「统一 rotation 数值」为理由重新走这条路**。
2. **Option A 暂停合理 ✅** — A 非技术不可行，而是时间点错误：会令 `Render geometry layer` 重新依赖 `content layout layer`，破坏 Gate 3-4A 刚建立的干净 seam。纪律：**Gate 4 不应重新打开 rotation ownership**。
3. **Option C 延后正确 ✅** — 正确方向，但现在引入会同时影响 Preview/Print/Merge/OFD/PDF·Image/测试矩阵，扩大 blast radius。正确顺序：`Gate 4（Print seam 稳定）→ Rotation Semantic Migration Gate → Option C`。

### 12.3 OFD 边界确认

OFD **不应该拥有独立打印哲学**，它只是 `Source Format = OFD`，经 `Render` 成为 `Image Resource` 后进入统一打印。当前不马上改 OFD 的原因：会同时混入「rotation ownership 未完全收敛」与「print pipeline boundary 未重新定义」两个问题，把 Rotation issue 与 Print pipeline convergence issue 搅在一起。故 §10 三条线拆分成立，独立推进。

### 12.4 Gate 4 约束确认

进入 Gate 4 时保持：

**允许**：`MultiTicketComposer` / per-slot geometry / slot placement / `RenderCommand` consumption（消费已有 `effectiveRotation`）。

**禁止**（否则 R1 被重新打开）：新增 rotation resolver / 修改 `sourceRotation` / 修改 `effectiveRotation` 定义 / 修改 `resolveContentPlacement` / 修改 OFD 特殊路径 / 补 rotation workaround。

### 12.5 冻结状态快照（Canonical）

```
Gate 3-4A          ✅ CLOSED
Gate 3-4B          ✅ CLOSED (Verification Gate, guard installed)
R1                 ✅ CLOSED (Option 0 adopted, Future Option C)
OFD                🧊 FROZEN (no special patch, Future Print Pipeline Convergence)

Next:
Gate 4 — Merge per-slot geometry
```

### 12.6 Gate 4 唯一关注点

> 在**已经冻结的 effectiveRotation ownership** 下，验证 merge per-slot geometry 是否保持 `RenderCommand` contract。

不要再回头讨论 rotation ownership，除非出现新的实证回归。当前 R1 已把这个边界封住。

---

## 附录 — 与生产代码关系

```
Production Code:   ❄ 零改动（R1 全程 docs-only）
Frozen Modules:    RotationResolver / PrintAutoRotationPolicy / usePrint.js /
                   resolveContentPlacement / RenderLayoutFactory / Sumatra mapping /
                   OFD·PDF·Image pipeline 均未被触碰
Gate 3-4A:         ✅ CLOSED (df7debd, REMOTE)
Gate 3-4B:         ✅ CLOSED (6aeceeb, REMOTE) — 验证 Gate + guard 已装
R1 Design Review:  ✅ CLOSED (0b7eb8a, local) — 设计评审完成
R1 Decision:       ✅ CLOSED (本文档) — Option 0 + Future C；OFD 路径暂不动，列入 Print Pipeline Convergence
```
