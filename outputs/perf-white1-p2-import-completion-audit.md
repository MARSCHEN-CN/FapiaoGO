# PERF-WHITE-1 · P2 Import Completion Audit（纯只读，零代码改动）

> 日期：2026-09-03　分支：rotation-b1-hardening　基线：Gate 5 实测（P1-A 后，run-261-p1a-gate5）
> 方法：静态取证（文件:行号证据）+ Gate 5 计数器交叉验证。**本阶段不插桩、不改码**。
> 目的：回答「为什么列表已完整、而展示区与重复报销计数仍在 T4/T5 之后后台收敛」。

---

## 0. 结论先行

两个现象**不是两个独立系统，而是同一条「T5 后反馈环」的两个下游表现**：

```
files 引用变化
   │  (排序 / import history 发布 / hydration 每批)
   ▼
FileContext [files] effect 重跑（importHistoryBatcher.jsx 查询 effect）
   │  cleanup 无条件重置 firedSigRef  ← 🔴 反馈环咽喉
   ▼
300ms debounce → runPool(6) 全量查询历史
   │
   ▼
命中 → enqueue → batcher 50ms flush → setImportHistoryInfo（Map 变大）
   │
   ▼
useSort importHistorySig 变 → applySort → setFiles（重排）
   └──────────────────────┬───────────────────────┘
                          ▼  （回到顶部，再触发一轮）
```

环内每一次 files 变化同时驱动 `displayFiles` 重建 → 自动预览 effect 反复评估 →
`handlePreview` 185 次（Gate 5 计数坐实）→ 后端 `/preview` 冷渲染被反复作废重发 →
展示区目标漂移、「陆续加载」。

**逐条回答用户的判断**：
- ✅ **「T4/T5 不代表导入后状态稳定」——成立。** T4/T5 只覆盖 parse+hydration+注册+seal，不覆盖 import history 查询收敛、不覆盖排序收敛、不覆盖预览渲染稳定。
- ✅ **「导入完成条件定义错了」——部分成立**，但修正为更精确的表述：**completion 边界（T2/T4）正确地覆盖了数据注册（结构上 261/261 在 T2 前完成），错的是「advisory 旁路（import history）+ 预览渲染」在弹窗关闭后仍持续驱动 UI 状态更新（重排/计数/预览重发），用户感知为『没做完』**。
- ⚠️ **候选 ①② 排除**（注册不在后台渐进，见 §3.1）；**候选 ③ 命中但程度更重**（是带重放环的 effect，不是简单 useEffect 收敛，见 §4）；**候选 ④ 命中核心**（见 §6 完成契约映射）。

---

## 1. 锚点取证：T4/T5 的真实语义（P2-0 扫描项 1-3）

| 锚点 | 触发点 | 条件 |
|---|---|---|
| T2 | `useFileOps.js:1094` | `runChunkedImport` **返回后**（= 全部分批 create→parse→`await hydrateChunk` 完成） |
| T3 | `useFileOps.js:1100-1101` | 末次 `flushUpdates()` 后 |
| T4 | `useFileOps.js:1109-1111` | `setImportStage('completed')` + progress=100 后立即 mark |
| T5 | `useFileOps.js:1133-1136` | `dismissModal` 内 mark。到达路径：`setTimeout(0)`(1159) → 双 rAF(1150-1153) → `setTimeout(250ms)`(1131/1148) → dismiss（>50 文件时 T4→T5 ≈ 2 帧 + 250ms） |
| 观察窗收尾 | `useFileOps.js:1140` | T5 后 `setTimeout(15000ms)` → `finishSession` |

**关键结论**：
- T4 的唯一上游 = parse 主流程完成。`runChunkedImport.js:185` **`await hydrateChunk`**，hydrateChunk（`useFileOps.js:667-1075`）内对每 chunk **同步**执行 `ensureDocumentFromFileObj` + `addDocument` + `sealDocument` + `flushUpdates`。→ **T2（乃至 T4）时，全部 InvoiceDocument 注册与 seal 在结构上已经完成**（ImportScale v1 批量路径）。Fallback 路径同样被 await（`useFileOps.js:1090` `Promise.all(parseWorkers)` + `:1100` flushUpdates）。
- 弹窗关闭链（T4→T5 的 0/双 rAF+100/250ms）是**固定延时**，不等待任何「渲染完成」信号——这正是 1B 时「250ms 后关闭、列表 30s 后才 commit」的原始设计缺口（已由 P1-A 的发布合并缓解，但结构上仍未等待）。

---

## 2. Track B 全链取证：重复报销 80 → 86 → 90

### B1：检测在哪里启动？
**不是** per-parse、**不是** DocumentStore effect，而是 `FileContext.jsx:238-305` 的 **`[files]` effect + 300ms debounce + runPool(6) 并发 HTTP**：
- `FileContext.jsx:249-256` 归一化号去重建 `byNumber`（号 → fileKey[]）
- `:265` 300ms debounce；`:267` 请求令牌 `myReq`（防旧轮回写）；`:271` `runPool(entries, 6, ...)`；`:272` `db.getImportHistory(norm)`
- `:278` 命中门控 `importCount >= 2`（首次导入 count=1 不算重复报销）
- `:284` P1-A 后合入 batcher `enqueue`（不再逐条 setState）

### B2：为什么增量（80→86→90）？
**Sidebar 计数 = importHistoryInfo Map 填充进度的 1:1 读数**：
- `Sidebar.jsx:106-135` `importHistoryCount` useMemo 遍历 `documentView.documents`，逐文档检查 `importHistoryInfo.has(p.key)`
- 每次 batcher flush（50ms，`importHistoryBatcher.js:98`）→ `setImportHistoryInfo` 新 Map → 计数跳变一次
- 查询并发仅 6、命中响应按 HTTP 完成序到达 → Map 渐进填满 → 计数 **80 → 86 → 90** 是查询波次内逐条命中的可视化，不是业务状态渐进。

### B3：为什么迟迟不收敛？→ 🔴 反馈环（本审计最重要发现）
```
useSort.js:86-101   applySort → setFiles（每次 importHistorySig 变化重排一次；Gate5 = 51 次）
        │
        ▼
FileContext.jsx:298-304  effect cleanup：clearTimeout + **firedSigRef.current = ''**（无条件重置）
        │
        ▼
FileContext.jsx:261-262  守卫失效：firedSigRef 已清空 → sig 非空 → 不 return → **300ms 后全量重查**
        │
        ▼
（查询结果发布 → Map 变大 → 重排 → 回到顶部）
```
**要害**：排序只改变 files 的**顺序**（key 集合不变），`byNumber` 重建的 sig 其实没变——本应命中 `:262` 去重直接跳过。但因为 cleanup **无条件**把 `firedSigRef` 重置为 `''`，任何一次 files 引用变化（哪怕纯排序）都会触发**一整轮全量重查**（~200 唯一号 × 并发 6）。

**Gate 5 计数器交叉验证**：
- `importHistoryQuery = 738` ≈ 3.5 轮 × ~200 唯一号/轮（**多轮重查坐实**）
- `importHistoryResponse = 203`（命中累计）> 最终唯一文档数 ~90 → **同 key 多轮重复命中坐实**
- `applySort = 51`：43 次 publish 中凡带新 key 者触发重排 + 其他触发源
- 收敛条件 = 某轮查询结束后**不再有新命中产生新 key** → Map 停止增长 → importHistorySig 不再变 → 环停。这是「碰运气收敛」，不是幂等设计。

### B 模型判定（用户 4 模型）
| 模型 | 判定 |
|---|---|
| 模型 1：DocumentStore 逐批加入 → 每批重检 | ❌ 不成立：检测与 DocumentStore 无关，只依赖 files + import history HTTP |
| 模型 2：React effect + debounce 重检 | 🟡 部分：机制确实是 files effect + 300ms debounce，但收敛失败的主因是 **cleanup 重置 firedSigRef 导致的重放环**，超出普通 debounce 收敛 |
| 模型 3：检测输入不稳定（fields 渐进到达） | ❌ 不成立：查询目标 = 已 parsed 且带 invoiceNumber 的 file（hydration 在 T2 前完成，输入稳定） |
| 模型 4：多重复检测消费者互相覆盖 | ❌ 不成立：**单消费者**（FileContext 查询 effect）；Sidebar/FileList 只读消费 |

---

## 3. Track A 全链取证：展示区为什么 T5 后还在等待

### 3.1 A1/A2：T4 时 DocumentStore 注册了多少？——结构上 = 261/261
- `runChunkedImport.js:184-185`：每批 parse 完成 → **await hydrateChunk**
- hydrateChunk 内（`useFileOps.js:685-1075`）：按 100/批遍历 chunk → 逐 file `ensureDocumentFromFileObj`（`DocumentStore.js:133+`）+ `addDocument(session, doc)` + `sealDocument` + `flushUpdates`（:1045-1053）——**全部同步、无 fire-and-forget 尾部**
- T2 在 runChunkedImport 返回之后 mark → T4 时注册必然已完成
- 唯一 T4 后仍在动的注册相关后台 = `ImportSessionStore.js:59` **60s session TTL**（GC 语义，不影响展示区）

> **结论：展示区延迟不是「DocumentStore 注册还没完」（候选 A 排除）；不是「parseResultConsumer 异步未等待」（候选 B 排除——批量路径根本不经过 parseResultConsumer，它是 fallback 单文件路径 `useFileOps.js:29` 的入口，且 fallback 也被 Promise.all await）。**
> A2 的运行时精确值（T5 时 size）仍建议探针实测一次以闭环（见 §7 测量点 M1），但静态结构已无悬念。

### 3.2 A3：展示区真正等待的是什么？——预览渲染管线（不是数据注册）
展示区显示链路：
```
App.jsx:162  activeDocument = useDocument(resolveDocumentIdentity(previewFile))   // 订阅 DocumentStore
App.jsx:121-131  displayFiles = selectDocumentRows({invoiceDocs: documentView?.documents, files, ...})
DocumentViewer.jsx:109-112  <img src=`${BACKEND_URL}/preview/${docId}?page=N`>    // 后端按需栅格化 WebP
previewResourceResolver.js:39-48 / ViewerViewport.jsx:380-386（loading="eager"）
```
等待的两层：
1. **activeDocument null 层**：注册完成前 `useDocument` 返回 null → App.jsx:1188-1218「加载中…」。结构上注册在 T2 前完成 → 这层只在**弹窗关闭前**存在，不是 T5 后长等待主因。
2. **`/preview` 冷渲染层（主因）**：后端对每个 docId **首次冷渲染**（App.jsx:166 注释：首次 701ms → 命中 render cache 后 6ms）。previewFile 目标每次漂移 → 新 docId 冷渲染 → 展示区空白直到该 img 返回。

### 3.3 「内容陆续加载」的机制
- 自动预览触发源**过多且随重排风暴反复评估**：
  - `App.jsx:972-1026`：场景 2（documentId 从无到有）/3（firstDocId 变化）/4（previewFile 身份不在 displayFiles）
  - usePreview 内部（约 `:2070-2109 / 2129-2140 / 2161-2194`）：docId 晋升、引用替换
- `displayFiles` 在每次 files/documentView 变化时**重建新数组**（`App.jsx:121-131`，deps 无稳定引用缓存）
- Gate 5：`handlePreview = 185`（计数含防抖层入口 `usePreview.js:2007`），但 `previewRenderAttempts = 2 / previewRenderCompleted = 1` → 绝大多数在防抖/守卫/版本层消化；`doLoadPreview` 的版本守卫 `usePreview.js:1971`（`version !== previewVersionRef.current` → 丢弃）保证**只有最后一个目标提交渲染**
- 视觉结果：重排风暴期（~10s+，受 §2 反馈环驱动）内目标反复漂移 → img 请求作废重发 → 风暴收敛后末目标冷渲染完成 → 内容「终于」出现；期间主线程被 43 publish + 51 applySort + 查询响应占住（Gate5：180 longTasks / 27s），img 解码绘制进一步被推迟

> **展示区等待 = 自动预览目标漂移（下游） + 后端 /preview 冷渲染（下游）× 主线程被反馈环占住（上游）。修复反馈环（P2-A）应同步缩短展示区等待——这是两个现象的共因。**

---

## 4. 用户 4 嫌疑对象判定

| 嫌疑 | 判定 | 证据 |
|---|---|---|
| ① parseResultConsumer | ✅ **排除** | 批量路径不经过它；fallback 路径被 `Promise.all` await（useFileOps.js:1090） |
| ② InvoiceAssemblyPipeline REGISTERED→SEALED 后台异步 | ✅ **排除** | hydrateChunk 内同步 ensure/add/seal，被 await（runChunkedImport.js:185） |
| ③ Duplicate Detection useEffect | 🟡 **命中、但程度更重** | 触发 = files effect + 300ms debounce（FileContext.jsx:238-305）；收敛失败 = **firedSigRef cleanup 无条件重置 → 重放环**（:298-304 vs :261-262） |
| ④ ImportBatch/ParseJobManager 完成条件 | 🟡 **命中核心** | parse/hydrate/注册边界正确；但系统把 advisory 旁路（import history，:228 注释明言「绝不作为 import pipeline dependency」）与预览渲染**排除在 completion 之外**，而它们在弹窗关闭后继续驱动 UI 更新 |

---

## 5. Import Completion State Graph（现状，实测/静态混标注）

```
                 PARSE COMPLETE（261/261）
                         │  runChunkedImport await 全部批次（runChunkedImport.js:185）
                         ▼
               hydrate + 字段回填 + queueUpdate（T2 前）
                         │  flushUpdates（useFileOps.js:1100）
                         ▼
              DocumentStore 注册+seal 261/261 ✅（结构上）
                         │
                         ▼  setImportStage('completed') + 100%
                        T4
                         │  setTimeout(0)→双rAF→250ms（固定延时，不等渲染）
                         ▼
                      T5 弹窗关闭
        ┌──────────────────┴────────────────────────────┐
        ▼                                               ▼
 FileList 已完整 ✅                              🔴 T5 后仍在跑的后台：
                                                    │
                          ┌─────────────────────────┼──────────────────────────┐
                          ▼                         ▼                          ▼
              importHistory 查询环          useSort 重排（51 次）       自动预览目标漂移
              （300ms+runPool6+重放）             │                    （handlePreview 185 次）
                          │                         │                          │
                          ▼                         ▼                          ▼
              Map 渐进填充 →                files 引用反复变 →         /preview 冷渲染作废重发
              Sidebar 80→86→90             displayFiles 重建          → 内容「陆续加载」
                          └─────────────── 反馈环（§2 B3）──────────────┘
```

---

## 6. 完成契约映射：现状 vs 你定义的 IMPORT COMPLETE

| 完成项 | 现状完成时刻 | 判定 |
|---|---|---|
| ① 文件解析完成 | T2（ParseJobManager await 全批） | ✅ 在 T4 前 |
| ② InvoiceDocument 注册 | T2 前（hydrateChunk await 内） | ✅ 在 T4 前（结构上 261/261） |
| ③ DocumentStore 状态稳定 | T2 前 + 60s session TTL GC | ✅（GC 不涉展示） |
| ④ 重复报销检测完成 | ❌ **不在 pipeline**：files 稳定后 300ms 才启动（FileContext.jsx:265），并发 6 + 重放环 → T5 后 ~10s+ 才碰运气收敛 | 🔴 **契约缺口 1** |
| ⑤ import history 状态完成 | ❌ 同 ④（同一查询环） | 🔴 契约缺口 1 |
| ⑥ files 最终排序完成 | ❌ 受 ④ 驱动 51 次重排，收敛于 Map 停增 | 🟡 契约缺口 2（P1-A 已减量未除根） |
| ⑦ 展示区首个文档可展示 | ❌ 预览渲染在 T5 后目标漂移收敛 + 冷渲染完成后 | 🟡 契约缺口 3（视觉渲染可延迟，但数据态应立即可展示——当前数据态其实已就绪，卡的是渲染目标稳定） |

> 修正你的框架：**⑦ 的「数据态」在 T4 前已就绪（activeDocument 可解析）**——T5 后等的不是数据，是渲染目标稳定 + 冷渲染 + 主线程空闲。而 ④⑤⑥ 的完成边界确实错位。

---

## 7. P2 测量点（Completion Ledger 运行时列；本阶段不插桩，留作下一轮探针扩展）

| # | 测量点 | 探针位置（建议） | 回答的问题 |
|---|---|---|---|
| M1 | T4/T5 时 `getRegisteredDocIds().length` | App/FileContext 在 T4/T5 锚点旁 | A1/A2 实证（预期 261） |
| M2 | import history 查询轮数（firedSigRef 重置次数） | FileContext.jsx:267 | 重放环轮次实证（预期 ≈3.5 匹配 738） |
| M3 | importHistoryInfo.size 稳定时刻 + 末次 publish 时刻 | batcher onPublish | ④⑤ 收敛时刻实测 |
| M4 | 末次 applySort 时刻 | useSort.js:96 | ⑥ 排序收敛时刻实测 |
| M5 | previewFile 首个 img onload 时刻 | ViewerViewport.jsx img onload | ⑦ 展示区 ready 实测 |
| M6 | handlePreview 185 次的触发源细分（按 App 场景 2/3/4 vs usePreview 内部 effect 计数） | App.jsx:994/1003/1009/1019 + usePreview 内各触发点 | 自动预览漂移来源归因 |
| M7 | parseMs 机差（跨轮不可比，仅记录） | — | 机差标注 |

预期台账形态（你要求的 Completion Ledger 实例）：

| 阶段 | 完成时刻 | 与 T4 的差 |
|---|---|---|
| Parse Complete | T2 | T4-T2≈0（同批） |
| InvoiceDocument Registered | T2 | ≈0 |
| Import History Settled | T5 + ~10s（推测，待 M2/M3 实测） | 🔴 |
| Duplicate Count Settled | 同上 | 🔴 |
| Files Sorted | 随 publish 51 次，末次≈Settled | 🔴 |
| Display Data Ready | T2+ε（数据态） | ✅ |
| Preview Ready | T5 + 漂移收敛 + 冷渲染 | 🟡 |

---

## 8. P2 修复候选（仅评估，不实施，待你拍板；严格遵守一次只改一个变量）

### P2-A（推荐，先做）：import history 查询幂等收敛 —— 切断反馈环
- **改动点**：`FileContext.jsx:298-304` cleanup——**不再无条件重置 firedSigRef**；改为「仅当 files 的 key 集合（或归一化号集合）真正变化时才允许重查」。纯排序 / 纯字段更新 / 纯内容更新不重置 → `:262` 去重守卫恢复效力 → 全量查询每批文件只发一次 → 计数一次收敛（80→90 一跳到终值，无 80→86→90）。
- 需要同时复核 `firedSigRef` 在 StrictMode remount 的语义（现注释说 cleanup 重置是为防 StrictMode 双调用跳过查询——需区分「卸载重置」与「files 变化重置」，或改用挂载级 ref）。
- 收益：① ④⑤ 在首轮查询波内收敛（~200 号 ÷ 6 并发 ≈ 数秒内一次到位）；② 消灭后续多轮重排（applySort 51 → ~个位数）；③ 展示区自动预览目标停止漂移 → ⑦ 缩短。
- 风险：低-中。TDD 用例（4 个行为测试）：
  - T1：同批文件纯排序 → **不重查**（firedSig 保留）
  - T2：新文件加入（key 集合变）→ 重查一次
  - T3：删除文件 → 重查一次
  - T4：查询命中后 Map 增长 → 不因自身发布触发下一轮
- **不改变**：advisory 定位（仍 fire-and-forget）、查询接口、命中门控、Sidebar 计数逻辑。

### P2-B（可选，契约层，侵入大，需先拍板哲学问题）：import history 纳入弹窗关闭等待
- 与 FileContext.jsx:228 注释「绝不作为 import pipeline dependency」的既有设计哲学**冲突**。若产品要求「弹窗关闭前计数必须准确」，需改变 advisory 定位 → 把「首轮查询波收敛」纳入 dismiss 前等待（不等多轮，P2-A 后一轮即收敛）。
- 建议：先做 P2-A 再看是否需要 B——P2-A 后一轮收敛 ≈ 数秒，弹窗多等 1-2s 可换来计数准确，但把 HTTP 查询塞进弹窗路径也把风险带回主流程。

### P2-C（依赖 P2-A 观察后再定）：自动预览去抖/单飞
- doLoadPreview 已有版本守卫（`usePreview.js:1971`），真正问题是**触发源多**。P2-A 后 displayFiles 重建次数骤降，185 次 handlePreview 应自然回落——先测后修（M6）。

### P2-D（先取证）：若 P2-A 后展示区仍慢，再查 /preview 冷渲染并发与后端 render cache 预热策略。

---

## 9. 本审计的边界与盲区
1. **纯静态 + 计数器反推**：A1/A2/收敛时刻的运行时精确值需 M1-M6 探针（下一轮扩展，需你批准插桩）。
2. 185 次 handlePreview 的**触发源归因**未静态钉死（App 场景 vs usePreview 内部 effect 的比例）——不影响结论方向，但 P2-C 前应补 M6。
3. 展示区「陆续加载」的用户观感与 img 渲染的精确对应（是否含缩略图/翻页路径）未逐一验证——按现有证据（previewRenderCompleted=1、RE/img 主路径）收敛于目标漂移解释。
4. parseMs +27%（48.1→61.3s）判为机差（后端未动、同 261 文件），跨轮不可比。
