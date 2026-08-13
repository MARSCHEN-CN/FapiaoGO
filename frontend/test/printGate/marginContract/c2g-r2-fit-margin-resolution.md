# C-2-G / G2-R2 — `fit` × `margin` 冲突解决方案（基于审计 F1–F5 的收敛）

> 状态：`G2-R2 OPEN READ-ONLY`。本文是对 `c2g-r2-fit-margin-audit.md`（commit `2551446`）F1–F5 的**解决方案收敛**，非 implementation。未修改任何生产代码。

## 0. 一句话结论

用户提出的 **「应用层 `contain-fit` 到 inner-paper-area + 边距 → 生成最终 PDF → Sumatra `noscale`」** 是对 F1–F5 最干净的收敛方案：

- 它**不推翻 D2**（`noscale` 仍是最终命令的 scale 策略）；
- 它把「被 Contract 禁止的 Sumatra `fit`」与「应用层自己算的 `fit`」彻底分开，反而**坐实**了 Margin Contract 的「单一几何权威」原则；
- 它让 **32-case Truth 收敛为纯粹的 `{orientation, rotate}`**，`scalePolicy='noscale'` 是 Margin Contract 常量而非 Truth 维度——直接消解 F2（scale 从未是 32-case 数据维度）。

## 1. 代码事实支撑（证明方案不是从零设计）

| 路径 | 当前几何权威 | scale 策略 | 位置 |
| --- | --- | --- | --- |
| 有边距 source 路径 | `pdfMargin.process()` 把边距**烤进 PDF** | `scalePolicy:'none'`（`main.js:600`） | `main.js:569-604` |
| bake 路径（有 placement） | `placement_bake.py` 烤入全部几何 | `scalePolicy:'none'`（`main.js:545`） | `main.js:532-568` |
| **纯 source / 无边距路径** | **无应用层几何，依赖 Sumatra `fit`** | **Sumatra 默认 `fit`** | `main.js:605` else 分支 |

`placement-bake-processor.js:99` 明确写道：若 `MediaBox ≠ paper`，**「fit 会二次变换」**——这正是用户担心的「双重缩放」，也是 D2 禁止 Sumatra `fit` 的根本原因。

**结论**：应用层几何 + `noscale` 的模式**已在两条路径落地**；唯一缺口是纯 source 路径仍把 `fit` 交给 Sumatra。用户的提案 = 把应用层 `contain-fit` **推广到全部路径**，让 Sumatra 永远 `noscale`，从而收敛成**单一几何权威**。D2 不仅不用推翻，反而被彻底执行。

## 2. 命名精确化：Fit-to-inner-paper-area

禁止理解为「先 fit 满纸 → 再加 margin」（后者要么扩大 MediaBox、要么对内容二次缩小，易失控）。正确顺序：

```
targetPaper
   │
   ├── inset(margin)            ← 先扣边距
   ▼
contentBox (inner paper area)   ← e.g. 210×297 → 204×291
   │
   ├── rotate(sourceContent, Truth.rotate)   ← 先按 Truth 旋转内容
   ▼
rotatedContent
   │
   ├── contain-fit(rotatedContent, contentBox)   ← 再 contain 进 inner box
   ▼
placedContent (scale = min(cw/Cw, ch/Ch), 居中)
   │
   ▼
Final PDF: MediaBox = paper, content baked
   │
   ▼
Sumatra: orientation + rotate + noscale
```

### 旋转坐标顺序（必须明确，否则 fit 用错 bbox）
**先按 Truth `rotate` 旋转内容，再用旋转后的 content bbox 做 contain-fit。**
例（用户提案的实验）：landscape 发票(297×210) 在 landscape 纸(297×210)、margin 3mm → inner box 291×204 → contain-fit scale = min(291/297, 204/210)=0.971 → 四周严格 3mm，Sumatra `noscale`。
例（T5）：portrait 发票(210×297) 在 landscape 纸(297×210)、candidate rotate=180 → 180° 后 bbox 仍 210×297 → inner box 291×204 → scale=min(291/210,204/297)=0.687 → 居中。旋转须在 fit 之前施加，fit 使用旋转后的包围盒。

## 3. D2 不被推翻（关键澄清）

- **被 Contract 禁止的 `fit` = Sumatra 执行期 `fit`**（缩放发生在打印机 printable area，应用无法控制）→ F1 已证这是无条件硬冻结。
- **用户提案的 `fit` = 应用层 `contain-fit`**（缩放由我们自己的几何层计算，Sumatra 仅 `noscale`）→ 是**另一个层**的几何决定，不触碰 D2。
- 最终 Sumatra 命令仍是 `orientation + rotate + noscale`。**D2 = noscale 完全成立**，只是重新定义了「应用层 fit」与「Sumatra fit」是两个不同事物。

→ 因此**无需走 §11 契约变更**推翻 D2；F3 的「Resolver 无权覆盖冻结契约」在此方案下自动消解（Resolver 根本不输出 `fit`，只输出 `{orientation, rotate}`，`scalePolicy` 由 Margin 层注入 `noscale`）。

## 4. 32-case Truth 进一步纯化为 `{orientation, rotate}`

F2 指出 32-case 数据从未记录 `fit`/`noscale`，「all 32 = fit」是 assertion。本方案给出更干净的解释：

> **`scalePolicy` 从来不是 32-case 的 Truth 维度，它是 Margin Contract 的常量（`noscale`）。**

所以 32-case Truth 只承载旋转正确性（orientation + rotate），与 scale/margin 彻底解耦。Resolver 输出：

```js
{ orientation, rotate }   // ← 纯旋转 Truth
// scalePolicy: 'noscale' 由 Margin 层注入（D2 常量）
```

这比「把 fit 塞进 32-case」在架构上正确得多，也符合用户「让旋转 Truth 与 Margin/fit 真正解耦」的终局目标。

## 5. 几何实验 A vs B（只读验证， endorsed）

用户提案的实验方向正确，细化如下（注意 B 用 `noscale`，且旋转在 fit 之前）：

- **A（基线）**：原始内容 → Sumatra `fit`。
- **B（候选）**：应用层 `rotate(Truth)` → `contain-fit` 到 inner box（inset margin）→ 生成最终 PDF → Sumatra `noscale`。
- **比较维度**：最终内容尺寸、实际四边距、打印方向、是否裁切。
- **判定**：若 B 稳定得到「方向正确 + 四周严格 3mm + 不裁切」，则该路线成立。

> 该实验用非 T5 case（landscape 发票 / verticalPaper / 0° / landscape），**不依赖 T5 冻结**，可在 T5 物理复核前先行验证架构。

## 6. Reviewer 风险清单（implementation 前必须确认）

- **R1（最关健）— `pdfMargin.process` 对「超大 PDF」的行为**：当前 margin-bake 路径对已 oversized 的 PDF 是**真正 shrink 到 inner box（contain-fit）**还是仅 clip？若只是 clip，则把 app-fit 推广到纯 source 路径会让超大 PDF 被裁。需读 `pdf-margin-processor` 确认其 contain 语义，否则纯 source 路径的 app-fit 须另写 contain 逻辑。
- **R2 — 不双重边距**：当 margin-bake 与新的 contain-fit 同时存在，必须合并为**单一阶段**（inset margin + contain-fit 一次完成），禁止先烤边距再 fit 导致二次 inset。
- **R3 — 旋转顺序统一**：所有路径必须「先 rotate 后 contain-fit」，且 rotate 取 Truth（非 Sumatra 隐含旋转）。
- **R4 — OFD/图片路径一致性**：`imgExts` 当前排除 `.ofd`（记忆：OFD 无边距）。推广 app-fit 时必须对 OFD 给出一致策略，不能让 OFD 成为新的几何权威缺口。
- **R5 — 与 bake 路径互斥**：bake 路径已烤全部几何（含 scale/offset），app-fit 阶段对其必须为 no-op（`MediaBox==paper` 时 contain-fit scale=1），否则与 placement 几何冲突（`placement-bake-processor.js:99` 的二次变换警告）。

## 7. Gate 顺序（与全局状态机一致）

```text
物理实测 32-case（orientation+rotate）
   ↓
Truth Matrix（{orientation,rotate}）
   ↓
一致性审计（Table A = Table B + 90°）
   ↓
T5 单变量物理复核（candidate rotate=180）
   ↓
几何实验 A vs B（本方案，只读）
   ↓
Frozen Truth + Margin(noscale + app-fit) 定型
   ↓
PrintCommandTruthResolver（纯旋转）+ Margin 层（app-fit + noscale）
   ↓
G2-R2 implementation
```

## 8. 与冻结状态的关系

- `e23107b` / `c39ae14` 保留不回退；本方案不改变它们。
- 本方案**不要求改** `RotationResolver` / `normalize` / 16 表 / `usePrint` / `PrintService` / `placement-bake-processor.js` / `main.js` 的现有接线；它要求的是**新增一个统一的应用层几何阶段**（inset margin + contain-fit + rotate），并将纯 source 路径从 Sumatra `fit` 切换到 `noscale`。
- implementation 仍未批准；当前唯一 blocker 仍是 T5 物理复核。
