# 单页 vs 多页 旋转/尺寸输入链 审计（2026-08-07 夜）

> 审计纪律：本审计**未修改任何旋转规则**（`RotationResolver.js` / `PrintPreviewModel.js` / `PrintPreviewCanvas.jsx` 均未改动）。
> 仅新增 `test/singleVsMultiInputMatrix.test.mjs`（用真实 `resolveContentPlacement` 跑输入矩阵）+ 本报告。

## 0. 用户假设

单页严重变形、多页正常，不像缓存（同文件单/多页表现不一致、同 `paperOrientation` 不稳定、单页错多页对）。
怀疑：**单页/多页走了不同 RenderResource 链 → `contentPhysicalSize` / `effectiveContentSize` 已被旋转污染 → Resolver 在错误坐标系计算**。

## 1. Step B：谁提供 `contentPhysicalSize`（尺寸写入点溯源）

`contentPhysicalSize` 在 `PrintPreviewModel.js:235` 来自 `fileContentPx(f)`（L48），而 `fileContentPx` 直接读 `f._pdfPageWidth/_pdfPageHeight`（PDF points × dpi/72）。
**`_pdfPageWidth/_pdfPageHeight` 有 3 个写入点，且旋转行为不一致：**

| Writer | 位置 | 取值方式 | 是否应用页 `/Rotate` | 产出（同页 /Rotate=90） |
|---|---|---|---|---|
| **A** usePreview RE 路径 | `usePreview.js:1377-1378` | `rot%180 ? swap : 原` | ✅ 是（交换 W/H） | DISPLAY `85×220` |
| **B** usePreview pdf.js 路径 | `usePreview.js:1440-1441` | `getViewport({scale:1})` 默认应用 rotate | ✅ 是 | DISPLAY `85×220` |
| **C** usePrint dims loader | `usePrint.js:603-604` | `getViewport({scale:1, rotation:0})` | ❌ 否（intrinsic） | INTRINSIC `220×85` |

**Resolver 契约（`RotationResolver.js:150`）：「contentRotation 由本函数内部施加，请勿预旋转后传入」→ 期望 INTRINSIC 未旋转尺寸。**
⇒ Writer-A/B **预旋转**，违反契约；Writer-C 守约。三条链对「同一页」产出**完全不同的尺寸**，根因 = 尺寸来源不一致。

## 2. Step A：输入矩阵（真实 Resolver 模拟，同一竖票 /Rotate=90）

桩发票：自然页 points `220×85`，`/Rotate=90` → 真实缩略图 `85×220`（竖，aspect≈0.386）。
`resolveContentPlacement` 真实调用，两种 writer 输出分别喂入：

| 场景 | contentPhysicalSize | effectiveContentSize | contentOrientation | layoutRotation | contentBox(<image>) | 变形? |
|---|---|---|---|---|---|---|
| 单页推测-Writer-C(未旋转) 竖纸型 | 917×354 | 917×354 | landscape | 0 | 917×354 | ❌ 长宽比不符 |
| 单页推测-Writer-C(未旋转) 横纸型 | 917×354 | 917×354 | landscape | -90 | 917×354 | ❌ 长宽比不符 |
| 多页推测-Writer-A/B(已旋转) 竖纸型 | 354×917 | 354×917 | portrait | 0 | 354×917 | ✅ 等比 |
| 多页推测-Writer-A/B(已旋转) 横纸型 | 354×917 | 354×917 | portrait | -90 | 354×917 | ✅ 等比 |

**机制判定**：`contentPhysicalSize` 长宽比 ≠ 真实缩略图长宽比 → 必变形；一致 → 等比 fit。

## 3. 变形执行点

`PrintPreviewCanvas.jsx:77-83`：
```jsx
<image href={thumbnailUrl} width={t.contentBoxWidth} height={t.contentBoxHeight}
       preserveAspectRatio="none" .../>
```
`contentBoxWidth/Height = effectiveContentSize`（即喂入的 `contentPhysicalSize`）。
`preserveAspectRatio="none"` 把缩略图**拉伸**到该盒子 → 长宽比不符即各向异性拉伸（严重变形）。

## 4. 根因分类 + 两个待证子假设

审计确认了**尺寸来源不一致**这一根因类（Writer-A/B 预旋转 vs Writer-C 守约，违反 Resolver 契约）。
但有一处必须诚实标注的矛盾：

> 纯尺寸长宽比机制预测「只要喂错 writer，**两种纸型都会变形**」（见上表行 1/2 同为 ❌）。
> 而你的现象是「**仅竖纸型（layoutRotation=-90）变形、横纸型（layoutRotation=0）正确**」。

因此存在**第二个独立子假设**，需与尺寸问题分开验证：

- **H1（尺寸来源）**：单页某路径拿到 Writer-C(未旋转 220×85) → 长宽比不符 → 变形。
- **H2（portrait 变换）**：即便尺寸正确，`layoutRotation=-90` 的 SVG transform（`translate scale rotate(-90,cx,cy)` + `preserveAspectRatio=none`）在竖纸型下产生拉伸/错位，横纸型（layout=0）不触发。

二者可能并存；当前证据（仅横纸型变形）更指向 **H2 是「只竖纸型坏」的主因**，H1 是「单页/多页差异」的候选主因。

## 5. 下一步（确认优先，仍不改码）

1. **确认单/多页实际 writer**：打开 UI，加载同一竖票分别作单页 / 多页，读 console：
   - `[DIAG-14 contentDims]` → 比对 `contentPx`（单页 vs 多页是否 917×354 vs 354×917）。
   - `[DIAG-13 slotImage SVG]` → 读 `rotationDeg`（确认竖纸型是否 -90）。
2. 若 H1 成立：统一尺寸写入契约——**所有 writer 输出 INTRINSIC 未旋转尺寸**（收敛到 Writer-C 语义），Resolver 内部靠 `contentRotation` 施加旋转。
3. 若 H2 成立：检查 `PrintPreviewCanvas.jsx` 的 `rotationCx/Cy`（= `effectiveContentW/H / 2`）与 `placedRect` 在 `layoutRotation=-90` 时是否自洽，必要时改用 `imageWidth/Height` 而非交换后的包围盒。

## 6. 本次改动

- 新增 `frontend/test/singleVsMultiInputMatrix.test.mjs`（审计 harness，1 passed）。
- 新增本报告。
- **未触碰**：`RotationResolver.js` / `PrintPreviewModel.js` / `PrintPreviewCanvas.jsx` / `usePreview.js` / `usePrint.js`。
