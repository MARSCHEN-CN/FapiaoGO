# R1 — Merge Path vs Source Path Rotation Semantic Divergence

> 状态：**OPEN**（只记录，不修）
> 创建：2026-08-19
> 来源：Gate 3-4B Verification Gate 实证（`docs/gate3-4b-source-rotation-ownership-review.md` §4.2）
> 分支：`rotation-b1-hardening`
> 裁决窗口：Gate 4（Merge per-slot）/ Gate 5（全量回归）之前

---

## 问题陈述

同一输入（document geometry / paper geometry / userRotation = `fileRotations[f.key]`），
merge path 与 source path 的**最终净旋转**在部分用例本就不一致（当前代码，未做任何迁移）：

| case | 输入（content × paper × user） | merge `effectiveRotation` | source 净旋转（`contentRotation + layoutRotation`） |
|---|---|---|---|
| B-2.4 | landscape × portrait × 90° | 0 | 90 |
| B-2.5 | portrait × landscape × 0° | 90 | 270 |

差异 = 180° 级（内容上下颠倒）。

## 根因：两 seam 的用户旋转语义不同

- **Merge Path**（`PrintGeometryBuilder` / INV-D4-2）：
  `effectiveRotation = normalize(autoRotation + userRotation)` —— userRotation **叠加**在 auto 之上，
  用户旋转是「物理页内旋转」，可以抵消 auto 修正。
- **Source Path**（`resolveContentPlacement`）：
  `contentRotation` 是「**朝向意图**」，resolver 先烤入缩略图、再按「旋转后内容方向 vs 物理纸方向」做纸面匹配（`layoutRotation ∈ {0,-90}`）。

同一 90° 用户旋转，在 merge 里「抵消 auto 270° → 回到 0」；在 source 里「把横内容转成竖内容 → 竖纸匹配 → 净 90° 直立」。
二者对「用户旋转是什么」的建模不同。

## 为什么不能靠迁移抹平

Gate 3-4B 已实证：`effectiveRotation → contentRotation` 会双重纸面匹配，
B-2.4/B-2.5 净旋转 180° 翻转（guard 测试已锁定）。此 issue 的解法**不是**值替换。

## 待裁决问题（Question）

> Should userRotation semantics converge between merge and source path?

## 候选方案（Options）

- **A. Merge 采用 source 语义**：userRotation 作为「朝向意图」，merge 路径在 auto 之后不再叠加 user，改为类似 source 的两段式（先物化 user 再纸面匹配）。改动面 = `PrintAutoRotationPolicy` / `PrintGeometryBuilder`（当前冻结）。
- **B. Source 采用 merge 语义**：userRotation 作为「物理页内旋转」直接叠加，`resolveContentPlacement` 不再做二次纸面匹配（改动面 = `RotationResolver`，当前冻结）。
- **C. 引入显式分层**：`RotationIntent`（用户/UI 输入）与 `RotationResult`（最终施加旋转）分离，两 seam 各自消费对应层，中间增加转换层。改动面最大，但语义最清晰。

## 约束（Constraints）

- ❄ 本 issue 只记录、不实施。
- ❄ 裁决前不得修改：`RotationResolver` / `PrintAutoRotationPolicy` / `detectOrientation` / `usePrint.js` / `resolveContentPlacement` / `RenderLayoutFactory` / Sumatra mapping / Preview pipeline。
- ✅ 允许在裁决确定后、以**独立 Gate**（而非顺手改动）实施所选方案，并配套回归矩阵（复用 B-2 六用例）。
- OFD 属于 placement pipeline（`renderFileToPrintImage → placement → resolveContentPlacement`），受本 issue 裁决影响，但**不得提前打 OFD 专属补丁**；OFD/PDF/Image 统一回归应在裁决之后。

## 影响范围

- PDF / Image 单文件（`mode='source'`，Sumatra `sourceRotation` 通道）与合并/多票（merge `RenderCommand` 通道）在 userRotation≠0 场景的纸面方向一致性。
- OFD（Canvas placement 通道）与 PDF/Image 共用验证。
