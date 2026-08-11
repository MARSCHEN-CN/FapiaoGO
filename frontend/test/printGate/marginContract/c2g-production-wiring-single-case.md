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
