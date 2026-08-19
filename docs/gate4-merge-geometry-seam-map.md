# Gate 4 — Merge Per-slot Geometry Validation

> 阶段：**Gate 4.1（现状基线 / seam map） + 4.2（Contract Audit 初步结论）**
> 日期：2026-08-19
> 分支：`rotation-b1-hardening`
> 性质：**docs-only 取证，零生产代码改动**
> 冻结纪律（来自 R1 + PPC 已封存边界）：本 Gate 不触碰
> `RotationResolver` / `sourceRotation` / `contentRotation`(定义) / `effectiveRotation`(定义) / OFD 打印路径 / `VirtualPrintSource` / `PrintResource` 生命周期。
> 唯一验证目标：**在冻结 `effectiveRotation` ownership 前提下，merge per-slot geometry 是否忠实消费 `RenderCommand` contract。**

---

## 0. 结论速览（Gate 4.1 + 4.2）

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| merge composer 是否重新解释 rotation（double rotation） | ✅ 否 | `composePlans` 仅透传 `plan.printGeometry.effectiveRotation`；`buildRenderCommand` 不二次 normalize（B-10a）；`mergeFactory` 仅对原始 `rotations[id]` 做 snap |
| merge composer 是否读取 source format（`if ofd` / `pdf.rotate` / `image.exif`） | ✅ 否 | `MultiTicketComposer` / `SlotLayout` / `composeSlot` / `mergeFactory` / `deriveMergePrintJobs` / `mergeModeContract` 均无 source 分支 |
| slot geometry 是否修改 content geometry | ✅ 否 | slot 仅作 `createPlacement` 的 fit 目标；composer 只附加 `meta`（executor 忽略） |
| rotation 是否只应用一次 | ✅ 是 | 唯一落盘旋转点在 `renderDraw.js:38 drawRenderCommand` 消费 `cmd.contentRotation` |
| **两条 merge 生产者 rotation 来源是否一致** | ⚠️ **不一致（观察点，非越界缺陷）** | Path A = canonical `effectiveRotation`（auto+user）；Path B = 原始 `rotations[id]`（仅 user，本地 snap，无 autoRotation） |

**Gate 4.1 基线判定：COMPLIANT（核心 contract 被忠实消费，无越界缺陷）。**
**Gate 4.2 初步判定：三条禁止规则全部缺席；但发现 Path B divergence，需用户在 4.3 前裁决是否纳入回归覆盖。**

---

## 1. 上游（冻结区，仅引用不改动）

```
PrintGeometryBuilder.buildPrintGeometry / PrintAutoRotationPolicy
        │
        ▼
effectiveRotation = normalize(autoRotation + userRotation)   // canonical {0,90,180,270}
        │  // 单一 resolver，R1 冻结 ownership 的产出
        ▼
plan.printGeometry.effectiveRotation   (composePagePlan.js:54-58,75)
```

> ❄ 此层属 R1 冻结区。Gate 4 只验证「该产出在 merge composer 中是否被忠实消费」，不重新推导、不二次 normalize。

---

## 2. 两条 Merge RenderCommand 生产者

### Path A — V16 / RenderLayoutFactory 路径（Preview 合并 / Print 多票 / Export）

```
composePagePlan.fileObjToComposePagePlan(item, …, forcedOrient, rotations)
   ├─ buildPrintGeometry({widthPx,heightPx, requestedPaperGeometry:{orientation:forcedOrient}, userRotation:{degrees:rotation}})
   │     → plan.printGeometry.effectiveRotation   (canonical, 已含 autoRotation+userRotation)
   └─ plan = { source:{docId,pageId}, printGeometry, documentState }

        ↓

MultiTicketComposer.composePlans({ paperLayout, plans, ticketCount, strategy, gridCols, gridRows })
   ├─ computeSlots(paperLayout, {count, strategy, gridCols, gridRows})   → slots[]   (PURE geometry, mm/px)
   └─ for each plan:
         buildRenderCommand(paperLayout, plan.documentState, slot, plan.printGeometry)
              ├─ contentRotation = plan.printGeometry ? plan.printGeometry.effectiveRotation : legacyShim(docState.rotation)   // 见 §5
              │     → 不二次 normalize（B-10a：Builder canonical + Factory canonical = 第二 resolver 违例，已规避）
              ├─ createPlacement({ contentRect: slot, sourceWidth:natW, sourceHeight:natH, rotation: contentRotation })
              │     → { scale, offsetX, offsetY, rotatedBounds, clip }
              └─ RenderCommand { version:1, paper, paperRect, usableRect, rotatedBounds,
                                  placement:{scale,offsetX,offsetY}, rotation:0, contentRotation, paperLandscape, clip, meta }
         → 附加 meta: plan.source（drawRenderCommand / validateRenderCommand 均忽略，冻结契约不受损）

        ↓

renderDraw.js:24 drawRenderCommand(ctx, cmd, source, contentW, contentH, ratio)
   └─ 唯一消费 cmd.contentRotation 落盘旋转的位置（line 38）   // rotation 应用一次
```

**文件**：`composePagePlan.js` · `MultiTicketComposer.js` · `SlotLayout.js`(computeSlots) · `RenderLayoutFactory.js`(buildRenderCommand) · `composePlacement.js`(createPlacement) · `renderDraw.js`(drawRenderCommand)

### Path B — Slice 1.3 / D1 canvas-bake 路径（renderers.js → render.worker.js）

```
createLayout(renderers.js)                          → { page, area, slots }  (绝对坐标 px@dpi，含 slot.contentRect)
contentMeta = Map<itemId,{width,height}>            (Phase1 光栅化真实像素)
rotations  = Map<itemId, deg>                       (用户旋转输入，任意值)

        ↓

mergeFactory.buildMergeRenderCommands(layout, contentMeta, rotations, { isLandscape })
   ├─ contentRotation = normalizeRotation((rotations[id]) || 0)   // 本地内联 normalizeRotation(line 28-31)，仅 snap 到 90° 倍数
   ├─ createPlacement({ contentRect: slot.contentRect, sourceWidth:natW, sourceHeight:natH, rotation: contentRotation })
   │     → { scale, offsetX, offsetY, rotatedBounds, clip }
   └─ RenderCommand { version:1, paper, paperRect, usableRect, rotatedBounds,
                      placement:{scale,offsetX,offsetY}, rotation:0, contentRotation, paperLandscape, clip }

        ↓

drawRenderCommand(ctx, cmd, ...)   // 同 Path A 的通用 executor
```

**文件**：`mergeFactory.js` · `composePlacement.js`(createPlacement，共用) · `renderDraw.js`(drawRenderCommand，共用)

---

## 3. Seam Map（谁创建 slot / 谁消费 RenderCommand / 谁算 page geometry）

| 职责 | Path A | Path B |
| --- | --- | --- |
| 票位几何（slot） | `SlotLayout.computeSlots`（纯几何，px，无 rotation/source 感知） | `createLayout`(renderers.js) → `slots[].contentRect` |
| 内容旋转决策 | `PrintGeometryBuilder` → `plan.printGeometry.effectiveRotation`（canonical，上游冻结） | 无（直接吃 `rotations[id]` 原始用户旋转） |
| RenderCommand 组装 | `RenderLayoutFactory.buildRenderCommand` | `mergeFactory.buildMergeRenderCommands` |
| fit/居中/旋转几何 | `createPlacement`（唯一几何 owner） | `createPlacement`（同一函数，逐字同源） |
| 物理页方向 | `paperLayout.paperOrientation` → `paperLandscape` | `options.isLandscape`（调用方 `getForcedLandscape` 决定） |
| 旋转落盘 | `renderDraw.js:38 drawRenderCommand` | `renderDraw.js:38 drawRenderCommand`（通用） |
| 来源身份 | `meta: plan.source`（executor 忽略） | 无（commands 不带 meta） |
| Plan→Job 映射 | `deriveMergePrintJobs`（仅按 `plan.pages[*].slots[*].fileId` 重映射，不碰 rotation/geometry） | 同左（merge 模式由 plan 驱动） |

---

## 4. Gate 4.2 三条禁止规则审计

### 禁止 1：重新解释 rotation（double rotation）

- **Path A**：`composePlans` 把 `plan.printGeometry`（已是 canonical `effectiveRotation`）透传给 `buildRenderCommand`；后者**直接转发**（line 153-154），注释明确「Factory 不再二次 normalize（否则 Builder canonical + Factory canonical = 第二 resolver，违 B-10a）」。无 double rotation。
- **Path B**：`contentRotation = normalizeRotation(rotations[id] || 0)`（line 81）。这是对**原始用户输入**（任意 deg）的一次 snap，不是对已旋转 RenderCommand 的二次旋转。不构成 B-2.5 式的「effectiveRotation → contentRotation → resolver」layer inversion。
- **落盘点**：`drawRenderCommand` 仅消费 `cmd.contentRotation` 一次（renderDraw.js:38）。composer 不在中间叠加旋转。
- **结论**：✅ 两条路径均无 double rotation。

### 禁止 2：composer 读取 source orientation

- 全链路 grep `effectiveRotation` / `pdf.rotate` / `image.exif` / `ofd` / `file.type`：**merge/compose 生产者中零出现**。
- `meta: plan.source` 仅携带 `{docId,pageId}` 身份，drawRenderCommand 明确忽略（MultiTicketComposer.js:91）。
- `mergeModeContract.js` 的 `forcedLandscape` 仅由 `getForcedLandscape(mode)` 决定（merge4→true），与文件格式无关。
- **结论**：✅ 无 source format 分支，composer 不感知 PDF/OFD/Image。

### 禁止 3：slot geometry 修改 content geometry

- slot 仅作为 `createPlacement` 的 `contentRect` 输入（fit 目标）。composer 不写 `renderCommand.transform` / `placement` / `contentRotation`。
- `composePlans` 对 `renderCommand` 的唯一改动是 `{ ...renderCommand, meta }`（附加，非几何）。
- `paperLandscape` 由 `paperOrientation` Fact 派生（buildRenderCommand:157 / mergeFactory:66-68），非由内容旋转推导（D3 物理纸事实，已锁）。
- **结论**：✅ slot 不修改 content geometry。

---

## 5. 观察点（非越界缺陷，需用户裁决）

### 5.1 Path B 的 rotation 来源缺少 autoRotation

- Path A 的 `effectiveRotation` = `normalize(autoRotation + userRotation)`（autoRotation 由「内容方向 vs 纸张方向」推导）。
- Path B 的 `contentRotation` = `normalizeRotation(rotations[id])`，`rotations` 是**用户旋转输入**（renderers.js 的 `fileRotations`），**不含 autoRotation**。
- 这意味着：同一份发票在 Path A（V16 多票预览/打印）与 Path B（canvas-bake 合并）下，自动旋转行为可能不一致——若内容方向 ≠ 纸张方向，Path B 不会自动转正。
- **是否为缺陷？** 尚不能定性：
  - 若 `rotations[id]` 在 renderers.js 上游已并入 autoRotation，则两条路径一致（仅命名不同）；
  - 若 `rotations[id]` 确为纯用户旋转，则 Path B 是「用户旋转轨」，与 Path A 的「自动+用户轨」语义分裂——这正是 R1 担心的「多个 rotation 入口」在打印执行层的残留。
- **Gate 4 关联性**：本 Gate 只验证「merge 是否忠实消费 RenderCommand contract」，不重新推导 rotation。Path B 的 rotation 来源差异不违反三条禁止规则，但**必须在 Gate 4.3 回归矩阵中显式覆盖两条路径**，否则矩阵只验 Path A 会漏掉 Path B 的语义。

### 5.2 `buildRenderCommand` 的 legacy shim（preview 路径，OUT OF SCOPE）

- line 153-155：无 `printGeometry` 时（preview 3-arg 调用 `compose()` adapter）走 `normalizeRotation(documentState?.contentRotation ?? documentState?.rotation ?? 0)`。
- 这是 Preview 路径（R1 冻结域），**非 Gate 4 的 merge 目标**。merge 经由 `composePlans` 恒传 `plan.printGeometry`，shim 不可达。
- 仅记录，避免未来误读为「第二 resolver」。

### 5.3 两条生产者结构同构

- 两者产出结构完全一致（version/placement/rotatedBounds/contentRotation/paperLandscape/clip），`drawRenderCommand` / `validateRenderCommand` 通用消费——这是 V16「Renderer 不拥有 Layout」纪律的正面证据。

---

## 6. Gate 4.1 → 4.2 裁决建议

1. **核心 contract 已 preserved**：merge per-slot geometry 忠实消费 `RenderCommand`，无 double rotation / 无 source 分支 / 无 content-geometry 篡改。→ **4.4 代码动作对核心 contract 不必要**。
2. **Path B divergence（§5.1）需用户裁决**：是否纳入 Gate 4.3 回归覆盖；是否定性为缺陷（取决于 `rotations[id]` 上游是否已含 autoRotation）。**不建议在 Gate 4 内顺手改 Path B**——那会触碰 rotation 语义（越界），应作为独立议题（或并入 Future Rotation Semantic Migration Gate）。
3. **下一步 Gate 4.3**：建立最小回归矩阵，**同时覆盖 Path A 与 Path B**，断言：
   - slot geometry 正确（slotRect == expected paper coordinate）；
   - rotation 只出现一次（effectiveRotation → RenderCommand → drawRenderCommand，无 composer 叠加）；
   - composer 不关心 PDF/OFD/Image（同 RenderCommand contract 进入同一 composer）；
   - 维度：rotation(0/90/180/270) × merge(none/2/4) × format(PDF/Image/OFD) × orientation(portrait/landscape)。

---

## 7. 已读文件清单（取证溯源）

- `frontend/src/layout/RenderLayoutFactory.js`（buildRenderCommand, validateRenderCommand, normalizeRotation）
- `frontend/src/layout/MultiTicketComposer.js`（composePlans, compose）
- `frontend/src/layout/SlotLayout.js`（computeSlots, computeTicketSlots, fitIntoSlot, slotToLandscape）
- `frontend/src/compose/composeSlot.js`（ComposeSlotLayoutFactory, resolveMergeSpec）
- `frontend/src/compose/composePlacement.js`（createPlacement — 唯一几何 owner）
- `frontend/src/compose/composePagePlan.js`（fileObjToComposePagePlan — 挂载 printGeometry）
- `frontend/src/layout/mergeFactory.js`（buildMergeRenderCommands — Path B 生产者）
- `frontend/src/print/deriveMergePrintJobs.js`（Plan→Job 映射）
- `frontend/src/print/mergeModeContract.js`（mode→paper 拓扑契约）
- `frontend/src/layout/renderDraw.js`（drawRenderCommand — 唯一旋转落盘点）
- grep `effectiveRotation` 全 src 流向（确认无 source 分支 / 无 composer 二次旋转）
