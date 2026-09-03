# P2-R Import Completion Contract Refactor Audit —— 独立复核版

> 日期：2026-09-03　分支：rotation-b1-hardening　复核者：独立取证（不沿用原 P2-R 审计结论）
> 方法：逐行 grep + Read，**零代码改动**。所有结论附真实文件:行号证据。
> 目的：回答「把 duplicate detection 纳入 Import Pipeline 尾部阶段」是否架构可行，以及原 P2-R 审计中哪些结论有漏洞。

---

## 0. 核心发现（与原 P2-R 审计的关键差异）

| # | 原 P2-R 说法 | 复核结论 | 证据 |
|---|-------------|---------|------|
| 1 | "useFileOps.js 里直接 setImportHistoryInfo" | ❌ **不可能**。setImportHistoryInfo 只在 FileProvider 内部（useState setter），Context value 只暴露只读 importHistoryInfo，setter 不对外。 | FileContext.jsx:69（声明）+ FileContext.jsx:347-363（Context value 无 setter） |
| 2 | "readyFiles 有 invoiceNumber 可以直接用" | ❌ **不可能**。hydrateChunk 通过 countingQueueUpdate 写 React state，不原地修改 readyFiles 的占位符对象。T3 时 readyFiles 只有 docId/identity/invoiceDocumentId 被原地同步。 | useFileOps.js:737-738 + :754（原地写的只有这三个字段）+ :723-724（解析字段走 queueUpdate） |
| 3 | "PR-1→PR-2→PR-3 三个独立 PR 安全" | ❌ **有双消费者窗口**。PR-2 接 pipeline 但 PR-3 未退役 effect → pipeline 查一次 + [files] effect 查一次 → 双 publish → 双 sort → 反馈环仍在。必须 PR-2 和 PR-3 绑定。 | FileContext.jsx:238（effect deps=[files]，会在 T3 后触发） |
| 4 | "runPool 改造风险极低" | ✅ **通过**。grep 唯一调用点在 FileContext.jsx:271。改造为可 await 不影响其他模块。 | grep runPool → 2 lines only |
| 5 | "publish 1 次 = sort 1 次" | ✅ **通过**。useSort importHistorySig 依赖 importHistoryInfo Map keys，一次 publish → Map 引用变 → sig 变 → sort 1 次。 | useSort.js:77-80 + :92-101 |
| 6 | "cancel/abort 契约不变" | ✅ **通过**。runChunkedImport 返回 { wasAborted } 但调用方（useFileOps.js:655）不检查——这是**已存在的行为**。detection 插在 T3-T4 之间不会让情况更糟。但 detection 自身需要感知 abort（signal 传递）。 | useFileOps.js:655（await 不检查返回值）+ runChunkedImport.js:251（返回 { wasAborted }） |

---

## G1：runPool 全局唯一调用点

### 取证命令
```
grep -n "runPool" *.{js,jsx}
```

### 结果
```
FileContext.jsx:22:function runPool(items, concurrency, worker) {   ← 定义
FileContext.jsx:271:      runPool(entries, 6, ([norm, fileKeys]) => ← 调用
```

### 结论：✅ 通过
runPool 完全封装在 FileContext.jsx 内部，无导出、无外部调用。改造为可 await 版本零外部影响。

---

## G2：setImportHistoryInfo 访问边界

### 取证（三层嵌套）

**层 1：setImportHistoryInfo 在哪里声明？**
```
FileContext.jsx:69: const [importHistoryInfo, setImportHistoryInfo] = useState(() => new Map())
```
→ useState setter，仅 FileProvider Hook 作用域内可访问。

**层 2：谁调用了 setImportHistoryInfo？**
```
FileContext.jsx:85: publish: (next) => setImportHistoryInfo(next),
```
→ 唯一调用点：importHistoryBatcher factory 的 publish 回调。

**层 3：importHistoryBatcher 如何被外部消费？**
```
grep importHistoryBatcher → 所有调用点都在 FileContext.jsx 的 [files] effect 内
  :242  setLiveKeys
  :248  prune
  :284  enqueue
```
→ batcher 是 FileContext 内部私有基础设施，外部无访问路径。

**层 4：Context value 暴露了什么？**
```
FileContext.jsx:347-363: Context value = {
  ...
  importHistoryInfo,        ← 只读值
  ...
}
// ❌ 没有 setImportHistoryInfo
// ❌ 没有 importHistoryBatcher
// ❌ 没有任何 publish 方法
```

### 结论：❌ 原审计错误
"useFileOps 里直接 setImportHistoryInfo" 不可能。**pipeline 要 publish importHistoryInfo 必须先修改 Context value 暴露 setter 或 publish 方法**。

### 正确路径
```
FileProvider Context value 新增:
  publishImportHistoryInfo: (nextMap) => { setImportHistoryInfo(nextMap) }
App.jsx:
  const { publishImportHistoryInfo } = useFileContext()
  const { ... } = useFileOps({ setFiles, publishImportHistoryInfo, settings, electronAPIRef })
useFileOps parseFiles 尾部:
  await detectImportHistory(...)
  publishImportHistoryInfo(completeMap)
```

---

## G3：importHistoryInfo 所有写入路径

### 取证命令
```
grep -n "setImportHistoryInfo" *.{js,jsx}
```

### 结果
```
FileContext.jsx:69  useState 声明
FileContext.jsx:85  batcher.publish 回调内
importHistoryBatcher.js:61  注释
```

### 写入链完整路径
```
db.getImportHistory(norm) × N responses
  → FileContext.jsx:284 importHistoryBatcherRef.current.enqueue(...)
  → importHistoryBatcher flush(50ms debounce)
  → importHistoryBatcher.publish(nextMap)
  → FileContext.jsx:85 (next) => setImportHistoryInfo(next)
  → React state 更新
```

### 结论：✅ 单写入路径，无其他消费者
当前只有 batcher.enqueue → flush → publish → setImportHistoryInfo 这一条链。**没有其他任何代码直接或间接修改 importHistoryInfo**。

---

## G4：publish 1 次 = sort 1 次

### 取证

**useSort importHistorySig**（useSort.js:77-80）：
```js
const importHistorySig = useMemo(() => {
  if (!importHistoryInfo || importHistoryInfo.size === 0) return ''
  return Array.from(importHistoryInfo.keys()).sort().join('|')
}, [importHistoryInfo])
```
→ 依赖 importHistoryInfo Map 引用变化。

**useSort 触发条件**（useSort.js:86-101）：
```js
const combinedSig = `${sortBy}|${sortOrder}|${sortSig}|ih:${importHistorySig}`
if (!sortSig || combinedSig === lastSortedSigRef.current) return
lastSortedSigRef.current = combinedSig
setFiles(current => applySort(...))
```

### 推导
```
一次性 publish(newMap)
  → importHistoryInfo 引用变了（新 Map）
  → importHistorySig 变了（Map keys 不同）
  → combinedSig ≠ lastSortedSigRef.current
  → sort 1 次 ✅
```

如果只有 1 次 publish，就只有 1 次 sort。反馈环的根因是**多次 publish**（每条 HTTP 响应各触发一次），不是 useSort 自身机制。

### 结论：✅ 通过

---

## G5：pipelineActiveRef 跨 Context 可见性

### 问题
原 P2-R 审计建议在 FileContext effect 里加 `importPipelineActiveRef` 守卫。但这个 ref 存在哪里？

| 方案 | 可行性 | 问题 |
|------|--------|------|
| (a) FileContext 内部的 ref | ✅ 可行 | useFileOps 怎么设这个 ref？——它不 import FileContext 模块 |
| (b) 全局模块级 ref（`module.js`） | ✅ 可行 | 污染全局，但独立模块可以双向 import |
| (c) Context value 暴露 setter | ✅ 可行 | 同 G2 的 publishImportHistoryInfo 方案，一起暴露 |
| (d) useFileOps 设一个全局 flag | ✅ 可行 | FileContext effect 读同一 flag |

### 推荐方案
**(d) + (c) 组合**：
1. 新建 `import/pipelineState.js` 模块（或在 db.js 加一行）：
```js
// 全局标志：import pipeline 是否在运行（供 FileContext effect 查询）
export let importPipelineActive = false
export function setImportPipelineActive(v) { importPipelineActive = v }
```
2. useFileOps parseFiles 头部 `setImportPipelineActive(true)`，尾部 detection 完成后 `setImportPipelineActive(false)`
3. FileContext effect 头部 `if (importPipelineActive) return`
4. Context value 同时暴露 `publishImportHistoryInfo`（G2 路径）

### 结论：✅ 通过，路径清晰

---

## G6：PR-1→PR-2→PR-3 双消费者窗口

### 原 P2-R 推荐顺序
```
PR-1: 基础设施（detectImportHistory + runPool 改造）
PR-2: Pipeline 集成（await detectImportHistory + 一次性 publish）
PR-3: FileContext effect 退役（加 flag 守卫）
```

### 中间状态危险分析（PR-2 完成但 PR-3 未做时）

```
parseFiles:
  await runChunkedImport → T2
  flushUpdates → T3
  await detectImportHistory  ← PR-2 新增
  publishImportHistoryInfo(completeMap)  ← PR-2 新增
  setImportStage('completed') → T4
  ...

同时 FileContext [files] effect（未退役）:
  files 变（flushUpdates 触发） → effect 重跑
  firedSigRef 被 cleanup 重置
  300ms 后又跑一轮查询
  → 双 publish → 双 sort → 反馈环依然存在 🔴
```

### 正确的 PR 切分

**方案 A：合并为 2 个 PR（推荐）**
```
PR-1: 基础设施 + Context value 扩展
  - runPool 改造为可 await
  - detectImportHistory 纯函数（零调用点）
  - FileProvider Context 新增 publishImportHistoryInfo
  - 新建 importPipelineActive 全局 flag 模块
  - FileContext effect 头部加 importPipelineActive 守卫（但 flag 默认 false，不影响现状）
  
PR-2: Pipeline 集成 + effect 退役（一次性）
  - useFileOps: parseFiles 尾部 await detectImportHistory
  - useFileOps: parseFiles 头部 setImportPipelineActive(true)，尾部设 false
  - 一次性 publishImportHistoryInfo
  - FileContext effect 在 importPipelineActive 时跳过查询
```
→ 无双消费者窗口。flag 默认 false，PR-1 后行为不变；PR-2 同时打开 pipeline 路径 + 关闭 effect 路径。

**方案 B：单 PR**
```
所有改动一次性进，无中间状态。风险：改动范围大，review 难。
```

### 结论：❌ 原审计 PR 顺序错误。必须把 pipeline 接入和 effect 退役绑定到同一个 PR。

---

## G7：cancel/abort/partial import 契约

### 现状（已有的行为）

```
runChunkedImport 内部:
  onAbort() → wasAborted = true → close eventSources → break chunk 循环
  return { wasAborted }

useFileOps 调用 runChunkedImport:
  await runChunkedImport({...})   ← 不检查返回值
  flushUpdates → T3               ← 继续执行
  setImportStage('completed') → T4 ← 继续执行
  dismiss modal → T5              ← 继续执行
```

**已存在的契约问题**：abort 后 UI 仍显示 "100% 完成"，未完成的 chunk 不会 hydration。这**不是本审计引入的**，是已有行为。

### detection 插入后的契约

```
parseFiles:
  await runChunkedImport → { wasAborted }  ← 现在要检查返回值了
  flushUpdates → T3
  
  if (wasAborted) {
    // 跳过 detection，直接 T4
  } else {
    await detectImportHistory  ← 仅正常完成时
    publishImportHistoryInfo
  }
  
  setImportStage('completed') → T4
```

### detection 自身的 abort 感知

detectImportHistory 是纯异步 HTTP 查询，runPool 内部的 worker 调 `db.getImportHistory`。如果 abort 了：
- 已有 HTTP 请求在途 → 自然返回/超时
- 关键：即使 abort 了，已经在途的响应如果晚到 → batcher 仍会 enqueue → publish 旧数据

因此 detectImportHistory 需要**接收 signal 参数**：
```js
async function detectImportHistory(files, { db, concurrency, signal }) {
  if (signal?.aborted) return null
  // runPool 内部检查 signal.aborted，跳过后续条目
  // 响应到达时检查 signal.aborted，丢弃结果
}
```

### 结论：✅ 可控。detection 需检查 wasAborted + 接收 signal。

---

## G8：detection 能拿到已解析的 invoiceNumber 吗？

### 现状取证

**hydrateChunk 内部对 fileObj 的原地修改**（只有这 3 处）：
```
useFileOps.js:737: fileObj.docId = enriched.docId
useFileOps.js:738: fileObj.identity = enriched.identity
useFileOps.js:754: fileObj.invoiceDocumentId = doc.invoiceDocumentId
```

**解析字段（invoiceNumber 等）的传递路径**：
```
item.invoiceNumber (后端响应)
  → hydrationResult.fields.invoiceNumber  (useFileOps.js:697)
  → mapParseResultToFileUpdate(hydrationResult, fileObj)  (:723)
  → countingQueueUpdate(fileObj.key, 'parsed', update)  (:724)
  → pendingUpdatesRef.set(key, { status: 'parsed', extra: update })
  → flushUpdates()
  → setFilesRef.current(prev => prev.map(f => applyFileUpdate(f, update)))
  → React state 文件对象更新（新引用）
```

**readyFiles 对象在 T3 时的状态**：
```
readyFiles[i] = {
  key, docId, identity, invoiceDocumentId,   ← 原地同步的 ✅
  invoiceNumber, invoiceDate, amount, ...    ← ❌ 还是 undefined！
  status: 'ready'（还没变 parsed）           ← 因为 queueUpdate 异步
}
```

### 有 invoiceNumber 的是谁？

hydrateChunk 内部的 `hydrationResult`（:692-721）是从后端响应 `item` 里提取的完整解析结果，**在闭包里**：
```js
const hydrationResult = {
  status: 'parsed',
  doc_id: item.docId,
  fields: {
    invoiceNumber: item.invoiceNumber || '',   ← ✅ 这里有
    invoiceDate: item.invoiceDate || '',       ← ✅
    amount: item.amount || '',                 ← ✅
    ...
  }
}
```

但 hydrationResult 是局部变量，没有返回给外部。

### 解决方案

**修改 hydrateChunk 返回值**：

hydrateChunk 签名现在是：
```js
hydrateChunk: async ({ batchId, chunk, signal, client, terminalFileKeys }) => {
  // ... 内部处理 ...
  // 现在没有显式 return（隐式 return undefined）
}
```

改为：
```js
hydrateChunk: async ({ batchId, chunk, signal, client, terminalFileKeys }) => {
  const parsedFileData = new Map()  // fileKey → { invoiceNumber, invoiceDate, amount, ... }
  
  for (const fileObj of chunk) {
    // ... 现有逻辑 ...
    if (item?.invoiceNumber) {
      parsedFileData.set(fileObj.key, {
        invoiceNumber: hydrationResult.fields.invoiceNumber,
        invoiceDate: hydrationResult.fields.invoiceDate,
        // 完整字段或只 export 所需子集均可
      })
    }
  }
  
  return parsedFileData  // ✅ 新增返回值
}
```

**runChunkedImport 收集所有 chunk 返回值**：

runChunkedImport 现在 return `{ wasAborted }`，改为：
```js
const allParsedData = new Map()

for each chunk:
  const chunkResult = await deps.hydrateChunk({...})
  if (chunkResult) {
    for (const [k, v] of chunkResult) {
      allParsedData.set(k, v)  // 聚合
    }
  }

return { wasAborted, parsedFileData: allParsedData }
```

**useFileOps 拿到 parsedFileData**：

```js
const { wasAborted, parsedFileData } = await runChunkedImport({...})
flushUpdates() → T3

if (!wasAborted && parsedFileData?.size > 0) {
  const ihMap = await detectImportHistory(parsedFileData, { db, concurrency: 6, signal: currentAbortRef.current?.signal })
  publishImportHistoryInfo(ihMap)
}

setImportStage('completed') → T4
```

### 检测输入：用 parsedFileData 的 fileKey 集合

detectImportHistory 的输入不再是 `files`（需要从 React state 拿），而是 `parsedFileData`（由 runChunkedImport 返回的 Map，key=fileKey，value={ invoiceNumber, ... }）：

```js
// detectImportHistory 签名改为
async function detectImportHistory(parsedFileData, { db, concurrency, signal }) {
  // parsedFileData: Map<fileKey, { invoiceNumber, invoiceDate, amount, ... }>
  // 从 parsedFileData 提取 invoiceNumber → 归一化 → 查询 → 合并
  const byNumber = new Map()  // norm → fileKeys[]
  for (const [fileKey, data] of parsedFileData) {
    if (!data?.invoiceNumber) continue
    const norm = normalizeInvoiceNumber(data.invoiceNumber)
    if (!norm) continue
    if (!byNumber.has(norm)) byNumber.set(norm, [])
    byNumber.get(norm).push(fileKey)
  }
  // ... runPool await ...
}
```

### 结论：✅ 可行，需 3 处改动

| 模块 | 改动 | 风险 |
|------|------|------|
| hydrateChunk 内部实现（useFileOps.js:667-1075） | 收集 parsedFileData → return | 低——纯新增，不改变现有逻辑 |
| runChunkedImport.js | 收集 chunk 返回值 → 聚合 return | 低——现有 return 扩展为多一个字段 |
| detectImportHistory 签名（新建纯模块） | 接收 parsedFileData Map 而非 files | 低——新模块，无调用历史 |

**不需要从 React state 读 files，不需要等 flushUpdates 异步渲染。** parsedFileData 是同步数据，runChunkedImport await 返回即已准备好。

---

## 修正后的实施路线图

### PR-1：基础设施（零行为变化）

| 模块 | 改动 | 风险 |
|------|------|------|
| 新建 `import/detectImportHistory.js` | normalizeInvoiceNumber 提取 + runPool 改造（可 await） + detectImportHistory 纯函数（签名用 parsedFileData Map） | 低——新文件 |
| runChunkedImport.js | hydrateChunk 返回值聚合 → return `{ wasAborted, parsedFileData }` | 低——return 扩展 |
| useFileOps.js hydrateChunk | 收集 parsedFileData → return | 低——return 扩展 |
| FileContext.jsx Context value | 新增 `publishImportHistoryInfo` 方法（调 setImportHistoryInfo） | 低——不破坏现有消费者 |
| 新建 `import/pipelineState.js` | importPipelineActive 全局 flag + setter/getter | 低——新文件 |
| FileContext.jsx [files] effect 头部 | `if (importPipelineActive) return`（flag 默认 false，当前行为不变） | 极低——当前 flag 永远 false，守卫永不触发 |

**验证点**：grep 无任何新调用点触发行为变化；import 行为与当前完全一致。

### PR-2：Pipeline 集成 + effect 退役（一次性）

| 模块 | 改动 | 风险 |
|------|------|------|
| useFileOps.js App 传参 | 新增 `publishImportHistoryInfo`、`setImportPipelineActive` | 低 |
| useFileOps.js parseFiles 头部 | `setImportPipelineActive(true)` | 低 |
| useFileOps.js parseFiles T3-T4 之间 | `await detectImportHistory(parsedFileData, { db, concurrency: 6, signal })` → `publishImportHistoryInfo(ihMap)` | 中——核心改动 |
| useFileOps.js parseFiles 尾部 | `setImportPipelineActive(false)` | 低 |
| useFileOps.js parseFiles | 检查 runChunkedImport 返回的 wasAborted → abort 时跳过 detection | 低 |

**验证点**：
1. applySort 从 51 → **2**（初始化 1 次 + publish 触发 1 次）
2. importHistoryQuery 从 738 → **~200**（每号查询 1 次，无重放）
3. importHistoryInfo 一次性 publish → Sidebar 计数 **一跳到终值**（无 80→86→90）
4. T4→T5 间隔 ≈ 250ms + **~700ms**（查询完成）
5. handlePreview 计数自然回落（无反馈环）

---

## 完成契约修正

| 完成项 | 现状 | P2 修正后 |
|--------|------|-----------|
| ① Parse | T2 | T2 |
| ② Register | T2 | T2 |
| ③ Duplicate Detection | T5+10s+ 🔴 | **T4** ✅（await detectImportHistory，~700ms） |
| ④ Final Sort | T5+10s+ 🔴 | **T4** ✅（publish 1 次 → sort 1 次） |
| ⑤ Preview 目标稳定 | T5+10s+ 🔴 | **T4** ✅（displayFiles 只变 1 次） |
| ⑥ Preview 图像 | T5+ | **T5+**（允许异步） |

---

## 风险汇总

| 风险 | 等级 | 对策 |
|------|------|------|
| runChunkedImport return 扩展是否有外部调用者解构 | 极低——grep `runChunkedImport({` 唯一调用点在 useFileOps.js:655，解构扩展不影响 | return 多一个字段 = 向后兼容 |
| hydrateChunk return 扩展是否影响 runChunkedImport 的其他 deps.hydrateChunk 调用方 | 极低——hydrateChunk 是注入函数（:667），无外部调用者 | 同上，return undefined 也不破坏 |
| detectImportHistory HTTP 超时 | 低——加 Promise.race + 5s 降级（超时跳过） | 降级策略：超时 → 仍 publish，但只包含已完成的命中 |
| detection 阻塞 abort 后的 dismiss | 低——wasAborted 检查在 detection 之前 | abort 时直接跳过 detection |
| 弹窗等待增加 ~700ms | 中——250ms → ~950ms | 但换取关闭后立即可信，体验反升 |
| StrictMode 下 importPipelineActive 状态泄露 | 极低——全局 flag 在 parseFiles finally 块里重置 | finally { setImportPipelineActive(false) } |

---

## 参考文件（全部只读）

| 文件 | 关键行号 | 作用 |
|------|---------|------|
| `contexts/FileContext.jsx` | :22-31, :69, :80-85, :228-305, :238, :347-363 | runPool、setImportHistoryInfo、batcher 创建、查询 effect、Context value |
| `contexts/importHistoryBatcher.js` | :61-100 | batcher 实现 |
| `hooks/useFileOps.js` | :37, :655, :667-1075, :723-724, :737-738, :754, :1093-1111 | useFileOps 签名、runChunkedImport 调用、hydrateChunk 注入、原地 vs queueUpdate |
| `import/runChunkedImport.js` | :62, :101-127, :165-212, :235, :251 | 返回类型、abort 处理、chunk 循环、wasAborted return |
| `hooks/useSort.js` | :77-80, :86-101 | importHistorySig 机制、sort 触发 |
| `db.js` | :129-131 | getImportHistory API |
| `utils.js` | :436-465 | applySort importHistoryInfo 消费 |
| `App.jsx` | :239 | useFileOps 调用点，需要新增参数传递 |

---

## 本审计边界

- **纯静态取证**：所有结论基于文件:行号 grep + Read，无 runtime 探针
- **零代码改动**
- **未讨论 preview 冷渲染优化**（另一个话题）
- **未覆盖 import-history 新文件增量路径**（PR-3 退役后手动添加新文件的 detection 由谁负责——需在 pipelineState.js 暴露 `triggerIncrementalDetection` 方法，留给后续迭代）
