# D3-3b-0 Source Resolver 只读审计

> 阶段：D3-3b 实现前的极短 gate（只读，不改代码）。
> 目标：确认 D3-3b executor 在 `open(sourceRef.path)` 之前，source 解析链的
> 信任边界 + 几何单位同构性已成立，无新阻塞。

## 1. 现有 path 解析模式（export-pdf 全链路）

`backend/app.py:1254 _build_export_items`：

```python
file_path = f.get('path', '')
if file_path and os.path.isfile(file_path):
    with open(file_path, 'rb') as fh:
        source = fh.read()          # → source: bytes
elif f.get('data'):
    source = base64.b64decode(f['data'])
else:
    return None, f"缺少 source: {filename}"
```

- 前端 `frontend/src/hooks/useExport.js:209/220` `handleExportPdf` 发送
  `{files:[{name, path, outputPath}]}`，其中 `path: f.path || ''`，
  `f.path` 是 Electron 文件对象暴露的**本机绝对路径**（来自 OS 文件对话框 / 拖拽）。
- `backend/services/pdf_handlers/image_handler.py:24` `export_to_pdf(source: bytes)`
  走 `fitz.open(stream=source)` —— 全链路 **bytes**，从不从 path 直接 `fitz.open`。

**结论**：`open(本机绝对路径)` 已是 export-pdf 的既有信任模式，唯一守卫是
`os.path.isfile`。D3-3b 的 `open(sourceRef.path)` 与之**同构**，不引入新的风险类别。

## 2. 部署信任边界

- 形态：Electron 桌面应用 + localhost Flask，前端/后端**同机**。
- path 由用户在 OS 文件对话框中选择，经 localhost HTTP 仅传输**路径字符串**
  （非文件内容）。后端读该 path = 与用户自己打开该文件的权限等同。
- `/api/export-pdf` 无 auth（localhost 假设）。D3-3b 的 `/api/export-render` 同此假设。
- 现有 `allowed_file` / `sanitize_filename`（`app.py:31`）仅用于 multipart 上传文件名，
  **不覆盖** path 直读。故 path 直读的验证缺口是**既有的**，非 D3-3b 引入。

## 3. 几何单位同构（"只翻译不重算"的前提）

前端事实（`composePlacement.js:22`、`composeSlotRasterizer.js:49`、
测试 `composeSlotRasterContract.test.js:79` `round(211.67*300/25.4)=2500`）：

```js
const k = dpi / 25.4;          // mmToPxFactor
px = Math.round(mm * dpi / 25.4)
```

- `createPlacement` 产出的 `placement.{scale, offsetX, offsetY}` 即在此 px 空间
  （源自 `slot.contentRect` 经 rasterizer 的 px）。
- 因此后端**合法的唯一 px 推导**：

  ```python
  paper_px_w = round(paper.widthMm  * dpi / 25.4)
  paper_px_h = round(paper.heightMm * dpi / 25.4)
  ```

  必须与前端 `mmToPxFactor` **逐字节一致（含 `round`）**。

- fitz page 尺寸以 pt 计，但 `image_handler.py:40`
  `pdf_doc.new_page(width=img_w, height=img_h)` 直接以像素数建页。
  故后端以 `paper_px` 建页即可与前端同构。
- executor 把 `placement` 翻译为
  `fitz.Matrix(scale) · Matrix(1,0,0,1, offsetX, offsetY)` —— **纯变换**，
  无 `_apply_margins` / center / `scale=min(...)`。

## 4. Image Source Adapter（D3-3b-2 职责）

- 复用 `_build_export_items:1267` 的读取方式：
  `open(sourceRef.path, 'rb').read()` → `fitz.open(stream=bytes)`。
  - image：`page=0` → `fitz.open(stream=bytes)[0]`
  - PDF/OFD（D3-3c/d）：`fitz.open(stream=bytes)[sourceRef.page]`
- adapter **只解析 source → bytes/pixmap，不碰几何**。

## 5. 阻塞 / 风险

- 🔴 **无新阻塞**。source ownership 已在 D3-3a 闭环（`sourceRef` 必填 `{path, page}`，
  `null` 被 schema 拒）。
- 🟡 **建议（既有，非 D3-3b 回归）**：把 `open(path)` 抽成共享
  `_read_source_from_ref(ref)` 同时服务 `export-pdf` 与 `export-render`，
  避免复制既有未校验直读；若未来要加固（path-traversal 限制 / 限发票目录），两处一起改。
- 🟡 **必须锁的不变式**：D3-3b-1 加契约测试，喂已知 `RenderCommand`，
  断言 fitz page 尺寸 == `round(mm*dpi/25.4)`；否则 `Preview ≠ Export` 会静默漂移。

## 结论

D3-3b-0 **PASS**。可进入 D3-3b：

- **D3-3b-1** 新增 `backend/services/render_executor.py`
  （`RenderCommand → fitz` 绘制，纯 executor；锁 `paper_px` 同构 + 禁后端 fit）
- **D3-3b-2** image source adapter（`sourceRef.path → bytes`，无几何）
- **D3-3b-3** 接入 `_run_export_render_task`

后端绝不做：`_apply_margins` / `scale=min(...)` / `center_x=(...)`。
只把 `command.placement` 翻译成 fitz matrix。
