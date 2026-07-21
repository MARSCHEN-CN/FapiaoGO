# 展示区改造（Display Area Refactor）

> 冻结日期：2026-07-21
> 前置依赖：InvoiceDocument V2 Steps 0-4 已完成（MultiPageAnalyzer / GroupPages / MultiPageMerge / Coordinator）
> 范围：用户如何**查看**发票文件。不含打印布局（Paper/Margin/A4/A5/一页多票）。

## 0. 定位

这次改造解决的是：

```
Document View 与 Print View 解耦
```

最终架构：

```
              Document
                 |
      ----------------------
      |                    |
      v                    v
Document Viewer        Print Preview
Image/WebP             Paper/Layout
Zoom / Pan             Margin
Rotate                 A4/A5
Page Navigation        Compose / N-up
OCR Overlay            Print Job
```

两条路径共享 Document 数据模型，但各自独立渲染。

### Architecture Law D1

> **Viewer 永远不碰纸张/边距；Print 永远不碰 zoom/pan。**
> **数据身份不混入渲染实现。Document 是业务数据，previewUrl 是渲染资源，二者生命周期不同。**

这是本次改造的第一架构纪律。

## 1. 三层模型

### 1.1 Document（数据层）

```ts
interface InvoiceDocument {
  docId: string
  fileKey: string
  sourceHash: string
  pageCount: number
  pages: PageMeta[]
}

interface PageMeta {
  index: number            // 0-based
  pageId: string           // 稳定身份: `${docId}:p${index}`
  width: number            // natural px（后端 raster 尺寸）
  height: number
  sourceRotation: number   // 文件真实方向（PDF Rotate=90 → sourceRotation=90）
}
```

**Architecture Law D1 体现**：PageMeta 不含 previewUrl / thumbnailUrl。URL 是渲染资源，生命周期与业务数据不同（今天 `/preview/doc?page=1`，明天可能 `/render/image/doc/page/1.webp` 或 `blob:`）。Document 不因渲染实现变化而变化。

**资源解析层**：

```
PageMeta
   |
PreviewResourceResolver    ← 独立纯函数
   |
   +---- previewUrl         // /preview/{docId}?page={index+1}
   +---- thumbnailUrl       // /preview/{docId}?page={index+1}&size=thumb
```

```ts
// utils/previewResourceResolver.js
function resolvePreviewUrl(page: PageMeta, docId: string): string
function resolveThumbnailUrl(page: PageMeta, docId: string): string
```

Viewer 通过 Resolver 获取资源，Document 模型零渲染依赖。

**与现有 fileObj 的关系**：

```
SidebarItem(fileObj)          ← 列表展示对象，不再继续扩大职责
  + documentId: string        ← 新增：指向 InvoiceDocument
  - previewImage: string      ← 保留兼容，单页仍可用
  - pageNum: number           ← 保留兼容，拆分模式仍可用
```

```
fileObj.documentId  ──→  InvoiceDocument（独立模型，models/InvoiceDocument.js）
                              |
                              pages: PageMeta[]
```

fileObj 是 SidebarItem，不是 Document。不让 fileObj 承担越来越多职责。
Step 5 已添加的 `fileObj.pages[]` / `fileObj.pageCount` / `fileObj.currentPage` 作为过渡兼容保留，
正式数据源迁移到 InvoiceDocument 后逐步废弃。

### 1.2 ViewerState（交互层）

```ts
interface ViewerState {
  currentPage: number       // 当前显示页 index
  zoom: number              // 百分比，100 = fit
  panX: number
  panY: number
  viewRotation: number      // 用户为了查看而临时旋转（0/90/180/270）
}
```

**旋转命名纪律**（避免"到底哪个 rotation？"）：

```
PageMeta.sourceRotation    = 文件真实方向（后端烘焙）
ViewerState.viewRotation   = 用户临时查看旋转
effectiveRotation          = sourceRotation + viewRotation
```

**关键决策**：

- 页切换时：reset zoom + pan，**保留 viewRotation**（document 级）
- 不为每页保存独立 zoom/pan（避免 N 页 × 3 状态复杂度）
- viewRotation 是 document 全局状态，切页不重置

### 1.3 Viewer（渲染层）

```tsx
<DocumentViewer
  document={InvoiceDocument}
  viewerState={ViewerState}
  onViewerStateChange={...}
  overlays={OverlayBox[]}
  toolbarSlot={...}
/>
```

内部结构：

```
DocumentViewer
├── ViewerViewport          // transform wrapper: translate3d + scale + rotate
│   ├── <img>              // 当前页 previewUrl
│   └── OverlayLayer       // SVG/DOM，归一化坐标 × naturalSize × transform
├── ThumbnailStrip          // 左侧竖排缩略图
│   ├── Thumb[0]
│   ├── Thumb[1]
│   └── Thumb[N]
└── Toolbar (slot)          // zoom / rotate / fit 按钮由宿主注入
```

## 2. 缩略图策略

**不生成第二套文件**。利用后端 Render Engine 已有的 `/preview/{docId}?page=N` 接口，增加 `size` 参数：

```
/preview/{docId}?page=1           → 150dpi WebP（大图，Viewer 用）
/preview/{docId}?page=1&size=thumb → 400px 宽 WebP（缩略图，ThumbnailStrip 用）
```

后端只需在现有 preview 路由加一个 resize 分支（Pillow `thumbnail()`），零新存储。

前端加载策略（Lazy Thumbnail）：
- ThumbnailStrip 只加载 `thumbnailUrl`（~5-15KB/页）
- ViewerViewport 只加载当前页 `previewUrl`（~100-300KB）
- 切页时：新页 previewUrl 加载 → 旧页 revoke（复用现有 blob LRU 机制）
- **缩略图不全量预加载**（企业发票场景：30页/100页/300页扫描件）
- Lazy 规则：当前页 ± 5 页加载真实缩略图，其余显示 placeholder（灰色骨架）
- 滚动时按 IntersectionObserver 触发加载，离开可视区不 revoke（已加载的保留）
- 300 页 × 10KB = 3MB 内存可接受，但 300 个 img DOM 有压力，所以用虚拟滚动

## 3. 与现有代码的映射

### 3.1 替换关系

| 现有 | 改造后 | 说明 |
|------|--------|------|
| `PreviewCanvas.jsx` | `DocumentViewer.jsx` | 纯展示组件替换 |
| `usePreview.js` 中 zoom/pan/rotate | `useViewerState.js` | 交互状态抽出 |
| `usePreview.js` 中 previewUrl 生产 | 保留 | RE URL 构建逻辑不动 |
| `usePreview.js` 中 canvas fallback | 保留 | 无 docId 时仍走 canvas |
| `.canvas-scroll` 容器 scroll-pan | ViewerViewport transform-pan | 从 scroll 迁移到 CSS transform |
| `contentLayout.paperDisplayRect` | ViewerState.zoom 直接驱动 | 去掉 paper 几何中间层 |
| `buildPreviewCacheKey` | 保留（canvas 路径用） | RE 路径不需要 cache key |
| `prevPage/nextPage`（死代码） | 激活，接入 ThumbnailStrip | 管道复用 |

### 3.2 不动的部分

- 后端 Render Engine（只加 `size=thumb` 参数）
- `parse_invoice_service`（Coordinator 已封装）
- 打印模块（`usePrint` / `printRenderer` / `MainProcess`）
- 文件列表（`FileList` / `react-window`）
- Identity 层（`identity.js`）
- 缓存身份（`previewCacheKey.js`）— canvas 路径继续用

### 3.3 新增文件清单

```
frontend/src/
├── components/
│   ├── DocumentViewer.jsx       // 主组件
│   ├── ViewerViewport.jsx       // transform wrapper + img + overlay
│   ├── ThumbnailStrip.jsx       // 左侧缩略图栏
│   └── ThumbnailItem.jsx        // 单个缩略图
├── hooks/
│   └── useViewerState.js        // zoom/pan/rotate/currentPage 状态机
├── models/
│   └── InvoiceDocument.js       // Document + PageMeta 类型定义 + 工厂函数
└── utils/
    └── viewerTransform.js       // transform 计算纯函数（clamp/boundaries）
```

## 4. 实施步骤

> Phase 0（测试样本）和 Phase 1（MultiPage Pipeline: Analyzer/GroupPages/Merge/Coordinator）已完成。
> 以下从 Phase 2 开始。

### Phase 2：InvoiceDocument Model（models/InvoiceDocument.js）

- 独立模型，不继续扩大 fileObj
- 定义 `InvoiceDocument` / `PageMeta` 类型（JSDoc typedef）
- 工厂函数 `createDocument(docId, pageCount, pages)` — 从 Coordinator 结果构建
- 适配器 `documentFromFileObj(fileObj)` — 从现有单页 fileObj 构建兼容 Document
- `PreviewResourceResolver` 纯函数（resolvePreviewUrl / resolveThumbnailUrl）
- fileObj 只新增 `documentId` 引用字段
- 纯数据，零 UI 依赖
- 验证：现有单页文件可转换成 InvoiceDocument；多页 mock 可生成 pages[]
- 提交：`feat(display): introduce InvoiceDocument model`

### Phase 3：Viewer State（hooks/useViewerState.js）

- 状态：`{ currentPage, zoom, panX, panY, viewRotation }`
- Actions：`zoomIn/zoomOut/setFit/setManualScale/rotateLeft/rotateRight/goToPage`
- 页切换逻辑：reset zoom+pan，keep viewRotation
- effectiveRotation = sourceRotation + viewRotation
- 边界 clamp：不拖出图片外（`viewerTransform.js` 纯函数）
- 验证：单元测试（状态迁移）

### Phase 4：ImageViewer（Mock 数据优先）

- **先用 mock 数据验证模型正确性**，不接真实导入
- DocumentViewer + ViewerViewport 组件
- `<img src={resolvePreviewUrl(page)}>` + CSS transform
- 双击适应、Ctrl+wheel zoom、拖拽 pan
- 保留 canvas fallback 分支（无 docId 时）
- 验证：mock 3页 Document → 翻页/zoom/rotate 全部工作

### Phase 5：Thumbnail Navigation

- 后端 `/preview/{docId}?page=N&size=thumb` 接口
- ThumbnailStrip 组件：竖排、Lazy 加载（当前页±5）、当前页高亮、点击切页
- 虚拟滚动（react-window 或 IntersectionObserver）
- 激活 `prevPage/nextPage` 管道
- 验证：mock 10页 Document → 缩略图栏正确显示 + 翻页

### Phase 6：Real Import Adapter

- 接入 Coordinator → InvoiceDocument 真实数据流
- 导入多页同号 PDF → 生成 1 个 fileObj + 1 个 InvoiceDocument
- fileObj.documentId 指向 Document
- 验证：真实多页 PDF 导入后，展示区显示缩略图栏 + 翻页

### Phase 7：OCR Overlay

- OverlayBox 契约（已在 image-viewer-plan.md 定义）
- OverlayLayer 渲染：与 `<img>` 共享 transform wrapper
- 接后端 bbox_data JSON
- 验证：字段高亮与图像对齐

### Phase 8：Print Adapter

- 打印模块读取 `Document.pages[]` 而非 Viewer 状态
- 多页文档 → 逐页送入打印队列
- 不读 zoom/pan/viewRotation（Viewer 状态不污染打印）
- 验证：多页发票打印输出完整

## 5. 边界（明确不做）

- ❌ A4/A5 纸张选择
- ❌ 边距调整
- ❌ 一页多票（N-up）
- ❌ 打印布局预览（PrintPreview 是另一个模块）
- ❌ 多页合并打印（先完成展示，验证模型正确后再做）
- ❌ PDF 文本选择 / 全文搜索
- ❌ 自由角度旋转（只做 90° 步进）

## 6. 风险与待确认

| ID | 风险 | 缓解 |
|----|------|------|
| R1 | 后端 preview 路由加 size=thumb 需要 Pillow resize | 确认后端已有 Pillow 依赖 |
| R2 | usePreview.js 1944行，抽取交互层可能引入回归 | Step C 用 adapter 模式渐进替换，不一次性重写 |
| R3 | 现有 `.canvas-scroll` scroll-pan 迁移到 transform-pan | 保留 scroll fallback 给 canvas 路径 |
| R4 | 超大文档（300页）缩略图 DOM 压力 | Lazy 加载（当前页±5）+ 虚拟滚动，不全量渲染 img DOM |

## 7. 验收标准

1. 单页文件：展示行为与改造前完全一致（zoom/pan/rotate/grayscale）
2. 多页同号 PDF：导入后生成 1 个 fileObj，展示区显示缩略图栏，可翻页
3. 缩略图加载 < 200ms/页（本地后端）
4. 切页 < 100ms（缩略图已缓存，大图按需加载）
5. OCR Overlay 坐标与图像像素对齐（误差 < 2px @ 150dpi）
6. 打印模块不受影响（回归测试）
