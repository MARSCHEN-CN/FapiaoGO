# D4-0 Legacy Ownership Audit（删除名单锁定）

> 承接 D2-3 验收通过（`0d5cd299`）。D4 阶段第一刀：**只读审计，不删任何代码**。
> 目标：在 D4-1 动刀前，把"谁还活着 / 谁已死 / 谁绝不能碰"三张地图锁死，避免误删仍被隐藏路径使用的东西。
> 方法：`grep` 全仓（frontend + backend）符号引用，读取定义与 import 边界，零代码改动。
> 当前 HEAD：`0d5cd299`。`EXPORT_RENDER_ENABLED` 默认 `false`（legacy 主用）。

---

## 结论速览

| 类别 | 符号 | 状态 | D4-1 动作 |
| --- | --- | --- | --- |
| fit legacy | `calculateFitScale` / `calculateCenteredPosition` / `calculateRotatedBounds` | 💀 死（0 production caller） | 删 layout.js 定义 |
| canvas legacy | `rotateContentOnPaper` | 💀 死（0 调用点，但 2 处死 import） | 删函数 **+ 2 处 import** |
| export legacy | `/api/export-pdf` / `PdfExportService` / `startPdfExport` | 🟢 活跃（flag=false 主用） | **D4-1 不动**，归 D4-2/D4-3 |
| 卫生项 | `RenderLayoutFactory.test.js`（pre坏测试） | ⚠️ 引用不存在导出 | D4 单独处理 |
| 卫生项 | 5 个未跟踪废弃 md | ⚠️ 废弃方向 | D4 移 `docs/archive/` 或删 |

---

## ① fit legacy —— 三个死函数，确认零 caller

**定义位置**：`frontend/src/layout.js`
- `calculateFitScale` —— `layout.js:145-153`
- `calculateCenteredPosition` —— `layout.js:155-166`
- `calculateRotatedBounds` —— `layout.js:168-176`

**互相依赖**：无。`calculateCenteredPosition` 把 `scale` 当入参（不回调 `calculateFitScale`）；`calculateRotatedBounds` 完全独立。三者均为纯函数，不读模块级状态。

**生产 caller（grep 全仓）**：**0**。
- 唯一相关命中是 `frontend/src/layout/renderLayoutFactoryPlacement.test.js:30-31` —— 这些是**静态守卫断言**，检查 `RenderLayoutFactory.js` 源码**不含** `calculateFitScale`/`calculateCenteredPosition`（即 D2-1 已切断引用）。属"证明已死"，非使用。
- `frontend/src/layout/exportRenderCommand.js:14` —— 仅注释"禁止 calculateFitScale…"，非引用。
- 其余命中全部在 `docs/`、`backups/`、gitignored 构建产物，均非源码 caller。

**活 import 检查**：`renderers.js:8` 从 `./layout` 导入的是 `createLayout / normalizeLayoutItem / normalizeLayoutItems / getPaperPixels / PRINT_SAFE_MARGIN_MM / PRINTER_PROFILES / getPrintableArea` —— **不含**这三个死函数。故删 145-176 不会破坏 `renderers.js` 的 layout 导入。

**D4-1 删除目标（精确）**：`layout.js` 删除行 145-176（三个函数体 + 段间空行 154/167），保留前序函数（`}@143`）与后续 `export const LAYOUT_STRATEGIES@178`。删除后顺手收掉 144/177 空行。

**测试影响**：`renderLayoutFactoryPlacement.test.js` 读的是 `RenderLayoutFactory.js` 源（D2-1 已 36 子测试绿即证明），与 `layout.js` 无关 → D4-1 不影响该测试。

---

## ② canvas legacy rotate —— `rotateContentOnPaper`：**函数 + 2 处死 import 必须一起删**

**定义位置**：`frontend/src/utils/canvasUtils.js`
- `rotateContentOnPaper` —— `canvasUtils.js:93-131`（含上方 JSDoc `84-92`）。

**调用点（grep 全仓）**：**0**。`backups/stage1-core/*.bak` 中的引用是备份文件，非源码。

**死 import（关键陷阱）**：
- `frontend/src/renderers.js:7` —— `import { rotateContentOnPaper } from './utils/canvasUtils'`
- `frontend/src/hooks/usePrint.js:6` —— `import { rotateContentOnPaper } from '../utils/canvasUtils'`

两处**只 import、不调用**。若 D4-1 只删 `canvasUtils.js` 里的函数而漏掉这两行，则留下悬空 import → 构建失败（ESM 具名导入解析错误）。

**D4-1 删除目标（精确，三刀）**：
1. `canvasUtils.js` 删除 `rotateContentOnPaper`（含 JSDoc，`84-131` 区间）。
2. `renderers.js:7` 整行删除。
3. `usePrint.js:6` 整行删除。

完成后 `canvasUtils.js` 其余导出（`clearCanvas` 等）不受影响；`renderers.js` / `usePrint.js` 的其余 import 不受影响。

---

## ③ export legacy —— **D4-1 严禁触碰**（活路径，flag=false 仍主用）

以下在当前部署下是**真实生产流量路径**，D4-1 不动：

**后端**（`backend/app.py`）：
- `from services.pdf_export import PdfExportService, ExportItem` —— `app.py:1246`
- `_export_pdf_service = PdfExportService()` —— `app.py:1251`
- `POST /api/export-pdf` —— `app.py:1300`
- `GET /api/export-pdf/events/<task_id>` —— `app.py:1329`
- `POST /api/export-pdf/cancel` —— `app.py:1352`
- `services/pdf_export.py:53` —— `class PdfExportService`

**前端**（`frontend/src`）：
- `ExportService.js:238` `startPdfExport`；`:262` POST `/api/export-pdf`；`:288` SSE；`:397` cancel
- `useExport.js:2` import；`:155` 实际调用 `startPdfExport`（flag=false 时走此分支）
- `models/ExportTask.js:8` 描述 `/api/export-pdf` body
- `services/EventStreamConsumer.js:35` 文档引用

**后端测试**（活，绑定 legacy 契约）：
- `backend/tests/test_export_post_contract.py`、`test_export_pdf_endpoint.py`、`test_pdf_export_service.py`

**路线约束（来自 D2-2-c0 用户拍板）**：
- **D4-2**：`EXPORT_RENDER_ENABLED` 默认翻 `true`，但保留 `else → startPdfExport` fallback 分支。
- **D4-3**：观察周期后（非现在）再删 `/api/export-pdf` + `PdfExportService` + `startPdfExport` + 相关后端测试。你的项目是实际工具，保留 fallback 是工程保险。

---

## 🟡 卫生项（归 D4，但**不进 D4-1**）

### H1. `RenderLayoutFactory.test.js` 引用不存在的导出（pre坏测试）
`frontend/src/layout/RenderLayoutFactory.test.js:3`：
```js
import { buildRenderLayout, emptyRenderLayout } from './RenderLayoutFactory.js'
```
`RenderLayoutFactory.js` **不导出** `buildRenderLayout` / `emptyRenderLayout`（该 API 已被 `createPlacement` 驱动的 `buildRenderCommand` 取代）。该测试文件引用已消失的 API，是早期迁移遗留的死测试。
- **建议**：D4 阶段单独删除此文件（或改写为基于 `buildRenderCommand`/`createPlacement` 的守卫）。不要并入 D4-1 的几何死代码删除，避免噪音。
- **风险**：若测试 runner 全局 globs `**/*.test.js`，此文件会在 import 阶段抛 `does not provide an export named 'buildRenderLayout'` → 整个文件失败。需在 D4 清理，且清理后应确认 `node --test` 全绿。

### H2. 5 个未跟踪废弃架构 md
`git status` 显示未跟踪：
```
docs/architecture/export-boundary-audit.md
docs/architecture/export-pipeline-audit.md
docs/architecture/export-pipeline-status.md
docs/architecture/print-pipeline-audit.md
docs/architecture/render-task-boundary-audit.md
```
其中 `render-task-boundary-audit.md` 明确属于已放弃的 RenderTask 抽取方向（D2-2-c1 已改用薄桥方案取代）。
- **建议**：移入 `docs/archive/`（保留追溯）或删除。与 D4-1 的源码删除物理隔离，避免一次 commit 混入文档噪音。

### H3. gitignored 构建产物含旧符号（非阻塞）
`frontend/dist/assets/index-BFPvvB2s.js`、`frontend/build-tmp/assets/index-*.js` 仍含 `calculateFitScale`/`rotateContentOnPaper` 等旧符号。
- 二者均 `dist/` / `build-tmp/`（gitignored），**不进版本库**，不影响 D4-1 源码删除。
- 下次 `vite build` 自然重生，无需手动清理。仅记录，免得有人误以为"删了函数还在 bundle"。

---

## ✅ D4-1 锁定删除名单（机械可执行）

```
frontend/src/layout.js
  - 删除 calculateFitScale      (145-153)
  - 删除 calculateCenteredPosition (155-166)
  - 删除 calculateRotatedBounds   (168-176)
  - 收尾 144/177 空行

frontend/src/utils/canvasUtils.js
  - 删除 rotateContentOnPaper（含 JSDoc，约 84-131）

frontend/src/renderers.js
  - 删除 import 行 7: import { rotateContentOnPaper } from './utils/canvasUtils'

frontend/src/hooks/usePrint.js
  - 删除 import 行 6: import { rotateContentOnPaper } from '../utils/canvasUtils'
```

**D4-1 不动**：`/api/export-pdf`、`PdfExportService`、`startPdfExport`、`RenderLayoutFactory.test.js`、5 个废弃 md。

**D4-1 验收门槛**：
1. `grep -rn "calculateFitScale\|calculateCenteredPosition\|calculateRotatedBounds\|rotateContentOnPaper" frontend/src` → 仅剩注释/测试字符串，**0 活引用**。
2. `node --test`（或 vitest）→ 全绿（含 `renderLayoutFactoryPlacement.test.js` 静态守卫）。
3. `vite build` 通过（确认 2 处 import 已清，无悬空）。

---

## D4 阶段顺序（重申，不变）

```
D4-0  ownership audit   ← 本步（只读，锁名单）  ✅
D4-1  remove-legacy-geometry（死几何，flag 仍 false）  ⏳ 下一步
D4-2  enable-render-export（flag 翻 true，留 fallback）
D4-3  legacy removal（观察后删 /api/export-pdf 等，最后做）
```

D2-3 验收记录（`d2-3-live-contract-verification.md`）即 D4 各步的回归基线——任何一步删完都可重跑那段 live contract harness 验证"Preview≡Export 几何不变"。
