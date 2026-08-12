# C-2-G · G2-R2 内容旋转因果审计报告（只读，未改生产代码）

> 状态：**C-2-G = G2 BLOCKED / G2-R2 OPEN (READ-ONLY)**
> 真机裁决：**T5 = 竖纸 A4 × 横向 ❌ FAIL**
> 冻结：`e23107b` 与 `c39ae14` 均保留，不因 T5 FAIL 回退。
> 纪律：**本审计不改任何生产代码**；任何修复须待用户批准 G2-R2 implementation，且严格单变量。

---

## 0. 一句话结论

T5 已证明：**这次不是「横向纸张没有形成」，而是「横向纸张形成了（297×210 ✅），但内容旋转/布局语义错了」**——内容被反向旋转了 90°，物理成品需逆时针旋转 90° 才正立。

R2-1 因果追踪**推翻**了「G2-R2 = Canvas 双方向权威分叉」的原假设：T5 实际走的是**纯 `source/Sumatra/fit` 路径**（placement 恒为 null → 不 bake、不进 canvas），因此 T5 的缺陷根因**不在 canvas 轨**，而在 **source/fit 单文件路径对「竖发票(A4 portrait-native) × 横纸(landscape) × 0°」缺少内容方向补偿**。

---

## 1. 用户裁决（来自 T5 真机 FAIL 后）

| 项 | 裁决 |
|---|---|
| T5 竖纸 A4 × 横向 | ❌ FAIL |
| 纸张物理方向 | ✅ 已正确横向 297×210（Paper Direction 已生效） |
| `c39ae14` | 保留，不回退 |
| `e23107b` (E1/E1a/E2) | 保留，不回退 |
| C-2-G 总状态 | **BLOCKED** |
| 下一阶段 | **G2-R2**（但范围已收敛，见 §4） |
| 改代码 | ❌ 现在不动；不进 RotationResolver / margin / Electron `normalize` |
| 物理现象 | 纸张已横向，但内容反向 90°；成品逆时针转 90° 才正确 |

---

## 2. R2-1：T5 实际走哪条打印路径

**结论：T5 走纯 `source/Sumatra/fit` 路径，既非 bake、也非 canvas/merged。**

证据链（逐跳，全部来自未修改的生产源码）：

1. **`usePrint.js:1051`** — `createPrintPlanInput(files, settings, fileRotations)` 仅传 3 参数，**未传 `placements`**。
2. **`buildPrintExecutionPlan.js:278`** — `perFilePlacement = (f) => placements[f.key] || null`；因上游 `placements` 未传入，`options.placements` 为 `undefined` → 每个 slot 的 `placement` 恒 `null`（`:287` `placement: perFilePlacement(f)`）。
3. **`deriveSourcePrintJobs.js:48`** — `placement: page.slots?.[0]?.placement ?? null` 透传上游 `null`（`:42-46` 明确「只搬运不计算」）。
4. **`PrintService.js:90`** — `buildPrintSettings(..., placement, executionPaper)` 收到 `placement = null` → 透传 `placement: null`；同文件 `:94` `executionPaper: executionPaper || null` → 因 `usePrint.js:986` `printSingleSourceFile(f, printSettings)` 仅 2 参数调用，**`executionPaper` 恒 `null`**。
5. **`electron/main.js:530`** — `bakeEnabled = placementBake.hasPlacement(settings, target.filePath)`。
6. **`placement-bake-processor.js:78-79`** — `hasPlacement(s, path)` 第一句 `if (!settings || !settings.placement || !settings.executionPaper) return false`。T5 两字段皆 `null` → **`hasPlacement = false`**。
7. **`electron/main.js:532/605`** — `if (bakeEnabled) {...}` 为 false → 落入 `else` 分支（`:605`「No margins to apply」纯 fit），**不触发 bake，不触发 E2 executor offset（`:564`）**。

> **关键推论**：E2（`main.js:564` `sourceRotation: execOrient==='landscape' ? 90 : 0`）只在 bake 成功分支内补偿 Sumatra 隐含 −90°。T5 单文件无 placement → 永不进入该分支 → **E2 补偿对 T5 完全不生效**。这解释了为何「横纸×横向」的 bake 路径（E 已验证 8/8 正向）正常，而 T5 单文件却反向 90°——两者根本不是同一条路径。

---

## 3. R2-2：T5 Rotation Ledger（含 ± 符号）

> 全程记录每一层的「纸尺寸/方向」与「内容旋转」，含符号。这是把 ±90° 因果链抓出来的核心。

| 层 | 输入 → 输出 | 内容旋转信号 | 纸几何 |
|---|---|---|---|
| ① 用户 UI | 选「横向」方向，UI rotation = 0° | 用户意图旋转 = 0° | 请求：landscape |
| ② `PrintService.js:79` | `paperOrientation: requestedPaperOrientation(userSettings)` = `'landscape'` | — | — |
| ③ `PrintService.js:69` | `sourceRotation = fileRotation = 0` | 0° | — |
| ④ `normalize` (`print-settings.js:183`) | `contentRotation = src.sourceRotation ?? src.rotation ?? 0` = **0** | **0°** | `spec.paper.orientation='landscape'` → **297×210** |
| ⑤ `resolveOrientationCommands` (`print-settings.js:44-49`) | `steps = ((round(0/90)%4)+4)%4 = 0` → `contentRotation = 0` | **0°** | `paperOrientation='landscape'` |
| ⑥ `buildPrintSettings` 输出 (`print-settings.js:289-294`) | `parts = ['landscape']`（因 `orientResult.contentRotation !== 0` 为 false → **跳过 `rotate`**） | **无 rotate** | 命令：`landscape,fit,paper=a4` |
| ⑦ Sumatra 执行 | `-landscape` 标志对**任意输入**施加隐含 **−90°** 布局旋转（冻结定论） | 净内容角 = 隐含(−90°) + 0 = **−90°** | 纸 = 297×210 landscape |
| ⑧ 物理成品 | 竖发票(portrait-native 210×297) 被 −90° 放到横纸 → **内容侧躺 / 反向 90°**，四周裁切/留白错位 | **反向 90°** | 297×210 ✅（纸对） |

**符号对账**：
- 系统本应让 portrait 内容「填充满 landscape 纸」→ 需要内容轴旋转 **+90°**（相对纸面）。
- Sumatra `-landscape` 已施加 **−90°**。生产命令**未补任何 rotate**（⑥ 跳过）→ 净 **−90°** → 内容反向侧躺。
- 用户实测「成品逆时针转 90° 才正确」= 当前内容偏 **顺时针 ~90°（即 −90° 体系）**，与 ledger 第 ⑧ 行完全吻合。

---

## 4. R2-3：根因定位（±90° 在哪一层被错误解释）

### 4.1 根因陈述

**根因 = `source/fit` 单文件路径对「竖发票(A4 portrait-native) × 横纸(landscape) × 0°」缺少内容方向补偿。**

具体机制：
- `buildPrintSettings` (`print-settings.js:292`) 仅在 `orientResult.contentRotation !== 0` 时输出 `rotate=N`。
- T5 的 `contentRotation` 来自用户 UI rotation = 0°（不是「内容需要随纸交换而旋转 90°」的语义），因此恒为 0 → **`rotate` 被整段跳过**。
- 于是生产命令只有 `landscape,fit,paper=a4`，把 Sumatra 的隐含 −90° 完全暴露给 portrait 内容 → 反向 90°。

### 4.2 理论正确值已被冻结测量给出，但从未被采用

- `sumatra-command-resolver.js:37`：`ROTATE_MATRIX[portrait][landscape][0] = 270`。
  - 含义（实测 16-case 矩阵，直打模型 truth）：**portrait 发票 × landscape 纸 × 0° 用户旋转时，正确命令应为 `rotate=270`**（抵消 Sumatra 隐含 −90°，使内容正立填满横纸）。
  - 但 `grep` 证实：`resolveSumatraRotation` 在 electron 中**从未被任何代码调用**（仅定义/导出）。生产实际命令构造走的是 `print-settings.js:274-294` 的 `resolveOrientationCommands` + `contentRotation!==0` 短路，**不查 16 表**。
- 因此 T5 实际输出 `landscape,fit,paper=a4`（无 rotate），与理论 `landscape,rotate=270,paper=a4` 偏差恰好是一个缺失的 270° 补偿 → 等价于遗留的 −90° 未抵消。

### 4.3 为什么不是「G2-R2 = Canvas 双方向权威分叉」

> G2-R2 在被 T5 验证前，命名是「**Canvas Paper-Direction Authority Divergence**」，假说 = canvas 轨 `forcedLandscape`/`documentState.*Orientation` 与 source 轨 `normalize` 两套方向权威分叉。

R2-1 已确定性证伪该假说对 T5 的适用性：
- T5 单文件（无 merge、无 placement）→ **完全不进入 canvas/merged 轨**（`buildPrintExecutionPlan` slot.placement=null → `deriveSourcePrintJobs` 透传 null → `hasPlacement=false` → 纯 source/fit）。
- canvas 轨的 `forcedLandscape`/`documentState.*Orientation` 交换逻辑**对 T5 组合根本未执行**（R2-1 证据链第 1–7 跳）。
- 所以「两套方向权威分叉」是**真实存在的结构债**（见 MEMORY.md / `c2g-physical-print-gate.md §8`），但**它不是 T5 FAIL 的触发层**。T5 的 ±90° 错误发生在更下游、更窄的 **source/fit 单文件内容方向补偿缺失**。

**结论性重命名建议（待用户裁定，不改代码）**：G2-R2 的实质已从「canvas 双权威分叉」收敛为「**source/fit 单文件路径的 portrait×landscape×0° 内容方向补偿缺失**」。标签 `G2-R2` 保留（用户已锁定），但审计范围内的问题边界必须据此收窄。

### 4.4 三轨对照（定位缺陷唯一归属）

| 路径 | T5 是否触及 | 内容方向补偿机制 | 结论 |
|---|---|---|---|
| **bake 路径**（merged / 有 placement 的 PDF） | 否（placement=null） | E2 `sourceRotation: execOrient==='landscape'?90:0` 在 bake 分支补偿 Sumatra 隐含 −90°（8/8 实测正向） | 正常，不涉 T5 |
| **canvas/merged 轨**（`createPlacement`） | 否 | Policy B 几何烤进 canvas，交换在 `buildRenderCommand`；T5 不进此轨 | 未触及，非根因 |
| **source/fit 单文件**（T5 实际路径） | ✅ | **`contentRotation=0` → `rotate` 被短路跳过 → 无补偿** | 🔴 **根因所在** |

---

## 5. 修复边界（仅记录，不执行）

> 以下为 G2-R2 implementation 的**候选**修复面，须经用户明确批准且单变量纪律后方可实施。当前**一律不执行**。

- **候选修复点**：`print-settings.js:292` 的 `if (orientResult.contentRotation !== 0)` 短路，对「portrait 发票 × landscape 纸」组合需补发 `rotate`（理论值 270，见 §4.2 16 表直打模型），使净内容角正确填满横纸。
- **单变量纪律**（用户原话「避免混入 G3/E1/E1a/E2/横纸×纵向 G2」）：
  - 只允许针对「portrait-native 发票 × landscape 纸 × 0°」这一个组合新增补偿；
  - 不得触碰：`e23107b`(E1/E1a)、`c39ae14`、`RotationResolver`、`margin contract`、`normalize` 其他分支、16 表本身、noscale、canvas 轨 `forcedLandscape`/`documentState.*Orientation`。
  - 修复后须独立验证：T5 真机 + E regression（cr=0 字节级 + 8/8）+ 横纸×纵向 G2 数值不退化。
- **禁止猜测性改动**：不得「顺手」把 canvas 双权威也统一进本次修复（那是独立结构债，见 §4.3 / §8 of `c2g-physical-print-gate.md`）。

---

## 6. 维持的冻结与裁决

- `e23107b`（E1 `placement_bake.py` phi + E1a `buildBakeSpec` 透传 + E2 `main.js` executor offset）**保留不回退**。
- `c39ae14`（`PrintService.js` 补传 `paperOrientation`）**保留不回退**；T5 失败与 c39ae14 无关（R2-1 已证 T5 根本不经 c39ae14 改动的路径生效差异）。
- 当前状态机：`C-2-G = G2 IMPLEMENTED（数值四象限 PASS）/ T5 真机 FAIL / G2-R2 OPEN READ-ONLY`。
- 下一步：等待用户裁决是否进入 G2-R2 implementation（按 §5 单变量纪律修复 source/fit 路径内容方向补偿），并以 T5 真机作为终局 Gate。

---

## 7. 本审计未改动的文件

- `electron/main.js`（含 `:564` E2 分支）
- `electron/print-service/print-settings.js`（含 `:292` 短路）
- `electron/print-service/placement-bake-processor.js`
- `electron/print-service/sumatra-command-resolver.js`（仍未调用）
- `frontend/src/services/PrintService.js`
- `frontend/src/hooks/usePrint.js`
- 任何 RotationResolver / margin / canvas 轨文件

> 全部结论来自对未修改源码的只读追踪 + 冻结测量矩阵，无任何生产代码变更。
