# PostScript 横向纸张打印失败 — 最小复现调查

> 日期：2026-08-11 ｜ 状态：🔴 生产 bug 已复现（未修复）｜ 关联 Gate：`sumatraLandscapeGate.mjs`（验收基线，当前 EXPECTED FAIL）
> 边界：只读调查 + 测试层 Gate；**未碰 geometry 链 / 4-2b-2 noscale 策略 / 生产代码**。

## 1. 背景

真实打印验证发现：**竖向纸张类型通过，横向纸张类型失败**。测试通道：Wondershare PDFelement 打印机 + PostScript 纸张（240×140mm 原生横向纸）。

⚠️ 上下文：工作区存在另一会话的未提交补丁（凭证纸 `Voucher240x140` → `PostScript` 改名，含 registry/paperSpec/print-settings/命令层）。本调查在该上下文下的**当前代码状态**执行（命令生成值已只读验证）。

## 2. 只读检查：横向 command 生成值（含补丁）

| 场景 | 生成命令 | normalize 物理纸 |
|---|---|---|
| PostScript + landscape 请求 | `landscape,noscale,paper=postscript` | 240×140mm（landscape） |
| PostScript + 未传方向（自然横） | `landscape,noscale,paper=postscript` | 240×140mm（landscape） |
| PostScript + portrait 请求 | `disable-auto-rotation,noscale,paper=postscript` | 140×240mm（needSwap） |

**command 生成层无异常**（landscape 旗标 + paper=postscript 与纸型匹配）。

## 3. 最小复现（`.out/ps-landscape-probe.mjs`，同一 baked PDF：240×140 /Rotate=0 横内容）

| Case | 命令 | artifact MediaBox | /Rotate | 视觉尺寸 | content bbox | 判定 |
|---|---|---|---|---|---|---|
| **A**（生产值） | `landscape,noscale,paper=postscript` | 680×397（240×140 横） | **90** | 239.9×140.1 横 | **36.3×58.9mm** | ❌ 内容旋转+裁切 |
| B | `disable-auto-rotation,noscale,paper=postscript` | **397×680（140×240 竖）** | 0 | 140.1×239.9 竖 | 111.8×167mm | ❌ 纸方向反 |
| C | `landscape,noscale,paper=240mm x 140mm` | **842×595（A4 横）** | 90 | 297.1×210 横 | 167×111.8mm | ❌ 尺寸命令未识别→回退 A4 |
| D | `disable-auto-rotation,noscale,paper=240mm x 140mm` | 397×680（竖） | 0 | 140.1×239.9 竖 | 111.8×167mm | ❌ 纸方向反 |

**Gate 固化（`sumatraLandscapeGate.mjs`）**：生产命令 → 断言「240×140 横 + /Rotate=0 + 内容面积 ≥90%」→ **FAIL**（/Rotate=90 + 内容面积 11%）。

## 4. 根因分析

**Sumatra 对「原生横向纸」的命令语义与 bake 产物冲突**：

1. **`landscape` 旗标伴生 `/Rotate=90`**（A3-V2 已确认：Sumatra 用 /Rotate 表达方向）：对 bake 产物（内容已横排、MediaBox 横、/Rotate=0），landscape = 内容**二次旋转**。
2. **`disable-auto-rotation` 强制竖纸**（B/D：即使输入 MediaBox 是 240×140 横，Sumatra 输出 140×240 竖 + /Rotate=0）：纸方向反。
3. **尺寸命令 `paper=240mm x 140mm` 未被驱动接受**（C：回退 A4 横 297×210）——Wondershare 驱动无 240×140 自定义纸或 Sumatra 未正确传递。
4. **纸名 `paper=postscript` 尺寸不匹配**：A 的布局空间 ≠ 240×140 → 内容被缩放/旋转/裁切（36×59mm = 面积 11%）。

**为什么 A3-02（A4 横打）PASS 而 PostScript 横打 FAIL**：Sumatra 认识 `a4`（210×297），`landscape` 后布局空间 297×210 == bake MediaBox → noscale 1:1 原样。PostScript 纸名/尺寸 Sumatra 与驱动都不认识 → 布局空间错乱。

**本质**：bake 产物需要「横纸 + 内容不转」的**原样输出**，但 Sumatra 的方向命令对原生横向纸无法表达该形态——landscape 必带内容旋转，disable-auto-rotation 必竖纸。

## 5. 修复方向候选（需裁决，均不碰 geometry 链 / noscale）

| 方向 | 做法 | 验证点 |
|---|---|---|
| **R1 paperkind** | 查 Wondershare 驱动中 PostScript 纸的 DMPAPER ID，命令改 `paperkind=<ID>,noscale`（绕过纸名解析） | artifact 240×140 + /Rotate=0 |
| **R2 rotate=0 覆盖** | 试 `landscape,noscale,paper=postscript,rotate=0`（rotate=0 显式可能覆盖 landscape 隐式 /Rotate=90） | 同上 |
| **R3 驱动纸方向核对** | 确认驱动里 PostScript 纸是 240×140 横还是 140×240 竖（B/D 输出竖 140×240 暗示驱动可能是竖纸）→ 若驱动竖纸，bake 应产 140×240 + 内容旋转烤进 | 与驱动真实纸方向对齐 |
| **R4 禁用 PostScript 纸的 landscape 旗标** | 原生横向纸 naturalOrient=landscape 时命令不带 landscape（但需解决 disable-auto-rotation 强制竖） | 需要 R3 结论 |

**初步倾向**：R3（驱动纸真实方向）先行——B/D 的 140×240 竖输出是强线索：**Wondershare 驱动里的 PostScript 纸可能是竖 140×240**，而非 registry 假设的 240×140。若属实，bake 侧（Plan truth）的 PostScript 纸定义需对齐驱动（但那是 geometry 链——需单独裁决，本调查不展开）。

## 6. 下一步建议

1. 确认驱动中 PostScript 纸的真实尺寸/方向（打印首选项 → 纸张列表，或 Windows 注册表驱动 DEVMODE）
2. 按 R1/R2 快速验证命令形态（纯测试层）
3. 结论后单独裁决修复（命令层 or 纸型定义）

**冻结不变**：C-2 geometry 链不动；4-2b-2 noscale 不回滚（问题在方向命令/纸型定义，不在 noscale）。

---

## 7. R1/R2/R3 实验结论（2026-08-11 追加）

### R1 `paperkind` — ❌ 失败
| 命令 | artifact | 判定 |
|---|---|---|
| `noscale,paperkind=256` | A4 竖 210×297（/Rotate=0） | ❌ 256(DMPAPER_USER) 不是 PostScript 纸 |
| `noscale,paperkind=256,paper=postscript` | 140×240 竖 + 内容 36×31.8mm | ❌ 内容极小 |

### R2 `rotate=0` — ❌ 失败（用户预判证实）
`landscape,noscale,paper=postscript,rotate=0` → **与 A 完全相同**（/Rotate=90 + 内容 36.3×58.9mm）。
**Sumatra 的 landscape 在命令解析阶段已定 orientation，rotate=0 无法覆盖隐式 /Rotate=90。**

### R3 竖 bake 验证 — ❌ 失败
竖 bake（140×240 + layoutRotation=-90 烤进）→ `disable-auto-rotation,noscale,paper=postscript` → 140×240 竖 + /Rotate=0 但**内容 36.2×31.8mm**（缩放 1/16）。

### 完整矩阵（PostScript 纸全部组合）

| bake 形态 | 命令 | artifact | 内容 |
|---|---|---|---|
| 横 240×140 | landscape | 240×140 横 /Rotate=90 | 36×59 ❌ |
| 横 240×140 | disable-auto-rotation | **140×240 竖** /Rotate=0 | 111.8×167（完整但转置）⚠️ |
| 横 240×140 | landscape,rotate=0 | 同 landscape | ❌ |
| 横 240×140 | paperkind=256 | A4 | ❌ |
| 竖 140×240 | disable-auto-rotation | 140×240 竖 /Rotate=0 | 36×32 ❌ |
| 竖 140×240 | landscape | 240×140 横 /Rotate=90 | 36×59 ❌ |

### 核心结论

1. **`paper=postscript` 在 Sumatra 层不可用**——所有组合要么内容旋转（landscape 伴生 /Rotate=90）、要么纸方向反（disable-auto-rotation 强制 140×240 竖）、要么内容缩放 1/16（纸型解析失败 fallback）。
2. **B 是唯一内容完整的 case**（横 bake + disable-auto-rotation → 140×240 竖 + 内容 111.8×167）——但内容被**转置 90°**（bake 横条 167×111.8 → 竖条 111.8×167），对横内容发票仍不正确。
3. **Sumatra 对 postscript 纸名解析异常**（对比 a4 完全正常：4-2b-2a Gate 证明 A4 横打 PASS）——**Sumatra 认识 a4，不认识 postscript**。`paper=postscript` 非 Sumatra 标准纸名，选纸 fallback 导致布局错乱。
4. **已排除**：非方向命令问题（R2）、非 paperkind 256（R1）、非「140×240 竖纸型 + 横向使用」（R3）。

### 下一步（需用户侧信息）

- **确认 Wondershare 驱动实际纸张列表**：打印首选项里「PostScript」纸是否存在？物理尺寸/方向？若是用户自定义 Form，DMPAPER ID 需从驱动 DEVMODE 获取（本机 reg/win32print 均不可用）。
- **候选替代**：若驱动无 postscript 纸 → PostScript 纸方案不成立，回退驱动真实支持的纸（A4 横打已验证 PASS）或注册自定义 Form。
- **候选修复（命令层）**：若 postscript 纸确实存在，用驱动真实 paperkind ID（非 256）+ `disable-auto-rotation` + 与驱动纸方向匹配的 bake。

---

## 8. 驱动纸型枚举 + 决定性对照（2026-08-11 终局）

### 8.1 驱动纸型枚举（pywin32 EnumForms，213 个）

**Wondershare PDFelement 驱动里没有 'PostScript' 纸型**；唯一 240×140 纸 = **「凭证纸」240.0 × 140.0 mm**。
**默认 DEVMODE**：`dmPaperSize=32767`（DMPAPER_USER）+ `dmPaperWidth=2400 / dmPaperLength=1400`（0.1mm）= **驱动默认纸就是凭证纸 240×140**。

**→ 命中决策树 C 分支**：`paper=postscript` 是**无效纸 token**（另一会话 Voucher→PostScript 改名只动了应用层，驱动层纸名仍是「凭证纸」）→ Sumatra 选纸 fallback → 布局错乱。

### 8.2 决定性对照（同一 PostScript bake 产物，横 240×140 /Rotate=0 内容 167×111.8）

| 命令 | 纸 | 内容 | 判定 |
|---|---|---|---|
| `landscape,noscale,paper=a4` | A4 横 /Rotate=90 | **167×111.8 完整** | ✅ |
| `disable-auto-rotation,noscale,paper=a4` | A4 竖 /Rotate=0 | **167.1×111.8 完整** | ✅ |
| `landscape,noscale,paper=postscript` | 240×140 横 /R90 | 36×59 | ❌ |
| `noscale`（无 paper）/ `paper=凭证纸` / `paperkind=32767` | 140×240 竖 /R0 | 36×32 | ❌ |
| `disable-auto-rotation,noscale` / `paper=240mm x 140mm` | 140×240 竖 /R0 | 111.8×167 完整但转置 | ⚠️ |
| 竖 bake + 上述任意命令 | 140×240 竖 /R0 | 36×32 | ❌ |

### 8.3 终局结论

1. **`paper=a4`（Sumatra 标准纸名）内容完整** → **bake 产物正确、Sumatra 不毁内容**；landscape 的 /Rotate=90 只是纸方向标记（fitz 归一后内容原位）。
2. **`paper=postscript` 无效 token** → Sumatra 布局空间 fallback 错乱（内容缩放 1/16 或转置）。**非 geometry、非 noscale、非旋转语义**。
3. **Sumatra 对驱动自定义纸（凭证纸 240×140）的所有表达均无法正确选纸**：纸名（postscript/凭证纸）、尺寸（240mm x 140mm）、paperkind（256/32767）——只有标准纸名（a4 等）布局空间正常。
4. **竖 bake 全组合失败**（内容 36×32）——Sumatra 对非标准纸的布局引擎异常，与 bake 形态无关。

### 8.4 建议（不再猜 Sumatra 参数）

1. **另一会话的 Voucher→PostScript 改名应立即回退/纠正**——PostScript 非驱动纸名，会让凭证纸打印持续失效；应用层应保持与驱动纸名（凭证纸）一致或走标准纸。
2. **凭证纸打印需 Sumatra 能选到驱动 form 的机制**——Sumatra 当前版本对 Wondershare 驱动自定义纸支持不良（可能需 Sumatra 升级 / 驱动注册标准 form / 换纸表达），属 executor 能力问题，**非 C-2 职责**。
3. **A4 横打路径完整可用**（4-2b-2a Gate PASS + 本对照 M/N 内容完整）——业务可先 A4 横打兜底。
4. **冻结不变**：C-2 geometry 链、placement_bake、noscale 全部冻结；生产代码零改动；调查工具在 `.out`（gitignored）。
