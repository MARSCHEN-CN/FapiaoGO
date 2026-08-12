# C-2-G — 生产 bake 路径 Command Matrix 最小接线（单 case 验证）

> 日期：2026-08-11 ｜ 状态：**单 case 验证通过（横票 0° + 横纸）** ｜ 基线：`f8f1b71`
> 前置：`c2-sumatra-command-matrix-freeze.md`（16 表冻结）、`c2e-executor-paper-selection-conclusion.md` §13/§14（P1-P5 + IoU 判定）

---

## 1. 背景（根因链闭合）

用户实测生产日志 `landscape,noscale,paper=postscript`（bake 产物）横向纸张失败。P1-P5 决定性对照（同一真实 bake 产物，只变命令）：

| Case | 命令 | 内容 | 判定 |
|---|---|---|---|
| P1 生产基线 | 无 rotate | 38% | ❌ |
| **P2** | `rotate=90,fit` | 70% = bake 1:1，IoU(0°)=0.806 | ✅ 正向 |
| P3 | `rotate=270,fit` | IoU(180°)=0.837 | ❌ 倒置 |
| P4 | `rotate=90,noscale` | 70%，IoU(0°)=0.792 | ✅ 正向 |
| P5 | `rotate=90,paper=凭证纸` | 70% | ✅ token 无关 |

**根因**：Sumatra `landscape` 隐含 +90° 布局旋转，作用于**任何输入（含 bake 产物）**；bake 路径缺 rotate → 内容 90° 错乱。16 表 rotate 值 = 该隐含旋转的补偿（对 bake 输入同样成立）。

## 2. 接线设计（最小范围）

**解冻范围**（用户裁决 18:12）：仅「Command Mapping → production bake executor」命令层。

```js
// main.js print-source-file bake 成功分支（L546+）
// 仅 paper.orientation == 'landscape' 注入（landscape 才有隐含旋转）
// 竖纸 disable-auto-rotation 无隐含旋转 → 不注入（bake 已含旋转，现状正确零回归）
const execOrient = settings?.executionPaper?.orientation
const contentOrient = settings?.contentOrientation
if (execOrient === 'landscape' && contentOrient) {
  const contentRot = settings?.sourceRotation ?? settings?.rotation ?? 0
  const cmdRot = resolveSumatraRotation({
    contentOrientation: contentOrient,
    contentRotation: contentRot,
    paperOrientation: 'landscape',
  }).rotate
  printSettings = { ...printSettings, sourceRotation: cmdRot }  // ⚠️ 注入 sourceRotation（normalize L183 优先读它，contentRotation 字段被忽略）
}
```

**边界遵守**：
- 不动 resolver / 16 表 / Gate（golden spec 冻结）
- 不动 RotationResolver / geometry / placement / bake / paper selection / noscale
- 竖纸、无 executionPaper（降级）、legacy 路径 → 零变化（C2/C5 harness 验证）
- resolver 失败 → 优雅降级保持 legacy rotate

## 3. 验证结果

### 命令生成 harness（与生产同源逻辑）

| Case | 输入 | 输出命令 | 期望 |
|---|---|---|---|
| C1 | 横票 0 转横纸 | `landscape,rotate=90,noscale,paper=a4` | ✅ 含 rotate=90 |
| C2 | 横票 0 转竖纸 | `disable-auto-rotation,noscale,paper=a4` | ✅ 无 rotate（零回归） |
| C3 | 竖票 90 转横纸 | `landscape,rotate=90,noscale,paper=a4` | ✅ 16 表值 |
| C4 | 竖票 0 转横纸 | `landscape,rotate=270,noscale,paper=a4` | ✅ 16 表值 |
| C5 | 无 executionPaper | `landscape,noscale,paper=a4` | ✅ 无 rotate（降级零变化） |

### 真实打印（注入后命令形态 = P4 组合）

`landscape,rotate=90,noscale,paper=postscript` → 内容 **1:1 正向**（IoU 0°=0.792 vs 180°=0.032）✅

### 回归全绿

- resolver 单测 6/6（含 Symmetry 8/8）
- gate 套件 77/77
- 4 guard 全 PASS
- Command Matrix Gate L1 16/16

## 4. 状态与后续

- **本 commit = 单 case 生产接线（横票 0° + 横纸 → rotate=90）**。用户要求不一次性改 16 case。
- 其余 15 个组合的 bake 路径 rotate 需**逐步实测验证**（尤其竖票×横纸、旋转 90/270 组合——16 表值在 bake 输入的正确性逐 case 确认）。
- ⚠️ 已知盲区：sumatraNoScaleGate 只证 fit==noscale 相对等价，未断言内容绝对正确——后续应补内容方向断言。

## 5. 提交

- commit：`feat(print): C-2-G bake 路径 landscape 纸 Command Matrix rotate 最小接线`（main.js 单文件）

---

## 6. 🔴 8 组合实测修正（2026-08-12）：bake 路径 rotate = 恒 90（非 resolver 查表）

单 case（横票 0°+横纸）PASS 后，按 16 表逐步验证剩余横纸组合（`bakeLandscapeMatrixGate.mjs`，240×140 横纸 + `landscape,rotate=N,noscale,paper=postscript` + IoU 0°/180° 模板匹配方向断言）。

### 6.1 第一轮（resolver 查表值）：4/8 PASS，rotate=270 组合 4/4 全倒置

| Case | resolver rotate | IoU(0°) | IoU(180°) | 判定 |
|---|---|---|---|---|
| 横票 0° | 90 | 0.929 | 0.033 | ✅ |
| 横票 90° | 90 | 0.719 | 0.032 | ✅ |
| **横票 180°** | **270** | 0.033 | 0.918 | ❌ 倒置 |
| **横票 270°** | **270** | 0.032 | 0.684 | ❌ 倒置 |
| **竖票 0°** | **270** | 0.705 | 0.848 | ❌ 倒置 |
| 竖票 90° | 90 | 0.980 | 0.687 | ✅ |
| 竖票 180° | 90 | 0.969 | 0.605 | ✅ |
| **竖票 270°** | **270** | 0.691 | 0.987 | ❌ 倒置 |

**完美二分：rotate=270 组合 4/4 倒置，rotate=90 组合 4/4 正向。**

### 6.2 第二轮（恒 rotate=90）：8/8 全正向 PASS

| Case | 内容 | IoU(0°) | 判定 |
|---|---|---|---|
| 横票 0° | 201.8×127 (76%) | 0.929 | ✅ |
| 横票 90° | 84.7×134.8 (34%) | 0.719 | ✅ |
| 横票 180° | 201.8×127.1 (76%) | 0.927 | ✅ |
| 横票 270° | 84.8×135 (34%) | 0.535 | ✅ |
| 竖票 0° | 71×112.2 (24%) | 0.977 | ✅ |
| 竖票 90° | 158.5×100.6 (47%) | 0.980 | ✅ |
| 竖票 180° | 71×112.2 (24%) | 0.969 | ✅ |
| 竖票 270° | 158.5×100.6 (47%) | 0.977 | ✅ |

### 6.3 机制修正（关键）

- **Sumatra `landscape` 隐含旋转 = -90°**（非此前推断的 +90°）。
- bake 内容已烤进最终方向（Plan truth）→ **恒 rotate=90 抵消隐含 -90°，内容保持 bake 原方向**，与内容方向/用户旋转无关。
- **16 表 rotate=270 是直打模型适配值（源 PDF 未旋转内容），不适用于 bake 路径**——这是 §2 接线"resolver 查表"方案的缺陷，8 组合实测暴露后修正。

### 6.4 生产接线修正（main.js）

```js
// 仅 paper.orientation == 'landscape'（landscape 才有隐含 -90° 旋转）
// 竖纸 disable-auto-rotation 无隐含旋转 → 不注入（bake 已含旋转，现状正确零回归）
if (execOrient === 'landscape') {
  printSettings = { ...printSettings, sourceRotation: 90 }   // 恒 90，非 resolver 查表
}
```

### 6.5 验证

- harness：横纸 8 组合全 rotate=90；竖纸 4 组合注入==无注入（零回归，透传 sourceRotation 是既有行为）；降级零变化。
- 真实打印：`bakeLandscapeMatrixGate` **8/8 PASS**（恒 90）。
- 回归：resolver 6/6 + gate 77/77 + 4 guard + Command Matrix L1 16/16 全绿（resolver/16 表零改动——直打模型 spec 仍冻结）。

### 6.6 结论

**Command Mapping → production bake executor（landscape 纸）整链冻结**：bake 路径恒 rotate=90（8/8 实测），竖纸零回归。resolver 16 表保持直打模型 spec（不适用于 bake，勿混用）。
