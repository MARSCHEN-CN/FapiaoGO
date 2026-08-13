# G2-R2 · `fit × margin` 关系审计（只读，未改生产代码）

> 状态：READ-ONLY。本审计是对「下一步做 fit×margin 关系审计」的回应。
> 核心结论先说在前面：**用户关于 Margin Contract `noscale` 的前提表述是错误的；`fit` 不能在不触发 §11 契约变更的情况下进入 32-case Truth。**
> 配套报告：`c2g-r2-truth-driven-state.md`（三层状态）、`c2g-r2-32case-truth-matrix-audit.md`（32-case 一致性）。
> 权威源：`docs/print_margin_contract.md`（**FROZEN v1.1**）。

---

## 0. Reviewer 总评

用户的方向直觉里，**三层分离（旋转正确性 ⟂ 安全边距正确性）是对的**，且「production 仍未消费 32-case Truth」「不要在 `print-settings.js` 继续加 if」也是对的。

但本次提议的落点——「把 `fit` 作为 32-case Truth 的一部分落实，并据此重新审计 Margin Contract 的 `noscale` 前提」——建立在一个**错误前提**之上，必须在本审计中纠正，否则会：

1. 让 32-case Truth 直接违反冻结契约 D2；
2. 把当前 `fit` 的「掩盖 desync」行为误当成正确 Truth。

---

## 1. 🔴 F1：`noscale` 不是「前提于 margin ≥ 硬件不可打印边」的软约束

用户原话（ paraphrased ）：

> 「你们之前的 Margin Contract 里有一个非常重要的决策：推荐 `noscale`，**前提是 margin ≥ 打印机硬件不可打印区域**。」

**这是错误的。** 该「margin ≥ 不可打印边」检查属于**另一层**：

- **Print Capability Guard（§5.1，C-1 独立层）**：只做 **放行 / 告警 / 阻断** 三选一，**明令「不得修改几何、不得改 fit」**（§5.1 末段）。它从不决定 `fit`/`noscale`。
- **D2（§0 / §4）**：是 `fit` 策略本身的冻结裁决，与 Capability Guard 完全正交。

D2 的实际冻结文本与理由（逐字）：

- §0 D2：`noscale`（**禁止 `fit`，禁止条件式、禁止静默降级**）—— 🔒 冻结。
- §4 行 248：`冻结值：noscale`。
- §4 行 259–261：

  > 「`fit` 为何不可用：Sumatra 的 `fit` 以**可打印区域**为目标而非纸张。打印机存在硬件不可打印边（典型 3–5mm），故 `printable < paper`。**即便 `MediaBox == paper`，`fit` 仍会整页再缩约 96–98%**，使实际边距 ≠ 设定值，且 scale 被后端二次解释——正是契约要禁止的行为。」

**结论**：D2 是无条件硬冻结。`fit` 被禁不是因为「margin 不够大」，而是因为 `fit` **必然**按 printable area 重新缩放（即便你的 margin 已经远大于硬件边），从而破坏严格边距并引入第二处 scale 解释点。这是**结构性禁令**，不存在「margin 够大就能用 fit」的豁免。

→ 因此「重新拿出 noscale 前提，检查它是不是保守选择」这个审计方向**前提不成立**：它本来就不是保守选择，而是硬约束。

---

## 2. 🔴 F2：32-case 数据里**根本没有 scale 维度**

回看本系列已冻结的两张表（`c2g-r2-32case-truth-matrix-audit.md` 的 Table A / Table B）：

| 发票 | Rotation | 横向纸 | 竖向纸 |
| -- | --: | -- | -- |
| 横向 | 0° | L + 0 | P + 0 |
| … | … | … | … |

记录的是 **orientation + rotate**。`fit` / `noscale` **从未作为被测维度出现**。

用户本次断言「目前所有实测 Truth 都是 `fit`」，但：

- 这**没有对应的逐格实测记录**支撑；
- 它更可能是对「当前 source 路径默认 `contain`（=fit）」的投射（`print-settings.js:304-306` 默认 `case 'contain': default → 'fit'`；`print-settings.js:186-187` 明令「现阶段默认 'contain'… 禁止在此做 if(margin) noscale」，noscale 迁移属 deferred D2 触点）。

按本项目自立法纪（**物理实测 → Truth → 冻结**），「all 32 = fit」在未被逐格实测前，**不能冻结为 Truth**，只能标记为 **assertion / candidate**。这与 T5 的 candidate 纪律完全一致。

---

## 3. 🔴 F3：即便采信「32-case = fit」，它也直接违反 D2

假设我们忽略 F2，直接把 `fit` 写进 Truth：

- Truth 输出 `…,fit`；
- 冻结契约 D2 要求 `…,noscale`；
- 二者冲突。

冻结契约 §11 规定：变更须「说明被推翻的不变量 + 同步更新 vectors + JS/Python 双侧执行器同向量 + 版本递增」，**禁止在 bugfix 中顺带修改**。

所以「fit 与 Margin Model 共存」不是一句架构判断就能成立的——它**必须走 §11 契约变更流程**，由用户显式签署推翻 D2（及其 §2.3 结构性证明 R-2 强制）。**Truth Resolver 无权用「物理 Truth 说 fit」去覆盖冻结契约**，否则正是契约 §2.5 警告的「第二个几何解释点」。

---

## 4. 🟡 F4：当前 `fit` 可能在「掩盖 desync」——用户提议的实验改错了轴

Margin Contract §2.4（审查提示）原话：

> 「现行 `fit` 一直在**掩盖** rotation 与 paper 方向的不同步——不同步时 fit 会缩放兜底，不报错。切到 `noscale` 会让这类历史缺陷**首次显形**。」

这直接冲击用户提议的验证实验：

- 用户 case：**横向发票 × 竖向纸张类型 × 0° × landscape**
- 当前（用户报）：`landscape,rotate=90,noscale`
- 用户想改成：`landscape,rotate=0,fit` ← **同时改了 rotate（对）和 scale（错）**

按本审计纠正后，正确的单变量实验应是：

```
landscape, rotate=0, noscale     ← 只改 rotate 对齐 Truth，scale 维持 D2=noscale
```

理由：

1. `rotate` 90→0 是消除 desync（32-case Truth 的本职），必须改；
2. `noscale` 是 D2 冻结值，**不应被改成 fit**；
3. 若改完 `landscape,rotate=0,noscale` 后真机出现「以前没见过的裁切」，按 §2.4 这是 **fit 长期掩盖的旧 desync 首次显形**，是好事，不是回归——需回到 32-case 的 orientation/rotate 进一步校正，而不是退回 fit。

**关键反转**：用户以为「当前=noscale 是旧算法该被 32-case=fit 取代」；但按冻结契约，**noscale 才是目标态**，当前 source 路径的 `fit` 才是旧 regime 的遗留。32-case 该固化的是 **orientation+rotate 的正确性**，scale 应交给 D2（noscale），二者在「desync 已修」前提下完全兼容。

---

## 5. 🟡 F5：三层拆分需修正——`fit/noscale` 不归 Truth Resolver 「拥有」

用户提议的架构：

```
PrintCommandTruthResolver → { orientation, rotate, fit }
```

其中 `fit` 被归为 Truth 的一部分。

按冻结契约，正确边界是：

```
PrintCommandTruthResolver（只答 PrintState → 最终视觉朝向）
        ↓ 输出 { orientation, rotate, scalePolicy }
scalePolicy 来源于 Margin Contract D2（当前 = 'noscale'），Resolver 只能「查表引用」，
            不得「自行决定」为 fit。
```

即：**Resolver 不知道 PDF/Canvas/Preview/Margin 几何（✅ 原提议正确），但它也不得自行裁定 scale 策略**——scale 策略是契约层职责（D2），Resolver 是契约的**消费者**而非**所有者**。这与 §2.5「全链只有一处决定几何」一致：geometry（含 scale）的权威在 Margin Contract，不在 Print Execution 层。

所以「`fit` 应属于 PrintCommandTruth 而非 Margin 层」这一句话需要改成：

> **「最终视觉朝向（orientation+rotate）属于 PrintCommandTruth；scale 策略（fit/noscale）属于 Margin Contract（D2），由 Resolver 引用而非裁定。」**

---

## 6. ✅ 仍被确认正确的部分

- 旋转正确性 ⟂ 安全边距正确性，是两条独立轴线（用户核心直觉，✅）。
- production 当前未消费 32-case Truth，仍走旧 `contentRotation → resolveOrientationCommands → rotate → fit/noscale` 链路（✅，本系列 R2-1 已证）。
- 不应在 `print-settings.js` 继续堆 `if`（✅，会重造「公式算法」）。
- 31 个非 T5 格可作 candidate dataset（✅）；T5 仍是唯一未冻结格（✅）。
- `paperType` 与 `paperOrientation` 两维分离（✅，本系列已立）。

---

## 7. 下一步 Gate（修正后）

**不做**：把 `fit` 写进 32-case Truth、或在本审计内「确认 fit 与 Margin 共存」。

**应做（全部只读 / 物理，无代码）**：

1. **补测 scale 维度**：对 32 格逐格记录实际发出的 `fit`/`noscale`（以及它来自 bake 路径还是 source 路径），把「all = fit」从 assertion 升级为 measured。注意当前 source 默认 `contain`(fit)、bake 成功路径 `noscale`（`main.js:536-541`、`placement-bake-processor.js:12-13`）——两路径 scale 取值本就不同，必须分路径记录。
2. **T5 物理复核不变**：`verticalPaper / portrait / 0° / landscape` → candidate `rotate=180`（candidate，非 frozen），单变量真机实验，PASS→冻结。
3. **若坚持要 `fit`**：必须走 `docs/print_margin_contract.md` §11 契约变更流程——明示推翻 D2（含 §2.3 R-2 结构性证明的失效说明）、更新 `margin_contract_vectors.json`、JS/Python 双侧执行器同步、版本递增、用户签署。**这不是 Resolver 能私下决定的。**
4. **验证「desync 修后 + noscale」终态**：用 `landscape,rotate=0,noscale` 类命令做真机，确认无裁切、边距严格、且不被 fit 掩盖——这才是 G2-R2 与 Margin Contract 同时 PASS 的收口形态。

---

## 8. 冻结状态（维持）

- `e23107b` / `c39ae14` 保留不回退；不动 resolver / margin / normalize / 16 表 / canvas / placement-bake / main.js / usePrint / PrintService。
- `C-2-G = G2 IMPLEMENTED（数值四象限 PASS）/ T5 真机 FAIL / G2-R2 OPEN READ-ONLY`。
- 本审计未改任何生产代码。
