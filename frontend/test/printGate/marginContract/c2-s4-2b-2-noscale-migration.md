# C-2 Step 4-2b-2 — Sumatra fit → noscale migration

> 日期：2026-08-10 ｜ 阶段：Phase 1-C-2 Step 4-2b-2 ｜ 基线：4-2b-1 冻结（`2ae1716`）
> 边界（用户批准）：**只动 Sumatra command 参数 / print execution policy / gate；不碰 geometry 链**（RotationResolver / placement schema / PrintExecutionPlan / deriveSourcePrintJobs / placement_bake.py / margin_contract / paper resolve）。

## 1. 目标

4-2b-1 已证明「生产接线 + bake 后进入 fit executor」不破坏 geometry。4-2b-2 回答：

> 当 PDF 已 bake 到最终纸尺寸（MediaBox == executionPaper）时，Sumatra 是否应停止参与 layout？

即证明：`bake → noscale` 与 `bake → fit` 严格等价，然后把生产执行切到 noscale。

## 2. 4-2b-2a — DEV migration proof（`sumatraNoScaleGate.mjs`，新增）

**方法**：5 case × 同一 baked PDF → 分别 Sumatra fit / Sumatra noscale → 量 artifact 几何对比。
生产命令 = `buildPrintSettings` 1:1（fit:'contain' → fit；fit:'none' → noscale），消除复刻漂移。

| Case | 场景 | 命令（fit / noscale） |
|---|---|---|
| A3-01 | portrait A4 + portrait content | `disable-auto-rotation,fit/noscale,paper=a4` |
| A3-02 | landscape A4 + landscape content | `landscape,fit/noscale,paper=a4` |
| A3-03 | 横票→竖纸（layoutRotation=-90，烤进 bake） | `disable-auto-rotation,fit/noscale,paper=a4` |
| A3-04 | portrait content + landscape paper（反向冲突） | `landscape,fit/noscale,paper=a4` |
| A3-07 | margin 极限（内容接近纸边缘） | `disable-auto-rotation,fit/noscale,paper=a4` |

**实测结果（真实 Sumatra + Wondershare capture，全部 PASS）**：

| Case | 物理尺寸差 | bbox drift max | center drift |
|---|---|---|---|
| A3-01 | 0.00mm | 0.16mm | 0.09mm |
| A3-02 | 0.00mm | 0.09mm | 0.04mm |
| A3-03 | 0.00mm | 0.09mm | 0.04mm |
| A3-04 | 0.00mm | 0.08mm | 0.06mm |
| A3-07 | 0.00mm | 0.09mm | 0.04mm |

容差：bbox drift ≤ 0.5mm / center drift ≤ 1mm / 尺寸 ±1mm。**全部远低于容差**（0.08-0.16mm = 驱动舍入级），物理尺寸零差异（printer DEVMODE / paper command 未引入尺寸变化——用户关注的历史变量已覆盖）。

**结论：noscale == fit（等价证明成立）**——MediaBox==paper 时 Sumatra 的 fit 就是 no-op，切 noscale 不改变任何几何。

## 3. 4-2b-2b — production switch（单独 commit）

`electron/main.js` print-source-file bake 分支：bake 成功后

```js
printSettings = { ...(settings || {}), scalePolicy: 'none' }   // → noscale
```

**条件分支（rollback 极易）**：
```js
if (bakeEnabled) {           // hasExecutionPlacement
  bake → 成功 → noscale
         ↓ 降级 → 原路径 fit
} else if (hasMargins...) {  // legacy 路径 unchanged
  pdfMargin（scalePolicy 逻辑不变）
}
```

- **不全局替换**：legacy 路径（无 placement / OFD / 图片 / bake 降级）完全不变。
- **新对象 override，不 mutate settings**（G-C1-C-1）。
- scalePolicy:'none' → normalize → `noscale`（print-settings.js 既有映射，零新增）。

**生产 gate（placementBakeProductionGate.mjs 更新为 4-2b-2 语义）端到端 PASS**：
- 守卫反转：bake 成功路径**必须**含 `scalePolicy:'none'`（切片定位 bake 成功块边界）
- noscale artifact：209.97×297.1mm /Rotate=0，逐边增量 max 0.17mm（<0.5mm），中心漂移 0.89mm

## 4. 回归

- gate 套件 **77/77**；4 guard 全 PASS；sumatraNoScaleGate 5/5；placementBakeProductionGate 端到端 PASS。
- ⚠️ 4-2b-1 gate 的守卫语义反转是**预期演进**（4-2b-1 冻结「保留 fit」→ 4-2b-2 冻结「bake 成功切 noscale」）；4-2b-1 的 fit 证明已由 4-2b-2a Gate 的 fit 列继续覆盖。

## 5. 下一步

- **V-04-rot90**（margin Gate 侧 pending）可重新评估：noscale + 旋转烤进 bake 已消除「非正方形纸 rotate 必裁切」的 D2 风险前提。
- Phase 1-B Step 4（删 add-pdf-margins.py）：source 轨 PDF+placement 已不经过 pdfMargin（4-2b-1 起）；OFD/图片路径仍依赖——删除前需确认这些路径的替代。
- 生产验证建议：真实打印机打一张横票竖纸，人工确认 noscale 输出与预览一致。
