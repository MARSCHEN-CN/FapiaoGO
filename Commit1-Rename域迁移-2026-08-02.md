# Commit 1 — Rename 域迁移到 InvoiceDocument

**状态**：✅ 已完成并推送
**提交**：`c70c0744`（代码 + 测试） · `14faa13a`（审计报告文档）
**分支**：`master` → `origin/master`

---

## 一句话

重命名域不再自己从 `files[]` 猜文档边界，改为消费装配阶段产出的 InvoiceDocument，
与侧栏 / 预览 / Excel 导出同源。

```
修复前                              修复后
files[]                             documentView.documents
  ↓ groupFilesByDocument              ↓ selectRenameDocuments
  ↓ 按 f.docId 归组                    ↓ 装配结果（_pageKeys 强身份）
2 条（金额 1000 / 300）              1 条
```

---

## 改动明细（3 文件，纯前端）

### 1. `frontend/src/hooks/useRenamePack.js`

`collectDocumentLevelFiles(files)` → **`selectRenameDocuments(documentRows, files)`**（已导出，可独立测试）

```js
export function selectRenameDocuments(documentRows, files) {
  const rows = Array.isArray(documentRows) && documentRows.length > 0
    ? documentRows                        // 主流程：装配结果
    : groupFilesByDocument(files || [])   // fallback：历史 session / 装配未完成
  return rows.filter(f => f?.status === 'parsed')
}
```

- `groupFilesByDocument` **从主流程降级为 fallback**，不再是文档边界的决定者
- 新增 `latestDocumentRowsRef`，与既有 `latestFilesRef` 同模式（回调依赖列表刻意不含数据，靠 ref 读最新值）
- 两处调用点切换：`generatePreviewInner` · `handleRename`
- `groupDocuments` 导入补 `.js` 扩展名 —— 对齐 `documentViewModel.js` 的既有写法，并使模块可被 `node --test` 原生 ESM 加载

### 2. `frontend/src/App.jsx:286`

```js
useRenamePack({ files, documentRows: documentView?.documents, ... })
```

**刻意不传 `displayFiles`**：它在搜索态会退回 page-level `filteredFiles`，
而重命名的作用域是全量文档，不应被搜索框缩小或降级。

### 3. `frontend/src/hooks/useRenamePack.selectDocuments.test.js`（新增）

---

## 验证

| 项 | 结果 |
|---|---|
| 新增测试 | **6 / 6 通过** |
| 既有相关测试 | **27 / 27 通过**（groupDocuments · invoiceDocumentViewModel · invoiceAssemblyContract · instancePageOwnership） |
| `vite build` | ✅ 152 modules transformed |

### fixture 纪律（针对前两次假绿事故）

本项目已两次因 fixture 拼造上游不产出的字段而产生恒绿测试：

| 位置 | 错误假设 | 生产真相 |
|---|---|---|
| `test_invoice_assembly.py:20-41` | page 带 `page_num` | parse 结果无此字段 |
| `groupDocuments.test.js:41` | 多页共享 `docId` | hydrateChunk 逐页改写 |

本次 fixture **复刻生产态形状**：逐页不同 docId、首页 `pageNum: null`、每页携带自己的 amount。

### 红绿对照

测试 1 与测试 3 使用**同一份输入**：

- 测试 1（传 documentRows）→ 断言 **1 条**
- 测试 3（不传，走旧路径）→ 断言 **2 条**，金额 `['1000.00', '300.00']`

测试 3 是**回归锁**：它断言的不是"期望行为"，而是"为什么旧路径只能当 fallback"。
一旦有人把 `groupFilesByDocument` 改回主流程，测试 1、2 立刻变红。

---

## 刻意未做（保持 commit 单一）

### 🟡 多页金额仍取首页值 → Commit 2

三方冲突尚未解决：

1. 装配规则（`invoice_assembly_pipeline.py:229`）：多页 = 首页身份 + 全页明细 + **末页金额**
2. `invoiceDocumentToRow:79` `rep = sorted[0]` → 行的 amount = **首页**
3. `assembled_documents` 契约只有 5 字段 `{instanceId, sourceDocId, invoiceNumber, invoiceType, pageCount}`，**无 amount**

后端算出的装配金额写进 DB 后就丢了，从未过网线。**必须先扩后端契约。**

> ⚠️ 验收时注意：现在应该看到 **1 条**，但金额是**首页值**。这是预期内的中间态，不是修复失败。

### 🔴 新发现 P0：Pack 的 zip 内同名 entry = 丢页风险

审计 handlePack 时发现的**独立且更严重**的问题：

```
ipc-pack.js:129   targetName = generateNewName(file.invoiceFields, file.name)
                  ↑ 名字完全由 invoiceFields 决定

archive-utils.js:84  createZipArchive(files, ...)
                  ↑ 无任何去重
```

同票多页两页若走同一 rename 规则（例如只用 fphm）→ **生成同名** →
archiver 写入两个同名 entry → 解压时多数工具后者覆盖前者 → **用户实际丢一页**。

这比行数问题严重，但**前端修不了**：base 名由主进程生成，前端注入不进后缀。
需要改 IPC 契约（`pack-invoices` 接受显式 `targetName` 或 `nameSuffix`），
并与 `handleRenameConfirm` 的 `_p{n+1}` 规则统一 —— 最好两处都改调
`docFacts.shouldAppendPageSuffix`（该 docstring 宣称已统一，实际未落实）。

---

## 建议的后续顺序

| | 内容 | 面 | 前置 |
|---|---|---|---|
| **Commit 2** | 扩 `assembled_documents`：`amount` / `invoiceDate` / `pageClientKeys` | 后端 + 前端 | — |
| **Commit 1b** | Pack 契约改造，消除 zip 同名 entry | IPC + 前端 | 可独立 |
| **Commit 3** | 抽 `selectDocumentRows()` 统一出口，供 Sidebar / Rename / Pack / Export / 确认弹窗共用 | 前端 | Commit 2 |
| **Commit 4** | Assembly 层契约漂移（`page_num` 不存在 + 测试假绿 + 页码正则漏 `第N页/共M页`） | 后端 | 独立 |

**⚠️ 禁止**：动 `hydrateChunk:720-724`（那是为修预览 URL 加的，正确做法是绕开 docId 用 `_pageKeys`）；
把 Rename 修复与 Assembly 修复混进同一个 commit。

---

## 架构结论

这次验证了 **InvoiceDocument 作为业务实体已经成立**。

文件列表为什么对？因为它已经走 InvoiceDocument。
重命名为什么错？因为它还停留在 File/Page。

不是同票多页方案失败，而是**新模型已有正确消费者，旧消费者正在暴露**——
典型的迁移中间态。Commit 3 的统一出口就是收口这个中间态的动作。
