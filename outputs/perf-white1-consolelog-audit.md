# PERF-WHITE-1 — 渲染/导入路径 console.log 全量审计（Gate 0 补充）

> 目的：探针只计数了已知的 `invoiceDocumentViewModel.js:119` 一条渲染期裸日志。
> 本审计给出 **A1（删 console.log）的完整收益面**（代码事实，非推断），
> 供基线数据到达后精确评估 A1 范围。全部为 grep 实证，未改任何代码。

## 排除规则
- `frontend/src/dist_rc/**`（构建产物副本，非源码）
- `*.test.js / *.test.mjs / __tests__/**`（测试输出，与运行期无关）
- `perf/importPerfProbe.js`（探针自身唯一输出，Gate 0 已冻结）
- `usePrint.js / PrintPreviewCanvas.jsx / print/**`（打印场景，不在导入白屏窗口）

## A 类：白屏窗口（T5→T6）渲染/派生路径 —— 最高嫌疑

| 位置 | 标签 | 触发条件 | 量级 | 探针是否计数 |
|------|------|----------|------|--------------|
| `utils/invoiceDocumentViewModel.js:119` | `[invoiceDocumentToRow] 单页文档` | **每次派生** × 每份单页文档 | N=200 → 数千次 | ✅ `renderPathConsoleLog` |
| `components/PreviewCanvas.jsx:64` | `[DIAG-10 display layer]` | **每次预览渲染**（render 期） | 每次预览 | ❌（预览多在 T6 后，窗口外） |
| `hooks/usePreview.js:76` | `[DIAG-2 fileRotations changed]` | fileRotations 变化（导入期不变） | 罕见 | ❌ |
| `hooks/usePreview.js:652` | `[DIAG-9 pdfData loaded]` | 每次预览数据加载 | 每次预览 | ❌（同上） |

## B 类：导入期（T0→T5）console 风暴 —— 进度条语义 & T5 到达时间

| 位置 | 标签 | 触发条件 | 量级 | 说明 |
|------|------|----------|------|------|
| `hooks/useFileOps.js:918,922,961` | `[ADD DOCUMENT][assembly/new/gate-reject]` | **hydration/组装循环**内，每文档 | N=200 次量级 | T3 附近，拖慢 T2→T5 |
| `hooks/useFileOps.js:988,991` | `[SEAL DOCUMENT][assembly]` | 每 SEAL 文档 | N 次量级 | 同上 |
| `stores/ImportSessionStore.js:326` | `[IDENTITY-TRACE] addDocument: 成功` | 每次 addDocument | N 次量级 | 组装主路径 |
| `consumers/parseResultConsumer.js:45` | `[E1] consumeParseResult` | 每次消费解析结果 | N 次量级 | T0→T2 段 |
| `hooks/useFileOps.js:822-828` | `[hydrateChunk] warn` | 仅异常路径 | 少量 | 保留（诊断价值） |
| `hooks/useFileOps.js:365-383` | `[IMPORT_ADMISSION]` | 每次导入门控 | O(1)-O(N) | 一次导入少量 |

## C 类：一次性/错误路径 —— 保留（低风险）

- `App.jsx` 删除文件/去重日志、`db.js` 错误、各 catch 分支、`useFileOps.js:1196` drop 错误等。
- 原则：**错误与 warn 保留**（诊断价值），只审计 `console.log` 级裸日志。

## 对 A1 的范围结论（代码事实）

1. **白屏窗口内**的裸日志唯一稳定命中点 = `invoiceDocumentViewModel.js:119`，探针已精确计数 —— 基线可以直接归因。
2. **导入期**（T0→T5）存在约 4 处 ×N 次量级的裸日志（B 类），虽不在白屏窗口内，但：
   - 拖慢 T5 到达（进度条 100% 更晚）；
   - 放大「进度条走完 → 界面可用」的总体感知时间。
3. **A1 建议范围**：删除/降级 A 类 1 条（已计数）+ B 类 4 处（assembly/IDENTITY-TRACE/E1），C 类不动。
   - 删 B 类需谨慎：`[IDENTITY-TRACE]` 是历史身份调试资产，建议改 NODE_ENV 守卫（`dev` 才打）而非删除。
4. **验证方式**：A1 后重跑 S-200 ×3，对照 `renderPathConsoleLog` 归零 + `T5` 提前量 + `WHITE_SCREEN` 变化。

> 本审计为只读产出（grep 证据），未修改任何业务文件。
