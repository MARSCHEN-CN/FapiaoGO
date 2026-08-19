# Gate 3-4B — Source Rotation Ownership 架构纠偏记录（Verification Gate）

> 状态：**REDEFINED**（迁移 Gate → 验证 Gate）
> 日期：2026-08-19
> 分支：`rotation-b1-hardening`（HEAD = `df7debd`，Gate 3-4A）
> 裁决：用户 APPROVED（三选一 → **(a) 重构为验证 Gate**）
> 权威文件：本文件 + `frontend/src/layout/Gate3-4B-SourceRotationOwnership.test.mjs`（可复现脚本）

---

## 1. 背景：Gate 3-4B 原计划（已废弃）

原 Gate 3-4B 假设 source seam 只需单点替换：

```js
// usePrint.js:479（原计划）
contentRotation = fileRotations[f.key]
//            ↓
contentRotation = printGeometry.effectiveRotation
```

目标：把 source path 的 rotation ownership 从 `fileRotations[f.key]` 收敛到
`PrintGeometry.effectiveRotation`，与 Gate 3-4A merge seam 形成「双路径同源」。

---

## 2. 取证结论：原方案不成立（BLOCKER）

### 2.1 语义层不同（决定性证据）

`RotationResolver.js:152-153` 契约原文：

> `contentRotation 由本函数内部施加，请勿预旋转后传入`
> `contentRotation - 用户旋转角（0/90/180/270）`

对照 `PrintGeometryBuilder.js:59-60`：

> `effectiveRotation = normalize(autoRotation + userRotation)` —— **已是最终旋转**

| 值 | 语义层 | 是否含自动纸面匹配 |
|---|---|---|
| `contentRotation`（source 输入） | **用户旋转**（fileRotations） | ❌ 不含，由 resolver 内部算 |
| `effectiveRotation`（merge 输出） | **最终旋转**（auto + user） | ✅ 已含 |

`effectiveRotation ≠ contentRotation` **不是 bug**，而是两个不同层级的量。
把最终旋转当 `contentRotation` 喂回 `resolveContentPlacement` = 双重纸面匹配。

### 2.2 双重纸面匹配（机制）

`resolveContentPlacement` 内部流程（`RotationResolver.js:209-243`）：

```
contentRotation  → 烤入缩略图(effectiveContentSize)
                 → 方向检测(contentOrientation)
                 → 纸张匹配(layoutRotation = 0|-90)   ← 第二层旋转
净旋转 = contentRotation + layoutRotation
```

若 `contentRotation = effectiveRotation`（已含 auto），auto 与 layoutRotation
对同一「内容 vs 纸」关系各算一次 → **两层旋转叠加，结果发散**。

### 2.3 附带取证（非阻塞但必须记录）

- **Shape 失配**：`resolveContentPlacement` 入参是对象 `{contentPhysicalSize:{width,height}, contentRotation, physicalPaper}`，非草案的位置参数形式；`buildPrintGeometry` 的入参形状是 `{widthPx,heightPx}`/`{orientation}`/`{degrees}`。两 seam 入参形状本就不同。
- **双通道（E）**：`PrintService.buildPrintSettings`（`PrintService.js:58-95`）同时透传
  `placement`（Canvas/OFD 通道，消费 `resolveContentPlacement` 产物）与
  `sourceRotation`（Sumatra 旧执行器通道，裸 `fileRotations`）。
  Gate 3-4B 若只改 `placements` useMemo，只影响 Canvas/OFD 通道，**不影响 Sumatra 通道**。

---

## 3. 当前架构（修正后的正确模型）

```
userRotation (fileRotations[f.key], 同一 canonical 用户意图)
        │
        ├──────────────────────────────┐
        │                              │
        ▼                              ▼
   Merge Path                      Source Path
   PrintGeometryBuilder            resolveContentPlacement
        │                              │
        ▼                              ▼
   effectiveRotation              contentRotation(user) 烤入
   = auto + user                        │
   （最终旋转，供 RenderCommand）         ▼
        │                          layoutRotation(纸面匹配)
        │                              │
        ▼                              ▼
   RenderCommand                   final placement
        │                              │
        └──────────?───────────────────┘
                     │
                     ▼
            物理输出（两 seam 各自自洽）
```

- **Merge Path**：`effectiveRotation` 是已完成纸面匹配的**最终旋转**，RenderCommand 直接消费、不得再解释（Gate 3-4A 已达成）。
- **Source Path**：`contentRotation` 是**用户旋转输入**，由 `resolveContentPlacement` 内部完成纸面匹配（`computeLayoutRotation`）。
- 两 seam **输入同源**（`fileRotations`），**消费模型不同**，各自 resolver 自洽。

---

## 4. 实证：B-2 验收矩阵（实测结果，2026-08-19）

脚本：`frontend/src/layout/Gate3-4B-SourceRotationOwnership.test.mjs`
运行：`node --test frontend/src/layout/Gate3-4B-SourceRotationOwnership.test.mjs`（1/1 PASS）

```text
case    content   paper     user  merge  srcCur  srcNaive  diverges  layersDiffer
B-2.1   portrait  portrait  0     0      0       0         false     false
B-2.2   portrait  portrait  90    90     0       0         false     false
B-2.3   landscape portrait  0     270    270     270       false     true
B-2.4   landscape portrait  90    0      90      270       true      true
B-2.5   portrait  landscape 0     90     270     90        true      true
B-2.6   portrait  landscape 90    180    90      90        false     true
```

- `merge` = `buildPrintGeometry(...).effectiveRotation`
- `srcCur` = 当前 source path 净旋转 = `normalize(contentRotation + layoutRotation)`（contentRotation=user）
- `srcNaive` = 非法迁移净旋转（contentRotation=merge）

### 4.1 护栏结论

| 项 | 结论 |
|---|---|
| 非法迁移是否改变 source 输出 | ✅ 是（B-2.4 / B-2.5） |
| 发散严重度 | **180°（内容上下颠倒）**，非微小偏差 |
| 等价用例 | B-2.1 / B-2.2 / B-2.3 / B-2.6（auto=0 时 merge===user；或对称抵消） |
| 裁决 | ❌ **禁止** `contentRotation = printGeometry.effectiveRotation` |

### 4.2 🔴 更深层发现（R1，独立 issue，不在 Gate 3-4B 范围内）

当前代码（未迁移）下，merge 与 source 的**最终净旋转**在部分用例本就不一致：

| case | merge effectiveRotation | source 净旋转 (srcCur) | 差异 |
|---|---|---|---|
| B-2.4 | 0 | 90 | 180° 级语义分歧 |
| B-2.5 | 90 | 270 | 180° 级语义分歧 |

根因：两 seam 的**用户旋转语义不同**——

- Merge Path：userRotation 按 INV-D4-2 **叠加**在 auto 之上（物理页内旋转，user 可抵消 auto）；
- Source Path：userRotation 作为「朝向意图」，由 resolver 再做纸面匹配（内容先转，方向对齐后再适配）。

这不是本次迁移引入的，而是既有的双 seam 语义分裂。**建议另立 issue（Gate 4 合并 per-slot / Gate 5 全量回归前裁决）**，不得靠 `effectiveRotation → contentRotation` 抹平（会破坏冻结契约）。

---

## 5. Gate 3-4B 验收矩阵（正式定义）

### B-1 输入一致性

同一输入（document geometry / paper geometry / userRotation）分别进入
`PrintGeometryBuilder` 与 `resolveContentPlacement`：
- ✅ 两 seam 输入同源：`fileRotations[f.key]`（userRotation / userRotation.degrees）。
- ✅ 各 seam 内部 resolver 自洽（已由 4.1 实证矩阵证明行为可预测）。
- ⚠️ 两 seam 最终净旋转在 B-2.4/B-2.5 不一致 → 见 §4.2 R1 issue。

### B-2 userRotation 覆盖

覆盖 6 用例（content × paper × user ∈ {0,90}），见 §4 实测矩阵。
重点 `userRotation ≠ 0`（B-2.2/2.4/2.6）——已暴露 `effectiveRotation ≠ contentRotation`。

### B-3 OFD / PDF / Image 共用验证

- OFD：走 Canvas 共享 `placement` 通道（`renderFileToPrintImage`），与 source `resolveContentPlacement` 同源。✅ 不做 OFD 专属分支。
- PDF / Image：单文件 `mode='source'` 走 Sumatra，消费 `sourceRotation`（`PrintService.buildPrintSettings` 通道）。
- 验证目标：三格式纸面方向一致（依赖 §4.2 R1 issue 裁决后的统一验证）。

### B-4 禁止事项（冻结）

❌ 修改 `RotationResolver` / `PrintAutoRotationPolicy` / `detectOrientation` / `usePreview` / `RenderLayoutFactory` / `MultiTicketComposer` / Sumatra mapping / Preview pipeline
❌ 修改 `resolveContentPlacement`
❌ 引入 `effectiveRotation → contentRotation`

---

## 6. Guard（回归护栏）

文件 `frontend/src/layout/Gate3-4B-SourceRotationOwnership.test.mjs` 作为明确 guard：

- 断言 1：非法迁移至少在一个用例改变 source 输出（非 no-op）。
- 断言 2：B-2.4 / B-2.5 必须发散且相差 180°（上下颠倒级回归护栏）。
- 断言 3：B-2.1 / B-2.2 / B-2.3 / B-2.6 必须等价（锁死不退化）。
- 若未来有人实施 `contentRotation = printGeometry.effectiveRotation`，断言 2 立即失败 → guard 生效。

---

## 7. Gate 状态

```
Gate 3-0 Contract Amendments        ✅ PASS
Gate 3-1 PrintGeometryBuilder       ✅ PASS
Gate 3-2 CodeReview                 ✅ PASS
Gate 3-3 Static Guard               ✅ ALL PASS
Gate 3-4A RenderCommand Seam        ✅ PASS CLOSED (df7debd)

Gate 3-4B Source Ownership
        ⏸ REDEFINED → Verification Gate
        ✅ Verification Matrix + Guard 落地（本文件 + 测试）
        ✅ 实证：非法迁移被禁止（180° 回归护栏）
        ❄ 生产代码零改动（usePrint.js / resolveContentPlacement 均未动）

开放项：
  R1 issue（merge vs source 用户旋转语义分裂，B-2.4/B-2.5）→ Gate 4/5 前裁决
```
