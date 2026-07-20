# InvoiceDocument Architecture V2

> 系统基本对象从 Page 升级为 InvoiceDocument（文档容器）。
> 一张发票是系统中的一等公民，而非一页 PDF。

---

## 1. 背景

### 1.1 Page 模型的问题

当前系统假设"一页 = 一张发票"：

```
PDF → split_pdf → 每页一个 fileObj → 逐页解析 → 逐条展示
```

业务现实：

- 多页电子发票（共5页 第1页...第5页）被拆成 5 条独立记录
- 用户看到 5 条"发票"，实际只有 1 张
- 项目明细被截断在单页内，金额/备注只出现在最后一页
- 打印、导出、归档都以"页"为单位，不符合业务语义

### 1.2 为什么 InvoiceDocument 才是正确对象

| 操作 | Page 模型 | InvoiceDocument 模型 |
|------|-----------|---------------------|
| 导入 | N 页 = N 条 | 1 张发票 = 1 条 |
| 列表 | 5 条记录 | 1 条（共5页） |
| 解析 | 每页独立，字段不完整 | 跨页合并，字段完整 |
| 预览 | 只看当前页 | 切页浏览完整发票 |
| 打印 | 打一张纸 | 连续输出所有页 |
| 导出 | 5 个文件 | 1 个文件（多页） |

### 1.3 Document Container 愿景

InvoiceDocument 不仅是"多页 PDF"，而是一个**文档容器**。未来可扩展为：

- 发票 + 附件
- 发票 + 合同
- 发票 + 清单
- OFD + PDF 混合
- 图片 + PDF 混合

`pages[]` 可自然演进为 `contents[]`，上层（列表、预览、打印）仍围绕同一个 InvoiceDocument 工作。

### 1.4 审计结论（2026-07-20）

- 现有 Extractor 管线已模块化，`_TOKEN_SUMMARY_RE` 已包含"小计"终止符
- 每页独立调用 `parse_invoice_service` 即可正确处理中间页（小计终止）和末页（合计终止）
- **无需修改任何现有 Extractor / Segmenter / OCR 逻辑**
- 新增层：MultiPageAnalyzer（归组）+ MultiPageMerge（合并）

---

## 2. 数据模型

### 2.1 InvoiceDocument（核心对象）

```typescript
interface InvoiceDocument {
  id: string                    // 唯一标识（原 fileObj.key）
  name: string                  // 显示名称
  file: File | Blob             // 原始文件
  fileFormat: 'pdf' | 'image' | 'xml' | 'ofd'
  status: FileStatus            // 沿用现有状态机，不改

  // ── 多页支持 ──
  pageCount: number             // 总页数（单页=1）
  pages: PageMeta[]             // 页面元数据
  currentPage: number           // 当前预览页索引（0-based）

  // ── 解析结果 ──
  parseResult: ParseResult | null

  // ── 打印 ──
  printSpec?: PrintSpec
}
```

### 2.2 PageMeta

```typescript
interface PageMeta {
  index: number                 // 页序（0-based）
  previewUrl: string | null     // 预览图 URL
  width: number                 // 像素宽
  height: number                // 像素高
  rotation: number              // 旋转角度（0/90/180/270）
}
```

不引入 PageRole。第一页 = `pages[0]`，最后一页 = `pages[pages.length - 1]`。所有逻辑通过索引表达，无需额外枚举。

### 2.3 单页退化

单页发票：`pageCount=1, pages=[{index:0, ...}], currentPage=0`。

所有消费 InvoiceDocument 的代码只需检查 `pageCount > 1` 决定是否展示多页 UI。

---

## 3. Field Source Policy

多页发票合并时，各字段的来源策略：

| 字段 | 来源 | 说明 |
|------|------|------|
| 发票号码 | `pages[0]` | 可校验所有页一致 |
| 发票代码 | `pages[0]` | 同上 |
| 开票日期 | `pages[0]` | |
| 发票类型 | `pages[0]` | |
| 购买方 | `pages[0]` | |
| 销售方 | `pages[0]` | |
| 项目明细 | **所有页 append** | 保持页序拼接，不覆盖 |
| 金额（合计） | `pages[-1]` | |
| 税额 | `pages[-1]` | |
| 价税合计 | `pages[-1]` | |
| 备注 | `pages[-1]` | |
| 收款人/复核/开票人 | `pages[-1]` | |
| 校验码 | `pages[-1]` | |

扩展规则：新增字段只需在此表增加一行 Policy，不改 Extractor。

---

## 4. MultiPageAnalyzer

### 4.1 职责

输入多页 PDF，判定是否为"同一张多页发票"，输出归组结果。

### 4.2 判定规则

**仅依赖 PDF 文字层（不做 OCR）：**

1. 用 PyMuPDF / pdfplumber 提取每页文字
2. 正则匹配页码标识：`共(\d+)页\s*第(\d+)页`（及变体）
3. 正则匹配发票号码：`发票号码[：:]\s*(\d+)`
4. 判定：所有页号码一致 + 页码连续 → 同一张发票

**满足** → 输出归组结果
**不满足 / 无文字层（扫描件）** → 回退现有 split_pdf 逐页处理

### 4.3 接口

```python
class MultiPageAnalyzer:
    def analyze(self, pdf_bytes: bytes) -> AnalyzeResult:
        """
        Returns:
            AnalyzeResult {
                is_single_invoice: bool,
                groups: List[PageGroup],
            }

        PageGroup {
            page_indices: List[int],
            invoice_number: str,
            total_pages_declared: int,  # 从"共N页"提取
        }
        """
```

### 4.4 边界 case

| 场景 | 处理 |
|------|------|
| 一个 PDF 含多张发票（号码不同） | 按号码变化拆为多个 PageGroup |
| 页码标识缺失但号码一致 | 仍归为同一组（号码优先） |
| 无文字层（扫描件） | 直接回退 split_pdf，不做 OCR 探测 |
| 单页 PDF | 跳过 Analyzer，走原流程 |

---

## 5. MultiPageMerge

### 5.1 职责

将多页独立解析结果合并为一个完整的 InvoiceDocument.parseResult。

### 5.2 输入

```python
page_results: List[ParseResult]  # 每页独立调用 parse_invoice_service 的结果
```

不需要 PageRole 参数。`page_results[0]` = 第一页，`page_results[-1]` = 最后一页。

### 5.3 合并策略

```python
class MultiPageMerge:
    def merge(self, page_results: List[ParseResult]) -> ParseResult:
        first = page_results[0]
        last = page_results[-1]

        return ParseResult(
            # Header: 第一页
            invoice_number=first.invoice_number,
            invoice_code=first.invoice_code,
            invoice_date=first.invoice_date,
            invoice_type=first.invoice_type,
            buyer=first.buyer,
            seller=first.seller,

            # Items: 所有页拼接
            line_items=[item for r in page_results for item in r.line_items],

            # Amount/Remark/Misc: 最后一页
            amount=last.amount,
            tax=last.tax,
            total=last.total,
            remark=last.remark,
            payee=last.payee,
            checker=last.checker,
            issuer=last.issuer,

            # Meta
            parse_method=first.parse_method,
            page_count=len(page_results),
        )
```

### 5.4 一致性校验（可选）

合并后校验所有页的 invoice_number 是否一致。不一致时记录 warning，不拆开发票。

---

## 6. Preview（V2.1）

### 6.1 缩略图导航

预览区底部增加缩略图条：

```
┌──────────────────────────┐
│                          │
│         大图预览          │
│                          │
└──────────────────────────┘
  [缩略图1] [缩略图2] [缩略图3]
```

- 点击缩略图切换 `currentPage`
- 当前页缩略图高亮
- 单页发票（pageCount=1）不显示缩略图条
- 键盘 ← → 切页

### 6.2 数据来源

每页的 `pages[i].previewUrl` 由前端 canvas 渲染或后端 preview 接口提供。

---

## 7. Print（V2.2）

### 7.1 模型

```
InvoiceDocument
    → for page in pages → 连续输出
```

每页使用 `pages[i].rotation`。单页退化 = 只有一页，行为不变。

---

## 8. Compatibility

### 8.1 单页自动退化

所有多页逻辑在 `pageCount === 1` 时跳过。现有单页流程零改动。

### 8.2 旧数据兼容

已入库的发票记录（DB）不受影响。前端 fileObj 新增 `pages[]`、`pageCount`、`currentPage` 字段，旧代码不消费时行为不变。

### 8.3 现有 split_pdf 保留

MultiPageAnalyzer 判定"不是同一张发票"或无文字层时，回退到现有 split_pdf。两条路径共存。

### 8.4 状态机不动

沿用现有状态机（uploading/splitting/ready/parsing/parsed/error）。InvoiceDocument 是对象升级，生命周期不变。

---

## 9. Migration

### V2.0：核心模型升级（不改 UI）

| 改动 | 范围 |
|------|------|
| fileObj 增加 `pages: PageMeta[]`, `pageCount`, `currentPage` | 前端数据模型 |
| MultiPageAnalyzer（纯文字层 + regex） | 后端新模块 |
| MultiPageMerge（Field Source Policy） | 后端新模块 |
| 导入流程：多页同号 PDF 生成 1 个 InvoiceDocument | 前端 fileHelpers + 后端入口 |
| 逐页 parse_invoice_service + merge | 后端调用层 |

不动：OCR、Extractor、Segmenter、状态机、UI 组件、打印、导出。

### V2.1：体验升级

| 改动 | 范围 |
|------|------|
| 文件列表显示"共N页" | 前端列表组件 |
| 预览缩略图导航 + 切页 | 前端 usePreview |
| 页码显示 | 前端预览组件 |

### V2.2：输出能力

| 改动 | 范围 |
|------|------|
| 多页打印（连续输出） | 前端打印模块 |
| 多页导出（保持原 PDF） | 后端导出 |
| 批量输出排序 | 前端 + 后端 |

---

## 10. 模块依赖图

```
                    ┌─────────────────────┐
                    │  MultiPageAnalyzer  │  (新增)
                    │  文字层 + regex 归组  │
                    └────────┬────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
        单页 PDF       多页同号         多页不同号/无文字层
        (原流程)     InvoiceDocument    (split_pdf 原流程)
              │              │              │
              │              ▼              │
              │     ┌────────────────┐     │
              │     │ 逐页 parse     │     │
              │     │ (现有管线不动)   │     │
              │     └───────┬────────┘     │
              │             │              │
              │             ▼              │
              │     ┌────────────────┐     │
              │     │ MultiPageMerge │     │  (新增)
              │     │ Policy 合并     │     │
              │     └───────┬────────┘     │
              │             │              │
              ▼             ▼              ▼
        ┌─────────────────────────────────────┐
        │         InvoiceDocument             │
        │  (统一数据模型 = 前端 fileObj)        │
        └─────────────────────────────────────┘
              │         │         │
              ▼         ▼         ▼
           列表       预览       打印
```

---

## 附录 A：审计证据

- `_TOKEN_SUMMARY_RE` 已含小计：`line_item_extractor.py:102`, `segmenter.py:65`, `invoice_table_extractor.py:130`, `line_item_segmenter.py:76`
- 明细反哺金额：`extractors/__init__.py:269-270`（`_aggregate_amount_from_line_items`）
- 终止逻辑 5 处分布，V2 无需修改任何一处
- `parse_invoice_service` 单页调用已正确处理小计终止（中间页）和合计终止（末页）

## 附录 B：设计原则

- Extractor 一律不动（OCR、Segmenter、所有字段提取器）
- 不引入 PageRole 枚举（用索引表达）
- Analyzer 不依赖 OCR（纯文字层，无文字层则回退 split_pdf）
- 状态机不改（InvoiceDocument 是对象升级，不是生命周期变更）
- Field Source Policy 表驱动（新增字段加一行，不改代码）
