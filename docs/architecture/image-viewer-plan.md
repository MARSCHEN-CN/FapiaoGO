# 预览查看器方案：统一 Image Viewer（非 PDF Viewer）

> 范围：仅方案设计，不含代码改动。基于 `PreviewCanvas.jsx` / `usePreview.js` / `previewCacheKey.js` 现状与 V16/V17 架构纪律。

## 0. 结论（TL;DR）

- **采纳方案四/五**：后端统一 Raster→WebP，前端统一 **Image Viewer**；不引入任何 PDF 渲染库。
- **现状确认**：V17 的 Render Engine 路径**已经在用 `<img src={previewUrl}>` 显示后端 WebP**（`PreviewCanvas.jsx:63-97`），`<canvas>` 仅是 fallback。架构已 ~80% 到位，缺的是「**交互层 + Overlay 坐标层**」。
- **推荐排序**：自研轻量 ImageViewer（⭐⭐⭐⭐⭐）> 借力纯图片库做 transform 核心（⭐⭐⭐⭐）> Electron/Chromium PDF Viewer（⭐⭐）> pdf.js / PSPDFKit / Apryse（⭐，回归 V16 想摆脱的，或引入 3–10 万行无关代码）。

## 1. 为什么你的分析是对的（架构层面确认）

- 发票管理 ≠ PDF 阅读器：你真正需要的功能集只有 `[显示 / 缩放 / 拖拽 / 旋转 / Overlay]`，**不需要**目录、注释、签名、全文搜索、附件面板。
- 引入 PDF Viewer 的真实代价：几万行代码、与 React 状态割裂、OCR Overlay 不可做、旋转状态难同步——这恰恰是 V16 想摆脱的 `pdf.js` 那一套。
- 后端 Raster→WebP **已是现状**：`previewUrl` 即 blob URL（`usePreview.js` 管理 `createObjectURL` / `revoke`，见 `:578/:649/:730/:1182`）。继续这条路 = 延续 V16/V17 收敛，不倒退。

## 2. 现有链路盘点（基于真实代码）

| 环节 | 现状 | 证据 |
|---|---|---|
| 后端输出 | Render Engine → WebP → `previewUrl` blob | `usePreview.js:578/649/730/1182` |
| 前端显示 | `PreviewCanvas` 消费 `previewUrl`，`objectFit:contain` 按容器 fit（**非交互**） | `PreviewCanvas.jsx:63-97` |
| 缓存身份 | `buildPreviewCacheKey`（fileKey+rotation）+ layout；V17 不变式=缓存身份=RenderCommand 字段 | `previewCacheKey.js` |
| OCR/字段 | 后端已独立产出解析 JSON（`ParseResult`），与图像是两份数据 | `models/ParseResult.js` |

> Viewer **不碰缓存内部**，只消费 `previewUrl`；Overlay 数据来自独立的 OCR JSON。

## 3. 核心设计：两层旋转分离（解决你最担心的「状态割裂」）

- **Baked orientation（服务端）**：`PaperOrientation` + `ContentRotation` Fact → 已烘焙进 WebP 像素，文档级、永久。Viewer 永远拿到「正确方向」的图。
- **Viewport transform（客户端）**：zoom / pan / 临时旋转 → 纯 CSS transform，**React state 是唯一真相源**。切换文件时随 `previewUrl` 重置。
- 这样不再有「iframe 自己维护一套状态」的割裂；双击适应 / 旋转按钮都只改 transform，**不重绘 `<img>`**。

## 4. Overlay 坐标契约（OCR / 字段 / 搜索高亮都建立在这）

- **后端契约（关键）**：raster 与 OCR 必须基于**同一张位图**（同 crop、同分辨率）——这是 Adobe「先 Raster 再 OCR」原则。Viewer 收到归一化坐标（0..1，相对 natural image）。
- Overlay 层：绝对定位的 SVG/DOM，**与 `<img>` 共享同一个 transform wrapper**，一起 scale/rotate/translate。
- 因图像是固定 raster（不因 overlay 重渲染），Overlay 可为纯 DOM → 零重绘、性能极佳，且能承载绿色金额框、字段高亮、搜索命中高亮。
- 契约：
  ```ts
  type OverlayBox = {
    id: string
    x: number; y: number; w: number; h: number   // 归一化 0..1，相对 natural image
    kind: 'ocr' | 'field' | 'search' | 'redaction'
    label?: string
    payload?: unknown
  }
  ```
  Viewer 负责 `× naturalSize` 再叠加当前 transform。

## 5. 组件 API 草图（定契约，不写实现）

```tsx
<ImageViewer
  src={previewUrl}                 // 后端 WebP blob URL
  naturalSize={[w, h]}             // 来自缓存元或 onload
  page={page} onPageChange={...}   // 多页：切 src = pageN.webp
  overlays={OverlayBox[]}          // OCR / 字段 / 搜索
  initialTransform? minZoom maxZoom
  onTransformChange?               // 供撤销 / 同步
  toolbarSlot?                     // 缩放 / 旋转 / 适应 按钮由宿主注入
/>
```

内部状态机：`transform = { scale, tx, ty, rotateDeg }`，带边界 clamp（不拖出纸张外）。
**性能**：单 wrapper `transform: translate3d() scale() rotate()` + `will-change: transform`，zoom/pan 时**永不重绘 `<img>`**。

## 6. 性能与可访问性

- **GPU 合成**：只动 transform，不触发 layout/paint；图片 decode 一次（`decoding="async"` 已有）。
- **多页**：`previewUrl` 按页取，绝不一次加载全部；图片 LRU + blob revoke（`usePreview` 已做）。
- **可访问性**：`<img role="img" aria-label={由 OCR 字段生成的摘要}>`；键盘 `+ / - / 0` 缩放、方向键平移、`r` 旋转；过渡尊重 `prefers-reduced-motion`；Overlay 文本对读屏可见。

## 7. 打印解耦（重申 V16 方向，给一个警示）

- 打印走独立模块（`printRenderer` / `usePrint`），从 `RenderCommand` 重新 raster 到打印 DPI。
- **不要**「直接把 viewer 的 canvas / transform 送去打印」——那会丢失纸张 / 边距 / 合并布局，并把显示态污染进打印态。
- **Viewer = 显示只读；打印 = 独立重渲染。**

## 8. 推荐排序（与你的判断一致）

| 选项 | 评级 | 理由 |
|---|---|---|
| 自研轻量 ImageViewer | ⭐⭐⭐⭐⭐ | 最贴合固定需求、Overlay 完全可控、零 PDF 依赖 |
| 借力纯图片库（react-zoom-pan-pinch / photoswipe）做 transform 核心，外层包 Overlay | ⭐⭐⭐⭐ | 省交互开发，仍保留 WebP 架构与 Overlay 控制 |
| Electron / Chromium PDF Viewer | ⭐⭐ | 仅适合通用阅读器，与 OCR / 打印 / 文件管理深度集成冲突 |
| pdf.js / PSPDFKit / Apryse | ⭐ | 回归 V16 想摆脱的，或引入 3–10 万行无关代码 |

## 9. 落地阶段（不阻塞 Stage 4.2 / 4.3）

- **A. 抽 `ImageViewer`**：纯展示组件，替换 `PreviewCanvas` 的静态 `objectFit:contain`；继续吃 `previewUrl`，不动后端、不动 Identity 工作。
- **B. Overlay 契约 + 渲染层**：定义 `OverlaySource`，接后端 OCR JSON（需先确认 R1 后端 raster 契约）。
- **C. 多页分页**：切 `src = pageN.webp`，transform 每页重置 / 可选保留。
- **D. 与 4.3 缓存清理对齐**：Viewer 按稳定身份（docId 缓存 key）取图，确保切文件不串图（Identity Layer 已根除该类 Bug）。

## 10. 风险 / 待确认

- **R1（后端契约，最高优先）**：raster 分辨率 / crop 必须与 OCR 假设一致，否则 Overlay 漂移。需后端确认。
- **R2**：临时旋转用自由角度还是 90° 步进（产品决策）。
- **R3**：超大图内存——依赖 blob LRU + 主动 revoke（现有机制足够）。
- **R4**：Retina / HiDPI 下 Overlay 文本清晰度——用 `devicePixelRatio` 缩放 SVG。

## 11. 一句话

> 后端统一 Raster→WebP，前端统一 ImageViewer，打印独立模块；Overlay 全部建在固定 raster 之上。这正是 Adobe / Office / Explorer 的「先 Raster 再展示」路线，也是 V16/V17 收敛的自然终点。
