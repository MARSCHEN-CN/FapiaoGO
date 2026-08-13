# C-2-G / G2-R2 — Implementation-Readiness Audit（G1a/b/c/d Change Set）

> 阶段：G2-R2 冻结态之后的「接线准备」只读审计。
> 目的：**不重写架构**，只把真正要改的生产代码收缩成一个明确、单变量、可 Review 的 change set。
> 纪律：Gate 2 = 把一个已选定的非 T5 真实 case 从现有路径切到 `apply_pdf + noscale`，证明生产链接线正确。
> 发现「可顺便重构」→ 默认不做，记入 Deferred Ledger。

---

## 0. 已冻结前提（不再讨论）

| 项 | 状态 |
|---|---|
| Geometry Contract | ✅ FROZEN |
| `margin_contract.apply_pdf` | ✅ FROZEN（不改） |
| Golden Vectors | ✅ PASS（Layer A 80 + Layer B 9，对未改引擎实跑） |
| Wiring Audit | ✅ COMPLETE（`c2g-r2-wiring-audit.md`） |
| 「更好的 margin 算法」 | ❌ 正式关闭（负责人裁决） |

---

## 1. Truth → 现有 Print Command 溯源（每个锚点都已核实）

`PrintService.buildPrintSettings`（`frontend/src/services/PrintService.js:58`）产出的 `ps` 对象直接 IPC 给 `main.js` 的 `print-source-file`（`electron/main.js:493`）。Truth 两轴**已在 `ps` 中，无需新增字段**：

| Truth 轴 | 生产字段 | 来源 | 行 |
|---|---|---|---|
| `orientation` | `ps.paperOrientation` | `requestedPaperOrientation(userSettings)` | PrintService.js:79 |
| `rotate` | `ps.sourceRotation` | `fileRotations?.[file.key] \|\| 0`（Print 域 = 用户 UI 旋转意图 = content rotation） | PrintService.js:59,69 |

> ⚠️ 命名域碰撞（已知）：`sourceRotation` 在 Viewer 域 = PDF 固有 `/Rotate`，在 Print 域 = 用户 UI 旋转。此处取 **Print 域语义**（PrintService.js:65 注释明确），即 contentRotation。Gate 2 case（rotate=0）该值恒 0，无歧义。

**结论**：Truth 无需改动即可从 `ps` 取得，G1a/b/c/d 全部消费已有字段。

---

## 2. 生产链接线当前分派（main.js:527-607）

```
hasMargins       = pdfMargin.hasMargins(settings)                          L527
bakeEnabled      = placementBake.hasPlacement(settings, filePath)         L530
if (bakeEnabled)            → placement bake（apply_pdf + noscale）        L532  [冻结，不动]
else if (hasMargins && imgExts.includes(ext))
                           → pdfMargin.process(...)  (apply_pdf 路径)      L569  ← Gate 2 落点
else                       → 纯 source，直接 Sumatra fit                   L605  ← G1a 目标（本次不触发）
backend.print(printTarget, printSettings)                                  L611
```

**关键事实**：默认 `marginLeft/Right/Top/Bottom = 3`（`PrintService.js:84-87`），故 `hasMargins` 默认 `true`。
→ **Gate 2 选定 case（横向发票 × 竖向纸型 × 0° × landscape）默认即落入 margin 路径（L569），已走 `apply_pdf`**。
→ `main.js:605` 的纯 source `else`（真·Sumatra fit 路径）**不被该 case 触发**。

---

## 3. 七个溯源问题的精确答案

### ① Translator 应放在哪里？ → **新建** `electron/print-service/geometry-translator.js`（G1d）
纯函数，不依赖 electron 运行时，可独立单测：
```js
// {orientation, rotate, baseDims:{width,height}} → {nativePaperW_mm, nativePaperH_mm, contentRotation}
function translateToGeometry({ orientation, rotate, baseDims }) { ... }  // 实现 §9.4
```
**⚠️ 严禁复用 `print-settings.js:normalize()` 充当 Translator**（见 §4 致命发现）。

### ② paperW/H 从哪里取得？ → `resolvePaperMmFromSettings(settings)`（已存在，pdf-margin-processor.js:207）
返回 `{width, height}`（mm），优先级 customPaper → PaperRegistry → A 系列。A4 → `{210, 297}`（竖向内禀）。
→ 作为 Translator 的 `baseDims` 入参；Translator 按 §9.4 换出 native paper。

### ③ contentRotation 从哪里取得？ → `settings.sourceRotation`（PrintService.js:69）
Gate 2 case = 0。

### ④ `pdfMargin.process` 参数怎么扩展？ → 见 §5 G1b/G1c
`process(inputPath, margins, isImage, orientation, opts)`（pdf-margin-processor.js:268）：
- `opts.paperW_mm/H_mm` 已读取（L294-295）并转发 `--paper-width-mm/--paper-height-mm`（L331-334）；
- `--content-rotation` CLI 已支持（add-pdf-margins.py:191,214-215）→ `apply_pdf(content_rotation=...)`（L79-80）；
- **缺失的只是 JS 胶水**：调用方没传 `opts`，且 `process` 无 `contentRotation` 槽位。

### ⑤ main.js 路由如何让 Gate 2 case 进 Geometry Authority？ → 改 L583 调用（G1b+G1c），无需改路由分支
Gate 2 case 已进 margin 路径；只需把 L583 调用补全 `opts`（paper + rotation）即可走 `apply_pdf` + 显式纸 + 显式旋转。
`noscale` 已在 L600（`printSettings={...settings, scalePolicy:'none'}`）就位，无需改。

### ⑥ Sumatra noscale → 已就位
`scalePolicy:'none'`（main.js:600）→ `print-settings.js:301-302` → `noscale`。margin 路径已强制 noscale。
（纯 source `else` 的 noscale 属 G1a，本次不触发。）

### ⑦ 几何权威唯一性 → 已成立
`apply_pdf` 是 margin 路径与 bake 路径共用的唯一几何引擎（add-pdf-margins.py:51 `from margin_contract import apply_pdf`）。

---

## 4. 🔴 致命发现：不可复用 `normalize()` 充当 Translator

`electron/print-service/print-settings.js` 的 `normalize()`（L172-231）看似已是「orientation+rotation → 纸几何」的转换，但其 swap 准则与 §9.4 **不同**：

| | swap 触发条件 | 公式位置 |
|---|---|---|
| `normalize()` | `requestedOrient !== naturalOrient`（请求纸向 ≠ 纸型内禀方向） | L199-213 |
| §9.4 Translator | `rotate % 180 === 90`（Truth 旋转） | `c2g-r2-fit-margin-resolution.md §9.4` |

对 `landscape + rotate=90` 两公式**产出不同 native paper**：
- `normalize`：requestedOrient=landscape、A4 natural=portrait → needSwap=true → native={297,210}(landscape)；contentRotation=90 → `policy_a(297×210, 90)` **再 swap → portrait** ❌ 双重交换。
- §9.4：rotate%180=90 → nativeOri=swapped(landscape)=portrait={210,297}；contentRotation=90 → `policy_a(210×297, 90)` swap → landscape ✅（与黄金 B 向量一致）。

`normalize` 是给 **Sumatra 命令字符串**用的（纸向走 `landscape` flag，由 Sumatra 自己处理方向），不是给 `apply_pdf` 的 `policy_a` 喂 native paper 用的。两者消费方语义不同。**复用 = 重新引入 R6 双重交换。**

→ G1d 必须是**全新独立函数**，且 Gate 2 几何路径必须消费 G1d 输出，**绝不**消费 `normalize().paper`。

---

## 5. 最终 Change Set（Gate 2 实施用）

| Change | 文件 | 修改 | 风险 | 说明 |
|---|---|---|---|---|
| **G1b** | `electron/main.js:583` | `pdfMargin.process(...)` 补第 5 参 `opts`：`{paperW_mm, paperH_mm}` = Translator 换出的 native paper | 中 | 单变量补参；`resolvePaperMmFromSettings`(L207) 已存在 |
| **G1c** | `electron/print-service/pdf-margin-processor.js:268` + `main.js:583` | `process` 签名加 `contentRotation`（入 `opts`）；内部 `optsObj.contentRotation` → 推送 `--content-rotation`（CLI 已支持 L191） | 中 | 仅胶水；`settings.sourceRotation` 为源 |
| **G1d** | **新建** `electron/print-service/geometry-translator.js` + `geometry-translator.test.js` | §9.4 纯函数 `{orientation,rotate,baseDims}→{nativePaperW_mm,nativePaperH_mm,contentRotation}`；单测对齐黄金 B 向量（8 组合 + 负向） | 最高 | 新语义边界；**禁复用 `normalize()`** |
| Geometry | `scripts/margin_contract.py` | 不改 | — | 冻结 |
| Bake | `placement-bake-processor.js` 路径 | 不改 | — | 冻结（C-2-G e23107b/c39ae14） |
| 16 表 | `sumatra-command-resolver.js` | 不改 | — | 冻结 |
| noscale | `main.js:600` + `print-settings.js:301` | 不改 | — | margin 路径已就位 |
| baseDims | `pdf-margin-processor.js:207 resolvePaperMmFromSettings` | 复用，不改 | — | 已存在 |

### G1a 处理决定（重要）
`main.js:605` 纯 source `else`（真·Sumatra fit 路径）**不在 Gate 2 单变量范围内**：
- Gate 2 选定 case 默认 3mm 边距 → 已落 margin 路径（L569），不触发 `else`；
- 把 `else` 也路由进几何 = 全量 pure-source 重构（高风、跨多 case），违反「单变量 / 不顺便重构」。
→ **G1a 记入 Deferred Ledger（D1），本次不做**。若未来纳入，用显式开关 `settings.geometryAuthority` 避免全量改路由。

---

## 6. Gate 2 A/B 实验设计（接线后执行，非本审计范围）

- **Case**：横向发票 × 竖向纸型(A4) × rotate=0 × paperOrientation=landscape。
- **A（现状，不改）**：当前 margin 路径 → `apply_pdf` 但 paper 靠源 MediaBox 兜底 + rotation=0（巧合正确）。
- **B（目标）**：margin 路径 → `apply_pdf` + 显式 native paper（Translator）+ 显式 contentRotation + noscale。
- **比对 4 项**：① 方向 ② 是否裁切 ③ 实际四边距（应 ≈3mm）④ 最终内容尺寸。
- **预期**：A≈B（证明巧合正确且变为确定性）；任一偏差即暴露 G1b/G1c 真实影响。

---

## 7. Deferred Ledger（「可顺便重构」→ 不做，记账）

| ID | 项目 | 为何延后 |
|---|---|---|
| D1 | G1a 全量 pure-source 路由进几何 | 高风、跨多 case；Gate 2 不触发；需 `geometryAuthority` 开关隔离 |
| D2 | `margin_mm=3 → expandMarginSymmetric → LTRB` 对称展开 | API 简化，非 Gate 2 必需；引擎已收 `margin_lrtb` |
| D3 | Translator 也接入 bake 路径（消除隐式重复） | bake 冻结（e23107b/c39ae14）；非 Gate 2 |
| D4 | 统一 `sourceRotation`/contentRotation 命名域（Viewer vs Print 反义） | 跨切面；Gate 2 case rotate=0 无歧义 |

---

## 8. 验收门槛（实施时）
1. `geometry-translator.test.js` 对齐 `docs/c2g-r2-golden-vectors.json` Layer B（8 组合 + 负向）全部 PASS。
2. `margin_contract.py` / `add-pdf-margins.py` / bake / 16 表 **git diff 为空**。
3. Gate 2 A/B 四比对项一致。
4. T5 `rotate=180` 仍 candidate，不在此冻结（Gate 3 物理复核）。

---
*本审计只读，未改任何生产代码。下一步由负责人批准 Gate 2 实施（G1b+G1c+G1d 三项），或先补 D1 开关设计。*
