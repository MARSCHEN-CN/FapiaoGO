# P1-0 只读扫描报告：导入期 warm preview 改造安全边界

> 目标：确认 P1（取消导入完成自动 warm preview，保留按需渲染）是否安全、无隐藏功能依赖。
> 方法：纯只读扫描，未修改任何代码。所有结论均附文件:行号证据。

## 结论速览

| 检查项 | 结果 | 关键证据 |
| --- | --- | --- |
| ① warm_after_import 全部调用入口 | ✅ 仅 1 处 | `import_batch_manager.py:305` |
| ② preview 首次渲染完整链路 | ✅ 纯 on-demand | `api.py:70` → `engine.render` → cache hit/miss |
| ③ cache 生命周期 | ✅ warm 与 on-demand 同路径 | `engine.py:323` / `cache.py:56-65` |
| ④ 隐式依赖 warm 的 UI 状态 | ✅ 无依赖 | 前端 `src` 零 `warm` 引用；无 status 轮询接口 |

**总体判定：P1 可安全实施。去掉 import 期自动 warm 不产生任何功能回归，仅把"首次点击预览"从 cache HIT 退化为一次 on-demand MISS+raster（用户无感）。**

---

## ① `warm_after_import` 调用入口（全仓）

- 定义：`backend/render_engine/warmup.py:74` —— `def warm_after_import(self, files)`
- 唯一调用点：`backend/import_batch_manager.py:305`
  ```python
  self._warm_planner.warm_after_import([
      {"doc_id": doc.doc_id, "page_count": doc.page_count},
  ])
  ```
- `WarmPlanner` 实例化也仅在此处：`import_batch_manager.py:301-304`（惰性初始化，依赖全局 `engine/render_queue/render_cache` 单例）。
- `warm_after_import` 内部已有护栏 `MAX_WARM_FILES = 20`（`warmup.py:41,85`）：每批最多 20 个后台 raster，并非全量 warm。

**推论**：P1 只需让 `import_batch_manager.py:305` 这一行不执行，即可彻底停用导入期 warm。`warmup.py` 整文件与 `WarmPlanner` 类保留，能力不丢，符合"取消自动触发、保留能力"的既定意图。

---

## ② preview 首次渲染完整链路（on-demand 已验证）

用户点击预览时前端路径：
- `usePreview.js` 设置 `previewUrl = getRenderEnginePreviewUrl(...)`，`<img>` 加载该 URL（`usePreview.js:1532-1533`）。
- 后端 `/preview/<doc_id>` 路由：`backend/render_engine/api.py:70`，处理器 `preview()` 调用 `_render_and_respond` → `engine.render(...)`（`api.py:338`）。
- `engine.render` 入口即 cache 查找（`engine.py:323`）：
  - **HIT** → 直接返回缓存字节（`engine.py:330-332`），不进渲染。
  - **MISS** → `registry.get(doc_id)` 取文档 → `_render_page` 渲染 → `cache.put` 写回（`engine.py:334-352`）。

**关键结论**：warm 只是提前把 MISS 变成 HIT 的预填充手段。去掉 warm，用户首次点击只是走 MISS 分支现场渲染一次。**预览功能完全自洽，不依赖 warm 已完成。**

> 同链路另有 `/thumbnail/<doc_id>`（`api.py:154`）、`/render/<doc_id>`（`api.py:169`），均经 `engine.render` on-demand，与 warm 无关。

---

## ③ cache 生命周期

- 缓存实现：`backend/render_engine/cache.py` —— `RenderCache`（线程安全 TTL 缓存，`MAX_ENTRIES=1000`，`DEFAULT_TTL=3600s`）。
- `get` / `put` 均走同一 `make_cache_key`（`cache.py:152`），key 由 `doc_id | preset | page | vs_hash` 组成。
- warm 路径 `_warm_render`（`warmup.py:130`）与 on-demand 路径 `engine.render`（`engine.py:340`）**调用的是同一个 `engine.render`**，因此写入的是同一个 cache 槽位，key 完全一致（`warmup.py:37` 用 `_EMPTY_VS_HASH` 对齐空 view_state 的 hash）。
- 无独立 "warm cache" 概念，warm 不拥有 cache（`warmup.py:10` 设计约束明确："Warm does not own the cache"）。

**结论**：不存在"warm 专用缓存 / on-demand 专用缓存"两套体系，去掉 warm 不会留下孤立缓存或一致性问题。

---

## ④ 隐式依赖 warm 的 UI 状态（重点排查）

逐项排除：

1. **前端 `src` 中无任何 `warm` 相关引用**：全仓 grep `warm`（忽略 `dist/` 构建产物噪声）在 `frontend/src` 下零命中。warm 完全是后端 fire-and-forget，无前端耦合。
2. **无 "preview ready / warm status" 轮询接口**：`app.py` 中 grep `/preview | render_status | is_ready | warm_status | preview_status` 无对应路由（仅注释 `app.py:1096`）。`warmup.py:11` 设计约束明确："Warm does not interact with the frontend: no endpoint, no UI coupling."
3. **`previewLoading` 状态纯请求驱动**：`usePreview.js:59` 的 `previewLoading` 在发起预览请求时置 true、`<img>` onload 或 L2 缓存命中时置 false（`usePreview.js:1495`）。它等待的是"本次请求的图回来"，不等待"warm 完成"。
4. **`preview_status = not_ready` 概念当前不存在**：前端 grep `preview_status | not_ready | previewReady` 无命中。这说明用户设计稿中的"register resource + preview_status=not_ready"是**新增可选字段**，并非现有行为。

**重要纠偏（避免把优化改成交功能变化）**：
> 用户 P1 设计稿写了目标态 `preview_status = not_ready`，但代码里**根本没有这个字段，也没有任何消费者**。因此 P1 **不应引入 `preview_status`**——那会成为无人读取的死字段（scope creep，正是用户明确想避免的"误改功能"）。
> **P1 最小安全改造 = 仅停用 `import_batch_manager.py:305` 的 warm 触发，连 `preview_status` 都不加。**

---

## ⚠️ P1 实施的两条铁律（来自扫描）

1. **必须保留 `registry.open`（import_batch_manager.py:297），只删 warm 调用（L305）。**
   - `registry.open` 是 `/preview/{doc_id}` 可达的前置条件：它把 bytes 注册进 registry，使 `engine.render` 能 `registry.get(doc_id)` 取到文档（`engine.py:335-337`）。
   - 若误删 `registry.open`，预览会全部 404。**warm 调用（L305）与 registry 注册（L297）是两件事，P1 只动前者。**

2. **不要新增 `preview_status` 字段。**
   - 无消费者 = 死代码；且会诱使前端加"warming…"分支，扩大改动面。保留能力即可（`warmup.py` 保留），未来若需"显式预渲染 N 个"再单独议题。

---

## P1 推荐落地方式（二选一，均低风险）

| 方案 | 改动 | 优劣 |
| --- | --- | --- |
| **A. 加 feature flag（推荐）** | 新增配置 `ENABLE_IMPORT_WARMUP = False`（默认关），`import_batch_manager.py:305` 外包 `if` 判断 | 可运行时翻转、可灰度、保留能力、完全可逆；最符合"保留显式预热入口"意图 |
| **B. 直接注释/删除调用** | 删除/注释 `import_batch_manager.py:301-309` 的 warm 段 | 改动最小，但失去运行时开关；warmup.py 保留以备复用 |

建议选 **A**：一行配置默认关，日后验证无回归再考虑删代码；且便于 P1.5 打点时 A/B 对比 warm 开/关的导入耗时差异。

---

## 验收建议（P1 完成前）

- 手动：导入 1 个 PDF + 1 个图片 → 确认导入进度不卡、导入后不出现后台 raster 线程激增（日志搜 `[CACHE]` / `warm_render`）。
- 手动：导入后**首次**点击预览 → 确认正常出图（走 MISS 分支），无 404、无空白、无"loading 卡死"。
- 回归：多页 PDF 翻页预览（`?page=`）正常；旋转/预览缩放后图随 spec 变化（依赖 `engine.render` 的 spec_tag 纳入 cache key，与 warm 无关）。
- 日志断言：导入期应**不再**出现 `warm_render done` / `warmup skip` 日志（方案 A 关 flag 后）。

---

## 与立项备忘的关系

本报告是 `P-Render-Resource-Unification.md` 中 **P1** 的前置安全扫描。结论已可支撑直接进入 P1 实施（待 E-Export-2 收口后）。**P1.5（导入链路性能打点）仍独立必要**——本报告确认了 warm 的移除安全，但 warm 占导入总耗时的比例仍需 P1.5 量化，才能决定 P2/P3 排期。
