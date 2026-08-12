# C-2-G · G2-R2 · 状态分叉：从「算法推导」转「物理 Truth 驱动」（只读，未改生产代码）

> 状态：**C-2-G = G2 BLOCKED / G2-R2 OPEN READ-ONLY / 32-case 数据建模已完成，尚未进入 implementation**
> 性质变更：G2-R2 从「推导旋转算法」正式分叉为「冻结 32-case 物理 Truth → 一致性审计 → 单点物理复核 → Frozen Truth Matrix → 最小 Resolver → G2-R2 impl」。
> 纪律：**本文件不改任何生产代码**；当前唯一正确动作 = T5 单变量物理实验（见 §6），不批准任何 Resolver implementation。

---

## 0. 一句话

可以把项目状态严格定义为：

> **G2-R2 已完成因果定位与 32-case 数据建模，但尚未进入 implementation。当前唯一 blocker = T5 的 `rotate=180` 物理复核。**

---

## 1. 三层状态模型（不能再混）

### ① 32-case 实测数据（Truth 候选数据源）
- 来源：本次会话中真机打印得到的最终 Sumatra 命令（Table A=横向纸张类型 / Table B=竖向纸张类型，各 16 项）。
- 角色：**候选 Truth 数据源**，不是已冻结的物理 Truth。
- **⚠️ Reviewer 收紧（强制）**：Layer ① 严格说是一个 *measured / candidate dataset*，而非「32 个 frozen truth」。其中 31 格按你的物理运行可视为已确认方向正确，**T5 这一格是已知 FAIL / 待复核**（见 Layer ③）。因此「Frozen Truth Matrix」是 Gate 的**产出**，不是 Layer ① 的同义词。不要把「已测量」等同于「已冻结」。

### ② 矩阵一致性（强证据，但非物理正确性证明）
- 已证：`Table A = Table B + 90°`（逐格恒定偏移，16/16）。
- 性质：这是**数据内部自洽的强证据**，证明两张表非随机、且应存在统一来源；但它**不能单独证明 Table B 每个值已通过物理打印验证**。
- 用法：一致性用于在发现异常时**定位**该重测哪一格，而不是用来**推导**某个未验证格的物理值并声称正确。

### ③ T5 单点（candidate ≠ frozen）
```text
T5 = verticalPaper(A4) × portrait invoice × rotation 0° × paperOrientation landscape
candidate:        landscape, rotate=180, fit
FROZEN TRUTH:     UNKNOWN   ← 唯一已知物理 FAIL 的格
```
- 当前 production 发 `landscape,fit`（无 rotate）→ 净 −90° → 成品反向 90°（已知 bug）。
- candidate 180 = 「抵消 −90° 后内容正立」的预期值，但**预期 ≠ 已验证**，一切以真机为准。

> 三层之间唯一允许的推进方向：
> **物理实测 → Truth → 矩阵一致性检查 → 冻结；绝不反向（矩阵一致 → 推导 → 认为物理正确）。**
> T5 之前的 270 错配，就是因为把 `paperType` 与 `paperOrientation` 混在一起、再用矩阵关系反推值，正是「反向」的反面教材。

---

## 2. Gate 顺序（正确 vs 错误）

### ✅ 正确
```text
32-case 实测
      ↓
Truth Matrix
      ↓
一致性审计
      ↓
发现异常 / 矛盾
      ↓
单独物理复核
      ↓
Frozen Truth Matrix
      ↓
PrintCommandTruthResolver
      ↓
implementation
```

### ❌ 错误（T5 已证明其危险）
```text
已有矩阵
  ↓
数学关系
  ↓
推导一个值
  ↓
认为物理正确
```

---

## 3. `PrintCommandTruthResolver` 边界（它不该知道什么）

Resolver **只负责回答一个问题**：
> 对于这个**已经确定**的 PrintState，Sumatra 最终应该收到什么命令？

输入：`{ invoiceOrientation, rotation, paperType, paperOrientation }`
输出：`{ orientation, rotate, fit }`

它**不得知道 / 不得依赖**：
- PDF 怎么旋转
- Canvas 怎么渲染
- Preview 怎么显示
- Margin 怎么计算
- placement 怎么算
- Invoice 怎么组装
- `RotationResolver` 怎么工作

这把「Sumatra 的特殊旋转语义」封死在最终执行层，不会反向污染全应用的内容旋转模型。

---

## 4. 32-case 内部可简化结构（第一版就硬编码，不压缩公式）

已观察：
- `verticalPaper` 的 rotate 只取 `{0, 180}`
- `horizontalPaper` 的 rotate 只取 `{90, 270}`
- 且 `Table A = Table B + 90°`

**建议第一版直接写成两子矩阵**：
```js
const TRUTH_TABLE = {
  verticalPaper:   { /* 16 cases: rotate ∈ {0,180} */ },
  horizontalPaper: { /* 16 cases: rotate ∈ {90,270} */ },
};
```
**不要**一开始就压缩成 `base + paperTypeOffset + rotationModulo + orientationCorrection ...` —— 那又重新回到了「旋转算法」。让物理实验结果成为代码一等公民，比让公式凌驾物理结果更有价值。等 32-case 真正全部冻结、规律稳定后，再考虑压缩实现也不迟。

---

## 5. Margin 因此彻底独立

```text
              ┌──────────────────┐
              │ PrintCommandTruth │
              │     Resolver      │
              └────────┬─────────┘
                       │ orientation / rotate
                       ▼
                   Sumatra
                       ▲
                       │ fit / paper size
              ┌────────┴─────────┐
              │  Margin Contract │
              └──────────────────┘
```
**旋转正确性** 与 **安全边距正确性** 是完全独立的两件事。G2-R2 解决完以后，剩下的工作可以非常明确地收敛为：只验证 **Margin Geometry + hardware safe margin**，不再出现「为修一个横竖方向问题，顺手改了 Margin / Canvas / RotationResolver / placement」的连锁风险。

---

## 6. 当前唯一正确动作：T5 单变量物理实验

固定（只动最终命令这一项）：
```text
paperType          = verticalPaper
paperOrientation   = landscape
invoiceOrientation = portrait
rotation           = 0°
```
只把最终命令从：
```text
landscape, fit
        ↓
landscape, rotate=180, fit
```
然后看真实成品。

### PASS
```text
T5 = rotate 180
candidate truth ──► frozen physical truth
```
然后才进入：
```text
Frozen 32-case Truth ──► PrintCommandTruthResolver ──► G2-R2 implementation ──► 32-case regression
```

### FAIL
**不要为了维护 `Table A = Table B + 90°` 而硬改数据。**
这反而是一个非常有价值的信号：说明「纸张类型差 +90°」只是当前数据中的**经验关系**，并不是系统的物理定律。届时应当重新检查 Table B，而不是修改 resolver 去迁就一个错误模型。

---

## 7. 冻结清单（本次未改动）

- `e23107b`（E1/E1a/E2）、`c39ae14` 均**保留不回退**。
- 不动：`RotationResolver` / `margin` / electron `normalize` / 16 表 / Canvas 双权威 / `placement_bake` / `main.js` / `usePrint.js` / `PrintService.js`。
- 唯一封口：T5 物理复核（需真实打印机，不在本会话内）。

---

## 8. 关联文档
- 32-case 一致性审计（含 T5=180 candidate 修正 + §4.1 Gate 实验）：`c2g-r2-32case-truth-matrix-audit.md`
- T5 因果定位（R2-1/R2-2/R2-3）：`c2g-r2-content-rotation-causal-audit.md`
- 物理 Gate 协议（含 2×2 矩阵 + T5 规格 + 否决清单）：`c2g-physical-print-gate.md`
