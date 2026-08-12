# C-2-G · INV-R 零代码预测实验报告（P-180 / P-270 / P-PORTRAIT / P-DELTA / P-GEOM + E-SIM）

日期：2026-08-12
状态：**C-2-G = PAUSED**；`placement_bake.py` / RotationResolver / 16 表 / 横纸 executor / paper / noscale **继续冻结**。
本轮生产代码改动：**0 行**（新增 2 个一次性实验脚本 + 本报告；脚本位于 gitignored `.out/`）。
前置：`c2g-ui-rotation-product-semantics-audit.md`（语义裁决）。

---

## 0. 结论摘要

1. **5 项预测全部 PASS**（8 组合 × 2 纸型实测）。INV-R 违约链已完成因果闭环。
2. **P-DELTA 8/8 命中**：bake 实际施加旋转 **恒等于 `layoutRotation`**，`contentRotation` 项在 bake 内被完全丢弃，`bakeDelta = −cr` 精确成立。
3. 🔴 **新增发现（原审计未预见）**：**几何缺陷是双纸型的，不止横纸**。
   - 方向缺陷 = 横纸独有（executor 覆盖 cr 通道）
   - **几何缺陷 = 横纸 + 竖纸都有**：`cr ∈ {90,270}` 时 bake 的 contentBox 是 `placedRect` 的**转置**，导致内容溢出纸面被裁切。
   - 竖纸 cr=90 实测：面积利用 **55.3%**（cr=0 为 78.9%），**触边裁切**。即 **今天的竖纸链在 cr≠0 时正在静默裁掉发票内容**。
   - 「竖纸零回归」此前只在 `cr=0` 子空间验证过 —— 现已被实测推翻。
4. **E-SIM（用等价输入驱动未修改的生产 bake 预演方案 E）8/8 全绿**：E-GEOM / E-ROT / E-CLIP 三项判据全部 PASS。
5. **E 的零回归已在 CTM 字节级证明**：`cr=0` 时 BASE 与 E-SIM 的内容流 CTM **逐字符 IDENTICAL**（横纸 + 竖纸）。
6. ⚠️ **E 的改动面比原估计多一项**：不是「一处 phi 表达式」，而是 **E1（bake phi）+ E2（executor offset 归一）**。详见 §5。

---

## 1. 取证方法与证据等级

所有旋转/几何数值均来自**运行时调用生产代码**，脚本自身不实现任何旋转语义。

| 等级 | 来源 | 用途 |
|---|---|---|
| **R1** | `frontend/src/layout/RotationResolver.js` `resolveContentPlacement`（真实 import） | placement / layoutRotation / scale / placedRect |
| **R2** | `electron/print-service/placement-bake-processor.js` `hasPlacement` + `process`（真实 require，内部调生产 `buildBakeSpec` + `scripts/placement_bake.py`） | 生产接线判定 + 真实 bake 产物 |
| **R3** | `electron/print-service/print-settings.js` `buildPrintSettings`（真实 require） | Sumatra 命令令牌 `rotate=N` |
| **M1** | baked PDF 内容流 **CTM 反解**（`atan2(b,a)`） | bake **实际施加**旋转与缩放（精确解，非模板匹配） |
| **M2** | fitz @300dpi 墨迹 bbox / 触边 / 面积 | 几何后果（位图独立交叉验证 M1） |
| **S1** | `electron/main.js` 覆盖字面量静态断言 | 证明是**覆盖**而非叠加 |
| **F1** | Sumatra landscape 隐含旋转 = **−90°** | 冻结实测常量，**本轮不重测** |

**为什么用 CTM 而不用 IoU 模板匹配**：`bakeLandscapeMatrixGate` 伪绿的教训是 fixture 自造模板会退化为自指断言。CTM 是产物内的**精确变换矩阵**，与任何模板无关，且可被 M2 位图独立交叉验证（本轮 8/8 一致）。

**符号约定（全文统一）：正 = 顺时针（CW）**
- UI rotation：`usePreview.js:373` `deg=(prev+90)%360`，按钮图标顺时针 → CW+
- `layoutRotation`：`RotationResolver.js:139-141` 不匹配统一 `-90`（逆时针）→ CW−
- `phi`：`placement_bake.py:97` `phi=(360+layoutRotation)%360`；`margin_contract.py:159` `_CW_UNIT[90]=(0,-1,1,0)` ⇒ phi 是 CW ✓ 同一约定

**S1 断言结果**：`cond=true literal=true additive=false` → **OVERWRITE（常量覆盖）**，非叠加。

**实验规格**：源票 `test_fixtures/25952000000127675627.pdf` 595.3×396.9pt = 210×140mm 横，墨迹基准 205.15×127mm；margins 3mm（`usePrint.js:533-537` 生产默认）；DPI 300。
纸型：`LAND` = Custom 240×140 横向凭证纸；`PORT` = A4 210×297 竖。`hasPlacement` 在两纸型 8/8 均为 true（**生产确实会 bake 竖纸**）。

---

## 2. 表 1 · 旋转链分解（INV-R 判定）

`实际合计 = bake实际(CTM) + rotate令牌 + implicit`；`INV-R 期望 = cr + layoutRotation`

| 纸 | cr | layoutRot | INV-R 期望 | bake 实际(CTM) | rotate 令牌 | implicit | 实际合计 | delta | INV-R |
|---|---|---|---|---|---|---|---|---|---|
| LAND | 0° | 0° | 0° | 0° | 90°(覆盖) | −90° | 0° | 0° | ✅ |
| LAND | 90° | −90° | 0° | −90° | 90°(覆盖) | −90° | −90° | **−90°** | 🔴 |
| LAND | 180° | 0° | 180° | 0° | 90°(覆盖) | −90° | 0° | **180°** | 🔴 |
| LAND | 270° | −90° | 180° | −90° | 90°(覆盖) | −90° | −90° | **90°** | 🔴 |
| PORT | 0° | −90° | −90° | −90° | 0° | 0° | −90° | 0° | ✅ |
| PORT | 90° | 0° | 90° | 0° | 90° | 0° | 90° | 0° | ✅ |
| PORT | 180° | −90° | 90° | −90° | 180° | 0° | 90° | 0° | ✅ |
| PORT | 270° | 0° | −90° | 0° | 270° | 0° | −90° | 0° | ✅ |

**读法**：竖纸方向全 ✅ 是因为 `rotate=cr` 通道**未被覆盖**，executor 恰好补上了 bake 丢掉的 cr。横纸 3/4 ❌ 是因为 `main.js:559-562` 把该通道覆盖成常量 90。→ **D-1 定位成立。**

---

## 3. 表 2 · P-DELTA（核心因果）

| 纸 | cr | layoutRot | bake 实际 | bake == layoutRot | bakeDelta | 预测(−cr) | 命中 |
|---|---|---|---|---|---|---|---|
| LAND | 0° | 0° | 0° | ✅ | 0° | 0° | ✅ |
| LAND | 90° | −90° | −90° | ✅ | −90° | −90° | ✅ |
| LAND | 180° | 0° | 0° | ✅ | 180° | 180° | ✅ |
| LAND | 270° | −90° | −90° | ✅ | 90° | 90° | ✅ |
| PORT | 0° | −90° | −90° | ✅ | 0° | 0° | ✅ |
| PORT | 90° | 0° | 0° | ✅ | −90° | −90° | ✅ |
| PORT | 180° | −90° | −90° | ✅ | 180° | 180° | ✅ |
| PORT | 270° | 0° | 0° | ✅ | 90° | 90° | ✅ |

**8/8 命中。** `bake 实际 ≡ layoutRotation`，与纸型、与 cr 无关。
⇒ **`placement_bake.py` 从不消费 `contentRotation`** 由产物矩阵直接证实（不再依赖源码阅读）。
⇒ 用户在裁决中写的关系式**精确成立**：

```
预期执行旋转 = contentRotation + layoutRotation
当前实际 bake =                  layoutRotation
delta        = contentRotation
```

---

## 4. 表 3 · P-GEOM（🔴 双纸型几何缺陷）

| 纸 | cr | placedRect(承诺) | bake contentBox(实际) | 一致 | 墨迹 | 方向 | 面积% | 高占% | 触边 |
|---|---|---|---|---|---|---|---|---|---|
| LAND | 0° | 201.17×134.11 | 201.14×134.10 | ✅ | 193.29×121.67 | 横 | 70.0% | 86.9% | 无 |
| LAND | 90° | 201.17×134.11 | **134.10×201.14** | 🔴 | 111.00×133.43 | 竖 | **44.1%** | 95.3% | **⚠️** |
| LAND | 180° | 201.17×134.11 | 201.14×134.10 | ✅ | 193.29×121.67 | 横 | 70.0% | 86.9% | 无 |
| LAND | 270° | 201.17×134.11 | **134.10×201.14** | 🔴 | 111.00×133.43 | 竖 | **44.1%** | 95.3% | **⚠️** |
| PORT | 0° | 194.06×291.08 | 194.05×291.07 | ✅ | 175.94×279.74 | 竖 | 78.9% | 94.2% | 无 |
| PORT | 90° | 194.06×291.08 | **291.07×194.05** | 🔴 | 196.09×175.94 | 横 | **55.3%** | 59.2% | **⚠️** |
| PORT | 180° | 194.06×291.08 | 194.05×291.07 | ✅ | 175.94×279.74 | 竖 | 78.9% | 94.2% | 无 |
| PORT | 270° | 194.06×291.08 | **291.07×194.05** | 🔴 | 196.09×175.94 | 横 | **55.3%** | 59.2% | **⚠️** |

**代数特征**：`cr ∈ {90,270}` 时 `bakeBox == transpose(placedRect)`（201.17×134.11 ↔ 134.10×201.14；194.06×291.08 ↔ 291.07×194.05）。这是「cr 未被施加」的**纯代数签名**——`scale` 由 resolver 按「cr 已施加」算出，bake 却把未旋转的源按该 scale 放进去，包围盒必然转置。

**溢出的直接物证（CTM 平移量）**：
```
BASE LAND cr=90 : q 0 0.9578 -0.9578 0 435.3125 -181.7183 cm   ← ty = −181.72pt，内容原点在纸面【外】
E-SIM LAND cr=90: q 0.9578 0 0 0.9578  55.2000    8.3379 cm    ← ty = +8.34pt，内容完整落在纸内
```

🔴 **这推翻了「竖纸链现状正确、零回归」的既有判断**：竖纸方向对，但 `cr∈{90,270}` 时 **面积利用从 78.9% 掉到 55.3% 且触边裁切** —— 用户旋转过的发票在 A4 上正在被静默裁掉边缘。`main.js:555` 注释「竖纸 … bake 已含旋转，现状正确零回归」中的「bake 已含旋转」是**事实错误**（表 2 已证 bake 从不含 cr），竖纸只是被 `rotate=cr` 侥幸补上了方向，几何并未补上。

---

## 5. E-SIM · 零代码预演方案 E

**方法**：E 的全部内容是 `placement_bake.py` 的 `phi` 表达式
`phi = (360 + layoutRotation) % 360` → `phi = (360 + contentRotation + layoutRotation) % 360`。
由于 `phi` 的唯一来源是 spec 的 `placement.layoutRotation` 字段，用**等价输入** `layoutRotation := cr + layoutRotation` 驱动**未修改的生产 bake**，产物与 E 实施后逐字节等价 → 可在解冻前完成验证。
（`cr + layoutRotation` 取值 ∈ {0, ±90, 180}，全部落在 `placement_bake.py:98` 的 `_CW_UNIT` 合法域内，无需放宽校验。）

### 5.1 判决

| 判据 | 内容 | 结果 |
|---|---|---|
| **E-GEOM** | bake contentBox == resolver placedRect（8/8） | ✅ PASS |
| **E-ROT** | bake 实际 == `cr + layoutRotation`（8/8） | ✅ PASS |
| **E-CLIP** | 8/8 无触边裁切 | ✅ PASS |

### 5.2 面积利用与裁切修复（BASE → E-SIM）

| 纸 | cr | BASE 面积/触边 | E-SIM 面积/触边 |
|---|---|---|---|
| LAND | 0° | 70.0% / 无 | 70.0% / 无（不变） |
| LAND | 90° | 44.1% / ⚠️ | **70.0% / 无** |
| LAND | 180° | 70.0% / 无 | 70.0% / 无（不变） |
| LAND | 270° | 44.1% / ⚠️ | **70.0% / 无** |
| PORT | 0° | 78.9% / 无 | 78.9% / 无（不变） |
| PORT | 90° | 55.3% / ⚠️ | **78.9% / 无** |
| PORT | 180° | 78.9% / 无 | 78.9% / 无（不变） |
| PORT | 270° | 55.3% / ⚠️ | **78.9% / 无** |

**所有 cr 收敛到与 cr=0 相同的面积利用率与方向** —— 这正是产品语义裁决要求的「归一后的正确方向 + 等比完整」。

### 5.3 零回归证明（CTM 字节级）

| 组合 | BASE vs E-SIM 内容流 CTM |
|---|---|
| LAND cr=0 | **IDENTICAL ✅** |
| PORT cr=0 | **IDENTICAL ✅** |
| 其余 6 组 | DIFFERENT（预期，即修复项） |

⇒ **E 在 `cr=0` 上与今天逐字符等价**，横纸 golden baseline 与竖纸 golden baseline 均不受影响。

### 5.4 ⚠️ E 的改动面修正：E = E1 + E2（不是单一 phi）

表 D 暴露出配套项。E1 生效后 bake 已烤入**全部业务旋转**，命令层 `rotate=` 必须只承载 **executor 机械补偿**：

| 纸 | bake 已含 | Sumatra 隐含 | 需 `rotate=` | 当前实际 | 结论 |
|---|---|---|---|---|---|
| LAND（全 cr） | `cr+lr`（全部） | −90° | **90°** | 90° | ✅ 已正确（常量覆盖恰好等于所需补偿） |
| PORT cr=0 | −90° | 0° | **0°** | 0° | ✅ |
| PORT cr=90 | 90° | 0° | **0°** | 90° | 🔴 **需改**（否则二次施加 cr） |
| PORT cr=180 | 90° | 0° | **0°** | 180° | 🔴 需改 |
| PORT cr=270 | −90° | 0° | **0°** | 270° | 🔴 需改 |

**E2（最小形态，`main.js:558-562`）**：把「仅 landscape 注入」改为「无条件赋 executor 补偿量」

```
现状：if (execOrient === 'landscape') printSettings = {...printSettings, sourceRotation: 90}
E2  ：printSettings = {...printSettings, sourceRotation: execOrient === 'landscape' ? 90 : 0}
```

净效果：**减少一个分支**，并让 `sourceRotation` 在 bake 路径的语义变为单一的「executor 机械补偿」（正是 D-3 建议的 `executorRotationOffset` 语义）。
副作用检查：竖纸命令串将从 `disable-auto-rotation,rotate=N,noscale,paper=a4` 收敛为 `disable-auto-rotation,noscale,paper=a4` —— **即已冻结的竖纸 golden baseline 命令串本身**（`rotate=0` 被 `buildPrintSettings` 省略）。
作用域：该分支仅在 `bakeResult.path !== target.filePath`（bake 成功）内；bake 降级路径完全不变。

---

## 6. 实验未覆盖的边界（诚实声明）

1. **未做物理打印**。本轮验证的是 **bake 产物几何 + 命令令牌**。`implicit = −90°`（横纸）沿用冻结实测常量（F1），**未重测**。E 实施后仍需一次真机打印做终局确认。
2. **未覆盖 C-2-E executor capability**（驱动无 PostScript 横向纸、`dmPaperSize=32767`）。那是纸张选择问题，与本轮 geometry/rotation 语义正交，继续冻结。
3. **只测了横票源**（`test_fixtures` 无竖票 PDF）。竖票源的 `layoutRotation` 取值会互换，但 P-DELTA 的结论（bake 恒等于 layoutRotation）与源方向无关，故不影响定位。补竖票 fixture 属 Gate 工程。
4. **未覆盖 merge / canvas 轨**（Policy B）。本轮全部在 source + bake 轨。

---

## 7. 解冻建议（待用户批准）

| 项 | 内容 | 文件 | 风险 |
|---|---|---|---|
| **E1** | `phi = (360 + contentRotation + layoutRotation) % 360` | `scripts/placement_bake.py:97` + `:139`（两处同一表达式） | 低。E-SIM 已 8/8 验证；cr=0 CTM 字节级零回归 |
| **E1a** | `buildBakeSpec` 透传 `contentRotation`（placement 已携带，见 `RotationResolver.js:277`） | `placement-bake-processor.js:145` | 低。纯字段搬运 |
| **E2** | `sourceRotation: execOrient === 'landscape' ? 90 : 0` | `electron/main.js:558-562` | 低。减少分支；竖纸收敛到已冻结 golden 命令串 |
| **不动** | RotationResolver / 16 表 / paper / noscale / contain-fit / `/Rotate=0` / 输出契约 R-1~R-3 / 竖纸 golden baseline / geometry 上游 | — | — |

**配套（Gate 工程，不解冻生产）**：
- `bakeLandscapeMatrixGate.mjs` fixture 重构为消费生产 `placement_bake.py`，断言改为 **INV-R**（`CTM 实测旋转 == cr + layoutRotation`）+ **placedRect 恒等** + **无触边**，替换现有自造模板 IoU。
- 把本报告的 8 组合 BASE/E-SIM 数值固化为回归 golden。
- 16 表适用域在冻结文档显式标注「直打模型 only」。

---

## 8. 冻结状态（本轮结束时）

```
C-2-G
├─ 16 表 / SumatraCommandResolver        🔒 FROZEN
├─ landscape executor rotate=90          🔒 FROZEN
├─ RotationResolver                      🔒 FROZEN
├─ paper / noscale / contain-fit          🔒 FROZEN
├─ UI rotation semantic                  ✅ 已裁决（方向校正=目标 / 增量旋转=机制）
├─ INV-R 违约因果链                       ✅ 已闭环（P-DELTA 8/8）
├─ 方案 E 可行性                          ✅ 已预演（E-SIM 8/8 + cr=0 零回归）
├─ E 改动面                               ⚠️ 修正为 E1 + E1a + E2（3 处）
├─ placement_bake.py                     ⏸ PAUSED（待批准解冻 E1）
└─ 竖纸链「零回归」判断                    🔴 已推翻（cr∈{90,270} 静默裁切，见 §4）
```

本轮生产代码改动：**0 行**。实验脚本：`frontend/test/printGate/.out/c2g-inv-r-predictions.mjs`、`c2g-e-sim.mjs`（gitignored 一次性工具）。
