# PPC-OFD Integration Gate 3-A.2 — Rotation Single Application 取证

> 状态：取证完成，待用户裁决（§6 裁决点）后定稿 harness
> 前置：Gate 1 PASS / Gate 2 PASS（Producer Contract）/ Gate 3-A.1 PASS（Single OFD Consumer Path）
> 纪律：docs-only，零生产码修改；不触碰 RotationResolver / RenderCommand / mergeFactory / render_ofd_page / OFDAdapter

---

## 0. Scope Lock

本阶段只回答三个检查点（用户 Gate 3-A.2 指示）：

1. `sourceRotation` 如何进入最终 `RotationResolver`？
2. `effectiveRotation` / `contentRotation` 当前真实 owner？
3. 是否存在 preview / print 两条 rotation 来源分叉？

**不验证**：物理打印末端（3-B）、merge geometry（3-A.3+）、多页（3-A.5）。
**不改**：见头注释；`RotationResolver` 输入模型属 R1 冻结范围，本 Gate 只审计不定义。

---

## 1. 检查点 1 — sourceRotation 进入 RotationResolver 的路径

### 结论：**不进入。**

R1 冻结模型下，前端几何层只有 **contentRotation = 用户旋转**（`fileRotations[f.key]` 会话权威）：

| 层 | 输入 | sourceRotation? | 证据 |
| --- | --- | --- | --- |
| `RotationResolver.resolveContentPlacement` | `{contentRotation, physicalPaper, margins, dpi}` | ❌ 无此入参（「请勿预旋转后传入」） | `RotationResolver.js:153,209,277` |
| `PrintGeometryBuilder.buildPrintGeometry` | `{rawDocumentGeometry, requestedPaperGeometry, userRotation}` | ❌ `effectiveRotation = autoRotation + userRotation`，sourceRotation 非输入 | `PrintGeometryBuilder.js:48-60` |
| 旧路径 `_buildComposeCommand` | `contentRotation = rotations[slot.itemId]`（用户） | ❌ `rotation: 0` 无第二层 | `renderers.js:763-770` |
| V16 `fileObjToComposePagePlan` | `rotation = rotations[id] ?? item.rotation` | ⚠️ `item.rotation` 为 **fallback**，但 usePrint 总传 `rotations`（含 0）覆盖 | `composePagePlan.js:48-49` |
| 单文件 `buildSingleFileRenderCommand` | `contentRotation = rotation` 参数 | ❌ 调用方传用户旋转 | `singleFileRenderCommand.js:61` |

**sourceRotation 仅存两种形态**：
1. **后端 metadata 外置**：`ofd_page_dimensions()` → `{index,width,height,sourceRotation}`（`ofd_page_render.py:187`，从 Content.xml `Rotate=\d+` 解析 `_page_source_rotation` `:127`）；注册时映射 `page.sourceRotation`（`DocumentStore.metadata.test.js:42-52`）。
2. **前端宽高交换**：`usePreview.js:1421-1422` 按 `meta.page_rotation` 交换 `_pdfPageWidth/_pdfPageHeight`——**只影响方向检测（orientation），不施加旋转**。

### PDF 对照（结构性差异）

| 链 | /Rotate 消费点 | 证据 |
| --- | --- | --- |
| PDF 打印 | **raster 阶段烤入**：`getViewport({scale:1})`（pdf.js 默认 `rotation = page.rotate = /Rotate`） | `renderers.js:521,547,560` |
| PDF 预览 | raster `rotation:0`（源非预旋）+ contentRotation（几何层） | `renderers.js:1464,1476` |
| **OFD 打印/预览** | **无消费点**：后端 `render_ofd_page` 无 rotation 参数不烤（Gate 2 冻结证据）；前端几何层不并入 | — |

---

## 2. 检查点 2 — effectiveRotation / contentRotation 真实 owner

### 结论：**单一 owner 成立，无 double rotation。**

- **`effectiveRotation` owner = `PrintGeometryBuilder`**（打印域，V16 链）+ `PreviewGeometryBuilder`（预览域），均委派 **`PrintAutoRotationPolicy`**（B-7：Builder 不是第二个 Resolver）→ `autoRotation + userRotation`，输出 canonical `{0,90,180,270}`（B-10a：唯一 canonicalization 出口，Factory 只消费不再 normalize）。
- **`contentRotation` owner = RenderCommand 字段**：producer 一次写入（旧路径=用户旋转、V16=effectiveRotation、单文件=rotation 参数），executor（`drawRenderCommand` `renderDraw.js:54` `ctx.rotate((cr*π)/180)`）一次消费。
- Gate 4 已验证：producer 设置一次 / executor 消费一次 / 无第二旋转层（`cmd.rotation===0`）。

---

## 3. 检查点 3 — preview / print 两条 rotation 来源分叉？

### 结论：**内容旋转无分叉；sourceRotation 消费存在结构性差异（非 contentRotation 来源分叉）。**

- **内容旋转（contentRotation）同源**：预览（`usePreview.js:1580-1659` effectiveRotation 用户旋转/DocFacts 恢复）与打印（`usePrint.js:186` fileRotations 用户旋转）**都源自 `fileRotations`**，autoRotation 都由方向检测驱动——无两条 rotation 来源。
- **sourceRotation 消费差异**（结构性，非本 Gate 缺陷）：
  - PDF 打印：/Rotate 在 raster 烤入（pdf.js）
  - PDF 预览：rotation:0 raster + 几何层 contentRotation
  - OFD：两链均无消费
  - 根因：OFD renderer 契约（Gate 2 冻结）「source 取向 + 元数据外置」与 PDF 的「pdf.js 默认烤入」不同——**OFD 缺 raster 阶段消费点，且前端几何层无并入**。

---

## 4. 真实样本验证

| 样本 | Rotate 属性 | sourceRotation |
| --- | --- | --- |
| `test_fixtures/1412424.ofd`（A4 2480×3508 @300dpi 横向发票） | 无（Content.xml 无 `Rotate=`） | 0 |
| `test_fixtures/print-gate-anchors/26447000000943604784.ofd` | 无 | 0 |

→ **当前样本均 sourceRotation=0，断链不触发**；但契约存在（`_page_source_rotation` 为 OFD 标准页面旋转预留），未来遇到带 Rotate 的 OFD 会缺旋转。

---

## 5. Gate 3-A.2 核心发现（上报裁决）

> **OFD `sourceRotation`（页面 Rotate 元数据）当前无消费点**：
> 后端 raster 不烤（Gate 2 冻结）、前端几何层不并入 `contentRotation`（RotationResolver / PrintGeometryBuilder 无 sourceRotation 输入）、PDF 有 pdf.js raster 烤入而 OFD 无等价机制。

### 影响评估
- **不触发**（当前样本 sourceRotation=0）：现有 OFD 发票预览/打印无旋转丢失。
- **潜在**：OFD 标准允许页面 Rotate（`_page_source_rotation` 存在即为此），带旋转的 OFD 会缺旋转（预览与打印均缺）。

### 裁决点（需用户/R1 层面裁决，不在本 Gate 自行定义）

> **R1 contract 是否应定义「OFD sourceRotation 并入 contentRotation」？**

- **选项 A（保持现状）**：OFD sourceRotation 由「宽高交换 → 方向检测 → autoRotation」间接承载，contentRotation 只承载用户旋转（当前模型）。3-A.2 harness = rotation-once（userRotation 恰一次）+ sourceRotation 观察哨。
- **选项 B（应并入）**：Gate 2 移交项（「前端把 OFD sourceRotation 与 fileRotations 合并施加一次」）确立目标行为 → 当前是 consumer 缺口（OFD sourceRotation 应用 0 次而非 1 次）→ 归因 Consumer chain → 需升级裁决是否进入最小修复（触碰 usePrint OFD 分支，涉 R1 边界，须 R1 复审）。

---

## 6. 3-A.2 harness 设计草案（待裁决后定稿）

| 用例 | 输入 | 断言（rotation application count） |
| --- | --- | --- |
| T1 rotation-once（0/90/180/270） | userRotation 四值 | `ctx.rotate` 次数 = userRotation?1:0，角度正确（复用 3-A.1 S5） |
| T2 sourceRotation 观察哨 | `item.rotation=90`（sourceRotation 语义）+ `rotations={key:0}` | 断言「当前几何层 contentRotation 不含 sourceRotation」→ PASS=现状锁定；未来并入则 FAIL=触发 R1 复审（Path B 同款 sentinel 语义） |
| T3 V16 fallback 语义 | `item.rotation=90` + `rotations` 无该项 | V16 `fileObjToComposePagePlan` contentRotation=90（fallback 生效，恰一次）——验证 fallback 语义存在 |
| T4 preview/print 同源 | 同 (sourceWidth,sourceHeight,rotation) | `buildSingleFileRenderCommand` 与 `_buildComposeCommand` 产出 RenderCommand 的 contentRotation/clip/placement 一致 |

---

## 7. 状态

```
[R1 CLOSED] [PPC RATIFIED] [Gate 4 CLOSED]
[PPC-OFD Integration]
  Gate 1: PASS
  Gate 2: PASS (Producer Contract)
  Gate 3-A.1: PASS (Single OFD Consumer Path)
  Gate 3-A.2: IN PROGRESS — 取证完成，待裁决 §5 裁决点后定稿 harness
```

待用户裁决：**选项 A（保持现状，harness=rotation-once+观察哨）或 选项 B（应并入，升级 consumer 缺口复审）**。
