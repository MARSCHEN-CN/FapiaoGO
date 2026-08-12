# C-2-G · G2-R2 · 32-Case Print Command Truth Matrix 一致性审计（只读，未改生产代码）

> 状态：**C-2-G = G2 BLOCKED / G2-R2 OPEN READ-ONLY**
> 性质变更：G2-R2 从「继续推导旋转算法」转为「冻结 32-case 实测 Truth → 一致性审计 → 最小 `PrintCommandTruthResolver` → G2-R2 implementation」。
> 纪律：**本审计不改任何生产代码**；下表视为用户实测 Truth，审计只做覆盖/等价/闭环/跨矩阵一致性校验。

---

## 0. 架构方向评审（CodeReviewExpert 视角）

**总体认可**。把 32 个真实物理打印得到的最终命令冻结成 Truth Table、再由一个**极窄的最终层** `PrintCommandTruthResolver`（`PrintState → SumatraCommand`，不碰 PDF/Preview/Canvas/几何/Margin）消费，方向正确，且与你已确立的「旋转正确性与 Margin 正确性解耦」目标一致。

**两个关键纪律点必须在落地时守住**（你已在 §七/§十一强调，这里作为 reviewer 加码确认）：
1. `paperType`（竖向/横向纸张**类型**）与 `paperOrientation`（portrait/landscape 纸张**方向**）必须是**两个独立维度**——本审计 §4 + §5 会证明混淆这两者正是当前最危险的错误。
2. 现有 `sumatra-command-resolver.js` 的 `ROTATE_MATRIX` **就是 Table A（横向纸张类型）**，且**在 electron 中从未被调用**；所以新 resolver 是**新建**而非重构旧 resolver，旧 16 表须被重新归属为「横向纸张类型」子矩阵。

**但本审计发现一处 🔴 blocker（§5），必须先在数据层解决，才能进入 implementation。**

---

## 1. 32-Case 模型定义

```text
发票原生方向 (2)  ×  用户旋转 (4)  ×  纸张类型 (2)  ×  纸张方向 (2)  = 32
invoiceOrientation × rotation × paperType × paperOrientation
```

- `invoiceOrientation` ∈ {portrait(竖向发票), landscape(横向发票)}
- `rotation` ∈ {0, 90, 180, 270}
- `paperType` ∈ {verticalPaper(竖向纸张类型=A4 等原生竖向纸), horizontalPaper(横向纸张类型=240×140 等原生横向凭证纸)}
- `paperOrientation` ∈ {portrait, landscape}

最终命令形态：`{ orientation: 'landscape'|'disable-auto-rotation', rotate: 0|90|180|270, fit }`。

---

## 2. 实测 Truth 矩阵（用户提供的 32 项）

### Table A — 横向纸张类型（horizontalPaper）｜对照既有 `ROTATE_MATRIX` ✅ 完全一致

| invoice | rotation | 横向纸(landscape) | 竖向纸(portrait) |
|---|---|---|---|
| landscape | 0° | L+90 | P+90 |
| landscape | 90° | L+90 | P+270 |
| landscape | 180° | L+270 | P+270 |
| landscape | 270° | L+270 | P+90 |
| portrait | 0° | L+270 | P+90 |
| portrait | 90° | L+90 | P+90 |
| portrait | 180° | L+90 | P+270 |
| portrait | 270° | L+270 | P+270 |

### Table B — 竖向纸张类型（verticalPaper = A4 等）

| invoice | rotation | 横向纸(landscape) | 竖向纸(portrait) |
|---|---|---|---|
| landscape | 0° | L+0 | P+0 |
| landscape | 90° | L+0 | P+180 |
| landscape | 180° | L+180 | P+180 |
| landscape | 270° | L+180 | P+0 |
| portrait | 0° | L+180 | P+0 |
| portrait | 90° | L+0 | P+0 |
| portrait | 180° | L+0 | P+180 |
| portrait | 270° | L+180 | P+180 |

**关键观察（你已指出）**：
- 横向纸张类型：rotate 只取 **{90, 270}**。
- 竖向纸张类型：rotate 只取 **{0, 180}**。
- 即「纸张类型决定 Sumatra 最终旋转的基准象限」。

---

## 3. 一致性审计结果

### ① 覆盖度：32 / 32 ✅
2×4×2×2 = 32，两张表各 16 项、四象限全填。无缺项。

### ② 等价 / 重复 Case：属正常属性，非缺陷
不同用户输入 → 相同最终命令，Truth Table 应显式记录（这正是 table 优于公式的地方）：
- Table A 横向纸：landscape@0°==landscape@90°(均 L+90)；portrait@90°==portrait@180°(均 L+90)。
- Table A 竖向纸：landscape@0°==portrait@0°==portrait@90°(均 P+90)。
- Table B 横向纸：landscape@0°==landscape@90°(均 L+0)；portrait@0°==portrait@270°(均 L+180)。
> 结论：等价 Case 存在且符合「同命令多输入」预期，**不阻塞**。

### ③ 旋转闭环：✅（以 mod-180 分组自洽）
- 竖向纸张类型 rotate 集合 {0,180} → 命令只依赖 rotation 的**奇偶性（mod 180）**；`+180` 在组内稳定toggle（0↔180、L+0↔L+180），闭环成立。
- 横向纸张类型 rotate 集合 {90,270} → 同理 mod-180 分组自洽。
- 经验证：对每个 (invoice, paperOrientation)，`rotation` 步进 90° 时命令在 {0,180} 或 {90,270} 内成对切换，无「半步漂移」。
> 结论：作为**数据异常检测**通过；未出现应变未变的硬偏移。

### ④ 跨矩阵关系：🔎 **Table A = Table B + 90°（逐格恒定偏移）**
对全部 16 个对应格求 `TableA.rotate − TableB.rotate (mod 360)`，结果恒为 **+90**：

| invoice | orientation | 0° | 90° | 180° | 270° |
|---|---|---|---|---|---|
| landscape | landscape | +90 | +90 | +90 | +90 |
| landscape | portrait | +90 | +90 | +90 | +90 |
| portrait | landscape | +90 | +90 | +90 | +90 |
| portrait | portrait | +90 | +90 | +90 | +90 |

> 强结论：**两个 16-case 矩阵并非独立，整个「横向纸张类型」矩阵 = 「竖向纸张类型」矩阵整体偏移 +90°**。这是数据高度可信、非随机的有力证据，也是 §0 第 2 点「现有 ROTATE_MATRIX == Table A」的旁证。

---

## 4. 🔴 Blocker：T5 的 Truth 归属被错配（§五的 270 是错的）

用户在 §五写道：

> T5（竖向发票, 0°, **横向纸张**）→ 横向纸张类型 → `landscape,rotate=270,fit`，并称「正好与 R2-3 的 `ROTATE_MATRIX[portrait][landscape][0]=270` 吻合」。

**这里把「横向纸张（= landscape 纸张方向）」与「横向纸张类型（horizontalPaper）」混为了一字段——正是你自己在 §七警告不要犯的错误。**

按你 §一~§七 建立的 4 轴模型逐字套：
- T5 = 「**竖纸 A4** × 横向」→ A4 是**原生竖向纸** → `paperType = verticalPaper（竖向纸张类型）`。
- 「横向」= 用户请求 landscape 纸张**方向** → `paperOrientation = landscape`。
- `invoiceOrientation = portrait`，`rotation = 0°`。

→ 查 **Table B（竖向纸张类型）** → 横向纸(landscape) 列 → portrait 行 → 0° = **L + 180**。

即 T5 的正确 Truth 应为 **`landscape,rotate=180,fit`**，**不是** `landscape,rotate=270,fit`。

### 为什么这不只是措辞问题
- §五的 270 来自 **Table A（横向纸张类型）**；但 T5 是 A4（竖向纸张类型），应查 **Table B**。
- 二者相差恰好是 §4 的 **+90° 恒定偏移**（270 − 180 = 90），与跨矩阵关系完全自洽——这反过来证明：只要你用对矩阵，T5 的 rotate 就是 180。
- 这同时**修正了 G2-R2 审计报告 R2-3 的一处疏漏**：R2-3 引用 `ROTATE_MATRIX[portrait][landscape][0]=270` 作为「T5 理论补偿」，但该 16 表是**横向纸张类型**矩阵；T5（A4=竖向纸张类型）的理论值应为 **180**。旧审计须加 erratum（见 §6）。

### 物理可验证建议（落实「冻结数据、不靠公式」）
当前 production 对 T5 发 `landscape,fit`（无 rotate）→ 净内容角 −90°（即你实测的「反向 90°」bug）。
- 候选修复 = Table B 值 **rotate=180** → 应得到正确 portrait-on-landscape 旋转。
- §五的 270（Table A）对 A4 是**错配矩阵**，物理上不会是 T5 的正解。
- **行动**：真机 T5 用 `landscape,rotate=180,fit` 复测；保留 `rotate=270` 仅用于**横向纸张类型**组合。这一步应并入「32-case regression」首轮。

> 若你确有独立实测证明 A4 横向用 270 才正立，则 Table B 的 portrait@landscape@0° 须改为 270——但那会破坏 §4 的「+90 恒定偏移」跨矩阵不变量，需一并重测整张 Table B。在矛盾解除前，本审计以「4 轴模型 + Table B 自洽」为准，标记 §五 的 270 为 **待物理复核的错配**。

---

## 5. 对 `PrintCommandTruthResolver` 落地的 reviewer 提示（仅建议，不执行）

1. **Key 必须含 4 轴，且 `paperType` 须从纸 spec 派生**：A4(210×297, h>w)→verticalPaper；240×140(w>h)→horizontalPaper。建议在 `PaperRegistry`/`resolvePaperSpec` 增加 `paperType` 字段，避免调用方再传布尔 `landscape` 误代类型。
2. **现有 `ROTATE_MATRIX` 重新归属**：它是 Table A（horizontalPaper），且 electron 从未调用。新 resolver 不应「复用」它，而应**显式持有两个 16-case 子矩阵**（或 1 个 base + paperType 偏移），并删除/冻结旧 resolver 的「直打模型唯一 truth」语义注释。
3. **`print-settings.js:292` 短路必须被绕过**：`if (orientResult.contentRotation !== 0)` 会在 T5（用户 rotation=0）时跳过 rotate，使 Truth 值 180 无法发出。新 resolver 应直接输出 Truth `rotate`，不受 contentRotation 短路约束（这是「最终执行层」与「content transform」语义分离的设计红利）。
4. **Preview 不持 Truth Table**：Truth 是最终打印执行层事实，不得回灌 Preview/Canvas/Viewer，防止 Sumatra 特殊旋转语义污染全应用（§十一）。
5. **bake / merged 路径不混进 32-case Truth 本身**：E1/E1a/E2（bake 路径 rotate=90 常量）是另一套语义；若未来要统一，应作为 resolver 的一个 `strategy` 输入，而非改这 32 个值。

---

## 6. G2-R2 审计报告（c2g-r2-content-rotation-causal-audit.md）Erratum

R2-3 中「理论补偿 `ROTATE_MATRIX[portrait][landscape][0]=270`」须加限定：
- 270 = **横向纸张类型**（horizontalPaper）的 portrait×landscape×0° 值（= 现有 `ROTATE_MATRIX`，从未在 electron 调用）。
- **T5 是 A4（竖向纸张类型）**，其正确 Truth 值按 Table B = **180**。
- 旧审计未区分 paperType 维度，导致把横向纸张类型的值误用于竖向纸张类型案例。本审计 §4 为权威修正。

---

## 7. 下一步（与用户提案一致）

1. **冻结数据**：本文件 Table A / Table B 即 32-case Truth（待 §4 blocker 物理复核 T5=180）。
2. **设计 `PrintCommandTruthResolver`**：4 轴 key + 两子矩阵（或 base+offset），输出 `{orientation, rotate, fit}`，不碰其他层。
3. **G2-R2 implementation**：仅对「竖向纸张类型 portrait×landscape×0°（T5）」单组合补发 `rotate=180`（绕过 `print-settings.js:292` 短路），严格单变量。
4. **32-case regression**：真机复测全部 32 项，重点 T5=`landscape,rotate=180,fit`；并验证横纸×纵向 G2 数值、E regression 不退化。
5. **Margin 独立成层**：Truth Command → Margin Contract → Final Print。

> 本审计未改动任何生产代码；所有结论来自对实测表的只读校验与既有 `ROTATE_MATRIX` 的交叉比对。
