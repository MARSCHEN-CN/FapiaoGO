# A2-G1 Gate 采集器（DEV-only）

> 冻结 §11/§12。**不改任何打印代码**，只增加 Gate 测量能力。

## 文件

| 文件 | 作用 |
|---|---|
| `gateCases.mjs` | 第一批 3 组 case 定义（A1 PDF rot0 基准 / A2 OFD rot0 语义缺口 / A1 PDF rot90 旋转方向） |
| `collectGateOutput.mjs` | source 轨采集器（node 可跑，已跑通） |
| `electron/collectCanvasOutput.js` | **canvas 轨采集器**（G1-CANVAS-1，Electron 渲染进程执行） |
| `analyzeGateOutput.mjs` | **分析器**：canvas vs source 对比报告（node 侧，已验证 OFD/PDF 双判定） |
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

### canvas 轨（需 Electron 渲染进程，G1-CANVAS-1 已就绪）

`renderMultipleItemsToCanvas` 依赖 DOM canvas（OffscreenCanvas）+ vite `?url` import，纯 node 不可跑。

**文件**：`electron/collectCanvasOutput.js`——makePrintItem 固化 usePrint.js:180-278 三分支（PDF read-file→_pdfData / OFD buildPrintJobItem+fetchPrintRaster→_previewImageUrl / Image read-file→blob），renderMultipleItemsToCanvas 调用序列与 usePrint.js:288-298 逐字一致（8 参数，已人工核对）。

**运行步骤**（Electron dev，`npm run dev` 起 vite:5173 后）：
1. 打开 devtools console（渲染进程）
2. 注入仓库根（磁盘路径）：
   ```js
   globalThis.__GATE_REPO_ROOT__ = 'E:/print706/'
   ```
3. 执行采集（**G1-CANVAS-1 只跑 PDF case，OFD 留 G1-B**）：
   ```js
   const { collectCanvasCases, CANVAS_G1_CASES } = await import('/@fs/E:/print706/frontend/test/printGate/electron/collectCanvasOutput.js')
   const results = await collectCanvasCases({ names: CANVAS_G1_CASES })  // ['A1-rot0','A1-rot90']
   ```
4. 每个 case 的 `canvas.json`（含 bbox + marginMm）在 console 输出；`results[i].pngBytes` 可手动落盘 `artifacts/<case>/canvas.png`（或注入 `globalThis.__GATE_WRITE__` 自动写盘）
5. node 侧跑分析：`node analyzeGateOutput.mjs` 生成 canvas vs source 对比报告

> **IPC 契约（已实测确认）**：真实暴露名 = `window.electronAPI.ipcRenderer.invoke('read-file', path)`（`electron/preload.js:51,92`），`read-file` 经 `'read-'` 前缀白名单放行（L29）。采集器 `resolveGateIPC()` 按 electronAPI → ipcRenderer → api.ipc 顺序探测，缺失时明确报错。
>
> **case scope**：`gateCases.mjs` 导出 `CANVAS_G1_CASES=['A1-rot0','A1-rot90']`（G1-CANVAS-1 PDF 主链）与 `OFD_G1_CASES=['A2-rot0']`（G1-B 单独做）。OFD 依赖 DocumentStore(docId)，需应用内已解析该 OFD。

## 已确认的生产语义（采集实测，2026-08-03）

1. **A1 是专用发票纸（≈230×160mm），非 A4**：`paperActualPx=2717×1890@300dpi`。source 边距 L14.3/T16/R10.6/B17mm——发票内容自身页内非居中留白 + 10mm 扩展，非对称是**真实语义**，不是 bug。
2. **OFD source 轨无边距**（main.js:512 `imgExts` 不含 `.ofd`），且 fitz 不支持 OFD → bbox 需后端 Render Contract（fetchPrintRaster）补采。
3. **source 轨 rotation 由 Sumatra 原生处理**，不在 PDF 内容中 → node 采集的 bbox 不体现旋转；旋转方向验证须 canvas 轨（rotations 参数）。
4. **add-pdf-margins.py 语义 = 扩展页面尺寸、内容位置不变**（L189），不是 contain-fit。
