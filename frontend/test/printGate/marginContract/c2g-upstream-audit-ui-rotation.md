# C-2-G — 上游审计：UI rotation 是否污染 Print Geometry（C 候选可行性）

> 日期：2026-08-12 ｜ 状态：**AUDIT 完成（只读）** ｜ C-2-G 保持 PAUSED / Semantic Audit Finding
> 前置：`c2g-rotation-semantic-audit.md`（侧躺根因）、Golden Semantic Matrix（90/270 竖内容 47% + 触边）

---

## 1. fileRotations（UI rotation）完整消费链

**写入**：`usePreview.js L65 setFileRotations`（用户点旋转按钮 → deg = +90，L369）——纯 UI 展示状态。

**消费**（全仓库 grep）：
| 消费方 | 位置 | 用途 |
|---|---|---|
| **打印几何** | `usePrint.js L545-547` | `contentRotation = fileRotations[f.key]` → resolveContentPlacement → placement → IPC → bake |
| **预览几何** | `PrintPreviewModel.js L291-292` | `contentRotation: userRotation` → resolveContentPlacement（与打印**共用同一 resolver**） |
| 预览显示 | `usePreview.js L369/L552` | 旋转渲染（canvas 显示变换） |
| 导出 | `useExport.js L166` | fileRotations 透传 |
| 事实记录 | `usePreview.js L422` | saveDocFacts 存 contentRotation |

## 2. 污染路径确认（C 的修复点）

```
UI 旋转按钮 → fileRotations[f.key]
    ├─→ 预览显示（旋转渲染）✅ 合理（展示状态）
    ├─→ 预览几何（PrintPreviewModel resolveContentPlacement）⚠️
    └─→ 打印几何（usePrint resolveContentPlacement → placement → bake）❌ 污染
```

**resolveContentPlacement 的 contentRotation 语义 = "旋转内容"**（Layer 1 先旋转内容尺寸再检测方向，RotationResolver L100-103）→ UI rotation 直接进入 bake 几何（90/270 → 内容竖 + 触边，Golden Matrix 证实）。

## 3. 是否有合法用途依赖「用户旋转方向 = 打印几何方向」？

**没有**。除 usePrint/PrintPreviewModel 外，fileRotations 的其他消费者（导出/事实）都是透传或记录，**不改变几何**。打印链中没有任何逻辑要求"打印必须体现用户 UI 旋转"。

## 4. C 候选可行性（解耦 UI rotation 与 Print Geometry）

**目标语义**（用户 12:37 定义）：UI rotation = 中间状态（源状态校正），最终打印应 0° 等价正向可读。

**障碍**：预览与打印**共用** resolveContentPlacement（usePrint 注释"与 Preview 共用唯一 layout resolver，禁两套算法"）+ 预览"所见即所得"期望——若打印侧去掉 contentRotation 而预览侧保留，两边 placement 不一致（预览旋转布局 vs 打印正向布局）。

**C 的最小形态（推荐审计结论）**：
- **打印侧**：contentRotation 不再取 `fileRotations[f.key]`（UI 状态），改为 **源 PDF 真实内容方向归一化**（page.rotation + 内容方向检测）→ bake 几何恒基于源真实方向 → 正向
- **预览侧**：保持 UI rotation 显示（用户旋转预览），但**预览几何同样基于源真实方向**（UI rotation 只做显示变换，不进几何）→ 预览显示与打印几何一致（都基于源方向，只是预览多一层显示旋转）

⚠️ 这需要预览显示层与几何层分离（显示旋转 ≠ 几何旋转）——**触及 PrintPreviewModel / 渲染链路**（Preview 渲染是冻结域：`禁止重审计：展示区 / DocumentStore / preview cache`）。**C 的完整实施触碰预览冻结域**。

## 5. A 候选对照（bake 消除用户旋转）

- A 只改 bake 侧：layoutRotation/placement 归一（contentRotation 校正语义进 bake）→ 解冻 bake 几何（placement_bake.py / buildBakeSpec 契约）
- 不碰预览（预览仍显示 UI 旋转，打印正向）→ **预览与打印不一致**（打印 0° 等价 vs 预览旋转状态）——同样有"所见非所得"问题

## 6. 结论（供裁决）

| 候选 | 修复点 | 触碰冻结 | 一致性 |
|---|---|---|---|
| C（完整解耦） | UI rotation 仅显示，几何基于源方向 | 预览渲染/几何层（冻结域） | 预览显示=旋转，几何=正向（显示层多一层变换） |
| C（最小：仅打印侧） | 打印侧 contentRotation 归一源方向 | 无（usePrint 单点） | **打印正向，但预览仍旋转 → 所见非所得** |
| A（bake 消除） | bake 归一 | bake 契约 | 同上（打印正向 vs 预览旋转） |

**关键权衡**：任何修复都会打破当前"预览所见即所得"（因为预览显示的是 UI 旋转状态）——除非产品同时明确"预览也应显示校正后正向"（即 UI rotation 校正后预览正向显示），那 C 完整形态才自洽。

**下一步（待裁决）**：
1. 产品确认预览语义：UI rotation 校正后，**预览应该显示正向还是旋转状态**？
   - 预览正向 → C 完整（显示/几何全基于源方向，UI rotation 只做"源方向解析"）
   - 预览旋转（所见即所得）→ 打印也旋转 = 当前行为（侧躺）——**那侧躺不是 bug，是产品语义**
2. 确认后定 C 或 A。

> ⚠️ 本轮只读审计，未改任何代码。C-2-G 保持 PAUSED。
