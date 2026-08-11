# C-2 冻结声明 + C-2-E 课题定义（Custom Form / Sumatra Executor Paper Selection Audit）

> 日期：2026-08-11 ｜ 状态：**双冻结生效**（C-2 + PostScript WIP）｜ 基线：`a675850`

## 1. C-2 冻结（正式）

**C-2 source print execution 链已达到目标态，全部冻结，不再修改：**

```
InvoiceDocument / Plan truth
        ↓
PrintExecutionPlan
        ↓
source job
        ↓
IPC executionPlacement + executionPaper
        ↓
placement bake（MediaBox == executionPaper）
        ↓
Sumatra noscale
        ↓
physical print
```

| 阶段 | 状态 | 验收 |
|---|---|---|
| Step 4-1 Plan→job→IPC handoff | ✅ 冻结 | placementPreservationGuard |
| Step 4-2a PlacementBakeAdapter | ✅ 冻结 | A3-03 Gate |
| Step 4-2b-1 生产 bake consumption | ✅ 冻结 | placementBakeProductionGate |
| Step 4-2b-2 noscale migration | ✅ 冻结 | sumatraNoScaleGate 5 case PASS |

**冻结范围（不得修改）**：placement / RotationResolver / paper resolve / PrintExecutionPlan / deriveSourcePrintJobs / placement_bake.py / margin_contract / **noscale 不回滚**。

**已排除的归因**：横向凭证纸问题 **非** landscape 旗标、非 noscale、非 RotationResolver、非 bake geometry。

## 2. 横向凭证纸问题 = Executor Capability Blocker（证据链闭环）

### 2.1 问题
Wondershare PDFelement + 凭证纸（240×140）横向打印失败（内容错乱/缩放/转置）。

### 2.2 证据链（2026-08-11，全部实测）
1. **驱动纸型枚举**（pywin32 EnumForms，213 个）：驱动**无 'PostScript' 纸**；唯一 240×140 = **「凭证纸」**；默认 DEVMODE `dmPaperSize=32767` + `dmPaperWidth=2400/dmPaperLength=1400` = 驱动默认纸即凭证纸。
2. **无效 token**：应用层 WIP 把 `Voucher240x140 → PostScript` 改名，但驱动 Form 名仍是「凭证纸」→ `paper=postscript` 非驱动存在的 Form → Sumatra 进入错误选纸/fallback 路径。
3. **隔离对照**（同一 baked PDF，内容 167×111.8）：
   - `paper=a4`（Sumatra 标准名）→ **内容完整** ✅（bake 正确、Sumatra 不毁内容）
   - `paper=postscript` / `paper=凭证纸` / `paper=240mm x 140mm` / `paperkind=256` / `paperkind=32767` / 无 paper → **内容异常** ❌
4. **排除**：landscape 的 /Rotate=90 仅为纸方向标记（fitz 归一内容原位）；竖 bake 全组合亦失败 → 与 bake 形态无关。

### 2.3 归因结论
**Sumatra 对驱动自定义 Form（凭证纸 240×140）的选择能力不足**——标准纸名（a4）布局空间正常，自定义 Form 的所有表达（纸名/尺寸/paperkind）均无法可靠选纸。属 **executor capability**，非 C-2 geometry 职责。

## 3. C-2-E 课题定义

**名称**：C-2-E — Custom Form / Sumatra Executor Paper Selection Audit

**核心问题**：
> Sumatra 能否通过当前 `-print-settings` / Windows DEVMODE 链，可靠选择 Wondershare 的自定义 Form「凭证纸」240×140？

**目标**：给出明确 YES/NO + 可行路径。若 NO，评估替代方案成本。

**边界（不得触碰）**：
- C-2 geometry 链（§1 冻结范围）
- noscale 策略
- PostScript WIP（未验证，不作生产纸型定义）
- 业务层纸张 orientation 逻辑

**调查方法（候选）**：
1. Sumatra 源码/文档：`-print-settings paper=` 参数解析机制（标准名 vs 自定义 Form vs 尺寸匹配的优先级/fallback）
2. Windows DEVMODE 链：`dmPaperSize`/`dmFormName` 在 Sumatra→GDI→驱动的传递方式；Sumatra 是否设置 `dmFormName`
3. 对照测试：标准纸（a4）成功路径 vs 自定义 Form 失败路径的 DEVMODE 差异（可用 pywin32 在打印前/后读驱动 DEVMODE 验证）
4. 替代 executor 能力评估：换打印 executor / 驱动注册标准可识别纸型 / 绕过 Sumatra 自定义 Form 选纸

**候选方案**：
- **A. 换 executor**：评估 Ghostscript/PDF24/系统 print API 对自定义 Form 的支持
- **B. 驱动注册标准纸型**：让 Wondershare 驱动把凭证纸注册为 Sumatra 标准可识别 form
- **C. 绕过自定义 Form 选纸**：如用尺寸命令 + 驱动自定义 form 的可靠组合

**验收标准**：凭证纸 240×140 横向打印 artifact = 240×140 横 + 内容完整（sumatraLandscapeGate 由 EXPECTED FAIL 转 PASS）。

## 4. PostScript WIP 处理建议

另一会话的 `Voucher240x140 → PostScript` 应用层改名：
- **状态**：未验证 WIP，不作为生产纸型定义
- **风险**：若上线，凭证纸打印将因 `paper=postscript` 无效 token 失效（本次已实测）
- **建议**：C-2-E 结论前回退或暂停；若 C-2-E 证明可行路径，再按结论重做纸型定义

## 5. 当前稳定基线

- 本地 = 远端 = `a675850`（rotation-b1-hardening）
- 工作区有另一会话未提交 WIP（PostScript 改名相关 12 文件）——未触碰，留待 C-2-E 结论后统一裁决
- C-2 全部 Gate：77/77 + 4 guard + sumatraNoScaleGate 5/5 + placementBakeProductionGate

## 6. 后续建议顺序

1. ~~Step 4-D~~（暂缓——用户裁决：C-2 source execution 已达目标态）
2. **C-2-E**：Sumatra 自定义 Form 选纸能力 audit（独立 executor 课题）
3. 真实打印验证可聚焦 A4 横打（已验证 PASS）作为业务兜底
