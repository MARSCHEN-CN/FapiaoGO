# DocumentStore Registry Contract

> **定位:** Entity Boundary Freeze v2 的一部分。
> **结论:** DocumentStore 是纯缓存 Registry 层，不是第二事实来源。

---

## 当前状态（2026-08-05）

### DocumentStore 写入方

| 调用方 | 函数 | 用途 |
|--------|------|------|
| `useFileOps.js` (hydration) | `ensureDocumentFromFileObj`, `registerDocument` | 导入后将 InvoiceDocument 注册到缓存 |
| `parseResultConsumer.js` | `ensureDocumentFromFileObj` | 单文件解析后注册（仅 IMPORT_SCALE_V1=false 路径） |
| `renderDocument.js` | `ensureDocumentFromMetadata` | 渲染合约元数据回填（页尺寸） |
| `DocumentViewer.jsx` | `patchPageMeta` | 页面加载后回填真实像素尺寸 |

### DocumentStore 读取方

| 调用方 | 函数 | 用途 |
|--------|------|------|
| `useDocument.js` | `getDocument` | React 响应式读取（DisplayAdapter） |
| `printAdapter.js` | `getDocument` | 打印任务页展开 |
| `App.jsx` | `removeDocument`, `getRegisteredDocIds` | 生命周期 GC（displayFiles 无引用 → 回收） |

### DocumentStore 不做

| 操作 | 状态 |
|------|------|
| 产生 InvoiceDocument | ❌ 不负责（由 assembly 产生） |
| 修改 InvoiceDocument 身份 | ❌ 不负责 |
| 参与列表生成 | ❌ 不负责（ImportSessionStore.documents 是唯一来源） |
| 参与 assembly | ❌ 不负责 |
| 生命周防护 | ❌ 不负责（ImportSessionStore + guard 负责） |

---

## 层次职责

```
┌─────────────────────────────────┐
│        ImportSessionStore        │  ← 唯一事实来源
│   documents[] (InvoiceDocument) │     权威生命周期状态
│   addDocument / seal / delete   │     所有 guard 保护
└────────────┬────────────────────┘
             │
             │ registerDocument / ensureDocumentFromFileObj
             │ (one-way sync)
             ▼
┌─────────────────────────────────┐
│        DocumentStore             │  ← 纯缓存 Registry
│   Map<identity, InvoiceDocument> │     无生命周期 guard
│   getDocument / patchPageMeta   │     无业务语义
└────────────┬────────────────────┘
             │
             │ getDocument (read)
             ▼
┌─────────────────────────────────┐
│   Preview / Print / Viewer       │  ← 下游消费
└─────────────────────────────────┘
```

DocumentStore = `{get, set, delete}` 的 KV 缓存，定位与 `Map<string, Blob>` 等同。

---

## 约束

### ✅ 允许

- `registerDocument(doc)` — 写入缓存
- `getDocument(id)` — 读取缓存
- `patchPageMeta(docId, pageIndex, patch)` — 更新页面元数据（纯技术数据：width/height/rotation）
- `removeDocument(id)` — GC 清理

### ❌ 禁止

- 从 DocumentStore 派生文件列表
- 从 DocumentStore 派生 InvoiceDocument 身份
- 在 DocumentStore 中添加生命周期 guard（属于 ImportSessionStore 职责）
- 将 DocumentStore 作为跨 Store 同步的中间层

---

## 与 ImportSessionStore 的关系

```
ImportSessionStore.documents[]
    ^                    ^
    |                    |
    | one-way sync       | 唯一读取方
    | (register)         | (FileContext, buildDocumentViewModel)
    v                    |
DocumentStore  ←─────────┘
    ^
    | read (preview, print, viewer)
    |
Downstream Consumers
```

**单向同步:** ImportSessionStore → DocumentStore。从不反向。
