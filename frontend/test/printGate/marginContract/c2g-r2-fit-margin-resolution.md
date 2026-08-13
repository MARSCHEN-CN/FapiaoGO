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

## 4.5 Gate 1 代码级核实（margin_contract.apply_pdf 几何语义）

主动读了 `scripts/margin_contract.py`（`apply_pdf` / `apply_margin_contract` / `contain_fit`）与 `add-pdf-margins.py` 兼容壳（本次新增核实，非前版 F1–F5 内容）。结论：

> **Gate 1 代码级初步 PASS —— 统一几何引擎已经存在，且正是「Fit-to-inner-paper-area」模型，不是 clip。**

- `contain_fit`（L72-96）：`scale = min(1.0, sx, sy)`，`offsetX = L + (usableW - contentW*scale)/2`（居中）。→ **真正 contain-fit、保宽高比、居中、scale 上限 1（不放大，INV-3）**；处理 oversized（scale<1 自动缩）、小于 inner box（scale=1 不放大）。✅
- `apply_pdf`（L240-321）：输出 `MediaBox == Policy A outputPaper`（G-2 断言），`/Rotate 恒 0`（R-1，旋转烤进 `compute_transform` 相似矩阵），`content_rotation` 经 `apply_margin_contract` 在 fit **之前**参与（θ%180==90 时 content_w/h 互换，R-2）。✅
- `add-pdf-margins.py` L9 注释：旧「页面边界外扩」模型已删除 → 确认**不是放大纸张**。✅

**🔴 但发现一个关键的语义对接陷阱（新增 R6，必须进 Gate 2 验证）**：`policy_a`（L51-69）的旋转模型是 **「源纸 dims + content_rotation → 推导出输出纸方向」**（θ%180==90 时输出纸 = (paperH, paperW) 互换）。而新架构的 32-case Truth 把 `orientation`（输出纸方向）与 `rotate` 当作**两个独立轴**。若调用方直接把「已交换好的目标纸 dims」+「rotate」一起传给引擎，θ%180==90 会**再交换一次 → 双重交换**（例如 Truth `orientation=landscape + rotate=90`，传 landscape dims+90 → 引擎又 swap 回 portrait）。因此 Truth `{orientation, rotate}` 与 `margin_contract` 的 `{paper_w/h(原生), content_rotation}` **不能直接 1:1 映射**，需要一个翻译层：要么调用方传**原生纸 dims + Truth.rotate**（让 policy_a 推导方向，Truth.orientation 仅作一致性校验），要么扩展引擎接受「显式输出方向 + 旋转」。这一翻译层是非平凡的，须在 A/B 实验里钉死，不能假设「引擎存在 = 直接接线即可」。

**集成缺口（真实工作量，非新引擎）**：
- **G1a**：纯 source 路径（`main.js:605`）当前**完全不调用**该引擎 → 依赖 Sumatra `fit`。
- **G1b**：`main.js:583` 调 `pdfMargin.process(filePath, margins, isImage, orient)` **未传 `paperW_mm/paperH_mm`**（opts 缺失）→ Python 回退「目标纸 = 源 MediaBox」，**不尊重纸张交换**。
- **G1c**：`main.js` 调 `pdfMargin.process` **未传 `content_rotation`** → 引擎旋转参数恒 0，32-case Truth `rotate` 从未进入几何层。

即：引擎已冻结可用（契约 §7.1 唯一几何权威），但 electron 侧**从未把「目标纸 + Truth rotate」喂给它**——这是 G2-R2 implementation 的核心接线工作，不是从零造引擎。R1 原担心的「如果是 clip 要另建引擎」**已被代码排除**。

## 5. 几何实验 A vs B（只读验证， endorsed；即 Gate 2）

用户提案的实验方向正确，细化如下（注意 B 用 `noscale`，且旋转在 fit 之前）：

- **A（基线）**：原始内容 → Sumatra `fit`。
- **B（候选）**：应用层 `rotate(Truth)` → `contain-fit` 到 inner box（inset margin）→ 生成最终 PDF → Sumatra `noscale`。
- **比较维度**：最终内容尺寸、实际四边距、打印方向、是否裁切。
- **判定**：若 B 稳定得到「方向正确 + 四周严格 3mm + 不裁切」，则该路线成立。

> 该实验用非 T5 case（landscape 发票 / verticalPaper / 0° / landscape），**不依赖 T5 冻结**，可在 T5 物理复核前先行验证架构。

## 6. Reviewer 风险清单（implementation 前必须确认）

- **R1（已代码级确认 ✅，非 blocker）— `pdfMargin.process` 几何语义**：已读 `margin_contract.apply_pdf`（`scripts/margin_contract.py`），确认对 oversized PDF 是**真正 contain-fit 缩小到 inner box**（保宽高比、居中、scale≤1），**不是 clip**。统一几何引擎已存在，原担心的「如果是 clip 要另建引擎」已被排除。剩余是集成接线（见 §4.5 G1a/b/c）。
- **R2 — 不双重边距**：当 margin-bake 与新的 contain-fit 同时存在，必须合并为**单一阶段**（inset margin + contain-fit 一次完成），禁止先烤边距再 fit 导致二次 inset。
- **R3 — 旋转顺序统一**：所有路径必须「先 rotate 后 contain-fit」，且 rotate 取 Truth（非 Sumatra 隐含旋转）。
- **R4 — OFD/图片路径一致性**：`imgExts` 当前排除 `.ofd`（记忆：OFD 无边距）。推广 app-fit 时必须对 OFD 给出一致策略，不能让 OFD 成为新的几何权威缺口。
- **R5 — 与 bake 路径互斥**：bake 路径已烤全部几何（含 scale/offset），app-fit 阶段对其必须为 no-op（`MediaBox==paper` 时 contain-fit scale=1），否则与 placement 几何冲突（`placement-bake-processor.js:99` 的二次变换警告）。更深一层：要真正「单一几何权威」，bake 路径的 `placement_bake.py` 几何也应归并到 `margin_contract` 或与之对齐，否则仍存在两个几何引擎（R5 的延伸）。
- **R6（🔴 关键，进 Gate 2）— Truth `{orientation, rotate}` 与引擎 `{paper_w/h(原生), content_rotation}` 的语义翻译**：`policy_a`（margin_contract L51-69）按「源纸 + content_rotation 推导输出方向」，θ%180==90 会 swap 输出纸；而 32-case Truth 将 orientation 与 rotate 当独立轴。直接传「已交换目标纸 dims + rotate」会在 θ%180==90 触发**双重交换**（landscape+rotate90 → 引擎再 swap 回 portrait）。须定义翻译层（传原生纸 dims+Truth.rotate 让 policy_a 推导，orientation 作校验；或扩展引擎接受显式输出方向），并在 A/B 实验钉死，不能假设直接接线。

## 7. Gate 顺序（与全局状态机一致，3-Gate 正式版）

```text
【已完成】物理实测 32-case（orientation+rotate）
   ↓
【已完成】Truth Matrix（{orientation,rotate}）
   ↓
【已完成】一致性审计（Table A = Table B + 90°）
   ↓
──────────── 以下为待执行 Gate ────────────
Gate 1（代码级 ✅ 已 PASS）：核实现有 margin processor 几何语义
   → 结论：margin_contract.apply_pdf 是真正 contain-fit（非 clip），
          统一几何引擎已存在；暴露 R6 双重交换陷阱 + G1a/b/c 集成缺口
   ↓
Gate 2（只读 A/B 实验，非 T5 case）：
   landscape invoice / verticalPaper / 0° / landscape
   A: 原 PDF → Sumatra fit
   B: app rotate(Truth) → contain-fit 到 inner box → margin → MediaBox=paper → Sumatra noscale
   比较：方向 / 内容完整性 / 四边距 / 内容尺寸 / 裁切 / 额外缩放
   + 顺带验证 R6 翻译层（orientation+rotate 如何喂给 policy_a 不出双重交换）
   ↓
Gate 3（T5 单变量物理复核）：
   portrait invoice / verticalPaper / 0° / landscape
   candidate: landscape, rotate=180, noscale   （注意：noscale，非 fit）
   验证后 → T5 升 frozen；FAIL → 不维护 +90° 不变量，重测 Table B
   ↓
Frozen Truth + Margin(noscale + app-fit) 定型
   ↓
PrintCommandTruthResolver（纯旋转 {orientation,rotate}）
   + Margin 层（margin_contract 引擎：app-fit + noscale）
   + 翻译层（R6：Truth → {paper_w/h(原生), content_rotation}）
   ↓
G2-R2 implementation（接线 G1a/b/c，不动已冻结引擎）
```

## 8. 与冻结状态的关系

- `e23107b` / `c39ae14` 保留不回退；本方案不改变它们。
- 本方案**不新造几何引擎**（统一引擎 `margin_contract.apply_pdf` 已冻结可用，契约 §7.1）；真实工作是**集成接线**（§4.5 G1a/b/c）：① 纯 source 路径（`main.js:605`）改走 `margin_contract` 引擎而非 Sumatra `fit`；② `main.js:583` 调 `pdfMargin.process` 须补传 `paperW_mm/paperH_mm`（目标纸，尊重交换）与 `content_rotation`（Truth.rotate）；③ 新增 R6 翻译层把 Truth `{orientation,rotate}` 正确映射为引擎 `{paper_w/h(原生), content_rotation}`（避免双重交换）；④ 最终 Sumatra 收 `noscale`。
- 原则上**不要求改** `RotationResolver` / `normalize` / 16 表 / `usePrint` / `PrintService` 的旋转语义；改的是打印执行接线与几何喂参。
- implementation 仍未批准；当前 blocker 顺序：Gate 2（A/B 非 T5）→ Gate 3（T5 物理复核）。
