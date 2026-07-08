# DocumentPage — 职责边界

> 写于 2026-07-08，在 `render()`/`text()`/`bbox()` 实装后、继续扩展前凝固。
> **原则：能力归 Engine / DocumentPage，业务做 Consumer。**

## 归属矩阵

| 能力 | 归属 | 理由 |
|---|---|---|
| `text()` → `List[TextSpan]` | **DocumentPage** | 页面固有文本层，无渲染参数 |
| `bbox()` → `List[BBox]` | **DocumentPage** | text() 的派生 |
| `rect()` → `BBox` | **DocumentPage** | fitz.Page.rect 的封装 |
| `size()` → `(w, h)` | **DocumentPage** | rect 的派生 |
| `rotation()` → `int` | **DocumentPage** | fitz.Page.rotation 的封装 |
| `has_text()` → `bool` | **DocumentPage** | text() 快速判空 |
| `number` / `doc_id` → 属性 | **DocumentPage** | 标识 |
| `render()` → `(bytes, fmt, etag)` | **DocumentPage** | 委托给 `Engine.render()` 的轻量代理 |
| `extract_pdf()` → `bytes` | **DocumentPage** | 委托给 `Engine.extract_page_pdf()` 的轻量代理 |
| `highlight()` → `(bytes, fmt, etag)` | **DocumentPage** | render() + highlights 参数 |
| `page_count` / (页面总量) | **Document** (Registry) | 不是页面固有属性，是文档级 |
| `pixmap()` / `image()` | ❌ **不公开** | 涉及 DPI/colorspace/preset 等渲染行为；已有 `engine.render()`  |
| `links()` / `annotations()` | ⏳ 未来 | 需等 `types.py` 扩展对应类型 |
| `search()` / `ContentIndex .*()` | ❌ **不属于 Engine** | 消费者层，消费 `DocumentPage.text()` |

## 关键分界线

```
DocumentPage 负责：暴露页面固有属性 + 委托渲染
RenderEngine 负责：统一渲染入口（image + geometry producer）
Registry    负责：文档生命周期管理
ContentIndex 负责：消费 text() 做搜索索引（不在 Engine 里）
```

## 不允许做的事情

- ❌ DocumentPage 不持有渲染状态（zoom/crop/gray 属于 `view_state`，由调用方传入）
- ❌ DocumentPage 不缓存像素（text_cache 属于 Document，像素缓存属于 `RenderCache`）
- ❌ DocumentPage 不自己调用 fitz Pixmap（走 `Engine.render()` 唯一入口）
- ❌ DocumentPage.Property 在 DocumentPage 层不做懒加载缓存（只有 `text()` 的 text_cache 在 Document 级做）

## 为什么 `pixmap()` 不公开

因为一旦暴露 `page.pixmap(dpi=150)`，就会和 `engine.render(page, preset="preview")` 形成两套渲染路径。以后改 preset（换格式/调质量/改 highlight 绘制方式），两边都要改。所有像素输出必须收敛到 `Engine.render()`。

## Consumer 契约

所有 Consumer（ContentIndex / Search / Highlight / Selection / Copy Text）只通过两条路径访问数据：

```
Image  ←  Engine.render()
Text   ←  DocumentPage.text()
```

不直接调用 fitz。不访问 Registry 内部结构。不读 `text_cache` 原始 dict。
