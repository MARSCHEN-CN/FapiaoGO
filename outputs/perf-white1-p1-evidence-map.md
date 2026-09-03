# PERF-WHITE-1 · P1-ReadOnly Evidence Map

> 状态：**纯只读审计** —— 本文件不含任何代码改动，不构成 P1 开工令。
> 目的：把 `454 importHistoryWrite → 195 applySort → 30s 白屏` 的因果链用代码行号钉死，
> 回答「P1 到底该批处理 / 加同序守卫 / 两者一起 / 还是另有放大器」。
> 数据来源：`outputs/perf-runs/run-261-1B-20260903.json`（热路径，importCount≥2=262 条）。

---

## 1. 十点链路（全部带 file:line 实证）

```
① 发起点    FileContext.jsx:211-293   useEffect([files])：建 byNumber（norm→fileKey[]，同号去重），
                                      300ms debounce 后 runPool(entries, 6) 并发查
② 回包点    FileContext.jsx:258       db.getImportHistory(norm).then(res => …)
                                      守卫：reqId 过期 / __error / exists≠true / importCount<2 全部静默 return
③ 写入点    FileContext.jsx:266-281   perfProbe.count('importHistoryWrite') 后
                                      setImportHistoryInfo(prev => …)   ← 454 次全在这
④ Map 构造  FileContext.jsx:267-279   new Map() 全量重建：拷贝 liveKeys∩prev 存活条目，
                                      再对同号 fileKeys 广播写入 {exists,invoiceDate,firstImportedAt,importCount,dateMismatchCount}
                                      ⇒ 一次响应 = 一次 O(size) 拷贝；多页共享号 = 一次重建内广播，不逐 key 重建
⑤ Sig 构造  useSort.js:77-80          importHistorySig = keys().sort().join('|')
                                      ⚠ 只取 key 集合，不取 value —— 值更新不改 sig
⑥ 消费点    useSort.js:20,56-60       参数接收 + ref 同步（effect [importHistoryInfo]）
⑦ 调用点    useSort.js:86-101         排序 effect [sortBy,sortOrder,sortSig,importHistorySig,setFiles]
                                      ⚠ 双闸门：combinedSig!==lastSortedSigRef(93) 才执行；count('applySort') 在 96
⑧ setFiles  useSort.js:97-100         setFiles(current => applySort(...))  函数式
              FileContext.jsx:60-63    dispatch SET_FILES（perfProbe.count('setFiles')）
⑨ 重派生点  FileContext.jsx:335-368   value memo deps 含 importHistoryInfo → 每次 Map 重建 = 新 value
              → Sidebar(65) + FileList(217) + 所有 useFileContext 消费者重渲染
              Sidebar:106-135 importHistoryCount memo deps [importHistoryInfo, documentView, files] 每次重跑 O(n)
              FileList rowProps useMemo:242-256 deps 含 importHistoryInfo → 每 flush 新 rowProps
⑩ 再执行    FileList.jsx:267-275      useLayoutEffect [files] → T6/T6p（epoch 守卫版）
              useSort.js:33-34/56-60   ref 同步 effect
              FileList.jsx:278-289     自动滚动 effect [previewFileKey, files]
              FileCardRow 比较器 FileList.jsx:198-214：importHistoryInfo 引用(211) → 每 flush 全挂载行失效
```

## 2. 六个问题的回答

### Q1 importHistoryInfo 的真实结构 → `useState(new Map())`，非 reducer，454 ≈ 454 个新引用

`FileContext.jsx:68` 是普通 `useState`，key=`file.key`，value 见 ④。
每次命中 = 一次函数式更新 + **全新 Map 引用**。454 次响应在并发 6 的 HTTP 流上分批到达，
跨响应的 React batching 只在同 task 落点生效（罕见）→ **454 次 Map 重建 ≈ 454 次独立 flush，
每次都是新状态引用**。原判断「454 命中 = 454 次新引用」成立。

### Q2 为什么 454 → 195 → 不是两个数字对不上，而是有两道闸在筛

195 的出处是 `useSort.js:96` 的 `count('applySort')`，只统计**真正执行了排序**的次数。两道闸：

1. **key 增长闸**：`importHistorySig` 只随 **key 集合变化**而变（⑤）。导入期间 files 渐进增长 →
   每轮 debounce 的 `byNumber` 集合都不同 → `firedSigRef`(FileContext.jsx:248) 允许对新集合重查 →
   **重查会重复命中已写入的 norm**（值更新或原样重写）→ 这些响应照常过 importCount≥2 闸
   并 `count('importHistoryWrite')`（454），但 key 没新增 → sig 不变 → 排序 effect 不触发。
2. **lastSortedSigRef 去重闸**（useSort.js:93）：同一 combinedSig 只排一次。

**结论：454 = 通过 count≥2 闸的响应数（含大量对既有 key 的重写）；195 ≈ key 集合真正增长
的 flush 数。**「454 写入 = 454 次排序」的 1:1 模型**被证伪** —— 排序不是按写入数放大。

### Q3 importHistorySig 精确依赖

- **A** 每次 Map 写入 → sig 变化 **当且仅当** 新增了 key；值更新（同一 key 换 invoiceDate/importCount）不触发。
- **B** 已存在 key 的重写（old 内容 == new 内容，或值变了 key 没变）→ sig **不变**，排序不触发。
  但注意：**渲染仍发生** —— Map 引用变了 → value memo(⑨) 变 → 消费者照样重渲染，只是不排序。
- **C** 多 fileKey 共享同一 invoiceNumber → `byNumber` 同号去重（FileContext.jsx:228-235）→ **一次响应内
  广播全部 fileKeys**（④，单次 Map 重建），不逐 key 重复写。响应数 ≠ fileKey 数。
  历史文件 262 条 count≥2 ≠ 454 响应 —— 差额来自多轮重查，坐实 Q2。

### Q4 applySort「无意义 setFiles」→ 守卫不存在，但被 sig 闸部分掩盖

`utils.js:529` 恒 `return [...分区]` —— **新数组，无同序守卫**。若排序 effect 触发，必然产出新 files 引用。
唯一的防抖是 useSort.js:93 的 sig 闸（阻止「根本不该排」的重排），不是「排了但顺序没变」。

两个不同性质的 churn 要分清：

| churn | 来源 | 频率 | 代价 |
|---|---|---|---|
| (i) Map 重建 + context 风暴 | 454 次响应各自 flush | ~454 | Sidebar memo + FileList + rowProps + 全部挂载行重渲染（⑨⑩） |
| (ii) 新 files 引用 + 全量 commit | 排序 effect 每次触发 | ~195 | 列表 commit + T6 打点 + react-window 全挂载行经比较器(198-214) |

(ii) 里真正的**无意义子集**：key 增长通常伴随真实顺序变化，但 react-window 行级比较器
`files[prev.index] !== files[next.index]`(201) 只挡「同 index 同 fileObj」的行 —— 而 211 行
`importHistoryInfo` 引用参与比较意味着 **flush 风暴里每行都重渲染**，哪怕该行未被本次写入波及。
所以 (i) 是更粗的放大器，P1-B 同序守卫只能砍 (ii) 的 commit 端。

### Q5 Map 重建不是主成本 —— 实锤支持你的成本模型

454 × O(261) Map.set ≈ 12 万次，JS 毫秒级。探针 durations 佐证：`buildDocumentViewModel` n=101
共 45.3ms、`selectDocumentRows` n=592 共 48.2ms、`invoiceDocumentsToRows` n=3 共 8.6ms ——
**所有被测的派生函数都便宜**。真正吃掉 42s long-task（300 条触顶截断，下界）的是 (i)+(ii)
叠加的 **React 调度 + 行级重渲染 + 布局** 风暴：每次 flush 让全部挂载行（视口 + overscan）重渲染
（比较器 211 行强制），~454 flush × 每行毫秒级 × 行渲染内联的发票字段/状态 → 超 50ms long task。

**P1 的正确目标 = 切断「单条 importHistory 响应 → 全局 files 重派生」的更新放大链**，不是「优化 Map」。

### Q6 业务契约冻结（P1 不改变什么）

```
① importHistory 查询次数不变     ② 查询结果内容不变
③ exists/invoiceDate/importCount 语义不变  ④ 排序规则不变
⑤ 最终 files 顺序不变            ⑥ 重复导入「计数≥2 才算重复」语义不变
⑦ DocumentStore 不变            ⑧ Preview/预览触发不变
P1 只允许改变 WHEN state updates are published，不允许改变 WHAT data is produced。
```

## 3. P1 候选方案（按证据排序，未实施）

- **P1-A 批处理（首选，主刀）**：响应不再各自 `setImportHistoryInfo`，先落 ref 侧 pending Map
  （同号合并、值去重），每 tick（rAF/IdleCallback/短 debounce）**一次 flush**；
  flush 时若合并结果与现 Map **无 key 新增且值全等 → 返回 prev 引用**（零重建、零渲染）。
  直接砍掉 (i) 的 454 次风暴，预期收益最大。
- **P1-B 同序守卫（副刀）**：`applySort` 内或 useSort effect 内做同序比较，顺序不变 → 返回
  prev files 引用。只砍 (ii) 的 commit 端 —— 但排序只在 key 真实增长时触发（Q2），且增长通常
  真改变顺序 → **独立收益有限，与 A 是两个独立变量**（你的判断成立）。
- **P1-C 行级细粒度（记录在案，本轮不推荐）**：FileCardRow 比较器 211 行改按「本行 key 的
  条目是否变化」判定，摆脱全 Map 引用。因虚拟化后挂载行仅 ~30，优先级低于 A。
- **⚠ 待证伪的隐藏放大器**：195 次 commit 里有多少次「顺序真的变了」没有直接计数 ——
  P1-A 落地后若白屏仍 >3s，需在 useSort effect 内加 `count('applySortOrderChanged')` 分诊。

## 4. 给 P1 实施前的验收基线（P0 校准已就绪）

- T6/T6p/T7 epoch 守卫已上线（`bd34dbd`）→ 新旧报告的 paint/commit 锚点可比。
- 判读器可比性守卫（`c7eef2c`）要求 `importHistoryWrite=0` 才认冷路径 —— **热路径对照仍缺失**，
  P1 效果量化建议：同一热路径条件下 A/B 对比（跑前不重置历史，保证 454 量级可复现），
  再补一轮真冷路径（历史重命名重置）拿绝对基准。
