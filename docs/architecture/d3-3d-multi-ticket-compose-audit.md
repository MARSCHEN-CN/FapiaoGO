# D3-3d Multi-ticket compose topology audit (D3-3d-0, read-only)

Date: 2026-07-19
Scope: D3-3d-0 — 只读确认三处，不改代码。为 D3-3d-1 入实施提供前置事实。

## 背景

D3-3b-3 已闭环单源 export（Case ① image→executor / ② pdf→insert_pdf）。D3-3d 目标
是 Case ③：一页多票重排版（如 A4 排 4 张发票），让
`Preview(commands[])` 与 `Export(commands[])` 共用同一 RenderCommand 消费端。

本审计只读确认三条进入 D3-3d-1 的前置事实：
1. `_buildComposeCommand` 形状是否满足 D3 schema；
2. compose 预览路径是否已脱离 `calculateFitScale`（确认无 `compose preview ≠ export compose` 分歧）；
3. 后端多 command 页合成能力（一 command=一页，还是 commands[] 共享一页）。

---

## ① `_buildComposeCommand` 形状 vs D3 schema

位置：`frontend/src/renderers.js:734-749`（live 生产预览 producer），L763
`_buildComposeCommands` 批量产出，L861 compose 预览调用，L1123 print 调用。

产出形状：
```js
{
  version: 1,
  paper: paper || null,
  rotatedBounds: p.rotatedBounds,
  placement: { scale: p.scale, offsetX: p.offsetX, offsetY: p.offsetY },
  contentRotation: rotate,
  rotation: 0,
  clip: p.clip,
}
```
`createPlacement` 唯一几何来源，`clip === contentRect`（C1/C4 合规）。

对照 D3-3a schema（`backend/services/export_render_schema.py` `_validate_command`）：

| 字段 | schema 要求 | `_buildComposeCommand` | 结论 |
|---|---|---|---|
| version | 必须 | `1` | ✅ |
| paper | PaperSpec 非 null | `paper \|\| null`（预览可 null） | ⚠️ 见下 |
| sourceRef | {path,page} 非 null | **无此字段** | ⚠️ 见下 |
| placement.scale/offsetX/offsetY | 数字 | ✅ | ✅ |
| rotatedBounds | 正数 size | ✅ | ✅ |
| clip | 正 rect | ✅ | ✅ |
| contentRotation | 0/90/180/270 | ✅ | ✅ |
| rotation | 整数 | `0` | ✅ |

**几何形状 100% 满足 D3 schema。** 两个 export-time 字段（`sourceRef`、非 null `paper`）
在预览 producer 中不存在，是因为：
- 预览源是 live bitmap（ImageBitmap/canvas），无文件路径；
- compose 路径 `paper` 来自 `layout.page`（预览中可为 null）。

这正是 D3-3-0 / D3-3a 已确立的模式：**预览 producer 产出"几何命令"，
export caller 负责补 `sourceRef` 与真实 `paper`**。D3-3b-3 单源已按此闭环。

**关键利好**：D3-2 已存在专用 export producer `buildExportRenderCommands`
（`frontend/src/layout/exportRenderCommand.js:70-90`），字节同构 `_buildComposeCommand`
（同走 `createPlacement`、`clip === contentRect`、`sourceRef` 默认 `null` 待 caller 填）。
所以 D3-3d-1 **不需要新 producer**，直接复用 `buildExportRenderCommands` 即可。

✅ **① 结论：形状满足，无新几何 producer 需要。**

---

## ② compose 预览路径是否已脱离 `calculateFitScale`

担心的"是否有 `compose preview ≠ export compose`"——已确认 **不存在该分歧**。

`calculateFitScale` 唯一活的生产调用方：`frontend/src/layout/RenderLayoutFactory.js:17`
import，L182 调用；而 `RenderLayoutFactory` 由 `usePreview.js:11`（**RE/V17 预览路径**）消费。

compose / merge / print 预览路径：`_buildComposeCommand` → `createPlacement`
（renderers.js:739、L861、L1123；`mergeFactory` 也走 `createPlacement`）。整条 compose
链路**不 import 也不调用 `calculateFitScale`**。

因此：
- compose 预览 与 export compose 共用 `createPlacement` → 几何同源，无 divergence；
- `calculateFitScale` 泄漏**仅限 RE 预览路径**，属 D2 收敛范畴（已在
  `docs/architecture/d-phase-backlog.md` 与 `d3-export-rendercommand.md:39-40` 记录），
  与 D3-3d 无关，不阻塞。

✅ **② 结论：compose 路径干净；泄漏隔离在 RE 预览（D2），不应在 D3-3d 处理。**

---

## ③ 后端多 command 页合成能力

当前后端模型（`render_executor.py` + `export_render_service.py`）：

`render_command_to_page(doc, command, source_bytes)`（render_executor.py:70-136）
**内部调用 `doc.new_page(width=pw, height=ph)`**（L83），即 **一个 command = 一个 page**。

`execute_export_render(commands)`（export_render_service.py:71-85）对 `commands` 逐条循环，
每条约等于追加一页。

### Case ①/②（单源）：✅ 已工作
1 command → 1 page，正确。

### Case ③（一页多票）：🔴 当前不支持
"A4 排 4 张发票" = 4 个 command，每个 `paper` 相同（共享 A4）、各自 `clip`/`offset`
为 A4 上的 slot 绝对坐标。当前后端会把 4 个 command 渲染成 **4 个独立页面**，而非 4 票同页。

但**几何已正确**：per-command 的 `offset_x/offset_y` 与 `clip` 是相对共享 paper px 的
绝对坐标，`render_command_to_page` 的 `page.insert_image(target, ...)` 用的就是这些绝对坐标
（L134）。所以只要把"建页"从 executor 内部分离出来、由 service 决定"哪些 command 共享同一页"，
executor 的绘制数学**完全不用改**（零新 fit/scale/center/rotation）。

### 🔴 真正的阻塞点：缺 page-grouping 信号
frozen schema（`validate_export_render_request`）只接受扁平 `commands` 数组，无
"哪些 command 属于同一页"的信号。后端无法区分：
- "4 command = 1 页"（Case ③ compose）
- "2 command = 2 页"（Case ① 导出两张独立发票）

若按 `paper` 是否相同分组：两张独立 A4 单发票也可能同 paper，会被错误合并成一页。
所以 **paper 相等 ≠ 同页**，分组键不能靠 paper 推断。

→ 这是 D3-3d-1 必须解决的真实设计决策（见下方"待决策"）。executor 改造本身极窄
（把 `new_page` 移到 service、executor 接收已存在的 page），但**分组语义必须在 D3-3d-1 先定**，
否则后端无从落子。

### 几何复用度小结
- 不需要新 placement/fit 数学：`placement`/`clip` 已正确；
- 不需要改 schema 校验字段：每个 command 形状已满足；
- 需要：① executor 支持"绘制到 caller 提供的 page"；② service 按分组键把 command 集合
  映射到 fitz page；③ 分组键来源（schema 扩展 or 约定）。

---

## 待决策（交 D3-3d-1）

Case ③ 需要"N command → 1 page"信号。选项：

- **(A) schema 扩展**（需显式解冻 D3-3a）：请求体改为 `pages: [[cmd1,cmd2],[cmd3]]`，
  或扁平 `commands` 每条约带 `pageIndex`/`sheetId`。最显式，但触碰冻结 schema。
- **(B) 约定（不动 schema）**：单个 export-render 请求 = 一个输出 sheet（所有 command
  共享同一 paper 绘到一页）。多 compose 页（如 8 票→2 A4）前端拆成多个请求，或后续加 pageIndex。
  最小侵入，但牺牲"一次请求多页 compose"。
- **(C) 混合**：默认单 sheet（B）；若需多 compose 页，未来再扩展 (A)。

考虑到已明确"D3-3a schema 冻结、不要改 schema"，**推荐 D3-3d-1 先走 (B)**：把当前 request
语义锁为"一请求 = 一组合 sheet"，落 Case ③（一 A4 多票）。多 compose 页作为明确 follow-up
（届时再决定是否解冻 schema 加 `pageIndex`）。这样 D3-3d 不破 schema 冻结纪律，又能证明
"Preview(commands[]) ≡ Export(commands[]) 共用消费端"这一完整 D3 意义。

---

## 结论

- ① ✅ 形状满足 D3 schema，复用 `buildExportRenderCommands`，无新 producer。
- ② ✅ compose 路径干净，泄漏隔离在 RE 预览（D2 收敛，不在 D3-3d）。
- ③ 🔴 后端当前"一 command = 一页"，Case ③ 需"N command = 一页"；几何已正确、改造极窄，
  但**缺 page-grouping 信号**——这是 D3-3d-1 的前置决策（建议方案 B：一请求=一 sheet，不破 schema 冻结）。
