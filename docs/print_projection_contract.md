# Print Projection Contract

> **定位:** Invoice Entity Boundary Freeze v2 的一部分。
> **原则:** Print Preview 是 page projection 视图，不是 InvoiceDocument 消费者。

---

## 核心声明

```
Print Preview ≠ InvoiceDocument Consumer

Print Preview = Page Projection（纸张预览视图）
```

---

## 职责分离

| 层 | 关心什么 | 不关心什么 |
|----|----------|------------|
| **InvoiceDocument** | 这是哪张发票、多页归属 | 打印纸张尺寸、边距、合并模式 |
| **Print Projection** | 纸张尺寸、顺序、是否选中、打印页数 | 发票号码、金额、业务身份 |
| **Print Execution** | 物理打印 job、Sumatra 路径 | 发票业务逻辑 |

---

## Print Preview 允许的操作

✅ 读取 `InvoiceDocument.pages[]`（获取 page count、render identity）
✅ 从 `buildPrintExecutionPlan` 派生预览模型
✅ 逐页导航（上一页/下一页/跳转）
✅ 修改打印设置（纸张、边距、合并模式、份数）
✅ **未来**: 逐页选中/取消选中（PrintSelectionState）

## Print Preview 禁止的操作

❌ 修改 `InvoiceDocument`（pages、identity、lifecycle）
❌ 调用 `removeFile` 或 `deleteInvoiceDocument`
❌ 修改 `session.documents` 或 `session.files`
❌ 将 page 重新推理为 InvoiceDocument

---

## 删除语义区分

| 操作 | 发生位置 | 语义 | 影响 |
|------|----------|------|------|
| `deleteInvoiceDocument` | 文件列表（Sidebar） | 删除发票实体 | InvoiceDocument 消失 + pages 释放 |
| **未来** `deselectPage` | 打印确认页 | 本次打印跳过该页 | InvoiceDocument 不变，仅 PrintSelection 变化 |

两个操作不可互替。

---

## PrintSelectionState（未来）

当打印确认页支持逐页选择时：

```typescript
interface PrintSelectionState {
  invoiceDocumentId: string
  pages: Array<{
    pageIndex: number
    selected: boolean     // 默认 true
  }>
}
```

`PrintSelectionState`：
- 不属于 `ImportSessionStore`
- 不属于 `DocumentStore`
- 属于 `usePrint` hook 的局部状态
- 生命周期 = 打印确认弹窗打开到关闭

---

## 当前实现状态（2026-08-05）

- Print Preview 已是纯投影（只读，不写）✅
- 当前无逐页选中/取消 UI（all-or-nothing）✅
- `removeFile` 仅在 Sidebar 文件列表调用，不在打印上下文 ✅
- 无 `PrintSelectionState`（待未来需求）⏸

---

## 相关文件

| 文件 | 角色 |
|------|------|
| `components/PrintConfirmModal.jsx` | 打印确认弹窗（纯展示 + 设置收集） |
| `components/PrintPreviewCanvas.jsx` | 打印预览 SVG 画布（纯渲染） |
| `print/PrintPreviewModel.js` | 纯函数：plan → 预览模型 |
| `print/buildPrintExecutionPlan.js` | 纯函数：files → plan |
| `hooks/usePrint.js` | 打印状态管理（无页面选择状态） |
