# D3-0 / D3-1: Export RenderCommand Integration — Topology Audit + Boundary Freeze

> D3-0 = 只读拓扑审计（确认 Export 缺口性质）；D3-1 = 冻结 Export RenderCommand schema。
> 本文档是 D3 的 Boundary-freeze 产物，仅 docs，无代码变更。
> 配套冻结索引：docs/architecture/d-phase-backlog.md（D3 项）。

---

## 1. D3-0 Topology Findings（均附代码证据）

### 1.1 Export 当前入口
`frontend/src/hooks/useExport.js:184` `handleExportPdf`：
- 仅 `POST /api/export-pdf` + 发 `files:[{path,name}]` + 消费 SSE 进度。
- **前端对 Export 零几何计算、零 RenderCommand。**

### 1.2 后端 Export Executor（backend/services/pdf_handlers/pdf_handler.py）
- `export_to_pdf`（L30-59）：PDF → **直接写源字节**（lossless，不重编码）。
- `export_merge`（L61-86）：`target_doc.insert_pdf(src_doc)` —— **源页原样插入，不重渲/不重 fit/不重旋**。
- 非 PDF 源（image/ofd handler）后端自己光栅化，但**也不消费前端 RenderCommand**，是后端本地逻辑。
- 结论：**Export 全格式都完全不消费前端 RenderCommand**。PDF 无损透传，image/OFD 后端自带几何重渲。

### 1.3 Preview Producer 形状（Export 可直接复用）
`renderers.js:734-749` `_buildComposeCommand` 产出：
```js
{
  version: 1,
  paper,                                 // validateRenderCommand 要求 truthy
  rotatedBounds: { width, height },      // 旋转后内容包围盒
  placement: { scale, offsetX, offsetY },// 唯一几何来源 createPlacement 算出
  contentRotation,                       // 内容旋转角（executor 施加）
  rotation: 0,                           // [LEGACY Wire] 兼容字段，恒 0
  clip: { x, y, width, height },         // === contentRect 几何边界
}
```
与 `validateRenderCommand` 契约一致；`buildSingleFileRenderCommand`(`singleFileRenderCommand.js`) 同形。
**Export 若做 Producer，应复用此形状 + `createPlacement`，不应新造 `calculateFitScale`。**

### 1.4 fit 原始泄漏现状（D2 未完成信号）
`layout.js:145/155` `calculateFitScale`/`calculateCenteredPosition` 在 `RenderLayoutFactory.buildRenderCommand`（L182-183）**生产在用** —— `usePreview.js:11` import 的 **RE/V17 预览路径**。
当前 fit 原始有**两套生产实现**：`createPlacement`（merge/single-file 预览，C3-2+D1 已接）vs `calculateFitScale`（RE 预览，仍活）。**D2 目标（单一 fit 原始）尚未达成**，但不阻塞 D3。

---

## 2. 架构分叉与决策

D3-0 发现：Export 当前**不是 RenderCommand 的消费者，而是另一个世界**（PDF 透传 / image·OFD 后端重渲）。
原预设"D3 = 防止 Export 重算几何"的前提不成立——Export 现在根本不算几何。

**用户拍板（混合路线）：**
> Export 接入 RenderCommand，但**保留 PDF native passthrough**。
> RenderCommand 管几何，不管输出介质。
> 同一套布局规则，不一定同一种输出介质。

**不选择「全部渲染走 RenderCommand」的原因**：PDF 强行走 `RenderCommand→Canvas→Image→PDF` 会把矢量降级为 300dpi 图片，导致 ❌ 文字变图 / ❌ OCR 丢失 / ❌ 体积膨胀 / ❌ 导出变慢。架构统一不应以牺牲 PDF 导出质量为代价。

**一致性目标修正**：从像素级 `Preview = Export = Print` 调整为 `Preview geometry ≡ Export placement semantics`（同布局规则，异输出介质）。

---

## 3. 冻结的 D3 Boundary

```
                    RenderCommand
                          |
           +--------------+--------------+
           |                             |
           v                             v
     Preview Executor              Raster Export Executor
     Canvas                        PNG/JPEG/PDF image
   PDF Export Executor
   直接: source PDF pages insert_pdf()   (不走 RenderCommand)
```

**分流规则（明确了才动手）：**
- **Case 1 单 PDF 导出**：保持 `insert_pdf`，不用 RenderCommand。
- **Case 2 PDF 合并**：保持 `insert_pdf`，不用 RenderCommand。
- **Case 3 一页多票排版**（如 A5 纸排 发票1/发票2）：此处已是重新排版（非 PDF copy），**必须走 RenderCommand**（复用 `_buildComposeCommand`）。
- **Case 4 图片/OFD**：后端当前自算 fit/rotation，**必须迁移**为 `frontend producer → RenderCommand → backend executor`；后端 executor 不再计算布局。

**铁律**：RenderCommand 成为几何唯一来源；Export 不拥有 fit/rotation 计算权；PDF native passthrough 不受损。

---

## 4. 冻结的 Export RenderCommand Schema（D3-1）

**不复定义，直接复用** Preview Producer 形状（`_buildComposeCommand` / `buildSingleFileRenderCommand`）：

| 字段 | 类型 | 说明 | 对 Export 的充分性 |
|---|---|---|---|
| `version` | `1` | 契约版本 | 后端 validate 拒绝未知版本 |
| `paper` | object | PaperLayout 上下文（truthy） | 必需，供 executor 取纸张尺寸 |
| `rotatedBounds` | `{w,h}` | 旋转后内容包围盒 | 表达 90/270 交换 |
| `placement` | `{scale,offsetX,offsetY}` | 由 `createPlacement` 唯一算出 | 表达 fit/居中，**禁止调用方自算** |
| `contentRotation` | `0\|90\|180\|270` | 内容旋转角 | executor 施加旋转 |
| `rotation` | `0` | [LEGACY Wire] 兼容字段 | 恒 0 |
| `clip` | `{x,y,w,h}` | === contentRect 几何边界 | 裁剪区域，绝不透出裸 margin/dpi |

对 **image / OFD / merge-raster** 三类 Export 消费者，此 schema **充分**（几何全部由 `createPlacement` 推导，executor 只消费）。

---

## 5. D3 子提交计划（atomic discipline）

- **D3-1**（本本文档）：冻结 Export RenderCommand schema + boundary。docs-only。
- **D3-2** Export Render Producer（additive）：新增前端 producer，复用 `createPlacement` / `buildSingleFileRenderCommand` / `_buildComposeCommand`；**禁止** `calculateFitScale` / `calculateCenteredPosition`；配套 node-safe contract test（锁 shape / rotation / placement / no-dpi-leak）。
- **D3-3** Backend Export Executor 接收 command：新增 `POST /api/export-render { renderCommands:[] }`，后端只做 `command → canvas → pdf`，**不计算布局**；image/OFD 路径从后端自算 fit 迁移到消费 command。

---

## 6. No-regression contract

- PDF 单/合并导出：行为不变（仍 `insert_pdf`，输出字节级一致，有 backend 现有 test 守护）。
- RenderCommand 形状：与 Preview/Print 同契约（composePlacement / rasterContract / mergeFactory / singleFileRenderCommand 测试绿）。
- 禁止项：Export 路径不得出现 `calculateFitScale` / `calculateCenteredPosition` / `ctx.translate` / `ctx.rotate` / `ctx.drawImage`（除 backend executor 内合法 executor 行为）。
- 验收：`vite build` 绿 + 前端 contract test 绿 + 后端 export test 绿。

---

## 7. D2 状态说明

D3-0 证实 **D2 不能算完成**：`RenderLayoutFactory.calculateFitScale` 在 RE 预览路径仍活（生产在用）。
但**不阻塞 D3**——只要 D3-2 的 Export Producer 复用 `createPlacement`、不造第三套 fit 原始。
建议顺序（与用户拍板一致）：`D1✅ → D3-0✅ → D3 接入 Export → D2 清理 RE fit → D4 删除旧 renderer`。
D2 留到最后 ≠ 已完成；待 D3 暴露所有仍依赖旧 fit 的位置后统一清理。
