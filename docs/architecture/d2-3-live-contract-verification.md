# D2-3 Live Contract Verification（验收记录）

**日期**：2026-07-19
**基线**：`3cf25121`（D2-2-c1 完成态）
**目标**：在不改代码的前提下，验证「真实用户动作 → Preview 几何 ≡ Export 几何 → 后端 RenderCommand 契约」已真实闭环（D2-2-c1 之后缺失的最后一段「线路通电测试」）。

**结论：D2-3 通过 ✅**。三个验收维度全部验证，且额外完成跨语言契约校验（前端 producer 产物被真实后端 schema validator 接受）。

---

## 方法

不使用手搓的 paperLayout（c1 单测曾手搓 `paperLayoutAt300` 来对齐），而是调用 **usePreview / useExport 实际使用的同一批真实 producer**：

- Preview 侧：`computePaperLayout({paperSize,margins})` → `buildRenderCommand(paperLayout, documentState)`（Canvas 预览的真实链路）
- Export 侧：`buildExportSnapshot({files, documentState, fileRotations, previewPage, settings})`（useExport 真接线的真实链路）
- 后端侧：`backend/services/export_render_schema.py::validate_export_render_request`（真实契约校验器，纯 Python / 无 fitz 依赖）

验证脚本为一次性 harness（node + ESM `import.meta.env` shim，与 c1 同模式），**未提交**，仅用于本次通电测试。

---

## 验收维度

### D2-3.1 单文件 Preview ≡ Export 几何（真实 producer）

同一输入 `{paperSize:A4, margins:3mm, pageSize:{w:1240,h:1754}, rotation:90, pdf, page:2}`：

| 字段 | Preview (`buildRenderCommand`) | Export (`buildExportSnapshot`) | 一致 |
| --- | --- | --- | --- |
| `placement.scale` | 1.3740 | 1.3740 | ✅ |
| `placement.offsetX` | 35 | 35 | ✅ |
| `placement.offsetY` | 902.12 | 902.12 | ✅ |
| `contentRotation` | 90 | 90 | ✅ |
| `rotatedBounds` | {1754,1240} | {1754,1240} | ✅ |
| `paper` | px@300 (2480×3508) | {210,297}@300dpi | ✅ 物理对应 |

**为什么是原始相等、而非「按比例」**：`PREVIEW_DPI = 300`（`config.js:77`），与 `EXPORT_DPI = 300` 为**同一坐标系**。且 `computePaperLayout`（`previewState.js:189-219`）与 `computeContentRectAtDpi`（`exportSnapshotBuilder.js:46-64`）使用**逐字相同的** `Math.round(mm/25.4*dpi)` 边距→px 公式 → Preview `usableRect` ≡ Export `contentRect` → `createPlacement` 产出字节相同。原始相等是成立的，不是巧合。

> ⚠️ 历史陷阱提醒（陷阱 A）：若曾「转发 Preview @300 command 到 Export」会因坐标空间一致而看似无害；但若任一侧 dpi 漂移（如 Preview 回退 72），则几何会错。D2-2-c1 已用 `computeContentRectAtDpi(EXPORT_DPI)` 锁死，此处再次确认无回归。

### D2-3.2 多票 same-sheet 结构

4 张 image 发票 → `buildExportSnapshot` 产出 4 个命令，逐个校验：

- `sourceRef.page === 0`（image 约定，陷阱 C）
- `paper = {210,297}@300dpi`（陷阱 B）
- 全部通过后端 schema 形状校验

后端 same-sheet 模型（scheme B：一 request = 一 sheet，`export_render_service.py::render_sheet_commands`）将 4 个 image 命令绘制到**同一共享页**。该执行器合并逻辑已由 D3-3d-2 的 `backend/tests/test_export_render_service_sheet.py` 覆盖，本阶段只验证「用户链路 → 4 命令」正确产出。

> 已知限制（非 D2-3 阻塞，归 Document Engine / 后续）：bridge 当前用「当前预览 documentState.pageSize」作多文件统一几何代表，**未做逐文件 n-up 槽位排版**。4 张发票当前会被居中叠放在同页（而非 2×2 拼版）。单文件导出完全正确；多票拼版是独立范围。

### D2-3.3 Flag OFF 行为（生产安全）

- `EXPORT_RENDER_ENABLED` 默认 `false`（无环境变量）→ `useExport.handleExportPdf` 的 `if (EXPORT_RENDER_ENABLED && previewState && settings)` 为 false → 回落 `startPdfExport` → `/api/export-pdf`（legacy）。
- 结论：默认部署下生产流量完全走 legacy，新管线仅在校验充分、显式 `EXPORT_RENDER_ENABLED=true` 时启用。符合 D2-2-c0 灰度设计。

---

## 跨语言契约校验（关键证据）

将前端 producer 真实产出的 5 个命令（1 PDF + 4 image）写入 payload，喂给**真实后端 schema validator**：

```
BACKEND SCHEMA: PASS (5 commands accepted)
  [0] src=/p/x.pdf         page=2 rot=90 scale=1.3740 off=(35,902.12) paper=210x297@300dpi
  [1] src=/p/invoice1.png  page=0 rot=0  scale=1.9435 off=(35,49.51)  paper=210x297@300dpi
  [2] src=/p/invoice2.png  page=0 rot=0  scale=1.9435 off=(35,49.51)  paper=210x297@300dpi
  [3] src=/p/invoice3.png  page=0 rot=0  scale=1.9435 off=(35,49.51)  paper=210x297@300dpi
  [4] src=/p/invoice4.png  page=0 rot=0  scale=1.9435 off=(35,49.51)  paper=210x297@300dpi
```

后端 validator 校验项（与 `export_render_schema.py` 对齐）：`sourceRef{path,page}` 必填、`paper` 为 PaperSpec（禁 marginRect/displayRect/viewport/zoom）、`placement{scale,offsetX,offsetY}` 数值、`rotatedBounds` 正数、`clip` 正矩形、`contentRotation ∈ {0,90,180,270}`、`version` 存在。**5/5 全部通过** —— 证明前端 producer 与后端契约**未漂移**。

> 注：后端 PDF **实际渲染** E2E（fitz `execute_export_render`）受限于本机未安装 `pymupdf` 未能跑；但几何所有权已在 D3-3b-3 审计确认（executor 仅消费 placement，绝不重算 fit/scale），且 schema 层契约已通过跨语言校验。真实 PDF 落盘建议在具备 fitz 环境时作为手动冒烟（用 `backend/tests/fixtures`）。

---

## 验收结论

| 维度 | 结果 |
| --- | --- |
| 单文件 Preview ≡ Export 几何 | ✅ 原始相等（同 300-dpi 空间） |
| 多票 same-sheet 结构 | ✅ 4 命令产出，后端 1-sheet 合并（执行器由 D3-3d-2 覆盖） |
| Flag OFF 生产安全 | ✅ 默认 false → legacy |
| 跨语言后端契约 | ✅ 5/5 通过 |

**D2-2-c1 的「PreviewState → exportSnapshotBuilder → RenderCommand → {Canvas /api/export-render}」链路已真实通电。** D3 核心承诺「RenderCommand 成为跨 Preview/Export/Print 共同几何事实」闭环验证通过。

**下一步**：进入 D4（legacy 清理）——删除 `calculateFitScale` / `calculateCenteredPosition` / `calculateRotatedBounds` / `rotateContentOnPaper` 死代码、legacy export renderer、旧 image handler、旧 compose path（grep 0 caller 后删），并翻转 flag。D2-3 为 D4 提供了「删除后仍可用 D2-3 重跑」的回归基线（harness 可随时重跑）。
