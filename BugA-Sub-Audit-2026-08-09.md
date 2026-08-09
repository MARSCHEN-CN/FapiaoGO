# Bug A 子问题只读审计：页序 / 第二页渲染 / orientation 保持

**元数据**: 2026-08-09 · rotation-b1-hardening · 基于 commit a474d863  
**性质**: 只读代码审计，不改码，不启动修复。与 M1 Pass5/6 / Resolver / Bug B 无关。  
**前提**: Bug A 最小修复（a474d863）已让 `buildPrintPreviewModel` 正确读取 `_aggregatedPageCount`，  
但 `_aggregatedPageCount=2` 只解决「知道有 2 页」，不解决「如何定位/渲染/选中第 2 页」与「模型重建后保持当前页」。

---

## §1 数据流溯源（你要求的四个实体）

```text
┌─ file list             [A_p1, A_p2, B]
│   原始页级文件对象（key / docId / sourceDocId / pageNum / totalPages / pageCount）
│
│   createPrintPlanInput → normalizePrintSources
▼
┌─ printPlanInput.files  [aggregatedA, B]
│   aggregatedA = { ...A_p1, key:'__source_inst::docA', _aggregatedPageCount:2, _aggregatedPages:[A_p1,A_p2] }
│   B           = 原始文件对象（key / docId 未变）
│
│   buildPrintExecutionPlan(files, options) — source mode
▼
┌─ plan.pages            [page_A, page_B]
│   page_A.slots[0] = { fileId: '__source_inst::docA', contentRotation, rotation, placement, ... }
│   page_B.slots[0] = { fileId: B.key,            contentRotation, rotation, placement, ... }
│
│   buildPrintPreviewModel(plan, { files, settings, currentSelection, ... })
│     ├─ pageToModel → basePages[].slots[].fileId = slotDef.fileId = plan slots fileId
│     └─ 多页展开
▼
┌─ expandedPages         [A_p1_preview, A_p2_preview, B_preview]
│   A_p1: fileId='__source_inst::docA'  pageIndex=0  thumbnailUrl=/thumbnail/{A_p1.docId}?page=1
│   A_p2: fileId='__source_inst::docA'  pageIndex=1  thumbnailUrl=/thumbnail/{A_p1.docId}?page=2 ⚠️
│   B:    fileId='B.key'               pageIndex=0  thumbnailUrl=/thumbnail/{B.docId}?page=1
│
│   currentSelection = { fileId: previewFile.key, pageIndex: previewFile.pageNum }
│     previewFile = 用户点击「打印预览」的那个文件（固定，不随 UI 翻页改变）
▼
┌─ currentPageIndex      匹配逻辑（PrintPreviewModel.js:379-389）
│   for each expandedPages[i]:
│     if slot.fileId === currentSelection.fileId && slot.pageIndex === currentSelection.pageIndex → match=i
│   未匹配 → 0
│
│   PrintPreviewCanvas.useEffect: setCurrent(Math.min(currentPageIndex, total-1))
│   Canvas 内部 [current, setCurrent] 是本地 state → UI 翻页只改 current，不改 previewFile
│
│   orientation change → settings.landscape 变化 → useMemo 各级链式重算
▼
model rebuild → currentSelection 仍是 previewFile（不变）→ 重新匹配 → 重新 setCurrent
```

---

## §2 🔴 Bug A-2：第二页内容无法定位/渲染

### 2.1 根因（确定性）

**文件级证据**：`PrintPreviewModel.js:358`（展开循环内）

```js
thumbnailUrl: getThumbnailUrl(f, p, slot.contentRotation || slot._deprecatedRotation || 0)
```

- `f` = `fileById.get('__source_inst::docA')` = `aggregatedA`
- `aggregatedA.docId` = `A_p1.docId`（spread representative → 只继承了第一页的 docId）
- `p=1` → `getThumbnailUrl(aggregatedA, 1)` → `${backendUrl}/thumbnail/${A_p1.docId}?page=2`

**但 A_p1 是一页拆分 PDF**，其 `docId` 只对应 1 页。后端 `/thumbnail/{A_p1.docId}?page=2` 会返回 404 或空。

**正确的第二页 docId** = `A_p2.docId`（`_aggregatedPages[1].docId`）。

### 2.2 为什么普通多页（同一 docId 不同 page number）不受影响

对于单 PDF 多页（未拆分），所有页共享同一 `docId`，`getThumbnailUrl(f, p)` → `?page=N` 是正确的。  
**拆分页的特殊性**在于：每页是独立文件 → 独立 `docId` → 聚合源继承的是第一页的 docId → page=2 寻址到错误文件。

### 2.3 修复方向（不出代码，只标位置）

展开循环（`PrintPreviewModel.js:352-361`）需要同时支持两种多页来源：

| 多页来源 | docId 特点 | 缩略图寻址 |
|---|---|---|
| 单 PDF 多页（未拆分） | 所有页同一 docId | `getThumbnailUrl(f, p)` ✓ |
| 聚合拆分页（normalizePrintSources） | 每页不同 docId | 需 `getThumbnailUrl(_aggregatedPages[p], 0)` |

最小改动点：`PrintPreviewModel.js:358` 处，若 `f._aggregatedPages` 存在则以 `_aggregatedPages[p]` 喂给 `getThumbnailUrl`，否则保持现逻辑。

---

## §3 🔴 Bug A-3：切纸张方向后当前页跳回 3/3

### 3.1 根因（确定性）

**触发链**（逐段文件级核实）：

**① `previewFile` 身份固定**（`usePrint.js:574-575`）
```js
const currentSelection = previewFile
    ? { fileId: previewFile.key, pageIndex: previewFile.pageNum ?? 0 }
    : null
```
`previewFile` 是用户最初点击「打印预览」的文件，**无论 UI 翻到哪一页都不会变**。

**② 聚合源 slot 的 fileId ≠ 原始页 key**（`buildPrintExecutionPlan.js:271`）
```js
const buildSlot = (f) => ({
    fileId: f.key,   // aggregatedA.key = '__source_inst::docA'
    ...
})
```
`pageToModel(:297)` 透传：`fileId: slotDef.fileId = '__source_inst::docA'`

**③ currentSelection 匹配总是失败**（`PrintPreviewModel.js:381-388`）
```js
if (slot && slot.fileId === currentSelection.fileId && ...)
```
`slot.fileId = '__source_inst::docA'` ≠ `currentSelection.fileId = A_p1.key` → 永远不匹配。

**④ 回退到 0 → 但 `previewFile` = B**（场景重现）

| 时序 | previewFile | UI 当前页 | currentSelection | 匹配结果 | currentPageIndex |
|---|---|---|---|---|---|
| 初始（从 B 进入） | B | 3/3 | {B.key, 0} | i=2 命中 | 2 |
| UI 翻到 1/3 | B（不变） | 1/3（current=0） | —（未重建） | — | — |
| orientation change → 重建 | B（不变） | 重新计算 | {B.key, 0} | i=2 命中 | 2 |

所以 `currentPageIndex = 2` → `PrintPreviewCanvas.useEffect` 设 `current = 2` → 显示**3/3（B）**，而不是用户刚才翻到的 1/3。

**⑤ B 本身不受影响**（B 不是聚合源，B.key 未变 → 匹配成功）

### 3.2 为什么不只是「回退到 1/3」

如果 `previewFile` 碰巧是 A_p1（从 A 进入的），则 `currentSelection = {A_p1.key, ...}` ≠ `'__source_inst::docA'` → 不匹配 → `currentPageIndex = 0` → 显示**1/3**。

你从 B 进入 → `previewFile` = B → 匹配中 B → 所以跳到 3/3。  
从 A_p1 进入 → `previewFile` = A_p1 → 匹配失败 → 跳到 1/3。

**结论**：现象取决于 `previewFile` 是谁，但根因相同——**聚合源 slot.fileId 与原始页 identity 断开**。

### 3.3 修复方向（不出代码，只标位置）

两个相互独立的可选方向，不互斥：

**方向 1（最小—让匹配能工作）**：在展开循环给 `slot.fileId` 写入可匹配的值。  
若 `f._aggregatedPages` 存在，`expanded slot.fileId = _aggregatedPages[p].key`（原始页 key）。  
这样 `currentSelection.fileId = A_p1.key` → 能匹配 → `currentPageIndex` 正确。  
**局限**：只修了「模型能找到当前页」，没修「previewFile 本身应该反映当前页」。

**方向 2（更根本—让 previewFile 跟踪当前页）**：把 `PrintPreviewCanvas` 的 `current` 状态上提到 `usePrint` 或 modal 层，让 `currentSelection` 反映实际正在预览的 expand page identity，而不是固定 `previewFile`。  

---

## §4 🟡 Bug A-1：页码顺序

### 4.1 审计结论：在当前数据流中顺序应是正确的

从头追踪：

1. **normalizePrintSources**：遍历 `files`（输入顺序），Map 插入顺序 = A_p1 处理时建组 → `sourceGroups` 第一组。结果 `[aggregatedA, B]`——A 在前、B 在后。

2. **buildPrintExecutionPlan**：`sourceFiles.map` 保序 → `plan.pages = [page_A, page_B]`。

3. **buildPrintPreviewModel**：`plan.pages.map(pageToModel).filter(Boolean)` 保序。展开循环同样保序（每个 base page 原地展开）。

4. **因此 `expandedPages = [A_p1_preview, A_p2_preview, B_preview]` = 期望的 1/3, 2/3, 3/3**。

### 4.2 可能出问题的一个场景（未实证，仅标注）

`pageToModel` 内部：
```js
usable.w <= 0 || usable.h <= 0 → return null
```
若某页因边距超纸返回 null → 被 `.filter(Boolean)` 丢弃 → 后续页码位移。  
这是边距校验问题，非聚合/展开 bug，不属于 Bug A 范围；若发生应独立排查。

---

## §5 三个子问题的共同根：聚合源展开后 slot identity 不完整

| 子问题 | 数据结构缺陷 | 影响 |
|---|---|---|
| **A-1 页序** | （当前成立） | 无已知 bug；边距 null-case 待观测 |
| **A-2 第二页渲染** | `getThumbnailUrl(f, p)` 用了聚合源 docId(=A_p1.docId)，未用 `_aggregatedPages[p].docId` | 第二页缩略图 URL 指向错误文件 |
| **A-3 orientation 保持** | `slot.fileId = '__source_inst::...'` ≠ 原始页 key；`currentSelection` 固定为初始 `previewFile` | 模型重建后无法恢复当前预览页 |

**一句话总结**：`_aggregatedPageCount` 给了 **count**，但展开循环没有给每页正确的 **identity**（docId / fileId / page locator）。`_aggregatedPages[]` 携带了所有这些信息——目前展开循环没消费它。

---

## §6 修复边界建议（授权后才动）

按你定义的顺序 A-2 → A-3，但它们的修复区域重叠在 `PrintPreviewModel.js:352-361`（展开循环）：

```js
for (let p = 0; p < pageCount; p++) {
    const pageFile = f._aggregatedPages ? f._aggregatedPages[p] : f
    expandedPages.push({
        ...page,
        slots: [{
            ...slot,
            pageIndex: p,
            thumbnailUrl: getThumbnailUrl(pageFile, 0, ...),  // A-2: 用真实 page 文件
            fileId: pageFile.key,                              // A-3: 用真实 page key
        }],
    })
}
```

关键改动：
- 取 `_aggregatedPages[p]` 而非直接用 `f`（A-2 的 docId、A-3 的 key 都对了）
- `getThumbnailUrl(pageFile, 0, ...)` → page=1（每个物理页都是 page=1，因为每个物理页都是独立 PDF）
- `fileId: pageFile.key` → 与原始 `currentSelection.fileId` 同源 → 匹配可工作

A-3 剩余问题（`previewFile` 不跟踪 UI 翻页）在本次最小修复范围内不碰——最小修复让「从 A_p1 进入后选 A 的页」能保持，但「从 B 进入后翻到 A 的页再切方向」仍会跳回 B——那是方向 2 的范围。

**commit 隔离**：此修复仍应与 M1 Pass5/6、Resolver、Bug B(7795cd6f/6eae913e)、5995ba8d 严格分开；测试先于修复。
