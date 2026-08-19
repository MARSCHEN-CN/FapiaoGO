# PPC-OFD Integration Gate 3-A.5 — OFD Multi-Page 取证

> 状态：取证完成，待用户批准后实现 harness
> 前置：Gate 1-2 PASS / 3-A.1 PASS（6/6）/ 3-A.2 PASS（4/4）/ 3-A.3 PASS（8/8）/ 3-A.4 PASS（7/7）
> 纪律：docs-only；本 Gate 只验证 OFD 多页 page contract，不进入 OFD+PDF multi merge / physical print / export

---

## 0. Scope Lock

唯一验证命题：**OFD 文档 pages[0..N] 的 page contract（render order / per-page size / per-page rotation / no page collapse）是否稳定**。

重点风险（用户给定）：
1. page index 稳定性：`page.index → render request pageNum → raster response → composer item order`
2. 多页 OFD 是否错误复用 `page[0] dimensions` 到 `page[1]`
3. rotation 是否逐页隔离（page0 rot90 / page1 rot0 → 两个独立 RenderCommand）
4. 边界：不进入 OFD+PDF multi merge / physical print / export

---

## 1. DocumentStore pages[] 结构（检查点 ①）

`doc.pages[]` 由 `createPageMeta`（InvoiceDocument.js:53）构造：

```js
{ docId, index /* 0-based */, width, height, sourceRotation, renderDocId, renderPage /* 1-based */ }
```

注册路径（DocumentStore.js）：
- **多页注册**（:242-266）：`meta.pages = [{index, width, height, rotation}]` → `createPageMeta({ index, renderPage: index + 1, ... })` —— **index 0-based → renderPage 1-based**。
- **metadata 回填**（:308-322）：只更新 width/height/sourceRotation，**保留 renderDocId/renderPage**（渲染身份不被覆盖）。
- **OFD 注册**（DocumentStore.metadata.test.js:42-52）：后端 metadata `pages[].rotation`（=sourceRotation）→ `page.sourceRotation`；`pageCount = pages.length`。
- `getDocument(docId)`（:102）/ `registerDocument(doc)`（:85）。

**页映射链（冻结）**：

```
doc.pages[i].index  (0-based 数组索引)
  → renderPage = index + 1                       (1-based 物理页码, DocumentStore:266)
  → resolvePrintUrl(page, docId)                 (/print/{renderDocId||docId}?page={renderPage}, previewResourceResolver.js:59-63)
  → fetchPrintRaster(docId, pageNum=index+1)     (printAdapter.js:104-112, 1-based)
  → 后端 /print/<doc_id>?page=N                  (N 为 1-based, engine.render)
```

无 index 错位：0-based ↔ 1-based 转换只在两处（DocumentStore 注册 / resolvePrintUrl），均一致。

---

## 2. usePreview 多页 OFD page materialization（检查点 ②）

- 预览定位：`pageForPreview = fObj.pageNum ?? 1`（usePreview.js:1410，1-based SOURCE evidence）→ `buildPreviewUrl(effectiveDocId, pageForPreview)`（:1411）——**单页 URL 定位**，多页切换由 Viewer 的 pageNum 驱动。
- mergePair（多文件 merge）与多页（单文件多页）是正交概念；3-A.5 只验证**单文件多页 OFD 打印**。

---

## 3. fetchPrintRaster 页映射（检查点 ③）

`printAdapter.js:104-112`：

```js
export async function fetchPrintRaster(docId, pageNum = 1, { signal } = {}) {
  const url = resolvePrintUrl({ index: pageNum - 1 }, docId)   // 1-based pageNum → 0-based index
  const res = await fetch(url, { signal })
  ...
  return res.blob()
}
```

**1-based pageNum 契约**：调用方（usePrint）传 `page.index + 1`，fetchPrintRaster 内部 `pageNum - 1` 还原 index → resolvePrintUrl 再 `index + 1`。往返一致，无 off-by-one。

---

## 4. renderMultipleItemsToCanvas 多页 item 顺序（检查点 ④）— 核心取证

**usePrint OFD 多页分支（usePrint.js:202-248）**：

```js
const job = buildPrintJobItem(f)          // pages: [{index, url}]（printAdapter.js:74-77）
const pages = job.pages || []
for (const page of pages) {               // ← 按 page.index 顺序（0,1,2,...）
  blob = await fetchPrintRaster(job.docId, page.index + 1)   // 逐页栅格
  ...
  const pageItem = { ...f, _previewImageUrl: blobUrl }
  const canvas = await renderMultipleItemsToCanvas(
    [pageItem], paper, PREVIEW_DPI, landscape, { [f.key]: rotation },
    1, false, false, { strategy: 'vertical', customPaper })  // ← 每页 slotCount=1 独立渲染
  ...
  buffers.push(await canvasToUint8Array(canvas))             // ← 每页一物理页
}
return { key, name, data: buffers, printPath }               // buffers = N 物理页
```

**决定性事实**：
- **多页 OFD 打印 = N 次单页渲染循环**（每页独立 `renderMultipleItemsToCanvas` 调用、独立 canvas、独立 RenderCommand、独立 `drawRenderCommand`），**非一次 multi-item 渲染**。
- item 顺序 = `job.pages` 顺序 = `doc.pages` 数组顺序（page.index 升序）——**无错位**（fetch 按 index+1，push 按循环序）。
- **每页 dimensions 独立**：每页 raster 独立 fetch（后端 /print 按页返回）→ Phase 1 `contentSources` 取该页真实尺寸 → `fileObjToComposePagePlan` 用该页尺寸 → **无 page[0] 复用 page[1] 的可能**（每页独立 item/canvas）。

---

## 5. page-level rotation / dimensions owner（检查点 ⑤）— 重要取证发现

- **dimensions owner = 每页 raster**（后端 /print 按页栅格化，尺寸随页），经 `contentSources → fileObjToComposePagePlan` 独立消费。
- **rotation owner = 文件级共享**（usePrint.js:186）：

  ```js
  const rotation = fileRotations[f.key] || 0
  ```

  `fileRotations` 是 **key → rotation** 映射（文件级），**非 key+page 映射** → OFD 多页的所有页共享同一 rotation。

  ⚠️ 对用户风险 3 的精确回答：**逐页不同 rotation（page0=90 / page1=0）在真实链中不存在**——旋转是文件级施加（每页独立 RenderCommand 各施加一次同一角度）。本 Gate 验证的是「N 页共享文件级 rotation，每页独立施加一次、无跨页污染」，而非「逐页独立角度」（后者需 fileRotations 扩展为页级，属未来增强，非本 Gate）。

---

## 6. 与后端契约对照（Gate 2 复用）

- `OFDAdapter.metadata()` → `pages:[{index, width, height, sourceRotation}]`（每页独立尺寸/旋转，Gate 2 冻结证据）。
- `render_ofd_page(raw_bytes, page_index, dpi)` → 按页栅格化（source 取向，不烤旋转）。
- `/print/<doc_id>?page=N`：N 1-based，`engine.render` 逐页。

---

## 7. 3-A.5 harness 设计草案（待批准后实现）

模拟 usePrint OFD 多页循环（真实调用 `renderMultipleItemsToCanvas` + mock `fetchPrintRaster` 按 (docId, pageNum) 返回对应页栅格）：

| 用例 | 输入 | 断言 |
| --- | --- | --- |
| T1 page index 稳定 | 3 页（page0=2100×2970, page1=2480×3508, page2=2100×2970）逐页渲染 | 第 i 页 canvas 使用第 i 页栅格尺寸（drawImage 区域与各页尺寸对应，顺序正确） |
| T2 无 page[0] 复用 | page0=2100×2970 / page1=2480×3508（不同尺寸） | 两 canvas 落盘区域各自对应自己页（无复用 page[0]） |
| T3 rotation 逐页独立施加 | 文件级 rotation=90，2 页 | 每页 canvas 各 rotate 1 次 90°（2 页 = 2 次，独立 canvas 无跨页污染） |
| T4 每页独立 RenderCommand | 3 页 | 3 次渲染调用 = 3 独立 canvas / 3 独立物理页（buffers 数 = 页数） |

**边界**：只验证单文件多页 OFD 打印 page contract；不进入 OFD+PDF multi merge（3-A.3/3-A.4 已覆盖混合 merge 的单页组）、physical print（3-B）、export。

---

## 8A. ⚠️ 缺陷发现（harness 实测，2026-08-19）— 多页 OFD 打印页内容塌缩

### 裁决：**Gate 3-A.5 = FAIL（A5.2–A5.5）——真实 Consumer chain 缺陷**

harness（gate3A5OfdMultiPage.test.mjs）如实模拟 usePrint 多页循环（同 f.key + 每页不同 `_previewImageUrl`），结果：

| 用例 | 结果 | 失败信息 |
| --- | --- | --- |
| A5.1 page index mapping | ✅ | fetch 调用序列 (1,2,3) 正确 |
| A5.2 per-page raster identity | ❌ | 第 2 页 canvas 复用第 1 页 source |
| A5.3 no dimension collapse | ❌ | 两页落盘尺寸相同（page1 用了 page0 尺寸） |
| A5.4 file rotation isolation | ❌ | `buffers[0] === buffers[1]`（同 canvas 对象） |
| A5.5 render isolation | ❌ | `canvas0 === canvas1 === canvas2`（对象共享） |

### 根因（代码级证据链）

```
usePrint.js:226   pageItem = { ...f, _previewImageUrl: blobUrl }   ← 每页 key 不变（f.key）
usePrint.js:984   clearRenderCache() 只在打印【完成后】            ← 页循环期间缓存持续有效
renderers.js:1013 buildCacheKey = `multi_${paperKey}_${dpi}_${P/L}_${slotCount}_${strategy}_${rotKeys}_${margin}_${custom}_${items.map(i=>i.key).join(',')}`
                  ← 只含 items key，【不含页标识】（_previewImageUrl / page index / renderPage）
renderers.js:1038 renderResultCache.get(_cacheKey) 命中 → 直接返回第一页 canvas
renderers.js:1096 L1 itemRenderCache key = `itemRender_${id}_${dpi}_${rotate}_${paperKey}_${P/L}`
                  ← 同样不含页维度
```

**决定性验证**：同 key 两次渲染（不同 `_previewImageUrl`）返回**同一 canvas 对象**（`c1 === c2 === true`，实测）。

### 影响

多页 OFD 打印（pageCount ≥ 2，如 2 页电子发票）→ **N 张物理页全部输出第 1 页内容**（页内容塌缩）。单页 OFD 不受影响；PDF/Image 多页场景不存在（PDF 前端渲染仅第 1 页、Image 单页）。

### 归因（Gate 纪律）

**Consumer chain 缺陷**（renderers.js L2/L1 缓存 key 缺页维度），非 Producer / Rotation / RenderCommand 契约缺陷。修复候选（**不自行实施，待用户裁决**）：
- **最小**：`buildCacheKey` / L1 key 增加页标识维度（`item.pageNum ?? item._previewImageUrl ?? item.key`）——cache key 是性能层非契约，改动受限。
- 或 usePrint 页循环每页后 `clearRenderCache()`（保 L1）——性能代价。
- 候选方向属 PPC 或 4.4 式最小修复，需用户裁决后实施。

### 状态

```
Gate 3-A.5: FAIL（A5.1 PASS / A5.2-A5.5 缺陷证据确凿）
→ 待用户裁决：进入最小修复（Consumer cache key）或升级 PPC Gate 复审
```

---

## 8. 状态

```
[R1 CLOSED] [PPC RATIFIED] [Gate 4 CLOSED]
[PPC-OFD Integration]
  Gate 1: PASS / Gate 2: PASS / Gate 3-A.1: PASS / 3-A.2: PASS / 3-A.3: PASS / 3-A.4: PASS
  Gate 3-A.5: FAIL（缺陷发现 §8A：多页 OFD 打印页内容塌缩，待裁决修复）
```

待用户批准：进入 3-A.5 harness 实现（test-only）。
