# 展示区自动预览失效 —— 只读审查报告

> 日期：2026-09-04 · 主线 HEAD：`e499e40`（含用户自加的 2 个 trace commit `b1fcbf2` / `e499e40`）
> 诉求：只确定原因，**零代码改动**，评估回归风险。
> 审查范围：`App.jsx` 自动预览 effect → `usePreview.js`（handlePreview / doLoadPreview / loadFilePreview / 重试 effect）→ `utils/previewScheduler.js` → `utils/documentSelector.js`

---

## 一、总体印象

这条链路上**已经有两轮历史加固**（2026-08-23 Display Row Identity Contract、PreviewScheduler Contract v2 + P4 Ownership），设计质量高于一般业务代码：决策层抽成纯函数、有 `node --test` 覆盖、契约文档化，这些是好的。

但**自动预览这条路径与「用户点击」路径共用同一套 supersede 语义**，而两者的前置条件截然不同：点击发生在「行已就绪」时刻，自动预览发生在「行可能未就绪」时刻。现存的所有守卫都是围绕「防止旧请求复活 / 防止重复加载」设计的，**没有任何一处守卫检查「即将 commit 的快照是否真的可显示」**——这就是空白能凝固下来的根本原因。

---

## 二、故障链（为什么会「有时失效、点一次就好」）

```
导入完成
   │
   ▼
displayFiles 由 group rows 切换为 InvoiceDocument（身份切换，documentSelector.js:48）
   │
   ▼
App 自动预览 effect 触发 handlePreview(displayFiles[0])        App.jsx:994/1003/1009/1019
   │   ⚠ intent 默认 = 'select'                                 usePreview.js:2006
   ▼
select 语义 → 每次 ++version（supersede）                       previewScheduler.js:65-73
   │   ⇒ 上一次在途加载在 await 边界被判 abort                    previewScheduler.js:208-210
   ▼
handlePreview 150ms 防抖（可能对加载再推迟一轮）                  usePreview.js:2015-2030
   │
   ▼
┌──────────────── 分岔点：最后一次成功的 select 落在哪一刻？ ────────────────┐
│                                                                          │
│  A. 落在 docId 就绪之后                    B. 落在 docId 就绪之前           │
│     → loadFilePreview 走 RE 路径             → 走 fallback，返回裸 fObj      │
│       usePreview.js:1352 / 1477                usePreview.js:1584          │
│     → 正常显示 ✅                             → 仍然 commit（见 🔴-1）      │
│                                                → previewFile = 裸对象      │
│                                                → activeDocument = null     │
│                                                → 展示区空白 ❌              │
└──────────────────────────────────────────────────────────────────────────┘
                                                        │
                                                        ▼
                                       重试链能否自救？
                                        ├─ App effect 场景1 `!previewFile`      → false（已 commit）✗
                                        ├─ usePreview:2182 `if (!pf)`           → false（已 commit）✗
                                        ├─ usePreview:2129 docId 就绪重预览     → 有守卫缺口（🟡-3）
                                        └─ App effect 场景2/3 的 ref 已消费     → 不再成立（🟡-4）
                                                        │
                                                        ▼
                                        用户点击文件列表 → 新 select（行已就绪）→ 显示 ✅
```

「有时」二字的来源：**分岔点 A/B 取决于时序**，而时序受文件数量、后端解析速度、主线程繁忙度影响——这正是间歇性复现的特征。

---

## 三、问题清单

### 🔴 阻断级（根因）

#### 🔴-1 `loadFilePreview` 永不返回 null，未就绪快照会被当作成功结果 commit

**位置**：`usePreview.js:1584`（兜底 `return fObj`）+ `:1728`（commit 保险丝）

```js
// :1584 —— 无论加载是否拿到任何可用资源，都返回对象（永不 null）
return fObj

// :1728 —— commit 前只检查 execution 阶段，不检查快照内容
if (!execution || execution.phase !== 'post-load') return
```

**Why**：`loadFilePreview` 在 `docId` 未就绪时（`usePreview.js:1352` / `:1477` 的 `if (USE_RENDER_ENGINE_PREVIEW && fObj.docId)` 不成立）会落到 fallback 分支，`_previewImageUrl` 与 `_pdfData` 均为 null，但函数仍返回 `{...fObj, _previewImageUrl: null}`。这个「空壳对象」能通过 `:1728` 的保险丝（它只查 `phase`），一路走到 `setPreviewFile()`。

后果链条：
- `App.jsx:162` `activeDocument = useDocument(resolveDocumentIdentity(previewFile))` → 空壳无 docId → `null`
- `App.jsx:196` `documentViewerActive` → `false` → 走 legacy 路径，而 `previewCanvas` / `previewUrl` 都是 null
- **展示区空白，且 previewFile 非 null** → 直接导致下面所有 `!previewFile` 型重试全部失效

**这是「空白能凝固」的直接原因**：失败被伪装成了成功。

**修复方向（供决策，未实施）**：在 `:1728` 的保险丝上增加「快照就绪度」判定——例如要求 `loadedFile` 至少具备 `_previewImageUrl || _pdfData || previewImage` 之一，否则**不 commit**（保持 `previewFile` 为 null，让现有重试链继续有机会工作）。这个方向的好处是不触碰 supersede 语义，回归面最小。

---

#### 🔴-2 自动预览复用 `select` 语义，连续触发造成 supersede 雪崩

**位置**：`usePreview.js:2006`（`intent = 'select'` 默认值）+ `previewScheduler.js:65-73`

```js
// previewScheduler.js:65-73
if (intent === 'select') {
  const nextVersion = version + 1          // ⚠ 无条件递增
  return { version: nextVersion, transaction: {...}, action: 'start' }
}
```

**Why**：INV-PS3（显式点击一律 supersession）对**用户点击**是正确语义，但对**自动预览**是错配的——自动预览不是用户意图，而是「跟随列表」的派生行为。App 的自动预览 effect 有 4 个场景守卫（`App.jsx:993/1002/1008/1018`），且 `previewFile` 是 state（异步更新），同一轮 effect 内可能触发多次，跨轮更会重复触发。每次都 `++version`，前一个 execution 在下一个 await 边界（`resolveBoundary:208`）判定 `execution.version !== transaction.version` → `abort`。

**运行时佐证（Gate5 实测报告 `run-261-p1a-gate5-20260903.json`）**：
```
handlePreview:            185 次
previewRenderAttempts:      2 次
previewRenderCompleted:     1 次
```
185 次调用只有 2 次真正进入渲染——这就是 supersede 雪崩 + 防抖吞噬的直接量化证据。

**修复方向**：为「自动预览」引入独立 intent（如 `'auto'`），语义 = 「同 key 且不 supersede 已完成的有效加载」，或让 App 自动预览 effect 显式传 `'refresh'`。⚠️ 这会触及 Contract v2 的 intent 枚举，属契约变更，必须先出 red 测试并与 `previewScheduler.test.js` 现有用例对齐。

---

### 🟡 建议级（加剧因素 / 守卫缺口）

#### 🟡-3 防抖饥饿：`lastSwitchTimeRef` 只在非防抖分支更新

**位置**：`usePreview.js:2015-2030`

```js
if (now - lastSwitchTimeRef.current < 150) {
  clearTimeout(switchTimeoutRef.current)
  return new Promise(resolve => {
    switchTimeoutRef.current = setTimeout(async () => { ... }, 150)   // 重排
  })
}
lastSwitchTimeRef.current = now      // ⚠ 只有走到这里才更新
return doLoadPreview(...)
```

**Why**：连续调用间隔 < 150ms 时，每次都走防抖分支，`lastSwitchTimeRef` 永不更新 → 永远走防抖分支 → 每次 `clearTimeout` 后重排 150ms。若调用持续密集（导入后 `files` effect 反复重跑时正是如此），`doLoadPreview` 会被**无限推迟**。用户点击是离散手势（间隔必然 > 150ms），所以总能立即执行——这恰好解释了「自动不行、点一下就行」的手感差异。

**Suggestion**：防抖分支内也更新时间戳（改为「距离上次实际执行/上次排程」），或改用 throttle（首次立即执行 + 冷却窗内合并末次）。这属于局部改动，回归风险低于 🔴-2。

---

#### 🟡-4 保底重试 effect 的守卫缺口：`if (!pf) return`

**位置**：`usePreview.js:2129-2140`

```js
useEffect(() => {
  const pf = previewFileRef.current
  if (!pf) return                                     // ⚠ 从未 commit 过 → 永不重试
  const live = filesRef.current.find(f => f.key === pf.key)
  if (!live) return                                   // ⚠ key 查不到 → 永不重试
  const changed = live.docId !== pf.docId
  if (changed) handlePreviewRef.current?.(live, 'refresh')
}, [livePreviewDocId])
```

**Why**：这是唯一能救「自动预览首次失败」的兜底，但它要求 `previewFileRef.current` 非空。结合 🔴-1，一旦空壳被 commit，`pf` 非空但 `pf.docId` 为空，此时若 `live.docId` 也未变（回填发生在别处），`changed` 为 false → 不重试。两个守卫在「自动预览失败」这个具体场景下恰好都失效。

**Suggestion**：把 `!pf` 的情形也纳入——当「有文件但无预览」时主动发起一次预览，而不是静默 return。

---

#### 🟡-5 App 自动预览 effect 的三个 ref 无条件更新

**位置**：`App.jsx:1023-1025`

```js
prevFilesLengthRef.current = displayFiles.length
prevDocIdPresenceRef.current = firstHasDocId
prevFirstDocIdRef.current = firstDocId
```

**Why**：这三个 ref 在每次 effect 运行时都写，无论本次是否真的触发了 `handlePreview`。于是「documentId 从无到有」这类一次性跃迁条件，若在行未就绪的那一次被消费掉，之后即使行真正就绪，条件也不再成立 → 不再触发。这让故障从「偶发」变成「可凝固」。

**Suggestion**：仅在真正发起预览后更新 ref，或增加一个「已成功预览」的事实源（而非「已尝试」）。

---

### 💭  nit / 文档债

#### 💭-6 过时注释与代码矛盾

- `App.jsx:1013` 注释称「InvoiceDocument 无 key 属性」，但 `InvoiceDocument.js:88` 明确 `key: fileKey`，且装配路径 `parseResultConsumer.js:55` 用 `{ ...fileObj }` 展开继承 `key`。**该注释已过时**，会误导后续维护者（本次审查就一度被它带偏）。
- `documentSelector.js:47` 注释「已含 `_isDocumentGroup` / `_pageCount` / `_pages` 等完整字段」，但 `:48` 返回的是 `sortInvoiceDocsByFiles(invoiceDocs, files)`（InvoiceDocument 数组），这些 `_` 前缀字段属于 row 而非 InvoiceDocument，注释与实现不符。

---

## 四、已排除的假设（重要，避免走错方向）

| 假设 | 结论 | 证据 |
|---|---|---|
| 「InvoiceDocument 无 key → 身份查找失效」 | ❌ **证伪** | `InvoiceDocument.js:88` 有 `key: fileKey`；`parseResultConsumer.js:55` `{ ...fileObj }` 继承 key |
| 「displayFiles 降级裸行 → storeDocument=null」 | ❌ 已修于 2026-08-23 | `documentViewCacheIdentity.js` + `displayRowIdentity.js` 冻结契约已覆盖 |
| 「旧 render effect 取消新 transaction（P4）」 | ❌ 已修 | `resolveCommittedClear`（`previewScheduler.js:326`）已实现，`usePreview.js:220` 已接入 |
| 「预览渲染本身慢」 | ❌ 非主因 | Gate5：`previewRenderCompleted=1` 说明渲染几乎没机会跑，问题在触发/commit 层 |
| 「并发受限导致加载排队」 | ⚠️ 未证实 | `runPool(entries, 6)` 只作用于 importHistory 查询，不在预览路径 |

---

## 五、如何在不改代码的前提下确认（建议的验证顺序）

1. **跑一次带探针的导入**，重点看这三个计数：
   - `handlePreview`（预期仍很高，佐证 🔴-2）
   - `previewRenderAttempts` vs `previewRenderCompleted`（两者都低 ⇒ 卡在触发层，非渲染层）
2. **观察失败时 `previewFile` 的内容**：若 `previewFile` 非 null 但 `_previewImageUrl === null && _pdfData === null`，即直接坐实 🔴-1（空壳 commit）。
3. **对比自动 vs 点击的 docId 状态**：自动预览触发时刻打印 `displayFiles[0].docId`，若为 null 而点击时非 null，即坐实分岔点 B。
4. 你已加的两个 trace（`groupDocuments` / `buildDocumentViewModel`）可辅助确认 displayFiles 切换时机，与本报告的时序假设互证。

---

## 六、回归风险评估（为什么不能贸然改）

改动这条链路会同时触及**两份冻结契约**，必须先出 red 测试：

| 契约 | 冻结内容 | 贸然改动的风险 |
|---|---|---|
| PreviewScheduler Contract v2 | INV-PS1~PS11，尤其 INV-PS3（select 一律 supersession）、INV-PS9（单 execution）、INV-PS10（restart 不 fork） | 破坏「快速连点只保留最后一次」的手感，或造成双 execution 竞态 |
| Display Row Identity Contract（2026-08-23） | 禁止消费侧用裸 key 静默兜底 | 若用「fallback 到 file.key」的方式修自动预览，会直接违反 D5 |

**建议的修复优先级**（风险由低到高）：

1. **先修 🔴-1**（快照就绪度 gate）——纯增量守卫，不改任何现有语义，回归面最小，且能直接消除「空白凝固」。
2. **再修 🟡-3**（防抖饥饿）——局部改动，独立可测。
3. **🔴-2（intent 语义）最后做**——属契约变更，需新 red 测试 + 契约文档同步。

---

## 七、结论

**根因不是「自动预览没触发」，而是「自动预览触发了太多次，前 N-1 次被自己 supersede 掉，最后一次若落在行未就绪时刻，会 commit 一个空壳 previewFile；而空壳的非 null 存在，恰好让所有基于 `!previewFile` 的重试守卫全部失效，于是空白凝固。用户点击时行已就绪，一次成功。**

一句话概括：**失败被伪装成了成功，从而屏蔽了所有自救通道。**
