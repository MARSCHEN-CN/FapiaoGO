# Print Margin Contract v1.2（冻结版）

> 状态：**FROZEN**（2026-08-10 定版 v1.1；2026-08-24 经契约变更流程批准扩展 v1.2——多页源支持）。
> 本文件是打印安全边距几何的唯一权威定义。
> 任何与本文冲突的代码、注释或历史文档一律以本文为准。
> 变更本文需走「契约变更流程」（§11），不得随 bugfix 顺带修改。
>
> **v1.2 变更记录（R-2.2 Design Decision Gate）**：
> `apply_pdf` 输入从「单页源」扩展为「单页或 N 页源」。单页路径行为与 v1.1 完全一致（零变化约束）；
> 多页语义见 §1.6。几何函数（contain-fit / Policy A / 矩阵 / mm_to_pt）零改动，仅页遍历范围扩展。
>
> 相关：`.workbuddy/artifacts/safety-margin-print-review.md`（根因审查）、
> `.workbuddy/artifacts/print-margin-contract-design.md`（Phase 1 设计）、
> `a3_design_spec_2026-08-03.md` §7.1（Policy A 旋转契约）、
> `print_preview_simulator_freeze_2026-08-03.md` §14.24（A3-V2）、
> `frontend/test/printGate/README.md`

---

## 0. 冻结裁决表

| 编号 | 议题 | 裁决 | 状态 |
|---|---|---|---|
| **D1** | margin 定义在哪个空间 | **(a) 源纸空间（旋转前），随 Policy A 一起变换** | 🔒 冻结 |
| **D2** | 打印后端 fit 策略 | **`noscale`**（禁止 `fit`，禁止条件式、禁止静默降级） | 🔒 冻结 |
| **D3** | 规范坐标系 | **PDF 用户空间：原点左下、Y 轴向上、单位 pt** | 🔒 冻结 |
| **R-1** | margin processor 输出的 `/Rotate` | **恒为 0**，不得留给后端二次解释 | 🔒 冻结 |
| **R-2** | 内容旋转 θ 的执行者（烤进内容 vs Sumatra `rotate=`） | **烤进内容**（被 D2 数学强制，见 §2.3） | 🔒 冻结（施工受 §2.4 门控） |
| **I-1** | 实现形态 | **单一规范 + 每语言一个执行器 + 共享向量集** | 🔒 冻结 |
| **C-1** | 打印机不可打印边 | **不进 Margin Contract**，独立为 Print Capability Guard | 🔒 冻结 |
| **X-1** | `expand_box` | **删除**（不保留 deprecated） | 🔒 冻结 |
| **X-2** | `margin==0` 短路复制 | **删除** | 🔒 冻结 |
| **X-3** | 环境（img2pdf 有无）决定几何 | **禁止** | 🔒 冻结 |

---

## 1. 唯一数学模型

### 1.1 规范坐标系（D3）

> **规范空间 = PDF 用户空间：原点左下、Y 轴向上、单位 pt。`1mm = 72/25.4 pt`。**

所有非 PDF 载体（Canvas / PIL / 预览 / 图片）只允许实现**坐标适配层**（原点翻转），
**不得**重新实现 `scale` / `usableRect` / contain-fit。

```
usableWidth  = paperWidth  - marginLeft - marginRight
usableHeight = paperHeight - marginTop  - marginBottom

sx = usableWidth  / contentWidth
sy = usableHeight / contentHeight

scale = allowUpscale ? min(sx, sy)          ← 允许放大
                     : min(1, sx, sy)       ← 默认：禁止放大（INV-3）

offsetX = marginLeft   + (usableWidth  - contentWidth  * scale) / 2
offsetY = marginBottom + (usableHeight - contentHeight * scale) / 2     ← 规范式（原点左下）
```

> **默认 `allowUpscale = false`。** 开启放大必须是显式入参，不得由载体/环境推断。

⚠️ **「禁止放大」只是 scale 的上限，不是另一套布局规则。**
它**只**在 `sx > 1 且 sy > 1`（源页两个方向都小于 usableRect）时才生效。
只要任一方向超出 usableRect，`min(1, sx, sy)` 自动取到那个 <1 的值，**照常缩小**。

```
源 300×300，usable 500×500  → min(1, 1.667, 1.667) = 1        保持 300×300 居中   ✅
源 300×600，usable 500×500  → min(1, 1.667, 0.833) = 0.8333   仍然缩小            ✅
```

> 禁止未来实现者读成「小图永远不 fit」或「小图走另一条分支」。
> **分支只有一条：算出 `sx`/`sy`，按上式取 min，其余流程完全相同。**

Top-left 载体适配式（唯一允许的差异）：

```
offsetY_top = marginTop + (usableHeight - contentHeight * scale) / 2
```

> ⚠️ 两式在 `marginTop == marginBottom` 时**数值完全相同**。对称边距下写反也测不出来。
> 因此向量集**必须**包含非对称上下边距用例（§7.2 V-02）。

margin 数组顺序全项目统一为 **`[left, right, top, bottom]`**，任何序列化/反序列化处必须注明。

### 1.2 不变量（INV）

- **INV-1**：输出页 MediaBox **必须等于经 Paper Orientation 与 Rotation Policy 解析后的最终物理输出纸张尺寸**（容差 0.1pt）。任何页面膨胀 = 错误。
  > INV-1 是**输出端不变量**，只陈述「等于最终纸」，不规定最终纸如何算出。
  > 具体解析规则由 Rotation Policy 给出（Policy A 定义见 §2.1a）。**Policy 不得反向引用 INV-1**，避免循环定义。
- **INV-2**：`scaleX == scaleY`（严格等比）。
- **INV-3**：默认 `allowUpscale = false`，此时 `scale <= 1.0` 恒成立；`scale > 1.0`（放大小内容）需**显式开关**。
  见 §1.1 的 clamp 式——禁止放大是 scale 上限，**不是**另一套布局分支。
- **INV-4**：几何结果与运行环境无关（img2pdf / pikepdf 是否存在、走哪条载体路径，结果一致）。
- **INV-5**：margin 在一张物理纸上**只施加一次**。多票/合并轨的 slot 切分发生在 usableRect **之内**，slot 不得各自再套一层 margin。
- **INV-6**：`margin = 0` 退化为「内容 contain-fit 满纸」，**不是**「跳过处理直接复制」。
- **INV-7**：**Margin 不得改变内容的内部几何。**

### 1.3 INV-7 的可执行定义

> **Margin operation may apply a uniform affine placement to the complete source page,
> but must not alter the source page's internal geometry.**

落成可断言的四条：

- **INV-7a｜相似变换**：作用于源页的变换矩阵只允许形如
  `[s·cosθ, s·sinθ, -s·sinθ, s·cosθ, tx, ty]`，其中 θ ∈ {0°,90°,180°,270°}。
  **禁止**独立的 x/y 缩放、shear、镜像（即禁止 `a != d` 或存在非旋转来源的 `b`/`c`）。
- **INV-7b｜整页原子性**：源页内容必须作为**一个整体**被引用施加变换（Form XObject / 等价机制），
  **禁止**逐对象重排、重新排版、重新生成内容流。
- **INV-7c｜不得裁切**：输出页的 CropBox 不得小于放置后的内容外接矩形。
  源页 CropBox ⊂ MediaBox 时，以 **CropBox 为内容尺寸基准**（见 §1.4）。
- **INV-7d｜无重采样失真**：栅格载体上，禁止改变像素宽高比的重采样；
  只允许等比重采样，且优先「原生分辨率放置 + 变换」而非先重采样。

**可测形式**：源页任取两点 p₁,p₂，必须满足 `|T(p₁)−T(p₂)| = s·|p₁−p₂|`（容差 0.1pt）。
向量集中以「内容内嵌基准标记 + 交比不变」验证。

### 1.4 contentSize 的规范定义（消歧）

`contentWidth/contentHeight` **恒定义为源页的有效可视尺寸**：

```
box     = CropBox if present else MediaBox
w, h    = box.width, box.height
if (sourceRotate % 180 == 90): w, h = h, w      ← 源页自带 /Rotate 必须先归一
contentWidth, contentHeight = w, h
```

> 不使用「墨迹外接矩形（ink bbox）」。理由：ink bbox 随内容变化，会让同一批发票缩放系数不一致，
> 且与 canvas 轨 `computePaperLayout` 的语义不符。**如需 ink-fit 是另一个功能，不属本契约。**

### 1.5 UserUnit

源页存在 `/UserUnit != 1` 时，pt 运算前提失效。**Guard 直接拒绝**（§6 G-4）。
实测样本（`artifacts/*.pdf`）均无 UserUnit，此为防御性条款。

### 1.6 Multi-page PDF Source Contract（v1.2 新增，冻结）

> 本小节是 v1.2 唯一新增范围：**多页源 PDF 的 margin contract 应用语义**。
> 单页输入行为完全由 §1.1–§1.5 定义，本小节仅扩展「页数 > 1」的情形，不改变任何单页语义。

#### 1.6.1 多页输入模型

A PDF source document MAY contain multiple pages. The margin contract is applied
**independently to each source page**. The output remains a **single PDF document**
with the **same page count**.

```
input.pdf                       apply_pdf            output.pdf
  pages: p1  ────────────────►  per-page             pages: p1' / p2' / p3'
         p2                     独立几何 + 逐页断言
         p3                     单文件 N 页输出
```

**禁止**把多页输出描述为「拆分成多个页面文件 / split pages」——输出必须是单一 PDF 文件，
页数 = 输入页数（§1.6.4 不变量），Source 打印轨以一个文件交付 Sumatra。

#### 1.6.2 Page-local geometry（页级几何，非文档级）

每页独立执行完整几何链（**禁止「document geometry / 首页决定一切」**）：

```
source page
   │
   ▼
_content_size(page)          ← §1.4：CropBox else MediaBox + /Rotate 归一，页级
   │
   ▼
apply_margin_contract(...)   ← 同一 paper/margin/content_rotation 参数
   │
   ▼
contain-fit                  ← 每页内容独立适配同一 inner area
   │
   ▼
output page（MediaBox = Policy A outputPaper，/Rotate = 0）
```

任何实现不得引入「以首页 / 文档级尺寸作为所有页的几何权威」的推断。

#### 1.6.3 Mixed page size policy（混合页尺寸）

源 PDF 各页尺寸**允许不同**（如 A4 / A5 / Letter 混排）。规则：

- 每页独立归一化到目标 paper policy（逐页 contain-fit）；
- **不**拒绝混合输入；**不**继承首页尺寸；**不**强制源页一致性断言。

目标纸几何（paper_w_pt / paper_h_pt / margin_lrtb / content_rotation）由调用方显式传入，
对所有页**同一**（文件级语义，见 §1.6.6 非目标）。

#### 1.6.4 Page count invariant（页数不变量）

```
Output page count MUST equal input page count.
N input pages  →  N output pages
```

空源（0 页）**拒绝**（raise，复用 §6 拒绝语义）。

#### 1.6.5 Rotation invariant（每页旋转不变量）

每个输出页 `/Rotate == 0`（G-1）。旋转归一化（源页 `/Rotate` 折入 form /Matrix，
§1.4 库行为）是**页变换的一部分**，逐页执行，输出恒不携带 `/Rotate`。

#### 1.6.6 断言与范围（Assertions）

多页模式仍执行 G-1（`/Rotate==0`）与 G-2（`MediaBox == Policy A outputPaper`），
但断言范围是 **per output page**，不是 whole document：

- 每一输出页必须独立满足 G-1 / G-2；
- 任一页 G 失败即 raise（§6：禁止降级为 warning）；
- G-3（/Annots 告警）、G-4（/UserUnit 拒绝）、AP-DR-6（Stamp flatten）亦逐页执行。

#### 1.6.7 API 兼容性（apply_pdf）

| 版本 | 输入 | 输出 |
|---|---|---|
| v1.1 | 单页 PDF | 单页 PDF |
| v1.2 | 单页 **或** N 页 PDF | 单页 或 N 页单文件 PDF |

保持：同一入口（`apply_pdf`）、同一 margin 参数（pt）、同一输出路径语义
（`input.pdf → output.pdf` 单文件）。单页输入时返回值与 v1.1 逐字段一致；
多页输入返回首页 info 并追加 `pageCount` / `pages` 增量字段（旧消费方兼容）。

#### 1.6.8 非目标（Non-goals，防范围蔓延）

本扩展**不引入**：

- page-specific margins（逐页不同边距）；
- page-specific paper policy（逐页不同纸张）；
- page-specific rotation policy（逐页不同旋转——content_rotation 恒为文件级统一）；
- new placement authority（不新增任何布局/放置权威）。

任何实现若需要上述能力，必须另立契约、另走 §11 变更流程，禁止借多页扩展顺带实现。

---

## 2. 旋转权威归属（R-1 / R-2）

### 2.1 D1 冻结文本

> **安全边距定义在旋转前的源纸空间，并遵循 Policy A；旋转后，margin 随纸面构造一起变换。**

推论：
- rot90 下，物理纸上观察到的四边边距是源纸 `[L,R,T,B]` 的**顺时针轮换**，不是恒定绑边。
  （MEMORY 实测锚点：rot0 `L14.3/T16/R10.6/B17` → rot90 `L17/T14.3/R16/B10.6`。）
- `sourceOrigin` 与 `margin` **同为 paper-space 属性，但绝不合并为一个概念**。
  数值上都曾等于 10mm 纯属巧合。`sourceOrigin` 是纸面构造的内容落点，`margin` 是 usableRect 的扣除量。

### 2.1a Policy A 定义（Rotation Policy 的唯一实现）

> **当 `rotation ∈ {90, 270}` 时，输出纸张宽高按 Policy A 交换；margin 同步参与同一次纸面变换。**

形式化（`paper` 为源纸空间纸张，`m` 为源纸空间边距 `[L,R,T,B]`）：

```
θ % 180 == 0   →  outputPaper = (paperW, paperH)      m' = [L, R, T, B]
θ % 180 == 90  →  outputPaper = (paperH, paperW)      m' = 顺时针轮换（见 §2.1）
```

INV-1 中的「最终物理输出纸张尺寸」即此处的 `outputPaper`。

> 分层纪律：**Policy A 只负责算出 `outputPaper` 与 `m'`，不陈述任何输出端不变量**；
> INV-1 只负责断言输出等于 `outputPaper`，不复述交换规则。二者单向依赖，不得互引。

### 2.2 R-1：margin processor 输出恒 `/Rotate == 0`

margin processor **不允许**把 `/Rotate` 留给后端解释。
输入页若自带 `/Rotate != 0`，必须在 §1.4 归一为 contentSize，并将该旋转**烤进变换矩阵**，输出页 `/Rotate = 0`。

### 2.3 R-2 不是偏好，是 D2 的数学推论

用户裁决 R-2 为「烤进内容」。审查确认：**在 D2=`noscale` 之下，这不是可选项。**

**证明**：设输出页 `MediaBox = W×H`、`/Rotate=0`，打印介质 `M = Mw×Mh`，后端 `noscale`（1:1，不做任何适配）。
若后端再施加 `rotate=90`，则呈现尺寸变为 `H×W`。
`noscale` 不缩放，故可完整落纸的充要条件是 `H <= Mw 且 W <= Mh`。
而 INV-1 已冻结 `W×H == 目标纸`，即 `W=Mw, H=Mh`。
代入得 `Mh <= Mw 且 Mw <= Mh`，即 **`Mw == Mh`（正方形纸）**。

> **结论：非正方形纸下，`noscale` + 后端 `rotate≠0` 必然裁切。**
> 因此 D2 一旦冻结，内容旋转就只能烤进内容，后端旋转必须为 none。R-2 被强制。

### 2.4 ⚠️ R-2 的施工门控（本次审查新增，必须遵守）

R-2 影响面**超出 margin 模块**：`print-settings.js:165-171` 目前会输出 `rotate=N`，
Sumatra 是现役的内容旋转权威。落实 R-2 = 从 Sumatra 手里收回旋转权。

这与 D1 选 (a) 的初衷（「不要在 A3 收敛期同时移动两个契约的靶心」）存在张力：
**A3-V2 正是在测量 Sumatra 的旋转行为**（`scripts/verify_sumatra_rotation.js`，虚拟 writer 量 artifact MediaBox）。

因此冻结如下门控：

| 门控 | 内容 |
|---|---|
| **RG-1** | Phase 1 施工范围**限定 rot0**。rot0 路径可立即落 `noscale`（θ=0 时 §2.3 的冲突不存在）。 |
| **RG-2** | rot90/180/270 路径在 **A3-V2 出结论前维持现状**（保留 Sumatra `rotate=` + 现行 fit），并在代码中以显式分支 + TODO 标注，**不得**被 §8 源码守卫误判为违规。 |
| **RG-3** | A3-V2 结论落地后，单独一个 commit 完成「旋转权移交」：`print-settings.js` 停止输出 `rotate=`，全路径切 `noscale`。该 commit 必须同时更新 A3 冻结文档。 |
| **RG-4** | 向量集中的 rot90 用例（V-04）**现在就写**，但标记 `"status": "pending-a3v2"`，Gate 中跳过并计入 pending 计数，不允许静默遗漏。 |

> **审查提示**：现行 `fit` 一直在**掩盖** rotation 与 paper 方向的不同步——不同步时 fit 会缩放兜底，不报错。
> 切到 `noscale` 会让这类历史缺陷**首次显形**。这是好事（暴露真实 bug），但要有心理预期：
> rot90 切轨时若出现「以前没见过的裁切」，大概率不是新引入的 bug，而是 fit 掩盖了很久的旧 desync。

### 2.5 最终权威链（冻结）

```
source rotation (含源页 /Rotate)
      ↓  归一进 contentSize（§1.4）
Policy A 纸面构造
      ↓
Margin Geometry（contain-fit 进 usableRect）
      ↓
Form XObject 单次相似变换（INV-7a）
      ↓
输出：MediaBox == target paper，/Rotate == 0
      ↓
Sumatra: noscale，无 rotate=
      ↓
printer（不得再解释几何）
```

全链**只有一处**决定几何。任何环节新增第二个旋转/缩放解释点，即为契约违反。

---

## 3. 责任划分（切分点 = usableRect）

```
Electron（业务层，零内容知识）              Python（载体层，零业务知识）
──────────────────────────────            ────────────────────────────────
PrintSpec { paper, margin, rotation }      measure contentSize（§1.4）
  → PaperLayout                            → 套用 §1.1 冻结公式
  → MarginContract                         → Form XObject 单次相似变换
  → { paper, usableRect, rotation }  ───▶  → 输出 MediaBox == paper, /Rotate = 0
```

**Python 收到的是一个矩形**，不是 `A4`、不是 `10mm`、不是 `portrait`。
「Python 不承载业务规则」成立，同时避免 probe round-trip。

**不采用 `{scale, translateX, translateY}` 切分**的理由（已 grep 确认）：
`scale` 需要 contentSize，而 electron 侧无任何 PDF 解析库（`pdfjs-dist` 仅在 frontend 渲染进程）。
改为 probe 往返 = 每文件 2 次 Python spawn，批量 N 张 = 2N 次，会吃掉 45s→28s 的性能收口成果。

> 若未来要把 transform 上移到 JS，前置条件是给 electron 主进程加 `pdf-lib`（首选）
> 或给 Python 加 `--probe` 批量模式（1 次 spawn）。**在此之前，切分点冻结在 usableRect。**

---

## 4. fit 策略（D2）

**冻结值：`noscale`。**

无条件禁止：

- ❌ `marginsApplied ? 'noscale' : 'fit'` 这类条件式（`DirectPrintHandler.js:164`、`main.js:551`）
- ❌ margin 路径自行决定 fit
- ❌ 打印机能力不足时静默 fallback 到 `fit`
- ❌ 任何 renderer / 入口私自覆盖 fit

fit 策略只能由 PrintSpec 决定一次，两个打印入口读**同一个常量**。

> `fit` 为何不可用：Sumatra 的 `fit` 以**可打印区域**为目标而非纸张。打印机存在硬件不可打印边（典型 3–5mm），
> 故 `printable < paper`。即便 `MediaBox == paper`，`fit` 仍会整页再缩约 96–98%，
> 使实际边距 ≠ 设定值，且 scale 被后端二次解释——正是契约要禁止的行为。

---

## 5. Print Capability Guard（C-1，独立层）

**Margin Contract 是纯几何契约，不得知道任何具体打印机。** 设备能力校验独立成层：

```
Margin Contract  ── 保证 ──▶  contentBBox ⊂ usableRect ∧ MediaBox == targetPaper
Print Capability Guard ── 校验 ──▶  min(margin) >= printer unprintable boundary
```

不满足时：**明确拒绝或提示用户**。绝不允许「发现打印机不支持 → 偷偷 fit」。

### 5.1 ⚠️ 可实施性提示（审查补充）

当前依赖下**拿不到**打印机硬件不可打印边：
- Electron `getPrintersAsync()` 不返回 margin 信息；
- Sumatra 不暴露该能力；
- 准确值需 Windows GDI `GetDeviceCaps(PHYSICALOFFSETX/Y, PHYSICALWIDTH/HEIGHT)`，属原生调用。

因此冻结以下**降级策略（不影响几何）**：

| 情形 | 行为 |
|---|---|
| 能力已知且 `min(margin) >= 不可打印边` | 放行 |
| 能力已知且不满足 | **阻断**，提示用户调大边距或换纸 |
| **能力未知** | 以保守常量 `5mm` 比较：不足则**告警一次并放行**，几何一律不变 |

> 关键不变量：**Capability Guard 在任何分支下都不得修改几何、不得改 fit。**
> 它只能放行 / 告警 / 阻断三选一。这样「不实现原生调用」不会污染契约。
>
> Print Capability Guard 的原生实现列为 **P1 独立 ticket**，不阻塞 Phase 1。

---

## 6. 运行时 Guard（保护，非测试）

生成 margin PDF 后立即自检，失败 **`raise` 并中止打印**，不允许降级为 warning。

```python
# ❌ 裸比较会被 /Rotate 90 骗过（595x842 + Rotate90 实际呈现 842x595）
assert page.mediabox == target_paper

# ✅ 比较有效页面尺寸
w, h = box_size(page.mediabox)
if int(page.get('/Rotate', 0)) % 180 == 90:
    w, h = h, w
assert abs(w - paper_w) <= 0.1 and abs(h - paper_h) <= 0.1
```

| 编号 | 条款 |
|---|---|
| **G-1** | 输出 `/Rotate == 0`（R-1）。非 0 即失败。 |
| **G-2** | 有效页面尺寸 == 目标纸（容差 0.1pt）。失败即中止，**不允许**「加了边距 + 尺寸不对 + 继续打印」这一状态存在。 |
| **G-3** | 源页存在 `/Annots` 时告警：Form XObject 变换**不会移动 annotation**（annotation 位于页空间，不在内容流内），可能导致签章留在原位或被裁。<br>📊 **实测降级**：`artifacts/25952000000127675627.pdf` 与 `sumatra_a1_rot90.pdf` 均为 `annots=[]`、`Rotate=0`、`CropBox==MediaBox`、无 UserUnit。故此项为**防御性 P2**，不阻塞 Phase 1；但一旦命中必须 flatten 或同步变换 `/Annots` 的 Rect，禁止忽略。 |
| **G-4** | 源页 `/UserUnit != 1` 时直接拒绝（§1.5）。 |
| **G-5** | 输出内容外接矩形 ⊆ usableRect（容差 0.5mm，与 printGate 一致）。 |

---

## 7. 单一实现的强制手段（I-1）

### 7.1 条款措辞（澄清「一个实现」≠「一个调用点」）

> **项目中只能存在一个 margin 几何规范，与每种语言各一个执行器。
> 任何 renderer 不得内联重算 margin，只能调用该执行器。调用时机可因路径而异。**
>
> **跨语言实现不是两个独立算法，而是同一规范的两个执行器；
> 任何一侧的修改必须通过同一组 contract vectors 才允许合入。**

这把「单一正确实现」从**代码组织层**提升为**行为层唯一性**：

```
                docs/margin_contract_vectors.json
                            │
                ┌───────────┴───────────┐
                ↓                       ↓
          JS executor            Python executor
                │                       │
                └───────────┬───────────┘
                            ↓
                       same result
```

> canvas 轨在渲染时调用 `computePaperLayout(paperSpec)` 是 MEMORY 已冻结的刻意设计
> （「safeMargin 不进模型，几何约束非数据」），属**调用时机差异**，不算重复实现。

### 7.2 一致性向量集

新建 `docs/margin_contract_vectors.json`，由 JS 测试与 Python 单测**共同消费**。
文件头必须注明：单位 pt、原点左下、margin 顺序 `[left, right, top, bottom]`。

| id | 用途 |
|---|---|
| `V-01-a4-sym` | A4 满版 + 对称 10mm，基线用例 |
| `V-02-asym-tb` | **上下非对称**边距 —— 专抓原点翻转错误（对称用例抓不到） |
| `V-03-wide` | 宽内容进窄纸，scale 由宽度决定、垂直居中 |
| `V-04-rot90` | rot90 + 非对称边距，验证 D1 的顺时针轮换。`"status": "pending-a3v2"`（RG-4） |
| `V-05-zero-margin` | `margin=0` 仍走 contain-fit（INV-6），不得短路复制 |
| `V-05b-zero-margin-crossfit` | **`margin=0` + 跨纸型**（Letter→A4）。抓的不是 margin 几何，而是 **zero margin ≠ bypass contract**：同纸型下短路复制与正确输出几何全等，只有跨纸型才能被 INV-1 判死 |
| `V-06-internal-geometry` | 内嵌基准标记，验证 INV-7（相似变换、交比不变） |
| `V-07-src-rotate` | 源页自带 `/Rotate 90`，验证 §1.4 归一 + R-1 输出归零 |
| `V-08-no-upscale` | 源页两向均小于 usableRect，`scale` 被 clamp 到 1（INV-3），验证「上限而非另一分支」 |

> 🔴 **期望值禁止由实现生成。** 向量集的 `expect` 必须**手工按 §1.1 公式推导**并写死。
> 若用当前实现跑一遍生成期望值，测试只能证明「实现等于它自己」，无法证明它符合契约。
> 这是本类测试最常见的失效模式。

### 7.3 源码守卫 Gate

（项目已有源码守卫模式；MEMORY 记录：仓库为 CRLF，切片前先 `.replace(/\r\n/g,'\n')`。）

| 规则 | 断言 |
|---|---|
| SG-1 | 全仓库 `expand_box` → **0 hits** |
| SG-2 | `.mediabox =` / `page.mediabox=` 赋值**只允许**出现在唯一 contract executor 内 |
| SG-3 | `mm_to_pt(` 的算术**只允许**出现在 contract 模块内 |
| SG-4 | `'fit'` / `'contain'` → Sumatra fit 标志的映射**只允许**出现在单一常量定义处 |

命中即 Gate 失败。这比文档有效得多——它拦得住半年后那句「这里之前有个 margin 方法，我复用一下」。

⚠️ SG-2/SG-3 需为 RG-2 的 rot90 遗留分支设白名单，并附到期条件（A3-V2 关闭后移除）。

---

## 8. 删除清单与禁止清单

### 8.1 删除（删除，不是废弃）

| 目标 | 位置 | 理由 |
|---|---|---|
| `expand_box()` | `scripts/add-pdf-margins.py:170` | 表达的是「修改 PDF 页面边界」，与「打印安全边距」是两个业务，不得共存 |
| `expand_box` 全部 6 处调用 | 同文件 L232/234/237/256/258/261 | 已确认全部集中在 `add_margins()` 内，**影响面完全可控** |
| `_pil_image_to_pdf_with_margins()` fallback | 同文件 L103-167 | 双语义根源。其 contain-fit 思路正确，可作新实现参考，但不得作为分支保留 |
| `margin==0` 短路复制 | 同文件 L212-215 | 违反 INV-6 与 INV-1 |
| `marginsApplied ? noscale : fit` | `DirectPrintHandler.js:164`、`main.js:551` | 旧世界遗产 |
| `DEBUG_SAVE_TO_DESKTOP` 默认 `true` | `pdf-margin-processor.js:35` | 默认往用户桌面写文件，本次一并改 `false` |

### 8.2 绝不能出现（冻结禁止项）

```
expand_box                      ❌
margin == 0 → copy input        ❌
marginsApplied ? fit : ...      ❌
margin path 自己决定 fit        ❌
printer capability 不足 → fit   ❌
renderer 自己重新算 margin      ❌
PDF /Rotate 留给 Sumatra 解释   ❌
环境（img2pdf 有无）决定几何    ❌
用实现生成向量集期望值          ❌
```

---

## 9. 施工闸门（Gate 0 → 7）

每一关是**闸门**不是步骤：未过不得进入下一关。每关一个独立 commit。

| Gate | 动作 | 通过判据 |
|---|---|---|
| **0** | D1/D2/D3 + R-1/R-2 + C-1 冻结 | 本文档 v1.0 落盘 ✅ **（已完成）** |
| **1** | 写 `docs/margin_contract_vectors.json` | 期望值手工推导，非实现生成（§7.2） |
| **2** | Margin Geometry Gate 对**当前错误代码**运行 | 必须 **RED**，且见 §9.1 |
| **3** | 删除 `expand_box` + PIL fallback 分支 | SG-1 = 0 hits |
| **4** | 实现唯一 contain-fit（Form XObject，INV-7a/b） | Gate 2 转 **GREEN** |
| **5** | 运行时 Guard G-1～G-5 | 故意注入错误页面尺寸 → 必须中止打印 |
| **6** | 两个打印入口统一 `noscale`（rot0 范围，RG-1） | 无条件式 fit；rot90 分支按 RG-2 显式保留 |
| **7** | 源码守卫 Gate + Python 侧向量单测 | SG-1～SG-4 全绿；JS/Python 双侧向量结果一致 |

### 9.1 Gate 2 的 RED 判据（审查加严）

> **「RED」必须是「因正确断言而失败」，不是「因任何原因而失败」。**

Gate 2 通过的条件：
1. 失败点是 **INV-1**（输出页面尺寸 > 目标纸），并**记录实测数值**作为修复前基线；
2. Gate 基础设施本身自检通过（用一份**已知正确**的手工 contain-fit PDF 跑，必须 GREEN）；
3. 若 Gate 直接 GREEN → **停止施工**。结论不是「测试可能不够严格」，而是「测试模型没有捕获已知 bug」。

> 复用现成设施，不另起 harness：`frontend/test/printGate/measureMargins.mjs`
> 已有 `findContentBBox` / `measureMarginsPx`（注释标注「A2-G1 安全边距测量纯函数」），
> 配合 `rasterize_pdf.py`；容差 0.5mm、DPI 300 沿用 `gateConfig.mjs`。
> fixture 用**确定性生成**的满版测试页，不用 gitignored 的真实发票。

### 9.2 四层防回退

```
contract vectors  +  geometry gate  +  runtime guard  +  source guard
   （规范一致性）      （行为正确性）     （生产安全网）    （组织约束）
```

---

## 10. 前向义务

- **OFD**：独立 ticket `unify-ofd-print-layout`。落地时**必须消费本契约**，不得新增第三套 margin 几何。
  当前两处扩展名白名单不含 `.ofd`（静默跳过边距），在该 ticket 内修复。
- **多票 / 合并轨**：INV-5 已覆盖（margin 纸级施加一次，slot 在 usableRect 内切分）。切轨时须验证不双重套边距。
- **A3-V2 旋转权移交**：见 RG-3，独立 commit，需同步更新 A3 冻结文档。
- **Print Capability Guard 原生实现**：P1 独立 ticket（§5.1）。

---

## 11. 契约变更流程

本文件为冻结契约。变更须满足全部条件：

1. 变更提案单独成文，说明**被推翻的不变量**及推翻理由；
2. 同步更新 `margin_contract_vectors.json`，且新旧向量集差异需逐条说明；
3. JS / Python 双侧执行器同时更新并通过同一向量集；
4. 版本号递增并保留变更记录；
5. **禁止**在 bugfix commit 中顺带修改本文。

### 11.1 变更记录

| 版本 | 日期 | 变更 | 来源 |
|---|---|---|---|
| v1.0 | 2026-08-10 | 初始冻结（Gate 0） | D1/D2/D3 裁决 |
| **v1.1** | 2026-08-10 | ① §1.1 scale 公式补 `allowUpscale` clamp，并注明「上限≠另一分支」；② INV-1 改为输出端不变量措辞，新增 §2.1a Policy A 定义，二者单向依赖；③ §7.2 补 `V-05b` / `V-08` | Gate 1 审查 ERRATA-1/2/3，用户签署 |

> v1.1 **未推翻任何不变量**，仅消除歧义与补齐向量表。
> `margin_contract_vectors.json` 的 `expected` 数值**零变更**（v1.1 只把既有向量的判定依据写进契约正文）。

---

## 附录 A：本次审查的实测事实（2026-08-10）

| 项 | 实测结果 | 影响 |
|---|---|---|
| `artifacts/25952000000127675627.pdf` | MediaBox 595.28×841.89，CropBox 同，Rotate 0，无 UserUnit，`annots=[]` | G-3/G-4 降级为防御性 P2，不阻塞 Phase 1 |
| `artifacts/sumatra_a1_rot90.pdf` | MediaBox 595.32×841.92，Rotate 0，`annots=[]` | 同上 |
| backend venv | `pikepdf/fitz/img2pdf/PIL` **均可用** | 说明当前环境走的正是 img2pdf → `expand_box` **错误分支**，与用户观察到的裁切现象吻合 |
| `print-settings.js:165-171` | 现役输出 `rotate=N`，Sumatra 是当前内容旋转权威 | R-2 需 §2.4 门控，不能与 margin 同 commit 落地 |
| `add-pdf-margins.py` | 全文无 `/Rotate`、`/Annots`、`/UserUnit`、Form XObject 处理（L27 注释自承「不处理页面旋转」） | Form XObject 路径为**全新代码**，非改造 |

## 附录 B：本轮值得肯定的判断

- **「删除而非废弃」** —— 成本极低（6 处调用全在一个函数内），收益极高：保留语义相反的同名工具函数几乎必然被复用。
- **「环境不能改变几何结果」** —— 提炼为 INV-4。本次实测已证实该环境分支正在生产中生效。
- **把 PRE-1 拆成 Margin Contract / Print Capability Guard** —— 正确拆分。几何契约不该知道具体设备，否则层次绑死。
- **INV-7** —— 补得关键。选 Form XObject 时，「整页原子相似变换」是唯一能让矢量路径既保真又可审计的约束。
- **把问题从「边距不准」重新定级为「打印几何 Contract 收敛」** —— 定级正确。按 bug fix 处理必然二次复发。
