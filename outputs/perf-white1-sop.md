# PERF-WHITE-1 — Baseline Evidence Gate 执行协议（Gate 0）

> 状态：**探针已埋、自测 8/8 通过、生产构建通过**（182 modules，无新增 warning）。
> 范围冻结（按审查意见）：只观测、不改业务逻辑、不删 console、不改导入流程。
> 本阶段唯一目标：拿到真实 T0–T7 与六类计数器，为 Gate 1（A1）提供数据归因。

---

## 1. 探针开关（运行时，无需重新构建）

探针默认关闭（模块顶层读 `localStorage`，无 key 时全部 no-op，生产零开销）。
**开启方式**：在应用内 DevTools Console 执行一次，然后**完全重启应用**（确保模块顶层 mode 读取生效）：

```js
localStorage.setItem('FAPIAOGO_PERF_PROBE', '1')          // 采集
// 或 'clipboard'：结算时额外尝试写入剪贴板（DevTools OFF 环境取数兜底）
```

**关闭方式**：

```js
localStorage.removeItem('FAPIAOGO_PERF_PROBE')
```

运行时开关：`window.__perfProbe.enable('1') / .disable() / .isEnabled() / .dump()`

---

## 2. 运行协议（必须逐条遵守）

| # | 要求 | 理由 |
|---|------|------|
| 1 | 用**生产构建**跑（`npm run build` 产物 / 打包版），**不要用 dev 模式** | React dev 模式有额外检查，渲染慢 2–5 倍，绝对时长失真 |
| 2 | **DevTools 全程关闭** | console.log 在 DevTools 打开时经 IPC 成本放大 10–50 倍，直接污染被测窗口 |
| 3 | 每数据集 **3 runs，取 median** | 消除机器抖动 |
| 4 | 数据集：**S-200**（200 张混合 PDF）+ **S-200-OFD**（200 张含 OFD/图片） | 覆盖两条后端路径（ImportScale batch / fallback parseWorker） |
| 5 | 每次 run 之间**完全重启应用** | 清空 session 状态与 `fileRotations` 等会话内变量 |
| 6 | 每次 run 前清空 localStorage 里的旧报告（可选） | 避免误读旧数据 |

**执行顺序**：开启探针 → 重启 → 导入 200 张 → 等待 ≥6 秒（探针在 T5+6s 自动结算）→ 重启或开 DevTools 取数 → 记录 → 重复 3 次 → 换数据集。

---

## 3. 取数方式（按优先级）

1. **`window.__perfProbe.summaryText()`** —— 单行表格摘要，直接贴对比表（DevTools Console）
2. **`JSON.parse(localStorage.getItem('FAPIAOGO_PERF_REPORT'))`** —— 完整报告（marks/counters/durations/longTasks）
3. **`window.__perfProbe.dump()`** —— 打印摘要 + 返回完整报告

---

## 4. 数据记录模板（每个 run 一行）

| runId | label | fileCount | WHITE_SCREEN T5→T6 | PAINT_GAP T6→T6p | whiteToPaint T5→T6p | PREVIEW_LAG T5→T7 | split | parse | hydrate | seal | dismissDelay | LT总n/忙ms | 白屏窗LT n/忙ms |
|-------|-------|-----------|--------------------|-------------------|---------------------|--------------------|-------|-------|---------|------|--------------|------------|----------------|
| S-200-r1 | | 200 | | | | | | | | | | | |
| S-200-r2 | | 200 | | | | | | | | | | | |
| S-200-r3 | | 200 | | | | | | | | | | | |
| **median** | | 200 | **★** | | | | | | | | | | |
| S-200-OFD-r1…r3 | | 200 | | | | | | | | | | | |
| **median** | | 200 | **★** | | | | | | | | | | |

计数器/时长明细（完整报告里的 `counters` 与 `durations`）：

| 指标 | 含义 | 判读 |
|------|------|------|
| `setFiles` | files 状态更新次数 | 渲染风暴基数，应≈applySort |
| `applySort` | 全量排序执行次数 | ≫setFiles 说明排序被重复触发 |
| `invoiceDocumentToRow` | 派生路径单文档调用次数 | N=200 时基数；×每次派生 |
| `renderPathConsoleLog` | 渲染期那条 console.log 的**实际执行次数** | ★ 与 `invoiceDocumentsToRows` 累计时长对照 → 回答「console.log 是否主因」 |
| `invoiceDocumentsToRows` dur | 单次派生累计/最大/平均 ms | ★ 派生成本 |
| `buildDocumentViewModel` dur | 缓存 miss 时的派生成本 | |
| `selectDocumentRows` dur | App 展示行选择成本 | |
| `importHistoryQuery` | db.getImportHistory 查询数（含条数） | 应为 1 批（200 条） |
| `importHistoryWrite` | 命中写回次数（每次触发 Map 重建+重排） | ★ 重复重排证据 |
| `handlePreview` | 预览触发次数（含自动预览） | ★ 自动预览是否反复触发 |
| longTasks | 全窗口/白屏窗口长任务数+忙 ms | ★ 主线程阻塞实证 |

---

## 5. Gate 1 决策规则（拿到 median 后）

```
WHITE_SCREEN (T5→T6) median < 500ms
   └─ ✅ A1 + A2 完成后停止（不再重构 O(N²)）
WHITE_SCREEN median > 500ms
   └─ 按 Profile 分支定位，一次只改一个变量：
        derive 重（invoiceDocumentsToRows/buildDocumentViewModel 累计时长占比高）
            → A3 回包合并 / A4 fileKeysSig useMemo / B1 Map 索引
        network 尾（parse 段长 / importHistoryQuery 批数多）
            → A3 importHistory 批量接口 / B2 metadata 并发池
        preview 重（PREVIEW_LAG 大 / handlePreview 次数≫1）
            → B3 自动预览防抖
        backend 重（T1→T2 大且后端仍在跑）
            → C 组 /results 轻量视图 + 进度语义
```

**关键判读陷阱**：
- `renderPathConsoleLog` 大 ≠ console.log 是主因：必须结合 `invoiceDocumentsToRows` 的 `total` 时长与白屏窗口 longTask 忙 ms。若 console.log 计数大但派生 total 小、白屏窗口 LT 忙 ms 低 → 排除 console.log，A1 降级为顺手清理。
- DevTools OFF 时 console.log 的 IPC 成本显著低于 DevTools 打开——**所有 run 必须同一 DevTools 状态**。

---

## 6. 探针自身行为说明（审查透明）

- 探针**唯一**输出：结算时一条 `console.log('[PERF_REPORT]', ...)`，发生在 T5+6s，**不在被测窗口内**，不污染测量。
- 探针不打任何 per-file 日志；关闭态全部 `if (!mode) return` 守卫，零开销。
- `T4`（进度 100%）会清除 T6/T6p/T7 锚点——导入过程中占位符导致 FileList commit / 预览渲染不会污染白屏窗口测量。
- longtask 观测上限 300 条；环境不支持时 `supported:false`，其余指标不受影响。
- 若某 run 未出 T7（预览 6s 内未到），`previewLagMs:null`，其余 KPI 仍有效——记录时标注即可。
