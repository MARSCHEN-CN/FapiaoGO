# RG-3 Rotation Authority Transfer — 交付报告

- 日期：2026-08-10
- commit：`038b3dd`（已推送 GitHub `rotation-b1-hardening`）
- 状态：**COMPLETED** — RG-3-A/B/C 全部落地，A3-02/A3-03 DSL 变化按用户裁决接受
- 范围：纸向权移交 + rotate 语义分离；**未接** placement（C-2 Step 4）、未动 RotationResolver / Plan schema / add-pdf-margins.py / Sumatra 执行路径

---

## 1. 交付内容

### 1.1 resolveOrientationCommands 两通道（print-settings.js）

```diff
- resolveOrientationCommands(contentOrient, paperOrient, desiredRotation)
-   → { baseFlag（纸向，但由 contentOrient 决定！）, rotate（三查表混合） }
- ROTATE_LOOKUP = { 'landscape|portrait': {...}, ... }   ← 删除

+ resolveOrientationCommands({ paperOrientation, contentRotation })
+   → { paperOrientation, contentRotation }               ← 两通道分离
+   纸向唯一来自 paperOrientation（Plan/请求方向）
+   内容旋转直通 rotate=N（content transform executor）
```

### 1.2 normalize 纸向缺口补全（RG-3 发现）

**关键发现**：source 轨 `landscape`（用户横打请求）此前**从未传到 electron**——
PrintService.buildPrintSettings 的 ps 不含 landscape，normalize 的
`paper.orientation` 只算纸型固有方向 → 用户选 A4 横打会被静默当竖纸打印。

修复：
- `normalize`：`paper.orientation` = needSwap 后物理方向（读 legacy landscape / paperOrientation，回退纸固有方向），与 frontend paperSpec 对齐
- `PrintService.js`：ps 透传 `landscape`

### 1.3 两轨调用同步（G-RG3-3 双轨同源）

- print-backend.js（source 轨）：传 `{ paperOrientation, contentRotation }`
- OsLauncherBridge.js（direct 轨）：传 `{ paperOrientation: spec.orientation, contentRotation: 0 }`
- detectPdfOrientation 降级为诊断日志（不再参与纸向决策）

### 1.4 Guard 三件套 + RG-3-C（rotationAuthorityGuard.mjs）

| Guard | 内容 | 状态 |
|---|---|---|
| G-RG3-1 | 纸向唯一来自 paperOrientation（函数参数/纸向行不得含 contentOrient） | PASS |
| G-RG3-2 | 输出两通道 `{paperOrientation, contentRotation}`（无单字段 rotate 决策） | PASS |
| G-RG3-3 | 双轨同源（print-backend/OsLauncherBridge 均引用同一函数，无内联查表） | PASS |
| RG-3-C | 禁 ROTATE_LOOKUP 复活（三混查表模式） | PASS |

---

## 2. DSL 变化（用户裁决的预期行为变化）

| 场景 | 旧命令 | 新命令 | 裁决依据 |
|---|---|---|---|
| A3-02 横纸横内容 | `landscape,rotate=90,fit` | `landscape,fit` | rotate=90 是 ROTATE_LOOKUP 混合副产物，删除（RG-3-C） |
| A3-03 横票竖纸 | `landscape,fit`（内容劫持纸向） | `disable-auto-rotation,fit` | 纸向=竖（RG-3-A，C2-R2） |
| Voucher 横纸 | `disable-auto-rotation,fit` | `landscape,fit` | 纸固有横 → paperCommand=landscape（纸向权移交） |
| A4 横打请求 | （landscape 被丢弃） | `landscape,fit` | landscape:true 现在正确到达 electron |
| 竖票横纸 | `disable-auto-rotation,rotate=90,fit` | `landscape,fit` | 纸向=横 + 无内容旋转（两通道） |

**不变**：竖纸竖内容 `disable-auto-rotation,fit`、内容转 90 `disable-auto-rotation,rotate=90,fit`、其余参数（paperkind/duplex/grayscale/copies）全部不变。

---

## 3. A3-V2 复测结果（grab 修复后，7-case 全绿）

### 🐛 A3-V2 初版 A3-03 SELF_ORIENT 是抓取 bug 误报

- 根因：Wondershare PDFCreator 目录累积同名副本（`a3v2_portrait_content_1.pdf`…`_N.pdf`），原 grab 按 mtime 抓「最新任意 PDF」，窗口内旧副本被误抓 → A3-03 抓到旧的 `landscape` 命令产物。
- 修复：grab 改为**按内容文件名前缀匹配 + mtime 最新** + **非空检查**（空文件残留会跳过 grab）。
- 对照实验（4 组）**推翻 A3-V2 的部分结论**：Sumatra **忠实执行命令**，内容方向不参与纸向决策：

| 命令 | 横内容 | 竖内容 |
|---|---|---|
| `disable-auto-rotation,fit` | 595×842 portrait /Rotate=0 | 595×842 portrait /Rotate=0 |
| `landscape,fit` | 842×595 landscape /Rotate=90 | 842×595 landscape /Rotate=90 |

### RG-3 后实测（7-case ALL OK）

| Case | 命令 | 视觉 | 判定 |
|---|---|---|---|
| A3-01 竖纸竖内容 | `disable-auto-rotation,fit` | 竖 | EXEC_AS_IS ✓ |
| A3-02 横纸横内容 | `landscape,fit` | 横 | EXEC_AS_IS ✓（rotate=90 移除） |
| **A3-03 横票竖纸** | `disable-auto-rotation,fit` | **竖** | **PAPER_ORIENT_OK ✓（C2-R2 达成）** |
| A3-04 竖票横纸 | `landscape,fit` | 横 | PAPER_ORIENT_OK ✓ |
| A3-05 非对称 margin | `disable-auto-rotation,fit` | 竖 | OFFSET_PRESERVED ✓ |
| A3-06 noscale | `disable-auto-rotation,noscale` | 竖 | NOSCALE_OK ✓ |
| A3-07 rotation=90 | `disable-auto-rotation,rotate=90` | 竖 内容居中 | ROTATE_EXECUTED ✓ |

---

## 4. 回归全量

| 测试 | 结果 |
|---|---|
| printSpecNormalize | 13/13 |
| executionPlanPaperGeometry | 10/10 |
| paperOrientationFreezeGate | 全绿 |
| buildPrintPreviewModel | 7/7 |
| normalizePrintSources | 15/15 |
| margin Gate phase1b | 9/9 GREEN |
| rotationAuthorityGuard | PASS |
| printSpecOwnershipGuard | PASS |
| shellGeometryGuard | PASS |

---

## 5. 架构状态（RG-3 后）

```
PrintSpec
   │
   ├── paper.orientation ──────────► Sumatra paper command（landscape / disable-auto-rotation）
   │
   ├── contentRotation ────────────► rotate=N（content transform executor）
   │
   └── slot.placement ─────────────► ⏳ pending C-2 Step 4（Plan placement 接线）
```

**Sumatra = PDF transform executor（✅ 执行 rotate=N / noscale / fit / 输出 PDF；❌ 决定纸向 / placement / 理解票据几何）**

---

## 6. 待办（C-2 Step 4）

- **A3-03 最终 GREEN**：横票竖纸需要「内容转 90 烤进」——RG-3 阶段 print-backend 暂传旧 sourceRotation（=0 → 内容不转，纸向已正确）。Plan placement 的 renderRotation 接线后，命令变 `disable-auto-rotation,rotate=90`（内容转 90 由外部 placement 提供）。
- A3-02 的 rotate=90 是否永久删除：A3-V3 用方案 A/B/C 裁决（本轮已按 RG-3-C 移除）。
- margin bake 链（add-pdf-margins.py）独立，不受 RG-3 影响。
