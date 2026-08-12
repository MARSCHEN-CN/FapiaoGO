# C-2-G 终局 Gate：真机物理打印验证协议

> **本文件是 C-2-G 的「终局 Gate」**，不是新的代码改动，也不是 Gate 工程修复。
> 在标记 **C-2-G PASS** 之前，必须由**真实打印机 + 真实 Sumatra/驱动**执行。
>
> **当前状态**：`C-2-G = G2 IMPLEMENTED / 数值四象限 PASS / T5 真机 UNKNOWN`
> - E 方案 `e23107b`（E1+E1a+E2）已合入；数值层（INV-R / 几何 / 无裁切 / cr=0 字节级 guard / E2 命令形态）全 PASS。
> - G2 `c39ae14`（仅 `PrintService.js` 补传 `paperOrientation`，零 electron 改动）数值四象限 Plan==IPC==normalize==dims 8/8 PASS，E regression 不退化。
> - **唯一未闭环物理缺口 = T5（竖纸 A4 × 横向）**。T1~T4 已覆盖其余三象限，但 T1~T4 不含「竖纸×横向」组合，故该组合从未真机闭环。
> - `implicit = −90°` 仍是冻结的 executor 假设，只在真实硬件执行时才能最终确认。

---

## 1. 这个 Gate 在验证什么

数值实验已经证明的是**几何层 + bake 层 + 命令层**：

```
E1/E1a  →  bake 烤入 contentRotation + layoutRotation  →  几何正确（CTM 实测）
E2      →  landscape → rotate=90 / portrait → no rotate  →  命令形态正确
G2-1    →  paperOrientation 闭环单一 Paper Truth        →  横纸×纵向 240×140 → 140×240
```

真机打印验证的是**最后一层**——executor 在真实硬件上的实际行为：

```
bake 几何正确
   ↓
E2 命令：landscape→rotate=90 / portrait→no rotate
   ↓
Sumatra / 驱动 真实执行（这里藏着 implicit = −90° 假设）
   ↓
最终物理纸面：方向 / 完整性 / 比例 / 边距
```

**`implicit = −90°` 是 Sumatra 在 landscape 纸型下的隐含旋转冻结定论。**
bake 把内容烤到「最终视觉方向」，Sumatra landscape 再施加 −90°，executor 用 `rotate=90` 补偿 → 净 0。
如果真实驱动/Sumatra 在该机器上**不**施加 −90°（版本、驱动、纸型差异），横纸就会错——而数值实验无法发现这一点。
**所以真机打印是 C-2-G 唯一的、不可绕过的终局确认。**

---

## 2. 前置条件

| 项 | 要求 |
|---|---|
| 构建 | 必须包含 `e23107b`（E1/E1a/E2）**与** `c39ae14`（G2-1）的本地构建 |
| 硬件 | 真实打印机（横凭证纸 240×140 / A4 竖纸均可），已装 SumatraPDF + 对应驱动 |
| 日志 | 主进程控制台可见（`[print-source-file] C-2-G bake executor offset: sourceRotation=...`） |
| 基线参照 | 若有可能，准备一份 **E 实施前**的横/竖票 0° 打印样张作为 regression 对照 |

---

## 3. 测试矩阵

### 3.1 纸型 × 方向（rotation 0° 基线，四象限）

| # | 纸型 | 方向 | 预期物理纸 | 预期内容 | 验证重点 |
|---|---|---|---|---|---|
| T1 | 竖 A4 (portrait-native) | 纵向 | 210×297 | 正立 | E 前 0° 一致性 |
| **T5** | **竖 A4 (portrait-native)** | **横向** | **297×210** | **正立、3mm 边距、裁切 0** | **新增：G2-R1 镜像 blocker 物理闭环** |
| T2 | 横凭证 (landscape-native) | 纵向 | 140×240 | 正立 | G2 主修复（240↔140 交换） |
| T3 | 横凭证 (landscape-native) | 横向 | 240×140 | 正立 | E 前横纸 0° 一致性 |

> 原 T1~T4 只覆盖了 T1/T2/T3（三象限）+ T4（竖纸×纵向×90°）。**T5 补上「竖纸×横向」象限**，
> 使纸型 × 方向 2×2 矩阵完整闭环。T1~T4 数值已 PASS，但 T5 物理 UNKNOWN。

### 3.2 内容旋转叠加（与方向正交，不混入）

纸型 × 方向 确定后，再叠加 UI rotation 0°/90°（180°/270° 可选扩展）：

| # | 纸型 | 方向 | UI rotation | 预期 |
|---|---|---|---|---|
| T4 | 竖 A4 | 纵向 | 90° | 内容顺时针正立、不裁切（E 前此处 55.3% 被裁） |
| — | 竖 A4 | 横向 | 90° | 推荐扩展：内容顺时针正立、不裁切 |
| — | 横凭证 | 纵向 | 90° | 推荐扩展：正立、不侧躺 |
| — | 横凭证 | 横向 | 90° | 推荐扩展（T1 已含 0°） |

**正交纪律**：纸型×方向 与 内容旋转 必须保持正交。T5 若裁切，**不要**重新归因到 rotation——
方向问题归方向，旋转问题归旋转（见 §8/§9）。

### 3.3 T5 详细规格（G2-R1 镜像 blocker 物理闭环）

```text
Paper Type      A4 / 竖纸型（natural 210×297）
Paper Direction 横向
Content UI      0°
Margin          3 mm
Expected        297 × 210
```

验收四项（**缺一不可，不只看裁切**）：

| 项目 | Expected |
|---|---|
| 物理纸张 | 297 × 210 |
| 内容方向 | 正立 |
| 边距 | 3 mm（四周） |
| 裁切 | **0** |

---

## 4. 每票执行步骤

1. 在应用内选中目标发票，设置纸张（横凭证纸 / 竖 A4）。
2. 设置纸张方向（纵向 / 横向）与 UI rotation（0° 或 90°）。
3. 触发打印（走 bake 路径 → Sumatra）。
4. **打印过程中**观察主进程日志，确认出现：
   - 横纸：`[print-source-file] C-2-G bake executor offset: sourceRotation=90 (landscape=90 / else=0)`
   - 竖纸：`sourceRotation=0 (landscape=90 / else=0)`
5. 取出物理纸，按 §5 逐项核对（T5 额外按 §3.3 四项核对）。

---

## 5. 逐票验收清单（每张纸 4 项全过才算该票 PASS）

- [ ] **方向正确**：发票正立，没有「侧躺」（即没有整体被旋转 90° 横在纸上）。
- [ ] **完整无裁切**：发票四边内容全部落在纸面内，无边缘缺失。
- [ ] **比例正确**：1:1（noscale），未被拉伸/压扁/缩放错位。
- [ ] **0° 回归一致**（仅 T1/T3）：与 E 实施前 0° 样张视觉一致（E 的 cr=0 路径字节级零回归，物理上应无差异）。

> T5 额外四项：物理纸 297×210 / 内容正立 / 3mm 边距 / 裁切 0（§3.3）。

---

## 6. 命令层交叉信号（不应与物理结果冲突）

| 纸型 | 期望 Sumatra 命令片段 | 失败指示 |
|---|---|---|
| landscape | 含 `rotate=90` + `disable-auto-rotation` + `noscale` | 缺 `rotate=90` 或带 `rotate=0` → E2 未生效 |
| portrait | 含 `disable-auto-rotation` + `noscale`，**不含** `rotate` | 出现 `rotate=NN`（NN≠0）→ E2 未生效，会双重旋转 |

> 命令片段来自日志 / 调试 dump；它只验证「命令层对了」，**不能替代物理纸面核对**（物理才是 truth）。

---

## 7. 决策（T5 分流，用户裁决）

```text
T5 PASS  →  C-2-G = PASS
           关闭"G2-1 导致竖纸×横向回归"的怀疑（c39ae14 change-delta=0 已证非触发）

T5 FAIL  →  C-2-G = BLOCKED
           新 blocker 命名：G2-R2 / Canvas Paper-Direction Authority Divergence
           不回退 c39ae14
```

- **T1 + T2 + T3 + T5 全 PASS（且 T4 等旋转叠加无退化）** → 可标记 **C-2-G PASS**，关闭整条线。
- **T5 FAIL** → 不标记 PASS；进入 §10 只读分流（G2-R2），**绝不回退 c39ae14**。
- **T5 未执行** → 维持 `G2 IMPLEMENTED / T5 真机 UNKNOWN`，**不得**因数值 PASS 即标 C-2-G PASS。

---

## 8. 架构判断（两套方向权威，非当前 blocker）

```text
                 ┌─ source/Sumatra 轨
paper direction ─┤     normalize 自己解释（读 src.paperOrientation / src.landscape）
                 │
                 └─ canvas/merged 轨
                       forcedLandscape / documentState.*Orientation（另一套 orientation 权威）
```

目前**并不是完全意义上的**「单一 Paper Truth → 所有 executor」，而是：

```text
Paper Truth
   ├── source 轨：normalize 自己解释方向
   └── canvas 轨：另一套 orientation authority（forcedLandscape / documentState.*Orientation）
```

- 数值实验（G2-R1）证明：四象限 Plan == normalize 全一致，**尚未证明** canvas 轨已分叉。
- 但若 T5 真机失败，将**优先怀疑此处**（canvas 轨两权威与 source `normalize` 不统一），
  而非继续改 `normalize`。该问题命名为 **G2-R2 / Canvas Paper-Direction Authority Divergence**（§10）。
- 当前**不是** G2 blocker（数值未证分叉）；属独立结构债，未来统一为单一 `paperOrientation` 事实源，不混入 G2。

---

## 9. 明确否决清单（当前不做什么）

用户明确否决以下动作，**当前一律不做**：

- ❌ revert `c39ae14`（回退会重新制造已确认真实缺陷「横纸×纵向 240×140→应 140×240」）
- ❌ 修改 `electron/print-settings.js`（`normalize`）
- ❌ 修改 `usePrint.js`
- ❌ 修改 `executionPaper`
- ❌ 修改 margin / Print Margin Contract
- ❌ 修改 `RotationResolver`
- ❌ 修改 16 表（`sumatra-command-resolver.js`）
- ❌ 为 T5 猜测性修改 `forcedLandscape`
- ❌ 因 T5 尚未测试就把 G2 标成 FAIL

**唯一推进动作 = 跑 T5 真机验证。** 不解冻任何新代码。

---

## 10. 失败回退与分流

`e23107b` 与 `c39ae14` 均为**独立、孤立的专项 commit**，回退容易：

```bash
git -c lfs.locksverify=false revert --no-edit c39ae14   # 干净回退 G2-1（仅当确证其为根因时，当前不执行）
git -c lfs.locksverify=false revert --no-edit e23107b   # 干净回退 E
```

分流判断：

- **T5 FAIL（竖纸×横向裁切）** → **不回退 c39ae14**（change-delta=0 已证非触发）。进入独立只读调查
  **G2-R2**：确认 Sumatra command → 实际 render path（source/canvas/merged 分轨）→
  检查 `forcedLandscape` → 检查 `documentState.paperOrientation` → 检查最终 `effPaperRect` →
  定位谁产生错误 placement（canvas 轨两套方向权威分叉）。与 G2-2 无关，单独开 issue。
- **横纸侧躺但竖纸正常** → executor `implicit=−90°` 假设在该机器不成立 → 属 executor 层，非 E 几何错误；
  回到 C-2-E / 16 表能力边界排查（**不**改 E 几何）。
- **裁切/比例异常（非 T5）** → 可能是 bake 几何或纸张尺寸识别，回到 `placement_bake.py` / `buildBakeSpec` 复查。
- **0° 与 E 前基线不一致** → 说明 cr=0 字节级 guard 在真实硬件上被打破，需重新跑 §3 数值 gate 定位。

---

## 11. 签署

| 角色 | 结论 | 签名/日期 |
|---|---|---|
| 真机执行人 | ☐ PASS / ☐ FAIL | |
| 复核（CodeReviewExpert） | | |

> 本 Gate 通过前，C-2-G 维持 `G2 IMPLEMENTED / T5 真机 UNKNOWN`，**不**升级为生产 PASS。
> Gate 工程（伪绿修复 / 8 组合 regression golden / 16 表标注）作为独立 commit 另行处理，不与本 Gate 或 `e23107b`/`c39ae14` 混同。
> 配套只读文档：`c2g-r1-portrait-landscape-mirror-audit.md`（G2-R1 镜像审计，结论已收紧为「c39ae14 非触发，早于与否 UNKNOWN」）。
