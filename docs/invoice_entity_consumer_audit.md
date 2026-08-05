# Invoice Entity Consumer Audit

> **定位:** Invoice Entity Boundary Freeze v1 的配套验证。
> **目的:** 确认 5 条下游消费链是否已从 File/Page 思维迁移到 InvoiceDocument。
> **审计日期:** 2026-08-05

---

## Consumer Audit Matrix

| Consumer | 输入模型 | 3 页发票行为 | 状态 | 风险 | 关键文件 |
|----------|---------|-------------|------|------|----------|
| **Rename** | `documentView.documents` (InvoiceDocument[]) | 1 条预览 / 1 个 baseName / 3 个物理文件名 | ✅ COMPLIANT | P1 (降级路径) | `useRenamePack.js`, `docFacts.js`, `RenamePreviewModal.jsx` |
| **ZIP/Pack** | `collectPackTargets(documentRows)` → pages | 1 个压缩包 / 3 个内部条目 | ✅ COMPLIANT | P2 (命名冲突) | `useRenamePack.js:collectPackTargets`, `docFacts.js:buildDocumentPageNames` |
| **PDF Export** | `files[]` (ViewModel 条目，非 pages) | 1 份 PDF (合并) / N 份 (单文件模式) | OK | P2 | `ExportService.js`, `pdf_export.py` |
| **Excel Export** | `files[]` → `dedupeByInvoiceDocumentId` → `fileNames[]` → DB | N 行明细 / 1 个串号 | 🔧 MIGRATED (Step 5B) | — | `ExportService.js`, `app.py`, `excel_exporter.py` |
| **Print Preview** | Page Projection（只读投影） | N/A（纯渲染） | ✅ CONTRACT DEFINED | — | `PrintConfirmModal.jsx`, `PrintPreviewModel.js`, `print_projection_contract.md` |
| **Print Execution** | `files[]` + `invoiceDocumentId` (Step 5A) | 1 个 job / 3 页（渲染层展开） | 🔧 MIGRATED | — | `usePrint.js`, `buildPrintExecutionPlan.js`, `printAdapter.js` |

---

## 详细发现

### 1. Rename — ✅ COMPLIANT

**链路:** `App.jsx(documentView.documents) → selectRenameDocuments → buildPreviewFilesFromDocuments → docFacts.buildDocumentPageNames`

- 以 InvoiceDocument 为原子单位
- 3 页发票 → 1 条预览 → 1 个 baseName → 物理执行展开为 3 个带 `_pN` 后缀的文件名
- 降级路径 (`groupFilesByDocument`) 仅在无装配结果时触发（兼容路径）
- `invoiceDocumentId` 不直接用于 Rename 链，但 `_pageKeys` / `_isDocumentGroup` 等装配边界事实正确使用

**验收:** 单页票 / 三页票 / 混合导入 → 全部正确

---

### 2. ZIP/Pack — ✅ COMPLIANT

**链路:** `collectPackTargets(documentRows) → buildDocumentPageNames → IPC pack`

- 以文档为单位汇总，展开到页面
- 3 页发票 → 1 个压缩包 (invoice.pdf / invoice_p2.pdf / invoice_p3.pdf)
- Commit 1b 增加了 strict naming 保护，重名直接失败

**验收:** 无页面级拆分

---

### 3. PDF Export — OK

**链路:** `ExportService.exportPdf(files) → POST /api/export-pdf`

- 输入 `files[]`（ViewModel 条目，非原始 pages）
- 合并模式: N 个文件 → 1 个 PDF
- 不自动拆分页面，行为由调用方传入的内容决定
- 不受 Page/File 旧模型影响

**风险:** 如果调用方传入 3 个页面文件而非 1 个文档条目 → 会导出 3 份 PDF（取决于前端 ViewModel 正确性）

---

### 3.5 Print — 🔧 MIGRATED (Step 5A, 2026-08-05)

**迁移内容:**
- `printAdapter.js`: `buildPrintJobItem` 输出增加 `invoiceDocumentId` 字段（通过 `resolveInvoiceIdentity` 获取）
- `buildPrintExecutionPlan.js`: 每页 plan 增加 `invoiceDocumentId` + slots 增加 `invoiceDocumentId` 标注
- 不替换 `f.key`（打印执行需要文件路径），`invoiceDocumentId` 作为身份追踪字段

**仍保留:** 执行层（`deriveSourcePrintJobs.js`、`usePrint.js`）仍使用 `f.key` 做文件查找——这是打印物理文件的必要步骤，不是身份问题。

### 4. Excel Export — ⚠️ NEEDS MIGRATION

**链路:** `ExportService.exportExcel(files) → extractExportFileNames → POST /api/export-excel-sse(fileNames) → db.get_invoices_by_filenames → _db_record_to_export`

**发现:**
1. **全链路未桥接 `invoiceDocumentId`**: 前端 `getInvoiceIdentity` 声明了最高优先级，但后端 `_build_export_header` 不产出此字段 → 等于无效代码
2. **后端默认分组键仍用 `invoiceNumber`**: `excel_exporter.py` 第 291 行默认 `group_key_fn` 直接使用 `invoiceNumber`
3. **多页发票页面文件名可能导致重复**: DB 层 `get_invoices_by_filenames` 的 `_p\d+` 回退匹配，3 个页面文件名都匹配同一 DB 记录 → 可能重复传入
4. **后端 `_invoice_identity` 缺少 `invoiceDocumentId`**: 与前端 `getInvoiceIdentity` 未对齐

**P0 修复项:**
- 后端 `_build_export_header` 注入 `invoiceDocumentId`
- 前端 `ExportService.exportExcel` 按 InvoiceDocument 去重后再请求
- 后端 `excel_exporter.py` 统一使用 `_invoice_identity` 分组

---

### 6. Print Preview — ✅ CONTRACT DEFINED (Step 5C, 2026-08-05)

**定位:** Print Preview 不是 InvoiceDocument 消费者，是 Page Projection（纸张预览视图）。

**合同:** `docs/print_projection_contract.md`

**当前实现:**
- `PrintConfirmModal.jsx`: 纯展示 + 设置收集，无写操作
- `PrintPreviewModel.js`: 纯函数 plan → 预览模型
- 当前无逐页选中/取消 UI（all-or-nothing）
- `removeFile` 不在打印上下文中调用

**禁止:** Print Preview 修改 InvoiceDocument / 调用 deleteInvoiceDocument

- `buildPrintExecutionPlan.js`: 输入应接受 `InvoiceDocument[]` 或至少标记 `invoiceDocumentId`
- `usePrint.js`: `createPrintPlanInput` 从 `documentView.documents` 构建输入

---

## 验收矩阵

| 场景 | Rename | ZIP | PDF | Excel | Print Preview | Print Exec |
|------|--------|-----|-----|-------|---------------|-----------|
| 单页票 (1 page) | ✅ 1 name | ✅ 1 file | ✅ 1 pdf | ✅ 1 row | ✅ 1 page view | ✅ 1 job |
| 三页票 (3 pages) | ✅ 1 entry / 3 files | ✅ 1 zip / 3 files | ✅ 1 pdf (merge) | ✅ 1 串号 (deduped) | ✅ 3 page views | ✅ 1 job / 3 pages |
| 混合 (3p + 1p) | ✅ 2 entries | ✅ 2 zips | ✅ 2 pdfs | ✅ 2 串号 (deduped) | ✅ 4 page views | ✅ 2 jobs |

---

## 迁移优先级（已全部完成）

| 优先级 | Consumer | 动作 | 状态 |
|--------|----------|------|------|
| **P0** | Print | printAdapter 迁移到 invoiceDocumentId；plan 加 invoiceDocumentId 标注 | ✅ Step 5A |
| **P0** | Excel | 后端注入 invoiceDocumentId；前端 dedupeByInvoiceDocumentId；统一 _invoice_identity 分组 | ✅ Step 5B |
| **P2** | PDF | 确认调用方传入的是文档级条目而非页面文件 | ✅ OK |

---

## 未发现的问题（正面确认）

- Rename/ZIP 链正确消费 InvoiceDocument ✅
- 无页面级 renaming（3 页 = 1 次预览，物理才有 `_pN` 后缀）✅
- 无 Print 按页面拆成多个 job ✅
- PDF 导出不自动拆分 ✅
- ZIP 已受命名冲突保护（Commit 1b strict mode）✅
