# Commit 3 评审 — DocumentSelector 收敛文档级选择

> 提交：`3294adef`（已 push `origin/master`，链路 `f834032d..3294adef`）
> 职责边界：消灭「每个消费者自己从 files[] 猜 Document」的 Page 泄漏点；InvoiceDocument 仍为业务唯一入口。

## 📦 改动清单（3 文件，+167/−9）

| 文件 | 角色 | 关键改动 |
| --- | --- | --- |
| `frontend/src/utils/documentSelector.js` | **新增** 收敛点 | `selectDocumentRows` / `selectParsedFiles` / `getDocumentFiles` |
| `frontend/src/App.jsx` | 中央 hub 接线 | `displayFiles` 改走 `selectDocumentRows`；4 处 `files.filter(parsed)` 改走 `selectParsedFiles`；移除直接 `import groupFilesByDocument` |
| `frontend/src/utils/documentSelector.test.js` | **新增** 回归锁 | 7 用例 |

## 🔍 评审结论

### ✅ 做得对的
- **边界守得干净**：只动干净的 `App.jsx`；`Sidebar.jsx` / `PrintConfirmModal.jsx` / `previewResourceResolver.js`（预存在未提交 WIP）一律未碰，符合「一次只修一个边界」。
- **`groupFilesByDocument` 保留为 fallback**：未删，等全消费者迁移后统一 grep 清理（你明确要求，风险最低）。
- **行为等价**：`selectDocumentRows` 的返回语义与原 `displayFiles` 分支完全一致（装配结果优先且**直接返回 InvoiceDocument[]**，不转 row——与 `useRenamePack` 经 `invoiceDocumentsToRows` 收敛的路径互不冲突）。
- **`selectParsedFiles` 是精确替换**：4 处 `files.filter(f => f.status === 'parsed')` 全部等价替换，无逻辑漂移。

### 🟡 需注意（非阻塞）
- **`Sidebar.jsx` 仍有内联重复分支**（`documentView.documents ?? groupFilesByDocument`）。它属预存在未提交 WIP，本 commit 无法安全触碰。建议在其 WIP 解决后单独收口到 `selectDocumentRows`（届时 `groupFilesByDocument` 调用点只剩 selector 内部一处）。
- **`useRenamePack` 已收敛**：它经 `documentRows` prop 走 `invoiceDocumentsToRows`，无需再动——本 commit 不重复造轮子。

### 💭 设计小记
`DocumentSelector` 不是「新模型」，而是「旧分支的单一收口」。把 `if (!isSearching && documentView?.documents?.length) return ...` 这种判断从 2+ 个文件收敛到 1 个函数，未来任何「装配结果 vs page-level 回退」的语义调整只改一处。

## 🧪 验证
- `documentSelector.test.js`：**7/7 绿**（装配优先 / 搜索退回 filteredFiles / 空数组安全 / parsed 过滤 / docId 取页）
- 关联套件回归：**45/45 绿**（invoiceDocumentViewModel ×2 / invoiceAssemblyContract / groupDocuments / documentViewModel / useRenamePack.selectDocuments）
- `vite build`：**✓ 7.38s**（编译验证；产物指向 gitignored 目录，避免 safe-delete 对 `dist` 的 trash 拦截）

## ⚠️ 需你裁决：工作树额外的未提交 backend 改动
Commit 3 刻意只含 3 个前端文件。但 `git status` 显示 backend 工作树仍有 4 处**真实**未提交修改（非 2.5/2.6 范围，属预存在 WIP）：
- `backend/app.py`：新增 `_clean_amount_str(s)` 并用于 `_build_export_header` 的 amount/tax_amount 转换（清逗号/货币符号）—— 真实 bug fix；
- `backend/import_batch_manager.py` / `invoice_assembly_pipeline.py` / `multi_page_merge.py`：各有一处以上增量修改。

这些**未进任何 commit**，按 Phase 1 纪律排除。请确认：是单独成 commit 还是你的个人 WIP？
注意 `multi_page_merge.py` 当前工作树内容已**超出**所提交的 2.5 范围，若后续要动请先 `git diff` 核对。

## 当前迁移链路状态
```
Commit 1   Rename → InvoiceDocument          ✅
Commit 1b  Pack naming safety               ✅
Commit 2   assembled_documents contract     ✅
Commit 2.5 Assembly multi-page content      ✅
Commit 2.6 Backend observability            ✅
Commit 3   DocumentSelector 收口 (App hub)  ✅  ← 本次
Commit 4   Assembly drift / page_num        ⏳
```
