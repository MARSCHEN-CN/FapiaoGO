# C-2-G / G2-R2 生产链接线审计（Production-Chain Wiring Audit）

> 审计对象：真实生产链 `Truth → Translator → main.js → pdfMargin.process → apply_pdf → 最终 PDF → Sumatra noscale`
> 审计性质：**只读**；未改动 `margin_contract.py` / `add-pdf-margins.py` / `placement_bake.py` / 任何 electron 生产代码。
> 关联文档：`c2g-r2-fit-margin-resolution.md`（§9 语义冻结 / §10 几何收敛 / §10.6 黄金向量 ALL PASS）。

---

## 0. 边界重审（不可逾越）

| 已证明 | 未证明 |
|---|---|
| `apply_pdf` 几何语义正确（黄金向量 Layer A + B ALL PASS） | 真实发票→真实打印机 物理一致（Gate 2/3 未做） |
| `margin_contract.py` 未被测试改动 | T5 `landscape+180°` 为物理 Truth（仍 candidate） |

**数学一致 ≠ 物理 Truth**（已被 270° 错配教育过一次）。本审计只回答「真实生产链是否把已验证的 Geometry Authority 正确消费」，不冻结任何 Truth。

---

## 1. 引擎身份确认（golden 测的是真引擎，不是影子实现）

| 生产路径 | 脚本 | 几何引擎 | 证据 |
|---|---|---|---|
| margin 路径 | `scripts/add-pdf-margins.py` | `margin_contract.apply_pdf` | L51 `from margin_contract import apply_pdf`；L79 调用 `apply_pdf(...)` |
| bake 路径 | `scripts/placement_bake.py` | `margin_contract.apply_pdf` | 历史 commit `e23107b`（E 方案 bake 已落地） |

- **结论**：唯一 Geometry Authority = `apply_pdf`，两条路径共用同一引擎。黄金向量 Layer A 直接 import 的正是此引擎 → 可信度成立（非「改完实现再让测试通过」）。
- `add-pdf-margins.py` 是纯兼容壳：自身**无几何实现**（L5-6 注释明确），全部转交 `apply_pdf`。它只额外提供 PDF/Image adapter（单页源 → `apply_pdf`）。

---

## 2. 真实生产链三条打印路径（分派点 `electron/main.js:528-607`）

| 路径 | 触发条件（main.js:530/569/605） | 几何执行 | Sumatra scalePolicy | 是否接 `apply_pdf` |
|---|---|---|---|---|
| **A 纯 source** | 无 Plan placement 且 无 margins | **无**（none） | `contain`（fit，print-settings.js:188 默认） | ❌ **完全绕过** |
| **M margin** | `hasMargins && imgExts` | `add-pdf-margins.py → apply_pdf` | `none`（noscale，main.js:600） | ⚠️ **部分**（缺目标纸尺寸 + 旋转） |
| **B bake** | `hasPlacement(Plan)` | `placement_bake.py → apply_pdf` | `none`（noscale，main.js:545） | ✅ **完整**（contentRotation + native paper 均传入） |

分派逻辑（main.js）：
```
bakeEnabled = placementBake.hasPlacement(settings, file)   // L530
if (bakeEnabled)            → placement bake + noscale      // L532-568
else if (hasMargins && img) → pdfMargin.process + noscale  // L569-604
else                        → 纯 source，Sumatra fit        // L605-607
```

---

## 3. 缺口定位（精确 file:line）

### G1a — 纯 source 路径绕过几何引擎
- **位置**：`main.js:605` `else` 分支 + `print-settings.js:188` `scalePolicy = src.scalePolicy ?? src.fit ?? 'contain'`。
- **现象**：单文件、无 margin、无 Plan → 直接 `backend.print(printTarget, printSettings)`，Sumatra 以 `fit`（contain）执行。
- **风险**：应用层几何（contain-fit + 3mm inner margin + `/Rotate=0` + 单一 CTM）**完全不参与**；缩放/边距解释权交给 Sumatra + 打印驱动 printable area。
- **与 Gate 2 的关系**：用户指定的非 T5 case「横向发票 × 竖纸类型 × 0° × landscape」若**不设 margins**，当前正走此路径 A（Sumatra fit）——正是要被 B 替代的「现有路径」。

### G1b — margin 路径未传目标纸尺寸（requested physical paper 被忽略）
- **位置**：`main.js:583` 调用 `pdfMargin.process(target.filePath, margins, isImage, orient)` —— **第 5 个参数 `opts` 未传**。
- **设计本支持**：`pdfMargin.process` 签名 L268 `process(inputPath, margins, isImage, orientation, opts, timeout)`；`opts.paperW_mm/paperH_mm` 在 L294-295 读取并推 `--paper-width-mm/--paper-height-mm`。
- **后果**：`add-pdf-margins.py` 收不到纸尺寸 → `_apply_to_pdf` L76 兜底 `_probe_media_box_pt(pdf_path)` = **源 MediaBox 即目标纸**。
- **风险**：请求的 physical paper 被静默丢弃。
- **Gate 2 巧合陷阱**：该 case 源 PDF 为 landscape(297×210)、execution paper 也为 landscape A4(297×210)，故「源=目标」**偶然正确**。一旦源纸 ≠ 目标纸（如 portrait 源打 landscape 纸），margin 路径会产出错误 MediaBox。这是脆弱巧合，**不是正确接线**。

### G1c — margin 路径无法传 content_rotation
- **位置**：`pdfMargin.process` 签名 L268 第 4 参 `orientation` 已废弃忽略（L256 注释、L337 不再传 --orientation）；**全签名无 `content_rotation` 槽位**。
- **后果**：无法把 Truth.rotate 注入引擎。
- **Gate 2 该 case** rotate=0 故不触发；但 32-case 通用化时结构性缺失——`apply_pdf` 的 `content_rotation` 接口（add-pdf-margins.py L191 `--content-rotation` CLI 已支持）在生产调用链被截断。

### G1d（新发现）— 无离散 Translator 层
- **事实**：§9.4 设计的 `PrintCommandTruthResolver` / Geometry Translator（`Truth{orientation,rotate} → {nativePaperW/H, contentRotation}`）在生产代码中**不存在**为可单测单元。
- **bake 路径（已正确接线）**：隐式 translator = `buildPrintExecutionPlan`（`frontend/src/print/buildPrintExecutionPlan.js`）——Plan 已含 `contentRotation` + `executionPaper` 原生尺寸；`placement-bake-processor.buildBakeSpec`（L135-152）直接读取喂给引擎。**R6 防护在此路径由 Plan 构建时一次性完成。**
- **source / margin 路径（无任何 translator）**：`Truth → {nativePaperW/H, contentRotation}` 的语义映射**完全缺失**。§9.4 公式无处落地 → 黄金向量 Layer B 证明「R6 双重交换必须被 Translator 拦截」在 source 路径无从执行。
- **风险**：这是比 G1a/b/c 更根本的架构洞——即使修好 G1b/c，若不在路由点插入 Translator，Truth.orientation 仍可能二次改变 paper dims（正是 R6 要防的）。

---

## 4. 与「16 表 / sumatra-command-resolver」的关系（防混淆）

- `sumatra-command-resolver.js` 的 `ROTATE_MATRIX[contentOrientation][paperOrientation][contentRotation]`（L30/L54）是 **Sumatra 命令 `rotate=N`** 查表（直打模型语义），**不是**几何 Translator。
- 记忆纪律：16 表 **仅适用直打模型**；bake 路径 270 全倒置（main.js:553-554 已注明）。
- 当前 source 路径 A 的 `rotate=N` 来自 `print-settings.js:buildPrintSettings`（L292-293，`contentRotation → rotate=` 透传），与几何 Translator 是两回事，不得混用。

---

## 5. Gate 2 最小接线方案（提议，**未实施**，待用户批准）

目标：把「横向发票 × 竖纸类型 × 0° × landscape」这一个非 T5 case 从路径 A 改走路径 B（`apply_pdf` + `noscale`），**单变量**验证真实链。

> 仅接线，不动几何引擎（`margin_contract.py` / `add-pdf-margins.py` 保持冻结）。

1. **路由**：让该单文件 case 进入几何路径（设 3mm margins 走 M，或新增明确 route 跳过纯 source A）。
2. **G1b 修复**：`main.js:583` 补传 `opts: { paperW_mm, paperH_mm }`，值取自已存在的 `pdfMargin.resolvePaperMmFromSettings(settings)`（L207，当前 main.js 未调用）。
3. **G1c 修复**：`pdfMargin.process` 增加 `contentRotation` 参数并透传至 `add-pdf-margins.py --content-rotation`（CLI 已支持 L191）。
4. **G1d 修复（Translator 落地，最小）**：在路由点用 §9.4 公式
   ```
   r = rotate % 180
   nativeOri = (r == 90) ? swapped(orientation) : orientation
   nativePaper = (nativeOri == 'landscape') ? (max,min) : (min,max)  // mm
   contentRotation = rotate
   ```
   算出 `{nativePaperW/H, contentRotation}` 喂给 #2/#3。
5. **Sumatra noscale**：margin 路径已 `scalePolicy:'none'`（main.js:600），维持。

**单变量纪律**：Gate 2 只验证这一个 case；不得顺带改 16 表 / RotationResolver / margin contract / canvas / bake / usePrint / PrintService。

---

## 6. 审计结论

- ✅ 几何引擎 `apply_pdf` 已验证、已共享、未动；golden 向量可信。
- 🔴 真实风险在**接线**，不在算法：
  - G1a：纯 source 完全绕过几何（路径 A = Gate 2 现有路径）。
  - G1b：margin 路径丢目标纸（靠源=目标巧合正确）。
  - G1c：margin 路径无法传旋转。
  - G1d：无离散 Translator，R6 防护在 source 路径无从落地。
- 📌 当前状态：Gate 2 该 case 走 A（Sumatra fit）；若设 margin 走 M 但**靠巧合正确**，非正确接线。
- ⏭️ 下一步：用户批准 §5 接线方案后，按单变量纪律实施 #1–#5，再做真机 A/B 复核（方向 / 裁切 / 四边距 / 内容尺寸）。T5 `180°` 仍待 Gate 3 物理复核升 frozen。
