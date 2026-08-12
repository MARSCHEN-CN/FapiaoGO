# C-2-G G2 Paper Direction — 零代码预测实验

> 状态：**C-2-G = BLOCKED / G2 Paper Direction**。`e23107b`（E1+E1a+E2）保持有效，不回退。
> 本轮**只读 / 零代码**：仅调用未修改的生产函数（`resolvePaperSpec` / `print-settings.normalize` / `buildPrintSettings`），不修改任何生产文件。
> 配套脚本：`frontend/test/printGate/.out/c2g-g2-predictions.mjs`（gitignored 实验脚本，不提交）。

## TL;DR

| 场景 | Plan 算对 | 当前链单一 Truth | G2-SIM 闭环 |
|---|---|---|---|
| 横纸型 + 横向 | ✅ | ✅ | ✅ |
| 横纸型 + 纵向 | ✅ | ❌ **断裂** | ✅ |

- **G2 阻断点精确定位**：`normalize`（`electron/print-service/print-settings.js:199-205`）用相对 `landscape` 布尔 + 纸型固有方向兜底**重推导** orientation，完全忽略 Plan 已算对的 `executionPaper.orientation`。横纸型 `natural=landscape` → `landscape=false` 落到 `naturalOrient='landscape'` → `needSwap=false` → 永远 240×140 landscape。
- **比审计更省的关键发现**：`normalize` **早已原生读取** `src.paperOrientation`（L202-203）！当前只是前端 `PrintService.buildPrintSettings` 从不发该字段。故 **G2 最小修复 = 纯前端补传 `paperOrientation`**，零 electron 改动。
- **第二个独立缺陷**：即便把 Plan 的 `executionPaper` 透传进 `src`，`normalize` 也不读它（两 case 实测均被丢弃）→ 该字段目前是 dead-on-arrival。
- **安全边距是同一上游错误的第二个表现**，非独立 margin bug：usable rect 在纵向下被转置（Plan `134×234` vs 当前 `234×134`），边距落错边。

## 方法（与 E 的 P-DELTA / E-SIM 同构）

调用**未修改**的生产模块，沿真实链路：

```
resolvePaperSpec(settings)              [frontend/paperSpec.js, 未修改]
        ↓  plan.paper (executionPaper)
currentSrc / simSrc                     [仿真真实 IPC 形状]
        ↓
normalize(ps)                           [electron/print-settings.js, 未修改]
        ↓  spec.paper.{orientation,widthMM,heightMM}
buildPrintSettings(ps)                  [electron/print-settings.js, 未修改]
        ↓  Sumatra -print-settings 命令串
```

- **横纸型建模**：`paper:'Custom', customPaper:{widthMM:240,heightMM:140}` → `natural=landscape`。等价 PostScript 240×140，规避 `PaperRegistry` require 依赖（与 E 实验同法），orientation 逻辑完全一致。
- **`currentSrc`**：忠实复刻 `PrintService.buildPrintSettings`（`frontend/src/services/PrintService.js:57-91`）——**只发 `landscape` 布尔，从不发 `paperOrientation`**。
- **`simSrc`**：在 `currentSrc` 基础上补传 `paperOrientation`（绝对方向），即修复后的数据契约。
- UI rotation 隔离为 0（纯 G2 验证，不动 G3）。

## 预测结果

### P-G2-PLAN — Plan 层算对 executionPaper

| 场景 | Plan orientation | Plan 尺寸 | usable(3mm) | 判定 |
|---|---|---|---|---|
| 横纸型 + 横向 | landscape | 240×140 | 234×134 | ✅ |
| 横纸型 + 纵向 | portrait | 140×240 | 134×234 | ✅ |

`resolvePaperSpec` 用 `needSwap = orientation !== natural`：纵向请求 vs 横纸型 natural → 宽高交换 → 140×240 portrait。**Plan 层即单一 Paper Truth 的权威来源，已正确。**

### P-G2-CURRENT — 当前执行链断裂（横纸型 + 纵向）

| 场景 | 当前执行 orientation | 当前尺寸 | 命令串 | 单一 Truth |
|---|---|---|---|---|
| 横纸型 + 横向 | landscape | 240×140 | `landscape,fit,paper=240mm x 140mm` | ✅ |
| 横纸型 + 纵向 | **landscape** ❌ | **240×140** ❌ | `landscape,fit,paper=240mm x 140mm` ❌ | **❌ 断裂** |

纵向方向下，`normalize` 收到 `landscape:false` → `requestedOrient = paperOrientation(undefined) ?? naturalOrient('landscape') = 'landscape'` → `needSwap=false` → 输出 240×140 landscape。**与真机 T2~T4 现象完全吻合：Sumatra 收到的是 landscape，不是 portrait。**

### P-G2-SIM — 补传 paperOrientation 闭环（未修改 normalize）

| 场景 | G2-SIM orientation | G2-SIM 尺寸 | 命令串 | 闭环 |
|---|---|---|---|---|
| 横纸型 + 横向 | landscape | 240×140 | `landscape,fit,paper=240mm x 140mm` | ✅ |
| 横纸型 + 纵向 | **portrait** ✅ | **140×240** ✅ | `disable-auto-rotation,fit,paper=240mm x 140mm` ✅ | ✅ |

仅把 `src.paperOrientation = 'portrait'` 喂入**未修改**的 `normalize`，即得到 140×240 portrait + 正确命令（portrait baseFlag、contentRotation=0 故无 `rotate`）。**证明：链路能形成单一 Paper Truth，且修复面比审计估计更小——只需前端补传字段。**

### P-G2-DELTA — 因果闭环

```
横纸型 + 纵向方向：
  预期执行纸 (Plan truth) : portrait / 140×240
  当前实际执行 (normalize): landscape / 240×140
  delta                   : absolute paperOrientation 未进入 IPC；
                            landscape 布尔无法表达「横纸型×纵向」；
                            normalize 回退 naturalOrient(=landscape) 致 needSwap=false
  G2-SIM 修复点           : 仅前端补传 paperOrientation='portrait'
                            （normalize L202-203 已原生读取，无需改 electron/print-settings.js）
```

## 回答用户的三个精确问题

### Q1 — 用户选择的「纸张方向」字段是什么？
**只有一个相对布尔 `settings.landscape` 进入打印 IPC，无绝对方向字段。**
- `PrintService.buildPrintSettings`（L57-91）返回的 `ps` 对象**不含 `paperOrientation`**；仅 `landscape: !!userSettings.landscape`。
- `paperOrientation` 仅作为 legacy Fact 存在于 preview/docFacts，**未进入打印链**。
- 源单文件路径 `executionPaper` 来自 `usePrint.js` 的 `f?.paper`（非 plan），多为 `null`——Plan truth 从没可靠进入 source-file IPC。

### Q2 — 横纸+纵向 → 140×240 portrait 应在哪发生却没发生？
**Frontend 算对了（paperSpec needSwap），但 `normalize` 重推导时丢弃，且布尔无法表达该请求。**
- 前端规范交换正确：`paperSpec.js:88` `needSwap = orientation !== natural` → 横纸型+portrait → `widthMM=140, heightMM=240` ✅ 进入 `plan.paper`。
- `normalize`（L199-205）重算：`requestedOrient = src.landscape ? 'landscape' : (src.paperOrientation ?? naturalOrient)`。横纸型 `natural='landscape'`、`paperOrientation=undefined` → 落 `landscape` → `needSwap=false` → 不交换。
- **两层失败叠加**：① IPC 不传绝对方向；② `normalize` 即便收到 `executionPaper` 也不读（`src.executionPaper` 在 L172-231 完全未被引用）。

### Q3 — 安全边距为何横向对、纵向错？
**边距在「纸张原生维度」坐标系（横纸型恒 240×140）计算，方向交换从未传到执行器。**
- `normalize` 的 margins 是绝对 mm（`marginLeft...`），但其**作用坐标系** = `spec.paper.{widthMM,heightMM}`，而后者来自 needSwap 结果。
- 横向：执行纸=240×140，usable=234×134，边距算对。
- 纵向：交换被丢弃，执行纸仍 240×140，usable 仍 234×134 → 与用户期望的 140×240 / usable 134×234 **转置** → 边距落错边、内容 fit 错位。
- **这是 Q2 同一上游错误的第二个表现，不能单独修 margin 契约。**

## 旁证：executionPaper 透传被 normalize 忽略

两 case 均将 `{...planTruth, size:'Custom'}` 作为 `src.executionPaper` 传入，实测 `normalize` 输出 orientation **仍为 landscape**（被丢弃）。证明：即便修复 IPC 把 Plan truth 传过去，`normalize` 不消费它，链路仍断裂。G2 修复必须让 `normalize` 以绝对方向为权威——而最简单路径即「前端补传 `paperOrientation`」（`normalize` 已读该字段）。

## 建议的 G2 最小修复面（待批准，未实施）

**仅前端，1 个字段**：在 `PrintService.buildPrintSettings` 返回值中加入
```js
paperOrientation: requestedPaperOrientation(userSettings),  // 绝对方向，normalize L202-203 已原生消费
```
（`requestedPaperOrientation` 已在 `paperSpec.js` 导出，逻辑与 Plan 同源。）

**可选增强**（独立 commit，不在本次）：让 `normalize` 优先采用 `src.executionPaper.orientation`（Plan truth 直接覆盖），并修复 `usePrint.js` 把 `plan.paper` 写入 source-file `executionPaper`。二者择一即可闭环；前者零 electron 改动、风险最小。

**冻结边界全部保持**：resolver / 16 表 / RotationResolver / placement 契约 / 其他打印路径 / E1+E1a+E2 不动。

## 冻结状态

```
C-2-G = BLOCKED / G2 Paper Direction
 ├─ E1  bake contentRotation              ✅ (e23107b, 不回退)
 ├─ E1a bake spec 透传                   ✅
 ├─ E2 landscape executor compensation   ✅
 ├─ G1 纸张类型                           ✅
 ├─ G2 纸张方向                           ❌ BLOCKED（本实验定位）
 │   ├─ Plan 层：算对 executionPaper      ✅
 │   ├─ IPC：仅传 landscape 布尔          ❌ 缺绝对方向
 │   └─ normalize：丢弃 executionPaper、回退 natural → 不交换 ❌
 └─ Physical Gate                         ⏸ 等 G2 修复后重新执行
```

## 下一步

1. 用户批准 G2 解冻（建议最小面：前端补传 `paperOrientation`）。
2. 解冻后做 G2 零代码验收（同构 P-G2 实验回放）+ cr 回归。
3. 真机重跑 T1~T4：重点 T2（横×纵 不再 landscape）、T4（竖×纵 不裁切）。
4. 真机通过后才标记 C-2-G PASS。
