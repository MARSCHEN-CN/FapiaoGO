# PERF-WHITE-1 ③ — console.log 只读审计（用户批准，2026-09-02）

> 范围声明：**只读审计，未改任何代码**。按用户要求回答四问：
> 落点 → 是否 render/useMemo/useEffect 高频路径 → 是否生产环境也执行 → 是否承担调试/业务诊断功能。
> 结论：若确认为调试日志，再**单独删除、单独 commit**（本轮不删）。
>
> 排除规则沿用 `perf-white1-consolelog-audit.md`：`dist_rc/**`（构建副本）、`*.test.*`（测试输出）、
> `perf/importPerfProbe.js`（探针唯一输出，Gate 0 冻结）、`usePrint.js / PrintPreviewCanvas.jsx / print/**`（打印域，
> 且几何/打印链路冻结，另议）、`render.worker.js / wasm`（worker 环境，console 去向独立）。

## 结论速览

| # | 位置 | 高频路径? | 生产执行? | 调试/业务? | ③ 判定 |
|---|------|-----------|-----------|-----------|--------|
| A1 | `utils/invoiceDocumentViewModel.js:119` | ✅ 渲染期派生路径（每次单页文档派生一次） | ✅ 无守卫 | 纯调试 | **确认可删**（探针已精确计数，run-261 实锤 556 次） |
| A2 | `components/PreviewCanvas.jsx:64` | ✅ 组件 render 体（每次重渲染） | ✅ 无守卫 | 纯调试(DIAG) | **确认可删/守卫** |
| A3 | `renderers.js:102,113,92,97,117,134`（LRUCache set/delete） | ✅ 预览缓存每次 set/delete | ✅ 无守卫 | 纯调试(LRU) | **确认可删/守卫**（新发现，旧审计漏了） |
| B1 | `useFileOps.js:918,922,961,988,1033` | ⚠️ 导入组装循环内，每文档 N 次 | ✅ 无守卫 | 调试标签 | 候选（属 T0→T5 导入期，非白屏窗口） |
| B2 | `stores/ImportSessionStore.js:326,236` | ⚠️ 每次 addDocument / prune | ✅ 无守卫 | IDENTITY-TRACE | 候选 |
| B3 | `consumers/parseResultConsumer.js:45` | ⚠️ 每次消费解析结果 N 次 | ✅ 无守卫 | 调试(E1) | 候选 |
| B4 | `services/ParseBatchClient.js:35,38,70` | ⚠️ 批量解析请求准备，每文件 | ✅ 无守卫 | 调试(DIAG) | 候选（旧审计漏了） |
| C | App.jsx/usePreview.js:76,652/useFileOps.js:365-383 等一次性或低频 | ❌ | — | 视情况 | 保留或另议 |

## 逐条证据（读代码核实，非推断）

### A1 — `utils/invoiceDocumentViewModel.js:116-125`（唯一已被探针计数的渲染期日志）

```js
// ⚠ 注意：此 console.log 位于渲染期派生路径（每份单页文档调用一次）。
// Gate 0 阶段「只计数、不删除」——删除属于 Gate 1（A1）范围，需先有基线数据归因。
perfProbe.count('renderPathConsoleLog')
console.log('[invoiceDocumentToRow] 单页文档:', { docId, pageKeys, originalName, displayName, status })
```

- **高频路径**：函数 `invoiceDocumentToRow`（:42）被 `invoiceDocumentsToRows`（:184）逐文档调用，
  属于「files/documentView 变化 → 展示行重建」的派生链；run-261 实锤 `invoiceDocumentToRow=561`、
  `renderPathConsoleLog=556`。
- **生产执行**：无 `NODE_ENV` 守卫，打包版同样执行。
- **诊断功能**：无（代码注释已自认纯调试；无任何下游消费其输出）。
- **③ 判定**：✅ **确认可删**。删除后以探针 `renderPathConsoleLog` 归零 + 列表正常渲染验证。

### A2 — `components/PreviewCanvas.jsx:62-71`（render 体，非 effect）

```js
// ── Render Engine <img> 路径 ──
// [DIAG-10] 每次渲染输出
console.log('[DIAG-10 display layer] rotation=%d previewUrl=%s hasCanvas=%s canvasSize=%s contentReady=%s containerW=%d', ...)
```

- **高频路径**：位于组件**渲染函数体**（return 之前），每次 PreviewCanvas 重渲染都会执行——
  不受下方 L1 命中跳过逻辑（callback ref 内）保护。
- **生产执行**：无守卫。
- **诊断功能**：DIAG 调试（旋转/显示层排障遗留）。
- **③ 判定**：✅ 确认可删/守卫。与白屏窗口后半段（预览首帧后）相关，建议与 A1 同批或紧随其后。

### A3 — `renderers.js:90-137`（LRUCache，预览缓存热路径，新发现）

```js
async set(key, value) {
  if (this.cache.has(key)) { console.log('[LRU] ... key already exists ...') ... }
  else if (...) { console.log('[LRU] ... cache full ...') ... }
  this.cache.set(key, value)
  console.log(`[LRU] ${this.name}.set() cache size: ${this.cache.size}/${this.maxSize}`)   // ← :102 每次 set 必打
}
async delete(key) { ... console.log('[LRU] ... destroying key:', key) ... }                  // ← :113 每次 delete 必打
```

- **高频路径**：PDF 文档 LRU（max 20）在预览切换/渲染循环中 set/delete 频繁；`:102` 每次 set、
  `:113` 每次 delete **无条件打点**，另有逐行级联（:306-378 PDF doc dispose 每步一打）。
- **生产执行**：无守卫。
- **诊断功能**：LRU 调试遗留。
- **③ 判定**：✅ 确认可删/守卫。⚠️ 但 `renderers.js` 是预览 + 打印共用模块，且 R-3（多页栅格化）
  审计 HOLD 中——**删除需先确认不在打印几何冻结范围内**，建议先只守卫（dev 才打）而非删除，
  与打印链路回归一起验证。

### B 类 — 导入期（T0→T5）每文档 N 次量级（非白屏窗口，但拖慢 T5 到达）

| 位置 | 标签 | 触发 | ③ 判定 |
|------|------|------|--------|
| `useFileOps.js:918,922` | `[ADD DOCUMENT][assembly]` | hydration/组装每文档 | 候选：删或 dev 守卫 |
| `useFileOps.js:961` | `[ADD DOCUMENT][gate-reject]` | 每被拒文档 | 候选 |
| `useFileOps.js:988` | `[SEAL DOCUMENT][assembly]` | 每 SEAL 文档 | 候选 |
| `useFileOps.js:1033` | `[ADD DOCUMENT][fallback]` | 仅 fallback 路径（少） | 候选 |
| `stores/ImportSessionStore.js:326` | `[IDENTITY-TRACE] addDocument: 成功` | 每次 addDocument | 候选（历史身份调试资产 → 建议 dev 守卫而非删） |
| `stores/ImportSessionStore.js:236` | `[IMPORT_ADMISSION] prune` | 每次 prune | 候选 |
| `consumers/parseResultConsumer.js:45` | `[E1] consumeParseResult` | 每次消费解析结果 | 候选 |
| `services/ParseBatchClient.js:35,38,70` | `[DIAG] prepareBatchRequest` | 批量请求每文件准备 | 候选（**新发现，旧审计漏**） |

### C 类 — 一次性/低频/错误路径（本轮不动）

- 事件处理器内单次日志（App.jsx removeFile/removeDuplicateFiles、PdfExportConfirmModal、PackConfirmModal 等）
- `console.warn / console.error`（保留，诊断价值）
- 已带 `NODE_ENV==='development'` 守卫的日志（如 `useFileOps.js:1103-1105` —— **正确姿势的现成范例**）
- `usePreview.js:76,652`、`useFileOps.js:365-383`：低频（fileRotations 变化 / 单次导入门控），保留或后续另议

## ③ 的落地建议（供批准后单独 commit）

1. **第一批（白屏窗口直接相关，建议单独 commit）**：A1 删除 + A2 删除 + A3 守卫化（dev-only）。
   验证：探针 `renderPathConsoleLog` 归零、白屏窗口重测、预览链路回归。
2. **第二批（导入期 T0→T5，建议另一 commit）**：B1/B2/B3/B4 中带 `IDENTITY-TRACE` 前缀的改 dev 守卫，
   其余删除。验证：重跑批量导入，观察 T5 是否提前、进度语义不变。
3. C 类不动。
4. **纪律**：A①②（弹窗时机/loading 占位）仍冻结未批，本批只动 console，不与 1B 探针改动混提交。

> 本文件为只读产出（grep + 定点读码证据），未修改任何业务文件。
