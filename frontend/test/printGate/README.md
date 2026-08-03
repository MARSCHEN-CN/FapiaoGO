# A2-G1 Gate 采集器（DEV-only）

> 冻结 §11/§12。**不改任何打印代码**，只增加 Gate 测量能力。

## 文件

| 文件 | 作用 |
|---|---|
| `gateCases.mjs` | 第一批 3 组 case 定义（A1 PDF rot0 基准 / A2 OFD rot0 语义缺口 / A1 PDF rot90 旋转方向） |
| `collectGateOutput.mjs` | 采集器：source 轨（node 可跑）+ canvas 轨（Electron 环境） |
| `rasterize_pdf.py` | fitz 光栅化 helper（PDF 页 → RGBA raw bin） |
| `measureMargins.mjs` / `gateConfig.mjs` | 测量纯函数（G0 产物，复用） |
| `artifacts/` | **gitignored**，采集输出（PNG + JSON） |

## 运行

### source 轨（纯 node，已跑通）

```bash
# venv python 需含 pikepdf + fitz（backend/venv）
node collectGateOutput.mjs  # 或 import collectAllSource() 编程调用
```

产出 `artifacts/<case>/source.json`：
- `bbox`：内容包围盒（px，纸边=光栅化后实际页面尺寸，非 A4 假设）
- `marginMm`：四边边距（px→mm @300dpi）

### canvas 轨（需 Electron 渲染进程）

`renderMultipleItemsToCanvas` 依赖 DOM canvas（OffscreenCanvas），纯 node 不可跑。
在 Electron 渲染进程（devtools console 或 dev-only harness）注入：

```js
const { collectCanvasCase } = await import('/src/../test/printGate/collectGateOutput.mjs')
// ctx 由 Electron 环境提供：
//   renderMultipleItemsToCanvas — 生产同款（renderers.js），调用序列与 usePrint.js:288-298 逐字一致
//   makeItem(caseDef) — 构造 { key, fileFormat, _pdfData | _previewImageUrl }（usePrint.js:180-278 同款加载）
await collectCanvasCase(case, { renderMultipleItemsToCanvas, makeItem })
```

## 已确认的生产语义（采集实测，2026-08-03）

1. **A1 是专用发票纸（≈230×160mm），非 A4**：`paperActualPx=2717×1890@300dpi`。source 边距 L14.3/T16/R10.6/B17mm——发票内容自身页内非居中留白 + 10mm 扩展，非对称是**真实语义**，不是 bug。
2. **OFD source 轨无边距**（main.js:512 `imgExts` 不含 `.ofd`），且 fitz 不支持 OFD → bbox 需后端 Render Contract（fetchPrintRaster）补采。
3. **source 轨 rotation 由 Sumatra 原生处理**，不在 PDF 内容中 → node 采集的 bbox 不体现旋转；旋转方向验证须 canvas 轨（rotations 参数）。
4. **add-pdf-margins.py 语义 = 扩展页面尺寸、内容位置不变**（L189），不是 contain-fit。
