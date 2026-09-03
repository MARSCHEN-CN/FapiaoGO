# P2-R Import Completion Contract Refactor Audit

> 日期：2026-09-03　分支：rotation-b1-hardening　前置：P2 审计已定位 feedback 环
> 方法：静态取证（文件:行号），**零代码改动**
> 目标：回答「duplicate detection 如何从 FileContext effect 提取进 Import Pipeline」
> 范围：R1-R6 共 6 个取证点

---

## 0. 结论先行

**R1-R6 全部可解，架构上可行。**

方案核心：把 duplicate detection 作为 Import Pipeline 的**尾部同步阶段**（T4 之前），完成后**一次性 publish + 一次性 final sort**，然后 dismiss modal。FileContext 现有 `[files]` effect 改为「仅响应手动触发 / 增量更新」，不再作为导入路径的主入口。

与 P2 审计发现的 feedback 环相比，本方案**不是补丁**，是**语义纠正**：duplicate detection 从 "advisory fire-and-forget UI effect" 升格为 "pipeline stage"，完成契约从根上正确。

---

## R1：duplicate detection 能否从 FileContext effect 提取为可等待的纯任务？

### 现状取证

FileContext.jsx 内的完整检测链（:228-305）：

```
[files] effect (触发)
  → normalizeInvoiceNumber (纯函数, :15-19, 内部)
  → 构建 byNumber Map (纯数据处理, :249-256)
  → 300ms debounce setTimeout (不可 await, :265-296)
  → runPool(entries, 6, worker) (并发受限执行, :22-31, 内部, **不返回 Promise**)
      → db.getImportHistory(norm) → Promise (可 await, db.js:129-131)
  → worker 内筛选 (importCount >= 2 + 同号广播, :274-293)
  → batcher.enqueue (批量 publish, :284-293)
```

### 提取可行性：✅ 可提取，需 3 处改造

| 组件 | 状态 | 改造 |
|------|------|------|
| `normalizeInvoiceNumber` | 内部函数 :15-19 | 直接提取到 `utils/` 下导出（无依赖） |
| `runPool` | 内部函数 :22-31 | **改造成可 await**：当前 fire-and-forget，需返回 Promise（最简单实现：用 `Promise.all` + `Promise.race` 或 `p-limit` 语义） |
| 查询主体 :249-293 | 嵌在 effect 里 | 提取成纯函数 `detectImportHistory(files, { db, concurrency })` → 返回 `Promise<Map<fileKey, value>>`，内部可 `await runPool` |
| `db.getImportHistory` | 已导出（db.js:129） | 直接复用 |
| batcher | 仅当**增量** publish 需要 | 同步一次性 publish 不需要 batcher；但 batcher 保留给未来「新文件增量检测」用 |

### 关键细节：runPool 的改造

**当前实现**（FileContext.jsx:22-31）：

```js
function runPool(items, concurrency, worker) {
  let i = 0
  const exec = () => {
    if (i >= items.length) return
    const cur = i++
    Promise.resolve(worker(items[cur])).finally(exec)
  }
  const n = Math.min(concurrency, items.length)
  for (let c = 0; c < n; c++) exec()
  // ❌ 无返回值 → 调用方无法 await 完成
}
```

**改造为可 await**（仅示意，不实施）：

```js
async function runPool(items, concurrency, worker) {
  let i = 0
  const exec = async () => {
    while (i < items.length) {
      const cur = i++
      await Promise.resolve(worker(items[cur]))
    }
  }
  const n = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: n }, exec))
  // ✅ 返回 Promise<void> → 调用方可 await
}
```

**风险极低**——原 runPool 仅在 FileContext 内部使用（全项目 grep 唯一调用点 :271），改造不影响其他消费者。

---

## R2：Import Pipeline 如何插入 duplicate detection 并等待完成？

### 现状：Import Pipeline 完整边界（已 await 的所有阶段）

```
runChunkedImport.js:64-251（纯编排层，await 所有内部步骤）
  for 每个 chunk:
    await createImportBatch (后端 SSE batch 创建)
    await subscribeBatchProgress → onComplete:
      await hydrateChunk (useFileOps.js:667-1075, 注入的 hook 函数)
        内部: ensureDocumentFromFileObj + addDocument + sealDocument + flushUpdates
        全部同步，runChunkedImport 第 185 行 await
  所有 chunk 完成 → return { wasAborted }

useFileOps.js:1093-1159（parseFiles 尾部）
  await runChunkedImport → T2
  flushUpdates → T3
  setImportStage('completed') + progress=100 → T4
  setTimeout(0) + rAF + 250ms → T5 dismiss (❌ 无 await duplicate detection)
```

### 插入点：T3 和 T4 之间（唯一正确位置）

```
                    T2 (parse 完成)
                     ↓
runChunkedImport 返回
                     ↓
flushUpdates → T3 (hydration 完成)
                     ↓
           ┌────────────────────────────┐
           │  新增：detectImportHistory │ ← ✅ 插入点
           │  (可 await, 并发 6)        │
           │  一次性 publish            │
           │  一次性 final sort         │
           └────────────────────────────┘
                     ↓
          setImportStage('completed') → T4
                     ↓
         setTimeout + rAF + 250ms → T5
```

**为什么选 T3-T4 之间？**
1. T3 时所有 Document 已注册、所有 fields 已回填（invoiceNumber 必定可用）→ detection 输入**完整稳定**
2. 插入 T3 之前：files 状态可能还在被 hydrateChunk 的 flushUpdates 逐步写入 → detection 输入不完整
3. 插入 T4 之后：用户看到「进度 100%」后还得等查询 → 体验倒退
4. T3→T4 之间**本来就是空窗期**（当前代码只有注释和 log）→ 不增加额外等待，把现有 T4→T5 之间的等待**前移**到 T3→T4 之间

### 等待时间预算

| 参数 | 值 | 推导 |
|------|-----|------|
| 每批文件数 | 261（Gate 5 基线） | — |
| 唯一 invoiceNumber | ≈200 | 去重后 |
| 并发 | 6 | 复用现有值 |
| 每次查询 RTT | 后端 import_history DB 查询 ≈ 10-30ms（无外部网络） | 后端 `/api/import-history/<num>` |
| 预计等待 | 200 / 6 ≈ 34 轮 × ~20ms ≈ **~700ms** | 保守估计 |

**结论**：~700ms 是可接受的完成等待，远小于当前 T4→T5 的视觉滞后（feedback 环驱动的 ~10s）。

### 实现方式：两种选项

**选项 A：内联在 useFileOps.js（推荐，低侵入）**

```js
// useFileOps.js parseFiles 尾部（:1093 附近）
await runChunkedImport({ ... })
flushUpdates()  // T3
perfProbe.mark('T3')

// ✅ 新增：duplicate detection（pipeline 尾部阶段）
if (readyFiles.length > 0) {
  const ihResult = await detectImportHistory(readyFiles, { 
    db: db, concurrency: 6 
  })
  // 一次性 publish（替代逐条 batcher.enqueue）
  setImportHistoryInfo(ihResult)
  // 一次性 final sort（替代 useSort 被 importHistorySig 触发 51 次）
  applySortOnce(readyFiles, ...)
}

setImportStage('completed')  // T4
```

优点：改动集中在一个文件，不破坏现有模块边界。

**选项 B：提升为 runChunkedImport 的 deps（更正规，侵入稍大）**

在 `runChunkedImport.js` deps 里加 `onFinalize` hook，所有 chunk 完成后 `await deps.onFinalize({ allFiles, signal })`。

优点：语义更正规（编排层知道自己有 finalize 阶段）。
缺点：runChunkedImport 是纯模块，不应直接依赖 UI 域概念（import history）。

**推荐 A**——当前 scope 内足够，后续如果有更多 finalize 阶段再考虑 B。

---

## R3：检测结果如何一次性 publish（替代逐条 publish + 逐条 sort）

### 现状：发布风暴链

```
db.getImportHistory response × 每条命中
  → batcher.enqueue (pending.push)
  → setTimeout(50ms) → flush
  → publish(setImportHistoryInfo) → React state 更新
  → importHistorySig 变 → useSort useEffect 触发
  → setFiles(applySort(...)) → files 变
  → feedback loop 回到顶部（cleanup 重置 firedSigRef）
```

### 目标：一次性 publish + 一次性 final sort

```
detectImportHistory(files) 
  → Promise<Map<fileKey, ihValue>>  // 内部 await runPool 全部完成
  → 返回完整 Map
  → setImportHistoryInfo(fullMap)   // 一次性 publish，无 batcher
  → applySortOnce(files, ...)       // 一次性 sort
  → done                            // 不再有后续更新
```

### 实现要点

1. **detectImportHistory** 返回 `Promise<Map>` 而非逐条回调。内部：
   - 收集所有命中的 `{ fileKeys, value }`
   - **全部** await 完成后合并成一个完整 Map（合并逻辑可复用 `applyHistoryEntry` 的迭代方式，但一次性跑完所有 entries）
   - 同号 fileKeys 广播写入同一 value 引用（语义不变）

2. **一次性 publish** 就是一个 `setImportHistoryInfo(fullMap)`——无需 batcher。因为是 pipeline 尾部同步等待后的单次写入，不存在需要 debounce 的多条响应。

3. **一次性 final sort** 有两种做法：
   - **(a)** 在 useFileOps.js 里直接调 `setFiles(applySort(...))`，和当前 useSort 走同一条 applySort 路径
   - **(b)** 利用 useSort 现有的 `importHistorySig` 机制——只要 pipeline 这次 publish 后 importHistorySig 变化只触发一次，就是一次性 sort

   **推荐 (a)**——把 sort 也作为 pipeline 的显式尾部步骤，而不是留给 useSort 的 effect 隐式触发。理由：
   - 当前 useSort 监听 `[importHistorySig]` 变化就 sort，**这正是反馈环里 sort 51 次的原因**
   - 显式 final sort 意味着可以在完成后**立即停止** useSort 对 importHistorySig 的监听
   - 或者更简单：pipeline 这次 publish 后，importHistorySig 的首次变化就是终态，useSort 正常触发一次即可

### 风险控制：useSort 的 importHistorySig 触发 1 次而非 51 次

关键在于：
- 旧路径：每一条 `db.getImportHistory` 响应 → batcher flush → publish → importHistorySig 变 → sort 1 次。200 条唯一号 × 部分命中 → sort 多次
- 新路径：全部响应收齐 → **1 次 publish** → importHistorySig 变 **1 次** → sort **1 次**

这正是 P2 审计中 feedback 环断裂的核心——从多条响应 → 多次 sort 变成 1 次 publish → 1 次 sort。

---

## R4：如何确保只做一次最终排序？

### 现状：排序触发源盘点

useSort.js:86-101 的 useEffect：

```js
useEffect(() => {
  const combinedSig = `${sortBy}|${sortOrder}|${sortSig}|ih:${importHistorySig}`
  if (!sortSig || combinedSig === lastSortedSigRef.current) return
  lastSortedSigRef.current = combinedSig
  setFiles(current => applySort(...))
}, [sortBy, sortOrder, sortSig, importHistorySig, setFiles])
```

排序触发条件：**任一依赖变化 + combinedSig 不同于上次**。

Gate 5 实测：`applySort = 51`——其中 importHistorySig 变化贡献了**绝大部分**（P2 审计已证实）。

### 方案：消除 importHistorySig 的多波次变化

P2-B 实施后，importHistorySig 只变**一次**（pipeline 尾部一次性 publish），useSort 自然只 sort **一次**。

**不需要额外代码改动 useSort 的触发逻辑**——触发源数量减少 → 排序次数自动减少。

### 防御性兜底（可选，低优先级）

为防止未来引入其他异步更新源导致 sort 再增，可考虑在 useSort 加一个 `finalSortOnce` 模式：

```js
// 伪代码：由 pipeline 设置全局 flag
if (importPipeline.completedOnce && !flagSortFinalRunThisSession) {
  // 跳过后续 importHistorySig 变化触发的 sort
}
```

但这属于防御性优化，不影响本次 P2-B 的核心正确性。**优先靠「减少触发源」而非「增加 skip 条件」**。

---

## R5：如何确保 preview target 在 T5 前稳定不漂移？

### 现状：漂移根因（P2 审计已证实）

```
applySort 51 次 → setFiles 51 次 → displayFiles 重建 51 次
  → App.jsx 自动预览 effect (:972-1026) 反复评估
  → handlePreview 185 次（绝大多数在 guard/防抖层被吞）
  → doLoadPreview 版本守卫只提交末个 → 后端 /preview 冷渲染被反复作废
  → 展示区空白等待
```

### 方案：P2-B 自动修复

一旦 duplicate detection + final sort 变成 pipeline 尾部同步阶段：
- `setFiles(setImportHistoryInfo)` 在 T3-T4 之间 **一次性** 发生
- `setFiles(applySort(...))` 也是 **一次性** 发生
- 排序完成后 displayFiles 稳定 → 自动预览 effect 评估条件只满足一次
- handlePreview 目标不再漂移

**P2-B 不直接修改预览逻辑，而是通过消除上游排序风暴间接修复。**

### 量化预期

| 指标 | 修复前（Gate 5） | 修复后（预期） |
|------|-----------------|---------------|
| applySort | 51 | **~2**（初始化 1 次 + importHistorySig 变 1 次） |
| displayFiles 重建 | 51+ | **~个位数** |
| handlePreview 计数 | 185 | **~个位数** |
| 展示区空白等待 | ~10s+ | **< 1s**（冷渲染仍在目标漂移收敛后开始，但已无漂移） |

---

## R6：FileContext 现有查询 effect 如何安全退役，避免双消费者？

### 现状消费者盘点（全项目 grep）

| 消费者 | 位置 | 语义 | 导入路径中是否应触发？ |
|--------|------|------|----------------------|
| useSort 排序 | App.jsx:146 → useSort.js:77-101 | 排序触发源 | **否**（P2-B 后 pipeline 已经 final sort） |
| Sidebar 计数 | Sidebar.jsx:106-135 | importHistoryCount 读数 | **否**（pipeline 已 publish 完整 Map） |
| FileList 行级标签 | FileList.jsx:28 | 逐行 ihInfo 显示 | **否**（pipeline 已 publish 完整 Map） |
| removeImportHistoryFiles | App.jsx:694 | 点击按钮时读取 | **否**（pipeline 已 publish） |
| **手动添加文件（非批量导入）** | — | 用户逐个添加文件时也触发 | **是**（需保留） |
| **删除文件 / 重命名** | — | files 变化但不应重查 | **否**（纯字段变更不影响归一化号集合） |

### 方案：FileContext effect 改为触发模式

FileContext.jsx:238-305 当前的 `[files]` effect 有两种退役思路：

**方案 A：加 flag，import 路径期间跳过**

```js
// FileContext.jsx (伪代码)
const importPipelineActiveRef = useRef(false)
// importPipeline 开始前设置 true，完成后设置 false

useEffect(() => {
  if (importPipelineActiveRef.current) return  // pipeline 期间跳过
  // 原有查询逻辑...
}, [files])
```

pipeline 完成后：files 可能又变了（sort 后），但归一化号集合没变 → firedSigRef 的签名匹配 → 跳过。

**方案 B：完全重写为手动触发 + 增量更新**

```js
// 暴露 trigger：由 pipeline 完成后手动调用
const triggerImportHistoryQuery = useCallback(() => { ... }, [])
// effect 仅处理增量（非 import 路径）
useEffect(() => {
  // 纯字段变更 / 删除 / 重命名 → prune 不重查
  // 仅当新增带 invoiceNumber 的文件（归一化号集合扩展）时才触发
}, [files])
```

**推荐 A**——简单、低侵入、与现有代码差异最小。方案 B 语义更干净但实现复杂，且当前的 300ms debounce 在手动触发后可能需要调整。

### batcher 保留策略

importHistoryBatcher（importHistoryBatcher.js）**保留**——它负责：
- pipeline 尾部的一次性 flush 也可以用（factory 接口不变）
- 未来「新文件增量检测」仍需要 batcher 的 debounce 语义
- P1-A 实现的「内容无变化不 publish」去重逻辑仍然有价值

**只改查询触发路径**（从 effect 自动触发 → pipeline 手动触发），不改变 batcher 的 publish 机制。

---

## 实施路线图：3 个 PR，严格单变量

### PR-1：基础设施（R1 + R3）

- 提取 `normalizeInvoiceNumber` + 改造 `runPool` 为可 await 版本
- 新增 `detectImportHistory(files, { db, concurrency })` 纯函数
- 改动范围：新建 `import/detectImportHistory.js`（纯模块，无 React 依赖）
- **零调用点变更**——新函数存在但暂不被任何人调用

### PR-2：Pipeline 集成（R2 + R4 + R5）

- useFileOps.js 在 T3-T4 之间 `await detectImportHistory`
- 一次性 publish + 一次性 final sort
- 改动范围：`hooks/useFileOps.js`（约 20-30 行新增）
- 验证指标：applySort 51 → ~2、handlePreview 185 → ~个位数

### PR-3：FileContext effect 退役（R6）

- FileContext.jsx effect 加 `importPipelineActiveRef` 守卫
- 改动范围：`contexts/FileContext.jsx`（约 5-10 行新增）
- 验证指标：pipeline 期间不再有 effect 触发的 importHistoryQuery

### PR-?（可选，低优先级）：防御性 sort once

- useSort.js 加 pipeline 完成后的 skip 保护
- 仅当 PR-2 验证后仍有偶发多 sort 时实施

---

## 契约修正摘要

### 现状（契约缺口）

```
T4: parse + hydrate + register 完成
T5: 弹窗关闭
T5+N: duplicate detection 收敛、sort 收敛、preview 目标稳定（用户感知延迟）
```

### P2-B 后（契约正确）

```
T4: parse + hydrate + register + duplicate detection + final sort 全部完成
T5: 弹窗关闭（100% 状态稳定）
T5+0: preview 单飞加载（数据态已稳定，仅图像异步）
```

| 完成项 | P2-B 前 | P2-B 后 |
|--------|---------|---------|
| ① Parse | T2 ✅ | T2 ✅ |
| ② Register | T2 ✅ | T2 ✅ |
| ③ Duplicate Detection | T5+10s+ 🔴 | **T4** ✅ |
| ④ Final Sort | T5+10s+ 🔴 | **T4** ✅ |
| ⑤ Preview 目标稳定 | T5+10s+ 🔴 | **T4** ✅ |
| ⑥ Preview 图像加载 | T5+ | **T5+**（允许异步，已单飞） |

---

## 风险与边界

| 风险 | 评估 | 对策 |
|------|------|------|
| detectImportHistory 延迟 ≥ 2s（批量大时） | 低——200 号 ÷ 6 并发 × 20ms RTT ≈ 700ms | 设超时保护（如 5s），超时降级：直接 dismiss、不阻塞 |
| runPool 改造后遗留调用点行为变化 | 极低——grep 唯一调用点在 FileContext 内部，PR-3 退役后才会移除 | PR-1 改造 + PR-3 退役 是独立 PR，互不影响 |
| PR-2 改动导入时序导致其他依赖问题 | 低——插入点 T3-T4 之间，在 flushUpdates 之后，不影响上游 | 先跑现有测试，再加 3 个行为测试（见下） |
| 弹窗等待时间增加（从 250ms → 250+700 ≈ 950ms） | 中——用户看到 100% 后多等 ~700ms | 但换取弹窗关闭后列表/计数**立即可信**，体验反升（不再看到弹窗关了后 UI 还在变） |

### 建议的行为测试（每个 PR 带测试）

**PR-2 必做 4 项**：
1. pipeline 完成后 `importHistoryInfo.size === 最终值`（无渐进）
2. `applySort` 在 pipeline 期间只触发 **1 次**（importHistorySig 变）
3. `handlePreview` 触发次数 ≤ 初始化 + 1（无漂移）
4. T4→T5 间隔 = 250ms + **≤ 1.5s**（查询完成）

**PR-3 必做 2 项**：
1. import 路径中 FileContext `[files]` effect 的 importHistoryQuery 计数 = 0
2. 手动添加文件（非批量）时 effect 正常触发查询

---

## 本审计边界

- **未修改任何代码**——所有结论基于静态行号取证
- **未插入 runtime 探针**——PR-2 实施后需 Gate 级计数器验证
- **未讨论 preview 冷渲染优化**——这属于另一个话题（后端 render cache 预热），不在本次 scope
- **未覆盖 cancel 路径**——需确认 duplicate detection 能否被 abort（建议：signal 传递进 detectImportHistory）

---

## 参考文件（全部只读）

| 文件 | 关键行号 | 作用 |
|------|---------|------|
| `contexts/FileContext.jsx` | :15-19, :22-31, :228-305 | 当前 import history 查询完整链 |
| `contexts/importHistoryBatcher.js` | 全文 | batcher 实现（P1-A） |
| `hooks/useFileOps.js` | :655-667, :667-1075, :1093-1159 | runChunkedImport 调用、hydrateChunk 注入、parse 完成尾部 |
| `import/runChunkedImport.js` | :165-186 | await hydrateChunk 边界确认 |
| `hooks/useSort.js` | :64-101 | sort 触发机制、importHistorySig 依赖 |
| `db.js` | :129-131 | getImportHistory API |
| `utils.js` | :436-458 | applySort 的 importHistoryInfo 消费 |
| `components/Sidebar.jsx` | :106-135 | importHistoryCount 计数逻辑 |
| `components/FileList.jsx` | :28, :211 | 行级 ihInfo + memo 比较 |
| `App.jsx` | :111, :146, :692-694, :972-1026 | consumers + 自动预览触发源 |
