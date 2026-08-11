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
