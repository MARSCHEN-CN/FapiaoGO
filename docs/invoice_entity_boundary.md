# Invoice Entity Boundary Contract

> **定位**: 代码级强制约束。本文件是 Invoice Entity 边界重构的权威来源。
> **优先级**: 高于任何现有代码注解、行内注释和口头约定。
> **冻结日期**: 2026-08-05
> **关联**: `import-model-boundary-freeze.md`（后端导入边界）→ 本文覆盖前端实体边界。

---

## 一、核心公理（不可违反）

### A1. InvoiceDocument 创建权唯⼀化

```
系统中只有 InvoiceAssemblyPipeline 有权创建正式 InvoiceDocument。
```

**允许**:
```
PageResult → InvoiceAssemblyPipeline → InvoiceDocument
```

**禁止**:
```
React / parseResult → InvoiceDocument
ImportSessionStore → 自动补对象
files[] → groupFilesByDocument → InvoiceDocument 伪装
```

### A2. InvoiceDocument 进入列表后不可逆

```
一旦 InvoiceDocument 注册到 ImportSessionStore.documents[]，
实体不可再被拆分、合并、替换或重新归类。
```

生命周期:
```
ASSEMBLING → REGISTERED → SEALED
```

SEALED 之后:
- 禁止 addDocument（覆盖）
- 禁止 split / merge / regroup
- 允许 patchDocument（metadata 更新）
- 允许 deleteInvoiceDocument（删除）

### A3. 文件列表 = InvoiceDocument 列表

```
FileList 的最小业务单位是 InvoiceDocument。
Page 是 InvoiceDocument 的内部资源，不参与列表排序、去重、统计。
```

---

## 二、操作清单

### ✅ 允许

| 操作 | 释义 | 备注 |
|------|------|------|
| `registerDocument(doc)` | 新 InvoiceDocument 注册到 DocumentStore | source 必须为 `backend_assembly` |
| `addDocument(sessionId, doc)` | 新 InvoiceDocument 追加到 ImportSessionStore.documents | 仅 append，拒绝覆盖 |
| `patchDocument(sessionId, instanceKey, patch)` | 更新已注册 InvoiceDocument 的 metadata/status | 不替换实体 |
| `deleteInvoiceDocument(docId)` | 删除 InvoiceDocument 及关联 pages 和资源 | 原子操作 |
| `ensureDocumentFromFileObj(fileObj)` | 从 fileObj 构建 single-page InvoiceDocument | 仅用于 fallback 路径，source=`fallback` |
| `backend assembly produce` | 后端 assembly pipeline 产出 InvoiceDocument | 唯一权威创建源 |

### ❌ 禁止

| 操作 | 释义 | 被破坏的规则 |
|------|------|-------------|
| `files[] → groupFilesByDocument → 伪装 InvoiceDocument` | 前端从 pages 重新推理实体 | A1, #7 |
| `addDocument 覆盖已存在条目` | 同 instanceKey 的 replace | A2, #2 |
| `已注册 InvoiceDocument → pages 重新成独立文件` | 二次拆分 | A2, #6 |
| `两个已注册 InvoiceDocument → 合并` | 二次合并 | A2, #7 |
| `invoiceNumber 作为 list key` | 身份键用发票号 | #10 |
| `pageId / fileId 作为 list key` | 身份键用页标识 | #1 |
| `DocumentStore → 反向生成列表` | 非 ImportSessionStore 来源 | #11 |
| `reactivateSession 复活 sealed session 的已有 documents` | 终态复活 | #9 |

---

## 三、InvoiceDocument 生命周期状态机

```
        create
          │
          ▼
    ┌──────────┐
    │ASSEMBLING│   ← 后端 assembly pipeline 正在构建
    └────┬─────┘
         │
         ▼
    ┌──────────┐
    │REGISTERED│   ← 已注册到前端 Store（ImportSessionStore + DocumentStore）
    └────┬─────┘  ← addDocument 完成
         │
         ▼
    ┌──────────┐
    │  SEALED  │   ← lifecycle 终态
    └──────────┘

SEALED 判定条件（满足任一）:
  - hydrateChunk 完成 assembly 消费（后端 assembled_documents 已处理）
  - 显式调用 sealDocument(doc)

SEALED 后允许:
  - patchDocument（metadata/status）
  - deleteInvoiceDocument
  - 读取（getDocument / 预览 / 打印）

SEALED 后禁止:
  - addDocument（覆盖）
  - 拆分 / 合并
  - 重新注册同 instanceKey
```

**关键区分**: seal 是**文档级**的（`doc.lifecycle = 'SEALED'`），不是 Session 级的（`session.documentsSealed`）。同一 Session 可以包含多个已 SEALED 的文档和正在 ASSEMBLING 的新文档。

---

## 四、身份体系

### 身份优先级（统一出口）

```js
invoiceDocumentId   // 最终目标：InvoiceDocument 领域 ID
  || instanceId     // 过渡：文件实例身份
  || docId          // 回退：内容哈希
  || id             // 兜底：旧数据兼容
```

### 禁止作为身份的字段

| 字段 | 原因 |
|------|------|
| `invoiceNumber` | 非唯一主键（红字票、重开票、不同年份同号） |
| `filename` | 文件系统细节，可能重复 |
| `pageId` | 页身份，非文档身份 |
| `file.key` | UI 渲染身份，跨 session 可重复 |

### 各 Store 身份出口必须统一

| Store | 当前 | 应改为 |
|-------|------|--------|
| DocumentStore | `instanceId \|\| docId \|\| id` | `invoiceDocumentId \|\| instanceId \|\| docId \|\| id` |
| ImportSessionStore | `instanceId \|\| id \|\| docId` | 同上（修复 id/docId 顺序不一致 bug） |
| invoiceIdentity.js | `recordId \|\| originalFilename \|\| invoiceNumber \|\| __ANON_{n}` | 增加 `invoiceDocumentId` 优先级 |

---

## 五、来源检查（Source Gate）

`addDocument` 必须记录并验证来源:

```js
doc._source = "backend_assembly"   // ✅ 允许: 来自后端 assembly
doc._source = "fallback"           // ✅ 允许: 降级路径（无 assembled_documents）
doc._source = "file_update"        // ❌ 禁止: 来自 parseResult 的 file update
```

已注册文档的来源不可更改。`patchDocument` 不改变 `_source`。

---

## 六、删除模型

```
deleteInvoiceDocument(docId):
  1. 从 ImportSessionStore.documents 移除
  2. 从 ImportSessionStore.files 移除所有关联 page（通过 _pageKeys）
  3. 从 DocumentStore 移除
  4. 从 React state files 移除所有关联 page

删除对象 = InvoiceDocument（不是删除文件/页面）
```

**禁止**:
- 单独删除某一页（多页发票的 page 删除必须是对整个 InvoiceDocument 的操作）
- 通过 page-level file.key 直接从 files[] 删除（绕过 document 层）

---

## 七、降级路径约束

### 当后端未返回 assembled_documents 时

```
hasAssembledDocs === false
  → 每个输入文件 = 一个 UnassembledImportItem
  → UnassembledImportItem 进入 ImportSessionStore.documents 作为单页候选
  → 不做任何文档聚合（不调 groupFilesByDocument / groupFilesByInstance）
```

**命名纪律**:
- `UnassembledImportItem` — 表示尚未被 assembly pipeline 确认的导入单元
- 禁止命名为 `InvoiceDocument candidate` 或任何暗示它是正式 InvoiceDocument 的名字

---

## 八、groupDocuments 函数约束

`groupFilesByDocument` / `groupFilesByInstance` 保留但受限:

| 用途 | 允许 |
|------|------|
| Render（渲染分组） | ✅ |
| Preview（预览分组） | ✅ |
| Print（打印分组） | ✅ |
| FileList（列表展示） | ❌ |
| Store（存储注册） | ❌ |
| Identity（身份判定） | ❌ |

调用时必须在 console.warn 中输出 DEPRECATED 标记。

---

## 九、16 条规则索引

| # | 规则 | 状态 |
|---|------|------|
| 1 | 文件列表只允许 Invoice Entity | 正在收敛（Step 1） |
| 2 | 追加原则（不覆盖） | 正在修复（Step 1） |
| 3 | 不隐藏（Imported Count = Entity Count） | 待修复（Step 4） |
| 4 | 多页触发条件 = 发票号 + 分页标识 | 后端已合规 |
| 5 | 同号无分页标识 → 独立发票 | 后端已合规 |
| 6 | 禁止二次拆分 | 由 SEALED 状态保证（Step 2） |
| 7 | 禁止二次合并 | 由降级路径禁聚合保证（Step 1） |
| 8 | 解析通道隔离 | 已合规 |
| 9 | 导入状态机（不可逆状态） | 正在建立（Step 2） |
| 10 | 唯一身份 = InvoiceDocument.id | 正在统一（Step 3） |
| 11 | ImportSessionStore 是列表唯一来源 | 已合规 |
| 12 | 删除 = 删 InvoiceDocument | 正在改造（Step 3） |
| 13 | 排序只作用于 InvoiceDocument | 基本合规 |
| 14 | 预览缩略图 ≠ 列表实体 | 已合规 |
| 15 | 异常情况处理 | 后端已合规 |
| **16** | **InvoiceDocument 创建权唯一化** | **本文件首次声明 → 全 Step 落地** |

---

## 十、架构四层闭合

```
  解析层 ─── 负责产生 PageResult
   Assembly层 ─── 负责产生 InvoiceDocument（唯一权威）
   Store层 ─── 负责保存 InvoiceDocument（只读 + 删除）
   View层 ─── 负责展示 InvoiceDocument（纯消费）

  四层之间不可跨层操作:
    解析层 +→ 不能直接注册 InvoiceDocument
    View层 +→ 不能重新推理实体
    Store层 +→ 不能创建/组装实体
```

---

## 十一、实施映射

| Step | 涉及规则 | 主要文件 |
|------|----------|----------|
| Step 0（本文件） | 全部 | `docs/invoice_entity_boundary.md` |
| Step 1 | #2, #7, #16 | `documentViewModel.js`, `ImportSessionStore.js` |
| Step 2 | #6, #9, #16 | 新增 `guards/invoiceEntityGuard.js`, `ImportSessionStore.js` |
| Step 3 | #10, #12, #8 | `invoiceIdentityResolver.js`, `DocumentStore.js`, `App.jsx` |
| Step 4 | #1, #3, #16 | 清理旧路径、hydrate 语义修正 |
