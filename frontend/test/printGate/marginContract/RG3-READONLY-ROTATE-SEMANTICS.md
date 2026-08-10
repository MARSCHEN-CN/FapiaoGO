# RG-3 只读调研：rotate 决策全链语义拆解（实施前确认）

- 日期：2026-08-10
- 状态：**只读调研完成**（未改任何代码）
- 目的：A3-V2 暴露「旧 rotate 语义里混了 paper/content 两种含义」——本报告拆清每处决策点，为 RG-3-A/B/C 提供精确改造面

---

## 1. rotate 决策全链地图

```
source 轨:
  renderer settings
       ↓
  print-backend.js buildSumatraCommand (L107)
       ├─ contentOrientation: 前端传入 ?? MediaBox 检测 (L117-123)
       ├─ paperOrientation:    getPaperShapeOrientation(paper) (L127)   ← 纸固有方向
       ├─ sourceRotation:      settings.sourceRotation ?? rotation (L135)
       ↓
  print-settings.js buildPrintSettings (L264)
       ↓
  normalize() → PrintSpec {paper.orientation, contentRotation, ...}
       ↓
  resolveOrientationCommands(contentOrient, paperOrient, desiredRotation)   ← ⚠️ 决策点 1
       ↓
  "-print-settings" DSL

direct 轨:
  printJob
       ↓
  OsLauncherBridge toSumatraArgs (L301)
       ├─ spec.orientation = getPaperShapeOrientation(job.paperSize) (L263)  ← 纸固有方向
       ├─ detectPdfOrientation(filePath) (L329)                             ← 内容方向
       ↓
  resolveOrientationCommands(pdfOrient, spec.orientation, 0)                 ← ⚠️ 决策点 2（同函数）
       ↓
  "-print-settings" DSL
```

**两条轨共用同一个 `resolveOrientationCommands`**——这是 RG-3 的收敛红利：改一处，两轨同步。

---

## 2. 决策点语义拆解（resolveOrientationCommands，L34-55）

当前实现三混输入，输出两个产物，各自语义不同：

```js
function resolveOrientationCommands(contentOrient, paperOrient, desiredRotation) {
  // Step 1: baseFlag —— 只由 contentOrient 和 rotation 奇偶性决定！
  //   content=landscape + 偶数步 → 'landscape'
  //   content=portrait + 奇数步 → 'landscape'
  //   ⚠️ 完全不看 paperOrient —— 这就是 A3-03 SELF_ORIENT 的根源
  const baseFlag = (contentOrient === 'landscape') === isEven
    ? 'landscape' : 'disable-auto-rotation'

  // Step 2: rotate=N —— 由 contentOrient × paperOrient × desiredRotation 三查表
  const ROTATE_LOOKUP = {
    'landscape|portrait':  { 0: 0,  90: 90,  180: 180, 270: 270 },
    'landscape|landscape': { 0: 90, 90: 180, 180: 270, 270: 0   },
    'portrait|portrait':   { 0: 0,  90: 0,   180: 180, 270: 180 },
    'portrait|landscape':  { 0: 90, 90: 90,  180: 270, 270: 270 },
  };
}
```

### 语义混淆确认（A3-V2 实测背书）

| 产物 | 当前决定者 | A3-V2 实测效果 | 真实语义 |
|---|---|---|---|
| **baseFlag='landscape'** | contentOrient（+奇偶） | Sumatra 输出 /Rotate=90 → **视觉纸方向变横**（A3-03） | ⚠️ **paper orientation request**（纸方向）——但当前由 content 决定！ |
| **baseFlag='disable-auto-rotation'** | 同上 | 纸向不干预 | paper orientation 的「保持」 |
| **rotate=N** | content×paper×desired 三查表 | 旋转烤进内容，/Rotate=0（A3-04） | ✅ **content transform command**（内容旋转执行器） |

### 结论（用户裁决的代码级确认）

> **baseFlag 实际上是 paper direction 通道，rotate=N 是 content rotation 通道。**
> 但当前 baseFlag 的算法只看 contentOrient —— 等于「内容方向劫持了纸方向决定权」。

这正是你冻结的：
```
landscape flag ≠ content rotation
landscape flag = paper orientation request
```
的代码级证据：**Step 1 算法用 content 算 paper 决定**。

---

## 3. 两通道改造设计（RG-3-2 目标）

```
旧（三混）:
  resolveOrientationCommands(contentOrient, paperOrient, desiredRotation)
  → { baseFlag: 'landscape'|'disable-auto-rotation',   ← paper 通道，但被 content 劫持
      rotate: number }                                  ← content 通道

新（两通道，RG-3 目标）:
  resolveOrientationCommands({ paperOrientation, contentRotation })
  → {
      paperCommand: 'landscape'|'portrait'|null,   ← 唯一来源 Plan.paper.orientation
      contentRotation: number,                      ← content transform executor
    }
```

### 新语义映射（关键转换）

| 场景 | 旧命令 | 新命令（纸向=Plan，内容=rotate） | 视觉预期 |
|---|---|---|---|
| A3-01 竖纸竖内容 | `disable-auto-rotation,fit` | paper=portrait → `disable-auto-rotation`；content=0 → 无 rotate | 竖纸原样 ✓ |
| A3-02 横纸横内容 | `landscape,rotate=90,fit` | paper=landscape → `landscape`；content=0 → 无 rotate | ⚠️ **rotate=90 消失**（RG-3-C 降级，A3-V3 裁决方案 A/B/C） |
| **A3-03 横票竖纸** | `landscape,fit`（Sumatra 自决横纸 🔴） | paper=portrait → `disable-auto-rotation`；content=90 → `rotate=90` | **竖纸 + 内容转 90°**（C2-R2 达成）✅ |
| A3-04 竖票横纸 | `disable-auto-rotation,rotate=90,fit` | paper=landscape → `landscape`；content=90 → `rotate=90` | 横纸 + 内容转 90° ✅ |
| A3-07 旋转 90 | `landscape,fit`（吸收） | paper=portrait → `disable-auto-rotation`；content=90 → `rotate=90` | 竖纸 + 内容转 90° ✅ |

### 关键点：A3-03 的 contentRotation 从哪来？
横票竖纸时，用户没旋转（desiredRotation=0），但内容需要转 90° 才「读得清」。
- **旧逻辑**：靠 baseFlag=landscape 让 Sumatra 转纸（错误——纸向被劫持）
- **新逻辑**：contentRotation 应由 **Plan 的 placement 计算**（RotationResolver 的 layoutRotation）显式给出——这正是 C-2 Step 1 已经具备的 `slot.placement.fitRotation`！
- RG-3 阶段：先让 resolveOrientationCommands 支持 contentRotation 显式传入（入口已通），**调用方（print-backend）暂仍传旧值**（不接 Plan），A3-03 的 placement 接线属 C-2 Step 4/Phase 1-C-3 范围。

---

## 4. RG-3-A 的精确动作面

### 4.1 resolveOrientationCommands 改造
- Step 1（baseFlag）删除 contentOrient 依赖 → 改为 paperOrientation 直接决定：
  - paperOrientation='landscape' → baseFlag='landscape'
  - paperOrientation='portrait' → baseFlag='disable-auto-rotation'（纸向=竖，Sumatra 不干预）
- Step 2（ROTATE_LOOKUP）删除 → rotate 直接 = contentRotation（content transform executor）
- 函数签名：`resolveOrientationCommands({ paperOrientation, contentRotation })`

### 4.2 两处调用方同步
- print-backend.js L332-340：传 `{ paperOrientation: normalizedSettings.paperOrientation, contentRotation: sourceRotation }`
- OsLauncherBridge.js L332-340：传 `{ paperOrientation: spec.orientation, contentRotation: 0 }`（direct 轨暂不接 contentRotation，保持现状行为——spec.orientation 已是纸固有方向，与 RG-3-A 一致）

### 4.3 向后兼容（关键约束）
**R1 红线（A3-V2 移交对象）**:Sumatra rotate 行为不变。RG-3 只改**谁决定命令**，不改 Sumatra 对命令的执行。
- DSL 输出对 **paper=portrait + content=0**（最常见场景）必须完全一致：`disable-auto-rotation,fit,paper=a4` 不变。
- 行为差异仅在 A3-03 型（横票竖纸）：命令从 `landscape,fit` → `disable-auto-rotation,rotate=90,fit`。这正是 RG-3-2 要验证的变化。

---

## 5. RG-3-C 的 A3-02 处理（本轮只加 guard，不裁决）

A3-02（横纸横内容）旧命令 `landscape,rotate=90,fit` 中 rotate=90 是否必要：
- A3-V2 实测：无 rotate=90 时 `landscape,fit` 是否也输出横纸？——**未测**（本矩阵 A3-02 固定带 rotate=90）
- 因此 RG-3-C 本轮**不删** rotate=90 的生成逻辑，但新实现里它自然变成「paper=landscape 的纸向命令 + contentRotation=0」→ 输出 `landscape,fit`（rotate=90 消失是两通道改造的自然结果）
- ⚠️ 这会产生 **DSL 行为变化**（A3-02 从 `landscape,rotate=90` → `landscape`），printSpecNormalize 测试的 11 组 DSL 等价回归**会挂**——需按用户裁决**更新期望**（RG-3 是语义迁移 commit，允许 DSL 变化，但必须显式记录）

---

## 6. Guard 三件套挂载点（RG-3-1）

| Guard | 检查 | 挂载 |
|---|---|---|
| G-RG3-1 | 禁止 `resolveOrientationCommands` 内出现 `contentOrient` 参与 baseFlag 计算（纸向唯一来自 paperOrientation） | 静态正则：`baseFlag.*contentOrient` 或 `contentOrient.*landscape.*isEven` |
| G-RG3-2 | 禁止 `geometryMaterialized/marginsApplied → rotation` 链路 | 已有 G-C2-6（0 hits）延续，扩展到 print-settings.js |
| G-RG3-3 | PrintSettings 输出三分离：`paper.orientation ≠ contentRotation ≠ sumatra rotate` | printSpecNormalize.test.mjs 断言扩展 + DSL 期望更新 |

---

## 7. 影响面清单（RG-3 commit 范围）

| 文件 | 改动 |
|---|---|
| `electron/print-service/print-settings.js` | resolveOrientationCommands 两通道改造 + buildPrintSettings 调用同步 |
| `electron/print-service/print-backend.js` | 调用签名同步（L332-340） |
| `electron/print-service/OsLauncherBridge.js` | 调用签名同步（L332-340，direct 轨 contentRotation=0） |
| `frontend/test/printGate/printSpecNormalize.test.mjs` | DSL 期望更新（A3-02 型）+ G-RG3-3 断言 |
| `frontend/test/printGate/marginContract/printSpecOwnershipGuard.mjs` | G-RG3-1/2 静态检查 |
| `scripts/verify_sumatra_capability.cjs` | A3-03 回归复跑（改造后重测） |

**不改**：RotationResolver / PrintExecutionPlan schema / add-pdf-margins.py / Sumatra 执行路径。

---

## 8. 待用户确认的两个决策点

1. **DSL 行为变化接受度**：A3-02 型（横纸横内容）命令从 `landscape,rotate=90` → `landscape`（rotate=90 消失是两通道自然结果，但属于行为变化）——接受则更新测试期望；不接受则 RG-3-C 保留 rotate=90 特判（A3-V3 裁决）。
2. **A3-03 contentRotation 来源**：RG-3 阶段 print-backend 暂传旧 sourceRotation（横票竖纸时=0 → 命令 `disable-auto-rotation,fit`，内容不转——视觉与旧 `landscape,fit` 不同但纸向正确）；Plan placement 的 fitRotation 接线留 C-2 Step 4。确认此边界。
