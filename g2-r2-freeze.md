# G2-R2 冻结记录（Execution Truth 层）

> **状态：FROZEN — 实机 Gate PASS**
> 冻结时间：2026-08-13 · 实施 commit `a5adb39` · 冻结 tag `g2-r2-machine-pass`（指向本文件所在的冻结 commit）· 分支 `rotation-b1-hardening`
> 本文件是 G2-R2 的**唯一权威冻结源**。`.workbuddy/memory/MEMORY.md` 只存索引，冲突时以本文件为准。

---

## 1. 冻结裁决（已被证明的结论）

G2 的失败根因是 **Execution 层 rotation wiring**，**不是** Geometry / margin contract / 打印机物理边界。

关键证据（不是「`fit` 偶然遮住了裁切」）：

| 阶段 | 命令 | 结果 |
|---|---|---|
| 修复前 | `landscape,rotate=90,noscale` | 内容 90° 错向 + 裁切 |
| 修复后 | `landscape,fit`（即 `rotate=0`，Sumatra 省略 `rotate=0`） | **实机 PASS** |

- `apply_pdf` 几何算法**全程未改**，裁切随 `commandRotate` 归零而消失 → 裁切是**双重旋转**的后果，不是几何缺陷。
- 双重旋转成因：`apply_pdf` 已把旋转烤进 PDF 且 `/Rotate=0`，而 Sumatra executor 又从旧 `sourceRotation` 独立再转一次。

**因果链归属确认（关键排除法）**：修复前观测到的 `rotate=90` 只可能由发射器 #1（`buildPrintSettings`）产生——发射器 #2（`OsLauncherBridge.toSumatraArgs`）硬编码 `contentRotation: 0`，在结构上**永远不可能**发射任何 `rotate=N`。故实机 FAIL→PASS 的因果确实落在 G2-R2 改动的发射器 #1 上，PASS 不可能是走了另一条路而产生的假阳性。

---

## 2. 冻结的 Truth（32 格，唯一 Rotation Authority）

来源：**用户物理真机实测**。优先级高于任何抽象 Translator 公式、`ROTATE_MATRIX` 16 表、或 `sourceRotation → rotate` 推导。
代码位置：`electron/print-service/execution-truth-resolver.js` → `TRUTH_ROWS`（32 行）。

**输出不变量：`paperOrientation`（命令纸向）恒等于 `requestedPaperOrientation`（32 格全部验证）。** 下表只列 `rotate`。

### 2.1 竖向纸张类型（`paperType='portrait'`，如 A4）

| 发票方向 | 用户旋转 | 请求纸向 | rotate |
|---|---|---|---|
| 横向 | 0 | landscape | **0** ← 实机 PASS 格 |
| 横向 | 0 | portrait | 0 |
| 横向 | 90 | landscape | 0 |
| 横向 | 90 | portrait | 180 |
| 横向 | 180 | landscape | 180 |
| 横向 | 180 | portrait | 180 |
| 横向 | 270 | landscape | 180 |
| 横向 | 270 | portrait | 0 |
| 竖向 | 0 | landscape | 180 |
| 竖向 | 0 | portrait | 0 |
| 竖向 | 90 | landscape | 0 |
| 竖向 | 90 | portrait | 0 |
| 竖向 | 180 | landscape | 0 |
| 竖向 | 180 | portrait | 180 |
| 竖向 | 270 | landscape | 180 |
| 竖向 | 270 | portrait | 180 |

### 2.2 横向纸张类型（`paperType='landscape'`，如 240×140 凭证纸）

| 发票方向 | 用户旋转 | 请求纸向 | rotate |
|---|---|---|---|
| 横向 | 0 | landscape | 90 |
| 横向 | 0 | portrait | 90 |
| 横向 | 90 | landscape | 90 |
| 横向 | 90 | portrait | 270 |
| 横向 | 180 | landscape | 270 |
| 横向 | 180 | portrait | 270 |
| 横向 | 270 | landscape | 270 |
| 横向 | 270 | portrait | 90 |
| 竖向 | 0 | landscape | 270 |
| 竖向 | 0 | portrait | 90 |
| 竖向 | 90 | landscape | 90 |
| 竖向 | 90 | portrait | 90 |
| 竖向 | 180 | landscape | 90 |
| 竖向 | 180 | portrait | 270 |
| 竖向 | 270 | landscape | 270 |
| 竖向 | 270 | portrait | 270 |

### 2.3 跨矩阵交叉校验规则（冻结）

**横向纸 rotate = 同格竖向纸 rotate + 90°（mod 360）**，逐格成立（32/32 单测含该断言）。
该规则是**一致性校验工具**，**不是**推导来源——新增/修订格子必须先有物理实测，禁止用 +90 反向生成 Truth。

---

## 3. 冻结的架构（单向、单一权威）

```text
4 个真值输入
  paperType                  = getPaperShapeOrientation(paper)   物理纸张形状
  invoiceOrientation         = contentOrientation                发票固有方向
  userRotation               = sourceRotation                    用户 UI 旋转
  requestedPaperOrientation  = paperOrientation                  用户请求纸向
        │
        ▼  resolveExecutionTruth()   ← 32 格查表，O(1)，纯函数，零依赖
  { paperOrientation, rotate }
        │
        ├──►  Executor  : buildPrintSettings → Sumatra -print-settings
        └──►  Geometry  : translateGeometry → apply_pdf（独立语义层）

中间不存在第二个 rotation resolver。
```

### 3.1 接线点（生产路径，逐一冻结）

| 位置 | 职责 |
|---|---|
| `main.js:506 gatherTruthInputs(settings, {baked})` | 收集 4 真值输入。`baked=true`（placement-bake 路径）语义：内容已烤入最终方向 → `userRotation=0` + `invoiceOrientation=请求方向`。 |
| `main.js:518 injectExecutionTruth(target, settings, opts)` | 查表并注入 `commandOrientation`/`commandRotate`。best-effort（失败仅 warn，不中断打印）。 |
| `main.js:592` | bake 路径注入。 |
| `main.js:665-666` | margin / 纯 source 路径注入（带 `if (!printSettings.commandOrientation)` guard，避免对 bake 重复解析）。 |
| `print-settings.js:287-310` | 消费注入值；未注入时**用同一个 resolver** 兜底解析（兜底也不破坏单一权威）。 |
| `print-settings.js:312-314` | 发射 `landscape`/`disable-auto-rotation` + 仅当 `commandRotate !== 0` 才发 `rotate=N`。 |

### 3.2 语义层边界（禁止跨层消费中间变量）

| 层 | 权威 | 输出 |
|---|---|---|
| Execution Command | 32-case Truth | `commandOrientation`, `commandRotate` |
| Geometry | `geometry-translator` + `apply_pdf` | `nativePaperW/H_mm`, `contentRotation` |
| Margin Contract | `margin_contract.py` | `fit` / `noscale`、3mm inset |

两层**只共享 4 个真值输入**，绝不消费对方的中间变量。`fit` vs `noscale` 属 Margin Contract 独立决策，**不因 G2-R2 而改动**。

---

## 4. 冻结的不变量（回归红线）

- **INV-E1**：`commandOrientation === requestedPaperOrientation`，恒成立。
- **INV-E2**：`commandRotate` 只能来自 32 格查表。禁止 `+90` / swap / `normalize()` / natural-orientation 推导。
- **INV-E3**：`sourceRotation` / `userRotation` **只作真值输入**，永不作命令输出。
- **INV-E4**：`paperOrientation`（用户请求）永不被纸张固有方向覆盖。
- **INV-E5**：`rotate=0` 不进命令串（Sumatra 语义），`landscape,fit` 即 `landscape + rotate=0`。
- **INV-E6**：Truth 表只能由**物理实测**修改；跨矩阵 +90 规则只作校验、不作生成。
- **INV-E7**：bake 路径 `userRotation` 恒 0（业务旋转已烤入内容），executor 不得再叠加业务旋转。

---

## 5. 已被永久移除的旧规则（禁止复活）

| 编号 | 旧逻辑 | 位置（原） | 性质 |
|---|---|---|---|
| G2-R2-3 | `sourceRotation = execOrient === 'landscape' ? 90 : 0` | `main.js` bake 路径 | 旧规则污染，本次 FAIL 的直接成因 |
| G2-R2-4 | `commandRotate := sourceRotation`（恒等映射） | `print-settings.js` | 32 格中 20 格结构性错误 |
| G2-R2-5 | `paperOrientation = getPaperShapeOrientation(paper)` | `print-backend.js` | 丢弃用户 landscape 请求 |

**C-2-G 兼容性**：横向纸的 `+90` executor 补偿并未丢失——它由 Truth 表「横向纸」矩阵对应格自然给出（如 横向纸+横向发票+0°+landscape → 90），且比旧 blanket-90 更精细。横向凭证纸行为等价保留。

---

## 6. 验证记录

| 门 | 内容 | 结果 |
|---|---|---|
| G2-R2-1 | 32/32 Truth 单测（`execution-truth-resolver.test.js`） | ✅ PASS |
| G2-R2-2 | FAIL 格：竖向纸+横向发票+0°+landscape → `{landscape, 0}`；命令串 `landscape,fit,paper=a4` | ✅ PASS |
| G2-R2-3 | 代码内无 `landscape ? 90 : 0` 字面量（含注释） | ✅ grep 清零 |
| G2-R2-4 | 无 `commandRotate = sourceRotation` 恒等映射 | ✅ grep 清零 |
| G2-R2-5 | `paperOrientation` 不被 natural orientation 覆盖 | ✅ grep 清零 |
| 自动化 | `execution-truth-resolver.test.js`(7) + `print-settings.g2r2.test.js`(4) + `geometry-translator.test.js`(6) | ✅ **17/17** |
| **实机 Gate** | 横向发票 + 竖向纸张 + landscape 纸向 + 0° | ✅ **PASS** |

**验证覆盖度的诚实边界**：32 格的**权威性**来自用户物理实测；**接线正确性**由 32/32 单测保证（发射器忠实复现 Truth 表）；**端到端实机**当前验证了 1 格（原 FAIL 格）。其余 31 格 = 实测 Truth + 单测接线双重保障，建议后续抽样实机点验，但不构成本次冻结的阻塞项。

**已撤回的旧记录**：先前 MEMORY 中 `T5 candidate = landscape,rotate=180` 系误查（读到了「竖向发票」行）。T5 场景实为「**横向**发票 + 竖向纸 + 0° + landscape」→ Truth `rotate=0`，已实机 PASS。**该 candidate 作废，不得据以回改 Truth。**

---

## 7. 本次未改动（保持冻结）

`scripts/margin_contract.py`（`apply_pdf`）· `add-pdf-margins.py` · `placement_bake.py` · `geometry-translator.js` 核心公式 · `sumatra-command-resolver.js` 16 表 · `RotationResolver.js` · `normalize()`（`print-settings.js`）· Margin Contract v1.0 的 `fit`/`noscale` 决策。

---

## 8. 残留项（**已记录，本轮不动**，各自需独立 Gate）

### R-1 🟡 存在第二个 Sumatra 命令发射器，未接 32-case Truth

- **发射器 #1**：`print-settings.buildPrintSettings` — ✅ 已接 Truth。生产活路径：`services/PrintService.js:147` → IPC `print-source-file` → `print-backend`。
- **发射器 #2**：`OsLauncherBridge.toSumatraArgs`（`OsLauncherBridge.js:302-361`）— ❌ **未接 Truth**，硬编码 `resolveOrientationCommands({ paperOrientation: spec.orientation, contentRotation: 0 })`，结构上只能发 `landscape`/`disable-auto-rotation`，**永远不发 `rotate=N`**。
- 可达入口：IPC `submit-print-job`（`usePrintIntent` → `App.jsx:234`）、IPC `print-file-direct`（`usePrint.js:1111` → `DirectPrintHandler` → `printService.submitDirect`）。
- **当前休眠**：`executePrint` 在 `PRINT_PIPELINE.mode === 'source'` 时于 `usePrint.js:1079` 提前 return，`print-file-direct` 分支只在 `mode === 'legacy'` 可达。
- **风险**：任何人把 `config.js` 切回 `mode='legacy'`、或启用 intent 管线，旋转就会**静默退化为「永不旋转」**（不报错、不告警）。
- **建议（不在本轮）**：切轨前必须先让发射器 #2 消费同一个 resolver，或直接下线该发射器。

### R-2 💭 非 90° 倍数旋转会使打印链路抛错而非降级

`injectExecutionTruth` 的 `catch` 只 warn 并落到 `buildPrintSettings` 兜底，而兜底调用的是**同一个会 throw 的 resolver**（`_normRot` 对 45° 返回 `null` → throw）。即：若上游出现非 90° 倍数旋转，主进程 warn 后仍会在 `buildPrintSettings` 内**未捕获抛出**。当前 UI 只产生 0/90/180/270，风险为潜在项。

### R-3 💭 死代码待清理（不影响正确性）

- `sumatra-command-resolver.js` 的 `ROTATE_MATRIX` / `resolveSumatraRotation` 已无生产调用方（仅自身 + 导出）。
- `print-settings.resolveOrientationCommands` 已不再被 `buildPrintSettings` 调用，但仍被 `OsLauncherBridge.js:335` 使用（见 R-1）——**清理 R-3 必须先解决 R-1**，否则会破坏发射器 #2。

---

## 9. 解冻程序

1. 先声明要解冻**哪一层**（Execution / Geometry / Margin），禁止跨层顺带修改。
2. 若涉及 Truth 表：必须先有**新的物理实测**，再改表，再跑 32/32 单测 + 跨矩阵 +90 校验。
3. 禁止以 bugfix 名义顺带改 Truth 表或 Margin Contract（沿用 Margin Contract §11 纪律）。
4. 任何改动后重跑：
   ```
   node --test electron/print-service/execution-truth-resolver.test.js electron/print-service/print-settings.g2r2.test.js electron/print-service/geometry-translator.test.js
   ```
5. Gate 纪律：**物理实测 → Truth → 矩阵一致性 → 冻结**。禁止反向推导。

---

## 10. 相关文档

`g2-wiring-trace-landscape-rotate90.md`（根因追踪）· `g2-32case-truth-vs-emitter.md`（逐格对照，12/32 clean 统计）· `docs/print_margin_contract.md`（Margin Contract v1.0）· `c2g-r2-wiring-audit.md` §7（终态裁决）
