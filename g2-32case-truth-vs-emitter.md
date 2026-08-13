# G2-R2：32 条实测 Truth × 当前 live command emitter 逐格对照（只读）

> **纪律**：本次只读。未修改 `margin_contract.py` / `add-pdf-margins.py` / bake / 16 表 / `RotationResolver` / `normalize` / `geometry-translator` / `main.js` / `print-settings.js` / `print-backend.js`。未 commit。
> 目标只做一件事：**逐格对照 32-case Truth 与当前 emitter，列出所有旧 rotation 注入点，并对每个变量做 Geometry/Truth/Executor 归属分类。**

---

## 0. 结论（一句话）

当前 live emitter 的 `rotate` 来自 `src.sourceRotation`（恒等映射 `commandRotate := userRotation`），而 **32-case Truth 中 `commandRotate ≠ userRotation` 在 20/32 格成立**。因此：

- 即便在「最干净」路径（无 bake 注入、无 print-backend 覆盖），emitter 也**只与 12/32 格 Truth 一致**，其余 20 格结构性错误。
- 你实测 FAIL 的那格（竖向纸·横向发票·0°·landscape）恰好是「干净路径本应正确」的 12 格之一，所以**把它打错的不是恒等式本身，而是叠在它之上的旧注入点**（`main.js:567-569` 的 `sourceRotation=90`）。
- 真正的收口不能是「去掉注入就完了」——**必须让 emitter 改成 32 格查表**，否则另有 20 格永远错。

---

## 1. 32-case Truth 重建（已提升为不可覆盖生产事实）

两个 paperType 的矩阵。命令简写 `L/R/N` = `landscape / disable-auto-rotation(=portrait 语义) / rotate=N`。

### 1.1 竖向纸张类型（A4 等，natural=portrait）—— 16 格（你前一轮已完整实测）

| 发票 | 用户旋转 | 请求方向 | Truth 命令 |
| -- | -: | -- | -- |
| 横向 | 0 | 横向 | `landscape,rotate=0,fit` |
| 横向 | 0 | 竖向 | `portrait,rotate=0,fit` |
| 横向 | 90 | 横向 | `landscape,rotate=0,fit` |
| 横向 | 90 | 竖向 | `portrait,rotate=180,fit` |
| 横向 | 180 | 横向 | `landscape,rotate=180,fit` |
| 横向 | 180 | 竖向 | `portrait,rotate=180,fit` |
| 横向 | 270 | 横向 | `landscape,rotate=180,fit` |
| 横向 | 270 | 竖向 | `portrait,rotate=0,fit` |
| 竖向 | 0 | 横向 | `landscape,rotate=180,fit` |
| 竖向 | 0 | 竖向 | `portrait,rotate=0,fit` |
| 竖向 | 90 | 横向 | `landscape,rotate=0,fit` |
| 竖向 | 90 | 竖向 | `portrait,rotate=0,fit` |
| 竖向 | 180 | 横向 | `landscape,rotate=0,fit` |
| 竖向 | 180 | 竖向 | `portrait,rotate=180,fit` |
| 竖向 | 270 | 横向 | `landscape,rotate=180,fit` |
| 竖向 | 270 | 竖向 | `portrait,rotate=180,fit` |

### 1.2 横向纸张类型（PostScript/凭证，natural=landscape）—— 16 格

按你给的压缩矩阵（`横向发票 0→90/90, 90→90/270, 180→270/270, 270→270/90`；`竖向发票 0→270/90, 90→90/90, 180→90/270, 270→270/270`，分母为 `landscape/portrait` 请求方向之 rotate）还原，且已用前一轮冻结的 **「横纸 rotate = 竖纸同格 +90°（mod 360）」** 关系交叉验证，全部一致。

| 发票 | 用户旋转 | 请求方向 | Truth 命令 |
| -- | -: | -- | -- |
| 横向 | 0 | 横向 | `landscape,rotate=90,fit` |
| 横向 | 0 | 竖向 | `portrait,rotate=90,fit` |
| 横向 | 90 | 横向 | `landscape,rotate=90,fit` |
| 横向 | 90 | 竖向 | `portrait,rotate=270,fit` |
| 横向 | 180 | 横向 | `landscape,rotate=270,fit` |
| 横向 | 180 | 竖向 | `portrait,rotate=270,fit` |
| 横向 | 270 | 横向 | `landscape,rotate=270,fit` |
| 横向 | 270 | 竖向 | `portrait,rotate=90,fit` |
| 竖向 | 0 | 横向 | `landscape,rotate=270,fit` |
| 竖向 | 0 | 竖向 | `portrait,rotate=90,fit` |
| 竖向 | 90 | 横向 | `landscape,rotate=90,fit` |
| 竖向 | 90 | 竖向 | `portrait,rotate=90,fit` |
| 竖向 | 180 | 横向 | `landscape,rotate=90,fit` |
| 竖向 | 180 | 竖向 | `portrait,rotate=270,fit` |
| 竖向 | 270 | 横向 | `landscape,rotate=270,fit` |
| 竖向 | 270 | 竖向 | `portrait,rotate=270,fit` |

> **一致性自检**：横纸 16 格的 rotate 值 = 竖纸 16 格对应格 +90（mod 360），与你前一轮冻结的「Table A = Table B +90° 恒定偏移」完全一致 → 重建可信。

---

## 2. 当前 live emitter 的真实行为（精确，带行号）

链路：`frontend sourceRotation/fileRotations → IPC → main.js:print-source-file → print-backend.buildSumatraCommand → print-settings.buildPrintSettings`（唯一活 emitter）。

`print-settings.js:buildPrintSettings`（`print-settings.js:274-359`）实际产出：

```
baseFlag = spec.paper.orientation==='landscape' ? 'landscape' : 'disable-auto-rotation'   // L289-291
rotate   = (contentRotation !== 0) ? `rotate=${contentRotation}` : ''                       // L292-294
contentRotation = src.sourceRotation ?? src.rotation ?? 0                                   // L183 (normalize)
spec.paper.orientation = requestedOrient = src.landscape ? 'landscape'
                         : (src.paperOrientation∈{landscape,portrait} ? src.paperOrientation : naturalOrient)  // L200-204
```

**即（干净路径下）：**
- `baseFlag` 跟随 `requestedPaperOrientation`（landscape↔landscape，portrait↔disable-auto-rotation）—— 前缀与 Truth 前缀一致。
- `rotate` = `sourceRotation`（恒等）。**这就是与 Truth 冲突的根。**

> 注意 `print-backend.js:128-132` 会在到达 `normalize` 之前把 `normalizedSettings.paperOrientation = getPaperShapeOrientation(paper)`：A4→`portrait`，**覆盖用户 landscape 请求**。这会让前缀也错（所有 landscape 请求格被改成 portrait 前缀），使匹配率进一步劣化。

---

## 3. 逐格对照（32 格）

判定：`匹配` ⟺ Truth 前缀 == 请求方向 且 `Truth.rotate == userRotation`（即恒等 emitter 恰好给出 Truth）。

| # | 纸张类型 | 发票 | 用户旋转 | 请求方向 | Truth 命令 | emitter(clean) 实际 | 匹配 |
| -: | -- | -- | -: | -- | -- | -- | :-: |
| 1 | 竖 | 横 | 0 | 横 | `landscape,0` | `landscape,0` | ✅ |
| 2 | 竖 | 横 | 0 | 竖 | `portrait,0` | `portrait,0` | ✅ |
| 3 | 竖 | 横 | 90 | 横 | `landscape,0` | `landscape,90` | ❌ |
| 4 | 竖 | 横 | 90 | 竖 | `portrait,180` | `portrait,90` | ❌ |
| 5 | 竖 | 横 | 180 | 横 | `landscape,180` | `landscape,180` | ✅ |
| 6 | 竖 | 横 | 180 | 竖 | `portrait,180` | `portrait,180` | ✅ |
| 7 | 竖 | 横 | 270 | 横 | `landscape,180` | `landscape,270` | ❌ |
| 8 | 竖 | 横 | 270 | 竖 | `portrait,0` | `portrait,270` | ❌ |
| 9 | 竖 | 竖 | 0 | 横 | `landscape,180` | `landscape,0` | ❌ |
| 10 | 竖 | 竖 | 0 | 竖 | `portrait,0` | `portrait,0` | ✅ |
| 11 | 竖 | 竖 | 90 | 横 | `landscape,0` | `landscape,90` | ❌ |
| 12 | 竖 | 竖 | 90 | 竖 | `portrait,0` | `portrait,90` | ❌ |
| 13 | 竖 | 竖 | 180 | 横 | `landscape,0` | `landscape,180` | ❌ |
| 14 | 竖 | 竖 | 180 | 竖 | `portrait,180` | `portrait,180` | ✅ |
| 15 | 竖 | 竖 | 270 | 横 | `landscape,180` | `landscape,270` | ❌ |
| 16 | 竖 | 竖 | 270 | 竖 | `portrait,180` | `portrait,270` | ❌ |
| 17 | 横 | 横 | 0 | 横 | `landscape,90` | `landscape,0` | ❌ |
| 18 | 横 | 横 | 0 | 竖 | `portrait,90` | `portrait,0` | ❌ |
| 19 | 横 | 横 | 90 | 横 | `landscape,90` | `landscape,90` | ✅ |
| 20 | 横 | 横 | 90 | 竖 | `portrait,270` | `portrait,90` | ❌ |
| 21 | 横 | 横 | 180 | 横 | `landscape,270` | `landscape,180` | ❌ |
| 22 | 横 | 横 | 180 | 竖 | `portrait,270` | `portrait,180` | ❌ |
| 23 | 横 | 横 | 270 | 横 | `landscape,270` | `landscape,270` | ✅ |
| 24 | 横 | 横 | 270 | 竖 | `portrait,90` | `portrait,270` | ❌ |
| 25 | 横 | 竖 | 0 | 横 | `landscape,270` | `landscape,0` | ❌ |
| 26 | 横 | 竖 | 0 | 竖 | `portrait,90` | `portrait,0` | ❌ |
| 27 | 横 | 竖 | 90 | 横 | `landscape,90` | `landscape,90` | ✅ |
| 28 | 横 | 竖 | 90 | 竖 | `portrait,90` | `portrait,90` | ✅ |
| 29 | 横 | 竖 | 180 | 横 | `landscape,90` | `landscape,180` | ❌ |
| 30 | 横 | 竖 | 180 | 竖 | `portrait,270` | `portrait,180` | ❌ |
| 31 | 横 | 竖 | 270 | 横 | `landscape,270` | `landscape,270` | ✅ |
| 32 | 横 | 竖 | 270 | 竖 | `portrait,270` | `portrait,270` | ✅ |

### 统计（clean 路径，已忽略 print-backend 覆盖与 bake 注入）
- **匹配：12 / 32（37.5%）** —— 全为「userRotation == Truth.rotate 的巧合格」。
- **不匹配：20 / 32（62.5%）** —— 全部因 `rotate := sourceRotation` 恒等违反 Truth。
- 若再叠加 `print-backend.js:128-132` 把 landscape 请求强制改 portrait 前缀，则所有 landscape 请求格（#1,3,5,7,9,11,13,15,17,19,21,23,25,27,29,31）前缀再错一次 → 匹配率进一步掉到仅 portrait-请求且巧合的 6 格（#2,6,10,14,28,32）。
- 若再叠加 `main.js:567-569` 的 bake `sourceRotation=90`，所有 rotate 再 +90 偏移 → 几乎全错。

> **你 FAIL 的 #1 格（竖·横·0·landscape）正是 clean 路径本应正确的 12 格之一。** 所以把它打错成 `landscape,rotate=90` 的，不是恒等映射，而是叠在上面的 **bake 注入 `sourceRotation=90`**（见 §4.1）。这恰好印证你的定性：「不是 margin 算法、不是 apply_pdf、是接线 bug」。

---

## 4. 仍存在的旧 rotation 注入点（逐一定位）

### 4.1 `electron/main.js:567-569`（bake 路径，C-2-G 横纸执行器补偿）—— **直接命中你 FAIL 的格**
```js
const execOrient = settings?.executionPaper?.orientation
printSettings = { ...printSettings, sourceRotation: execOrient === 'landscape' ? 90 : 0 }
```
- 机制：把 `sourceRotation`（语义上是 Truth 的 userRotation 输入）**直接改写成 90**，注入到 emitter。
- 因为你 FAIL 的观察是 `landscape,rotate=90,noscale`，而 `noscale` 来自 bake 同段 `scalePolicy:'none'`（L549），`landscape` 来自 `src.landscape===true`，`rotate=90` 正是这里硬写 → **签名完全吻合**。
- 性质：用「执行纸是 landscape」推导 `rotate=90`，正是你点名禁止的隐式规则（32-case 已证明 paperOrientation≠rotate）。

### 4.2 `electron/print-backend.js:128-132`（CommandBuilder 覆盖 paperOrientation）
```js
if (contentOrient) {
  normalizedSettings.paperOrientation = getPaperShapeOrientation(normalizedSettings.paper, normalizedSettings.customPaper)
}
```
- 机制：用纸张自然方向（A4→portrait）**覆盖用户请求的 `paperOrientation`**，丢弃 landscape 请求。
- 后果：所有 landscape-请求格前缀被改写成 portrait → 与 Truth 前缀冲突（§3 统计已量化）。

### 4.3 `electron/print-settings.js:183 + 292-294`（emitter 恒等映射）
```js
const contentRotation = src.sourceRotation ?? src.rotation ?? 0   // L183
if (orientResult.contentRotation !== 0) parts.push(`rotate=${...}`) // L292-294
```
- 机制：`commandRotate := sourceRotation`（恒等）。
- 后果：20/32 格结构性错误（§3）。这是**架构级缺口**——emitter 根本没有 `paperType`、`invoiceOrientation` 这两个 Truth 维度，不可能用公式复现 32-case。

### 4.4 死代码 `sumatra-command-resolver.js:ROTATE_MATRIX`（旧 16-case，仅 90/270）
- grep 全仓仅自引用，无任何生产 `require`/`import` 消费。
- 它也不是 Truth（只有 90/270 两值，且是另一套语义），但残留会误导后续维护者。建议并入/删除。

> 三个注入点 + 一个架构缺口，共同构成「G2 wiring FAIL」。**4.1 是 you FAIL 格的直接因；4.3 是 20 格永远错的因；4.2 让前缀也错。**

---

## 5. 变量归属分类（Geometry / Truth / Executor）

| 变量 | 当前所在 | 语义身份 | 应归属层 |
| -- | -- | -- | -- |
| `paperType`（natural orient，A4→portrait / PostScript→landscape） | 纸张定义 | Truth 输入维度 | **Truth** |
| `invoiceOrientation`（`contentOrientation`，发票自然方向） | PDF/前端 | Truth 输入维度 | **Truth** |
| `userRotation`（用户旋转意图 0/90/180/270） | 前端 `fileRotations` → `sourceRotation` | Truth 输入维度 | **Truth** |
| `requestedPaperOrientation`（用户请求纸方向） | `paperOrientation` / `landscape` 标志 | Truth 输入维度 | **Truth** |
| `commandRotate`（Sumatra `rotate=N`） | `buildPrintSettings` 输出 | Executor 输出 | **Executor**（值来自 Truth 查表） |
| `baseFlag`（`landscape` / `disable-auto-rotation`） | `buildPrintSettings` 输出 | Executor 输出 | **Executor**（值来自 Truth 查表） |
| `contentRotation`（喂 `apply_pdf`） | `geometry-translator` → `pdfMargin` | Geometry 输出 | **Geometry** |
| `nativePaperW/H`（目标纸几何） | `geometry-translator` → `apply_pdf` | Geometry 输出 | **Geometry** |

**🔴 命名陷阱（根因之一）**：当前 `sourceRotation` 这个名字被同时当成了「Truth 输入（userRotation）」和「Executor 输出（commandRotate）」。两者在 20/32 格是**不同数值**。修复时 `sourceRotation` 只能作为 Truth 输入，绝不能原样透传给 `buildPrintSettings` 当 `commandRotate`。

---

## 6. 正确接线形态（仅描述，本次不实现）

```
Truth 输入 {paperType, invoiceOrientation, userRotation, requestedPaperOrientation}
        │
        │  单一 32 格查表（唯一 Rotation Authority，禁止任何公式重算）
        ▼
   { baseFlag, commandRotate, nativePaperW/H, contentRotation }
        ├─→ Geometry Translator → apply_pdf（nativePaperW/H + contentRotation, /Rotate=0）
        └─→ Execution Command Resolver → Sumatra（baseFlag + commandRotate + noscale）
```
- 两路**只共享 Truth 输入**，互不拿对方中间变量推导。
- `apply_pdf` 路径：Sumatra 只发 `noscale` + 正确物理纸，`commandRotate` 来自 Truth 查表（本例 #1 → `rotate=0`），**绝不从 `sourceRotation` 恒等透传**。
- 旧纯 source 直打路径：保留 32-case Truth 作唯一权威（同查表）。
- 删/并入死代码 `ROTATE_MATRIX`；`buildSumatraCommand` 不得覆盖 `paperOrientation`。

---

## 7. 纪律守约
- ✅ 本次只读对照，未改任何代码、未 commit。
- ✅ 边界未破：`margin_contract.py` / `add-pdf-margins.py` / bake / 16 表 / `RotationResolver` / `normalize` / 上一版 `geometry-translator` 均未动。
- ✅ 未复用 `normalize()` 当 Truth 查表（其 swap 准则 `requestedOrient!==naturalOrient` 与 32-case 不同，会 reintroduce drift）。
- 🔴 当前状态裁定：**G2 wiring FAIL**。`landscape,rotate=90,noscale` 是该 FAIL 的直接证据；根因 = §4.1 bake 注入 + §4.3 恒等 emitter（缺 Truth 查表）。
