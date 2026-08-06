# 旋转架构迁移验证指南

> rotation-refactor 分支，Commit 3-B-2-A 完成后。
> 目标：确认三层模型（Viewer → PrintPreview → Print）在真实环境中行为正确。

---

## 1. 环境准备

### 1.1 启动后端

```bash
cd E:\print706
backend\venv\Scripts\python.exe backend\app.py
```

确认后端启动在 `http://localhost:5001`。

### 1.2 启动前端（开发模式）

```bash
cd E:\print706\frontend
npx vite --port 5173
```

### 1.3 启动 Electron（连接开发前端）

```bash
cd E:\print706
npx electron .
```

Electron 会加载 vite 开发服务器。确认 Electron 窗口打开且连接正常。

### 1.4 打开 DevTools

在 Electron 窗口中按 `Ctrl+Shift+I` 打开开发者工具 → Console 面板。这是本次验证的核心工具——所有诊断日志在这里看。

---

## 2. 测试文件准备

### 2.1 确认锚样本存在

```bash
ls E:\print706\frontend\test_fixtures\25952000000127675627.pdf
```

如果文件不存在，导入任意一张真实发票 PDF 作为测试样本。

### 2.2 导入测试文件

1. 在 Electron 窗口左侧文件列表中，点击「导入」或拖入一张 PDF 发票
2. 等待解析完成（状态变为"已解析"）
3. 记下文件名，后续步骤用它

### 2.3 验证文件元数据

在 DevTools Console 中执行：

```js
// 检查第一个已解析文件的尺寸信息
const f = window.__print706_debug?.files?.find(x => x.status === 'parsed')
console.log('文件元数据:', {
  key: f.key,
  format: f.fileFormat,
  width: f._pdfPageWidth,
  height: f._pdfPageHeight,
  orientation: f._pdfPageWidth > f._pdfPageHeight ? 'landscape' : 'portrait',
})
```

预期输出：能看到 PDF 页面尺寸和一页对应的方向。

---

## 3. 展示区（Viewer）验证

> Layer 1：纯内容展示，无纸张/边距/DPI。

### 检查点 V1：旋转按钮可见

在右侧展示区底部工具栏，确认有旋转按钮（通常是一个旋转图标）。hover 时 tooltip 显示当前角度。

### 检查点 V2：旋转后展示区变化

1. **初始状态**：发票竖着显示
2. **点击旋转按钮一次**：发票逆时针旋转 90°，变成横向
3. **再次点击**：继续旋转（90 → 180 → 270 → 0 循环）

在 Console 中验证状态：

```js
// 获取当前旋转角度（来自 usePreview.fileRotations）
// 需要在 React DevTools 中查看 usePreview hook 的 fileRotations 状态
```

### 检查点 V3：旋转状态持久化

1. 旋转发票到 90°
2. 切换到另一张发票
3. 切回来——确认旋转状态保持 90°

---

## 4. 打印预览区（PrintPreview）验证

> Layer 2：第一次出现纸张世界。RotationResolver 计算 layoutRotation + renderTransform。

### 4.1 基本打印预览

1. 选中发票，按 `Ctrl+P` 打开打印确认弹窗
2. 在弹窗右侧查看「打印预览」
3. 验证以下 DevTools 日志：

```js
// 在打印确认弹窗打开后，在 Console 中查找 RotationResolver 的输出
// 搜索关键词: [PRINT] 或 placement
```

### 4.2 Gate A：普通竖票 + A4 竖向

**条件**：contentRotation=0, paper=A4 portrait, 发票竖向

**操作**：
1. 确认发票未旋转（旋转按钮显示 0°）
2. Ctrl+P → 查看打印预览

**预期**：
```
┌─────────────────┐
│                 │
│   ┌─────────┐   │
│   │  发票   │   │
│   │  内容   │   │
│   └─────────┘   │
│                 │
└─────────────────┘
```
- 纸面 = A4 竖向（白底矩形）
- 发票缩略图居中，竖着放
- 安全边距虚线框可见（3mm 默认）
- **无 CSS transform:rotate() （Commit 2-A 已删除）**

**Console 确认**：

在 DevTools 中执行：
```js
// 查找最近一次打印预览的 slot 数据
// 在打印确认弹窗打开时：
//   React DevTools → PrintConfirmModal → PrintPreviewCanvas → preview prop
// 或直接在 Console 中打日志
```

关键验证：
- `slot.rotation`（deprecated）存在且值正确
- `slot.contentRotation` = 0
- `slot.layoutRotation` = 0
- `slot.finalRotation` = 0
- `slot.placement` = `{ scale, offset, placedRect, renderTransform }`（非 null）
- `slot.placement.renderTransform.rotationDeg` = 0

### 4.3 Gate B：用户旋转 90°

**条件**：contentRotation=90, paper=A4 portrait

**操作**：
1. 在展示区旋转发票 90°（点击旋转按钮）
2. Ctrl+P → 查看打印预览

**预期**：
```
┌─────────────────┐
│                 │
│  ┌───────────┐  │
│  │  发  票   │  │
│  └───────────┘  │
│                 │
└─────────────────┘
```
- **纸面仍然是 A4 竖向**（不旋转！这是新模型和旧 Policy A 的最大区别）
- 发票内容显示为横向（因为用户旋转了 90°）
- 安全边距虚线框仍在纸张坐标上

**Console 确认**：
- `contentRotation` = 90
- `layoutRotation` = -90（因为横向内容 + 竖向纸，布局引擎自动旋转 -90°）
- `finalRotation` = 0（90 + (-90) = 0）
- `placement.renderTransform.rotationDeg` = 0
- SVG viewBox 始终 = 纸张尺寸 mm（如 `0 0 210 297`）

### 4.4 Gate C：横内容 + 竖纸

**条件**：发票本身是横向（_pdfPageWidth > _pdfPageHeight），contentRotation=0, paper=A4 portrait

**操作**：
1. 找一张横向发票（或使用 preview test.pdf 多页文件中的横向页）
2. 确认 contentRotation=0
3. Ctrl+P → 查看打印预览

**预期**：
```
┌─────────────────┐
│                 │
│     发票内容     │
│                 │
└─────────────────┘
```
- **纸面不旋转**——仍然是 A4 竖向
- 横向内容自适应竖纸（layoutRotation=-90）
- 内容在纸面居中

**Console 确认**：
- `contentRotation` = 0
- `layoutRotation` = -90
- `finalRotation` = 270（0 + (-90) = -90 → 归一化 270）
- `placement.renderTransform.rotationDeg` = 270

### 4.5 切换纸张方向

1. 在打印确认弹窗中切换纸张方向（如果有选择）
2. 观察打印预览变化
3. layoutRotation 随纸张方向改变

**Console 确认**：
- 横纸 + 横向发票 → layoutRotation=0
- 竖纸 + 纵向发票 → layoutRotation=0
- 横纸 + 纵向发票 → layoutRotation=90
- 竖纸 + 横向发票 → layoutRotation=-90

---

## 5. 真实打印验证

> 最高风险：Sumatra `ps.sourceRotation` 是否会导致二次旋转。
> **建议使用虚拟 PDF 打印机（如 Microsoft Print to PDF）而不是物理打印机。**

### 5.1 打印到 PDF

1. 选中发票，Ctrl+P
2. 选择打印机为「Microsoft Print to PDF」（或其他虚拟 PDF printer）
3. 点击「打印」
4. 选择保存路径

### 5.2 验证打印输出的 PDF

用 SumatraPDF 或浏览器打开输出的 PDF，检查：

**Gate A（rot0）**：
- PDF 页面 = A4 竖向
- 发票内容居中、方向正确
- 无额外旋转

**Gate B（rot90）**：
- PDF 页面 = A4 竖向（**不是横向**！）
- 发票内容居中、方向正确
- 如果内容看起来转了 90°——说明 Sumatra `sourceRotation` 导致了二次旋转

**Gate C（横内容竖纸）**：
- PDF 页面 = A4 竖向
- 内容正确放置

### 5.3 验证 Console 日志

打印时 Console 中应出现：

```
[PRINT] Source pipeline: file=xxx format=pdf printer=xxx
[PRINT] PrintSettings: {...}
[print-source-file] settings={...}
[CommandBuilder] orient: content=portrait (src=frontend), paper=portrait (paper=A4), sourceRotation=0
```

关键检查：
- `sourceRotation` 的值与 `contentRotation` 一致
- `ps.placement` 非 null（如果有文件尺寸）
- Sumatra 的 `-print-settings` 字符串中包含正确的方向标识

### 5.4 如果出现二次旋转

现象：打印预览正确，但打印输出旋转了 90°。

排查步骤：

1. 检查 Sumatra 的 `-print-settings` 参数：
```
# 预期（rot0，竖票竖纸）：
disable-auto-rotation,fit,paper=a4

# 预期（rot90，竖票竖纸）：
# 如果 sourceRotation=90 被传给了 resolveOrientationCommands：
disable-auto-rotation,rotate=90,fit,paper=a4
```

2. 如果 `rotate=90` 出现且不应出现：
   - 检查 `usePrint.js` 中 `ps.sourceRotation` 的值来源
   - 临时 hack：将 `ps.sourceRotation` 设为 0 验证

3. 如果问题确认，需要在 `electron/print-settings.js` 中修改 `resolveOrientationCommands` 的逻辑或传入参数。

---

## 6. 快速诊断命令

以下命令可以在 DevTools Console 中直接执行（适用于 print706 的 React 环境）：

### 6.1 查看当前 fileRotations

```js
// 需要在有文件选中时
const state = document.querySelector('#root')._reactRootContainer?._internalRoot?.current?.memoizedState
// 或者更简单的方式：在展示区旋转按钮的 tooltip 中查看
```

### 6.2 查看打印预览 slot 数据

打印确认弹窗打开时，在 Console 中：

```js
// 查找最近的 placement 相关日志
// 或者在 React DevTools 中：
//   Components tab → PrintConfirmModal → PrintPreviewCanvas
//   → preview prop → pages[0] → slots[0]
```

### 6.3 触发 placement 计算日志

在 `frontend/src/hooks/usePrint.js` 的 `placements` useMemo 中添加临时日志：

```js
console.log('[VERIFY] placements computed:', Object.keys(result).length, 'files')
// 打印第一个 placement 的关键字段
const first = Object.entries(result)[0]
if (first) {
  const [key, p] = first
  console.log(`[VERIFY] ${key}: contentRotation=${p.contentRotation} layoutRotation=${p.layoutRotation} finalRotation=${p.finalRotation} scale=${p.scale}`)
}
```

---

## 7. 验收清单

| # | 检查项 | 预期 | 实际 | 状态 |
|---|--------|------|------|:---:|
| V1 | 展示区旋转按钮可用 | 点击旋转 90° 发票变横 | | |
| V2 | 旋转状态持久化 | 切换文件后旋转保持 | | |
| V3 | 展示区无纸张/边距 | 纯内容，无 A4/A5 标记 | | |
| P1 | Ctrl+P 弹出打印确认 | 弹窗右侧有预览 | | |
| P2 | 预览纸面 = A4 竖向 | SVG viewBox="0 0 210 297" | | |
| P3 | 竖票+竖纸→居中 | 发票竖着居中 | | |
| P4 | 旋转90°+竖纸→纸不转 | 纸面仍竖，发票横显 | | |
| P5 | 横票+竖纸→自动适配 | 纸竖，内容自适应 | | |
| P6 | 切换纸张方向预览变化 | layoutRotation 随方向变 | | |
| P7 | slot.placement 非 null | 有文件尺寸时 placement 存在 | | |
| P8 | slot.renderTransform.rotationDeg | = finalRotation | | |
| D1 | 打印到 PDF rot0 | 纸竖，内容正确 | | |
| D2 | 打印到 PDF rot90 | 纸竖，无二次旋转 | | |
| D3 | 打印到 PDF 横票竖纸 | 纸竖，内容正确 | | |
| D4 | Console: sourceRotation 值 | = contentRotation | | |
| D5 | Console: ps.placement | 非 null | | |

---

## 8. 如果发现 bug

### 展示区问题 → usePreview / fileRotations

搜索：`usePreview.js` → `fileRotations` / `handleRotate`

### 预览区问题 → PrintPreviewModel / RotationResolver

搜索：`PrintPreviewModel.js` → `resolveContentPlacement`

### 打印输出问题 → usePrint / electron print-settings

搜索：`usePrint.js` → `ps.sourceRotation`
搜索：`electron/print-service/print-settings.js` → `sourceRotation`

### 单元测试回归

```bash
cd E:\print706\frontend
node --test test/printPreviewModel.test.mjs test/rotationResolver.test.mjs test/printExecutionPlan.test.mjs
```

77/77 必须全部通过。
