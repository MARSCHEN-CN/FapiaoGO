# Stage 4.2.0 — Import Contract Audit（只读）

> 目标：先证明当前 Import 世界里 `fileObj` 的真实流向，再决定恢复方案。不改代码。
> 结论：Identity Contract 的**结构**已闭合，但 `docId` 的**进给**只在多页 PDF 拆分一处分流接上；单文件主流路径静默降级为 `''`，且存在一个绕过 `buildFileObj` 的裸字面量入口。

---

## 1. Entry Points

| 入口 | 构造位置 | 是否注入 identity | 是否保留 key/docId/path |
| --- | --- | --- | --- |
| Drop | `onDrop` (useFileOps:681) → `processFilesForAddition:255` → `processPdfFile`/`buildFileObj` | ✅ 经 `buildFileObj` → `resolveIdentity` | ✅ key(占位)/path/docId(部分) |
| Picker | `handleOpenDialog:712` → `resolveFile` → `processFilesForAddition` | ✅ 同上 | ✅ |
| Folder | `handleOpenFolder:732` → 同上 | ✅ | ✅ |
| **Context Menu** | **`App.jsx:584 handleContextMenuFiles` → 裸字面量 `:586-592` → `parseFiles`** | **❌ 绕过 `buildFileObj`/`resolveIdentity`** | ✅ key/name/path 但**无 identity、无 searchText** |
| Batch | `ImportBatchClient.js`（NEW 未跟踪）— 纯 API 客户端 | N/A（只发 `File`+`clientKey`，hydration 在 orchestrator） | N/A |

**发现 A1（自造身份）**：`App.jsx:586-592` 是裸 `fileObj` 字面量，直接 `setFiles` + `parseFiles(initialFiles)`，**完全绕过 `buildFileObj`**。用 `generateFileKey(file.name)` 自造 key，无 `identity`。这是当前唯一一个「自造身份」入口。

---

## 2. fileObj Contract（当前真实结构）

`buildFileObj` (fileHelpers.js:17-46) 产出：
```
{
  key, name, path, file,
  status, invoiceType, invoiceNumber, amount, invoiceDate,
  newName, parseMethod, fileFormat, previewImage, printPath,
  docId,            // buildFileObj 入参透传；多数路径为 null
  pageNum,
  identity,         // resolveIdentity({key, docId, contentHash, pageNum})
  searchText
}
```
`identity` = `{ uiKey, docId, sourceHash, pageId? }`（identity.js:60-69）。

**身份字段归属：**
| 字段 | 当前用途 | 正确归属 | 判定 |
| --- | --- | --- | --- |
| key | React key / 去重 / selection | UI/session | ✅ 正确 |
| docId | DocumentState.id / DocFacts 写键 | Document | ✅ 正确（但多数路径为 `''`） |
| path | 文件读取定位 | source locator | ✅ 正确 |
| identity | 统一身份出口 | contract | ✅ 正确 |

**发现 B1（`stripIdentity` 误读澄清）**：
- `stripIdentity` (identity.js:19-24) 的 `IDENTITY_FIELDS = ['key']` —— **只剥 `key`，不剥 `identity` 对象**。
- 编排器 `splitWorker` (useFileOps:375/396) 调 `stripIdentity(toAdd[0])` 仅移除 `key`，**`identity` 存活**；随后 `{...p, ...toAddRest}` 由占位项 `p.key` 胜出。
- 结论：4.1.3 注入的 `identity` **确实抵达文件列表**，三路合并（单页PDF/多页/非PDF）全部保留 `identity`。✅（初判「被剥离」是误读，已纠正。）

**发现 B2（docId 进给缺口）—— 本次最重要**：
- `resolveIdentity` 全仓**仅**在 `buildFileObj` (fileHelpers.js:22) 调用一次；parse 结果从不二次 resolve。
- `buildFileObj` 的 `docId` 入参，仅有**多页 PDF 拆分路径** (fileHelpers.js:96, `data.doc_id` from `/split_pdf`) 提供真实 docId。
- 其余 3 个调用点（splitRunner:52、fileHelpers:76、fileHelpers:113）传 `docId=null` → `identity.docId=''`（partial）。
- **`mapParseResultToFileUpdate` (parseResultMapper.js:24-54) 不回写 `docId`/`identity`**：后端解析时算出的 docId 在该 mapper 被丢弃。
- 结果：**单文件导入（最主流路径）的 `identity.docId` 永远是 `''`**，`DocumentState.id` / `RenderSpec.docId` / `DocFacts` 写键全部退化成 `''`。这符 4.1.3 方案 A「partial identity 允许」，但意味着 **4.1 闭环目前只对多页 PDF 拆分真正生效**，单文件路径静默降级。

---

## 3. Identity Flow

```
Import
  │
  ├─ Drop/Picker/Folder
  │     └─ buildFileObj() ── resolveIdentity()
  │              └─ fileObj.identity  (docId: 仅多页PDF有值, 其余 '')
  │                        │
  │                        ▼
  │              splitWorker → stripIdentity(仅剥key) → 列表项【含 identity】
  │
  ├─ Context Menu (App.jsx:584)
  │     └─ 裸字面量 → setFiles + parseFiles  【无 identity, 无 searchText】
  │
  ▼
Parse (runFallbackParseTask / ImportBatchClient)
        └─ mapper: mapParseResultToFileUpdate
                  └─ 回写业务字段, 【不回写 docId/identity】
                        │
                        ▼
              fileObj.identity.docId 仍为 '' (单文件)
                        │
                        ▼
  ┌──────────────────────────────────────────────────────┐
  │ DocumentState.id = identity?.docId || docId           │
  │   → 多页PDF: abc123  ✓                              │
  │   → 单文件:    ''      (静默降级)                  │
  └──────────────────────────────────────────────────────┘
```

---

## 4. ImportSession Boundary

- `models/ImportSession.js`：**纯数据模型**（`createSession`/`createSessionFile`）。`createSessionFile` 的 `id: input.key`（:107）—— Session 级 id 用 **key（UI 身份）** 作 id，非 docId。注释明确「契约冻结阶段，已定义但不迁移任何现有状态」（:8-11）。
- `stores/ImportSessionStore.js`：真实状态权威（`addFilesToSession`/`replaceFileItems`/`updateFileStatus`），useFileOps:266 注释确认。
- **判定**：ImportSession 当前**不**承担 identity 生成 / rendering / preview / persistence。职责边界清晰 ✅。它现在的问题是「定义但未被主流程采用」（主流程用 `placeholderGenerator` + `ImportSessionStore`）。这是 4.2.2 的恢复对象，非 4.2.0 问题。

---

## 5. Import Scale Impact（D 节）

- `useFileOps.js`（未提交 +218/-13）：diff 仅新增 `import { createImportBatch... }` 与 `enqueueParse([{fileObj:{...p,key}}])` → `collectOrEnqueue({...p, key})`。**未改 fileObj 形状、未绕过 buildFileObj。**
- `ImportBatchClient.js`（NEW 未跟踪）：纯 fetch/SSE 客户端，发送 `File` + `clientKey`，接收 progress/results（含 `clientKey` 用于匹配）。**完全不构造 fileObj**。
- **判定 = 情况 1**：Import Scale 仅扩展批量能力，**不改变 fileObj contract**。可与 4.2 隔离继续。⚠️ 但 batch hydration (`getBatchResults`) 返回结果映射到 fileObj 时，同样经 `mapParseResultToFileUpdate` → **docId 缺口同样存在**（见 B2）。

---

## 6. Migration Risk

**Medium。**

- 🔴 **真实泄漏 1 处**：`App.jsx:584-598` 上下文菜单裸字面量绕过 `buildFileObj`，fileObj 无 `identity`、无 `searchText` 进系统。属「自造身份」违规，正是 4.1 要消灭的模式。
- 🟠 **docId 进给缺口（结构性）**：4.1 的 docId 链仅在 `/split_pdf` 一处分流接上；单文件主流路径的后端 docId 在 `mapParseResultToFileUpdate` 被丢弃，4.1 闭环对单文件静默降级为 `''`。这正是用户警告的「第二套身份」温床：任何新功能（OCR/Rename/Batch）若需 docId，要么拿 `''` 静默坏，要么自己重派生 → 4.1 问题复发。
- 🟢 ImportSession 职责清晰、Import Scale 可隔离 —— 无额外风险。

---

## 7. Recommendation — 4.2.1 Freeze Scope

冻结 `fileObj` 契约时，必须同时堵上述两缺口，否则「契约」只是纸面：

1. **契约字段冻结**
   - 文档级事实 → `identity.docId`（读：`loadedFile.identity?.docId || loadedFile.docId`）
   - UI 操作 → `identity.uiKey` / `file.key`
   - 禁：任何消费者用 `key` 当文档身份、自行 `generateFileKey` 造身份
   - `fileObj` 必备字段清单：`key, name, path, file, docId, identity, pageNum?, searchText, status...`

2. **必须补的契约保障（归入 4.2.1 或紧邻）**
   - **A-修复**：`App.jsx:584` 上下文菜单路径改走 `buildFileObj`（或统一经 `processFilesForAddition`），消除裸字面量泄漏。
   - **B2-修复**：`mapParseResultToFileUpdate` 在解析成功且后端返回 `doc_id` 时，回写 `docId` + 触发 `resolveIdentity` 刷新 `identity.docId`（或至少把 `doc_id` 透传进更新）。这是让 4.1 闭环对**所有**文件成立的关键一环，非性能迁移。

3. **不归入 4.2.1（留 4.3）**
   - `previewCacheKey.js` fileKey→uiKey 改名
   - `renderers.js` B 路径 fileKey→docId
   - RenderSpec 收敛到 `documentState.id`

4. **Import Scale 处理**：保持隔离（情况1），但 4.2.1 冻结后，batch hydration 回写路径同样要接 B2 修复（共用 mapper）。
