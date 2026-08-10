# A3-V2 Sumatra Executor Capability Verification

- 日期：2026-08-10
- 状态：**COMPLETED** — 7-case 矩阵实测（真实 SumatraPDF + Wondershare PDFelement capture writer）
- 定位：回答「Sumatra 在失去几何解释权后，能否成为纯 executor」（用户 A3-01~07 矩阵）
- ⚠️ 本阶段零生产代码改动（DEV-only 脚本 + fixture + 报告）

---

## 1. 环境与方法

| 项 | 值 |
|---|---|
| SumatraPDF | `E:\print706\resources\sumatra\SumatraPDF.exe`（便携版 3.x） |
| capture writer | **Wondershare PDFelement**（默认打印机；落盘 `C:\ProgramData\Wondershare\PDFelement10\PDFCreator\`，保留原文件名 + `_N` 后缀） |
| probe | `scripts/probe_render_resource_fitz.py`（fitz @300dpi，亮度<250 bbox） |
| 被测命令 | 生产 `buildPrintSettings` 1:1 复刻（`scripts/verify_sumatra_capability.cjs`） |
| 运行 | `node scripts/verify_sumatra_capability.cjs`（全部 7 case）或 `--only A3-0x` |

### ⚠️ 2026-08-10 实测环境修正（与 2026-08-04 设计的差异）
- Wondershare 落盘目录不是 Desktop，而是 **PDFCreator** 目录（2026-08-04 记录的 Desktop 是早期探索期行为）。
- **Sumatra 输出 PDF 用 `/Rotate` 属性表达方向**，不是交换 MediaBox——所有 artifact 原始 MediaBox 恒为 595×842（A4 portrait），方向靠 `/Rotate=90`。
  → 测量必须用 /Rotate 归一后的视觉尺寸（`pixmap_px`），probe 的 `mediabox_px`（原始）会导致方向误判。已修正 `computeMetrics`。

---

## 2. 测试矩阵实测结果（全部 7 case）

| Case | 输入组合 | 生产 -print-settings | artifact 视觉 | /Rotate | 内容边距（视觉坐标 mm） | 判定 |
|---|---|---|---|---|---|---|
| **A3-01** | portrait paper + portrait content | `disable-auto-rotation,fit,paper=a4` | 210×297.1 portrait | 0 | L29.5 T29.7 R29.6 B29.8 | ✅ **EXEC_AS_IS**（原样输出，无旋转无缩放） |
| **A3-02** | landscape paper + landscape content | `landscape,rotate=90,fit,paper=a4` | 297.1×210 landscape | 90 | L84.1 T9.8 R89.2 B15.3 | ✅ **EXEC_AS_IS**（rotate=90 由 ROTATE_LOOKUP 对 landscape\|landscape 的要求，Sumatra 忠实执行） |
| **A3-03** | landscape content + portrait paper | `landscape,fit,paper=a4` | 297.1×210 landscape | 90 | L6 T14.4 R0.8 B16 | 🔴 **SELF_ORIENT**（Sumatra 收到 landscape 旗标**自行决定纸方向**→ 视觉横纸；Plan 未决定纸向 → **违反 C2-R2**） |
| **A3-04** | portrait content + landscape paper | `disable-auto-rotation,rotate=90,fit,paper=a4` | 210×297.1 portrait | 0 | L20.9 T95.2 R21 B95.3 | ✅ **ROTATE_EXECUTED**（rotate=90 由 ROTATE_LOOKUP 发出，Sumatra 执行：旋转烤进 /Rotate=0 页面） |
| **A3-05** | asymmetric margin（L20/R60/T40/B15 已 bake） | `disable-auto-rotation,fit,paper=a4` | 210×297.1 portrait | 0 | L19.6 T14.6 R59.6 B39.8 | ✅ **OFFSET_PRESERVED**（fit 同尺寸纸不抹边距；Δ≈0.4mm） |
| **A3-06** | noscale | `disable-auto-rotation,noscale,paper=a4` | 210×297.1 portrait | 0 | L29.5 T29.6 R29.5 B29.7 | ✅ **NOSCALE_OK**（1:1 输出，内部 fit 关闭） |
| **A3-07** | rotation=90 参数存在（业务旋转） | `landscape,fit,paper=a4`（rotate 被吸收） | 297.1×210 landscape | 90 | L29.5 T29.5 R29.7 B29.6 | ✅ **ROTATE_ABSORBED**（rotation=90 被吸收为方向旗标：命令 rotate=0 + landscape，Sumatra 输出横纸） |

---

## 3. 用户 5 问逐项回答

| # | 问题 | 答案 |
|---|---|---|
| 1 | 按指定纸张输出？ | ✅ **部分**。A4 正常（A3-01/02/05/06/07 全部 210×297 或 297×210 精确）。⚠️ 但**纸方向由 Sumatra 决定**（`landscape` 旗标 → /Rotate=90 视觉横纸；`paper=a4` 仅定 MediaBox 尺寸，不锁定方向）。 |
| 2 | 是否偷偷 rotate？ | ⚠️ **取决于命令**。命令含 `rotate=N` → Sumatra 忠实执行（A3-04 烤进内容、/Rotate=0）；命令只含 `landscape` 旗标 → Sumatra 自行转纸（A3-03 /Rotate=90）。**无隐式额外旋转**：rotate=0 且无旗标时（A3-01）原样输出。 |
| 3 | 是否二次 fit？ | ✅ **noscale 可靠关闭**（A3-06 内容 1:1）。⚠️ fit 默认开启（A3-01~05 均收到 fit），但**同尺寸纸 fit 不抹 offset**（A3-05 非对称边距 Δ0.4mm 保持）。 |
| 4 | 是否裁切？ | ✅ 未观察到裁切。内容全部落在纸内（A3-03 虽贴边 R0.8mm 但未超界）。 |
| 5 | 是否改变 margin？ | ✅ **fit 同尺寸纸不改变已 bake margin**（A3-05 证明）。⚠️ 若纸尺寸被 writer 夹改（2026-08-04 的 Microsoft Print to PDF 先例），offset 会丢——capture writer 必须忠实纸尺寸（Wondershare 满足）。 |

---

## 4. 核心机制发现（对 RG-3 的决策意义）

### 机制 1：Sumatra 输出方向用 `/Rotate` 属性（非交换 MediaBox）
所有 artifact 原始 MediaBox 恒为 595×842（A4 portrait）。方向由 `/Rotate=90` 表达。
**推论**：物理打印时，Sumatra 把 `/Rotate` 交给打印机驱动解释。**「Rotate 权移交」的对象是 `/Rotate` 属性和驱动解释权**，不是 MediaBox 交换。

### 机制 2：两种旋转路径
| 路径 | 触发 | 表现 |
|---|---|---|
| 旗标路径 | `landscape` 旗标 | Sumatra 输出 `/Rotate=90`（视觉横纸）→ 驱动旋转 |
| 参数路径 | `rotate=N` 参数 | Sumatra 把旋转**烤进页面内容**（/Rotate=0，A3-04）→ 内容已转，驱动直打 |

### 机制 3：A3-03 是 C2-R2 违反的直接证据 🔴
横票竖纸场景：Plan 的预期是「外部提供 placement rotation」（RotationResolver 的 layoutRotation），但 Sumatra 收到 `landscape` 旗标后**自行决定纸方向**（视觉横纸 /Rotate=90）。这意味着：
- 现状：`landscape` 旗标 = Sumatra 的纸向决定权，Plan 无法从 PrintSpec 表达「我要竖纸 + 内容转 90°」。
- **RG-3 的精确动作**：`landscape`/`portrait` 旗标不能由 ROTATE_LOOKUP 自由发出——必须由 Plan 的 paper.orientation 决定后，以**确定纸向**发出（或改走参数路径 rotate=N + disable-auto-rotation 显式声明方向）。

---

## 5. RG-3 决策建议

### 结论：**可以进入 RG-3，但需限定动作**（非全量移交）

**GREEN 侧**（Sumatra 可 executor 化的证据）：
- noscale 可靠（A3-06）→ Plan 烤好内容后 Sumatra 不会二次 fit
- fit 同尺寸纸不抹 margin（A3-05）→ 边距 bake 方案兼容现有 fit
- rotate=N 参数忠实执行、无隐式额外旋转（A3-01/04/07）

**RED 侧**（必须先在 RG-3 处理的风险）：
- `landscape` 旗标路径 = Sumatra 自决纸向（A3-03）→ **违反 C2-R2**。RG-3 必须把「旗标→纸向」的决定权从 ROTATE_LOOKUP 收归 Plan（`print-settings.js` 的 `resolveOrientationCommands` 只应输出**由 Plan 纸向确定**的旗标，或改走参数路径）。

### RG-3 建议动作清单（供裁决）
1. `resolveOrientationCommands` 停止自由发出 `landscape`/`portrait` 旗标——纸向改由 `Plan.paper.orientation` 决定（C-2 Step 1 已有字段）。
2. 方向冲突场景（A3-03 型）改走**参数路径**：`disable-auto-rotation,rotate=N` + 内容旋转由外部 placement 完成（R-2 已冻结「旋转烤进内容」）。
3. `landscape|landscape` 的 ROTATE_LOOKUP 0→90 语义需复核（A3-02 显示横纸横内容也会发 rotate=90——若 Plan 已定横纸，rotate=90 是否多余？）。

### 暂缓项（不变）
- 不删 add-pdf-margins.py（Step 4 待 Phase 1-C 完成）
- 不改 PrintSpec/Plan schema（A3-V2 只验证，不迁移）
- V-04-rot90 的 Gate 向量保持 pending 直到 RG-3 结论

---

## 6. 产物与复现

| 文件 | 说明 |
|---|---|
| `scripts/verify_sumatra_capability.cjs` | 7-case 矩阵脚本（dry-run / 实测 / measure-only） |
| `.out/a3v2/A3-0x.pdf` | 7 个 artifact（Wondershare 真实打印产物） |
| `.out/a3v2_*.pdf` | 确定性内容 fixture（竖版内容 + 非对称 margin） |
| `.out/a3v2/A3-0x.png` | 渲染图（人工核对用，未提交） |

复现命令：
```bash
node scripts/verify_sumatra_capability.cjs --dry-run          # 7 条生产命令
node scripts/verify_sumatra_capability.cjs --only A3-05       # 单 case 实测
node scripts/verify_sumatra_capability.cjs --measure-only     # 复用已有 artifact 重判
```

## 7. 遗留待确认
- **Wondershare 对自定义纸（230×160）的行为**未在本矩阵覆盖（A3 矩阵全用 A4）——A1 异形纸场景仍由 `verify_sumatra_rotation.js`（V2-B，Wondershare「PostScript」纸型）负责，与本矩阵互补。
- A3-03 的 SELF_ORIENT 是否可被「显式 paper 方向参数」抑制，需在 RG-3 的实施阶段用同一矩阵复测验证。
