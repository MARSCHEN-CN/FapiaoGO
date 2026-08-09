# Bug B — 预览内容消失 静态追踪报告

> 调查线：Bug B 独立调查（不碰 M1 Pass 5/6，不碰 Resolver）
> 目标：快速切页 / 切换纸张方向 → 纸张 + 安全边距正常，但 Invoice Content 消失
> 方法：纯静态追踪（未改任何代码）
> 日期：2026-08-09

## 1. 追查的链

```
用户操作（切页 / 切方向）
  ↓
usePrint.printPreviewModel (useMemo)        usePrint.js:570
  ↓  buildPrintExecutionPlan + buildPrintPreviewModel
PrintPreviewModel.buildPrintPreviewModel    PrintPreviewModel.js:128
  → pageToModel → resolveContentPlacement   PrintPreviewModel.js:177 / 245
  ↓
PrintPreviewCanvas (memo) + SlotImage       PrintPreviewCanvas.jsx:295 / 39
  ↓  placement.renderTransformMM (SVG <g transform>) 或 fallback 填充
发票缩略图 <image>
```

## 2. 核心结构事实（已读源码确认）

- `buildPrintPreviewModel` 是**纯函数**，不持有状态（PrintPreviewModel.js:128）。所以它本身不会"滞后"；滞后只能来自调用方传入的 `plan` / `files` / `settings` 快照不一致，或异步驱动的重算时序。
- `resolveContentPlacement`（RotationResolver.js:182）在非法输入时 **throw**（:191 `contentPhysicalSize` 缺/非正；:205 `physicalPaper` 缺；:249 边距超纸），`scale` 有兜底（:264 `Number.isFinite && >0 ? scale : 1`）。**它不会输出 `scale=0/NaN` 的退化 placement**。
- `printPreviewModel` useMemo 外层有 **try/catch**（usePrint.js:571-586）。一旦 `resolveContentPlacement` throw，整个 preview 返回 `null` → Canvas 走 `total===0` 占位分支（"暂无预览数据"），**连纸张都不画**。
  ⇒ 因此"纸在、内容消失"**不是**退化 transform 导致的，反证问题类 2（无效 placement）不是主因。
- `SlotImage` 有两条渲染分支（PrintPreviewCanvas.jsx）：
  - `placement` 存在 → `<g transform=translate/scale/rotate>` 内画 `<image>`（:72-113）
  - `placement` 为 null → **fallback 直接填充槽位** `<image>`（:114-152）
  ⇒ 无论 placement 是否存在，只要 `thumbnailUrl` 有效，内容都应可见。**内容消失 = `thumbnailUrl` 为 null/错误**，而非 placement 数学。

## 3. 发现（按与症状贴合度排序）

### 🔴 F2 — `fileId` 在 `files` 快照中解析不到 → `thumbnailUrl` 为 null（问题类 3：model/render 不同步）
- `PrintPreviewModel.js:204` `const f = fileById.get(slotDef.fileId)`
- `PrintPreviewModel.js:296` `thumbnailUrl: getThumbnailUrl(f, 0, userRotation)`
- `getThumbnailUrl`（:164-175）：仅当 `f.docId` 存在（拼 `/thumbnail/{docId}?page=`）或 `f.previewImage` 存在时返回 URL；否则返回 **null**。
- 若 `f` 为 `undefined`（plan 引用的 `slotDef.fileId` 不在本次传入的 `files` 数组里），`getThumbnailUrl(undefined,...)` → null → `<image>` 无 src → **SlotImage 只画淡色占位 rect，发票内容整体消失**；而纸张（:348 `page.paperSizeMM`）+ 安全边距（:351）+ 槽位边框（:66）均不依赖 `f`，照常绘制。
- **这是唯一能稳定产生"纸在、内容消失"的代码路径。**
- 待验证：`plan.pages[].slots[].fileId` 是否恒 ⊆ `printPlanInput.files`（即 `createPrintPlanInput` / `buildPrintExecutionPlan` 是否保证 plan 与 files 同源同快照）。若快速切换时 plan 来自新 `files`、但 `buildPrintPreviewModel` 某次重算拿到的 `files` 快照滞后，则 `f` 取不到。

### 🟡 F1 — `dimsVersion` 异步驱动 preview 重算，与切页/切方向不同步（问题类 1 + 4：状态竞态 / 异步回写）
- `usePrint.js:591-622` dims 加载 effect：RE 路径 PDF 的 `_pdfPageWidth/_height` 经 IPC + pdf.js **异步**加载，完成后 `setDimsVersion(v=>v+1)`（:618）。effect 带 `cancelled` 守卫，依赖 `[files, ...]`（:621）——快速切换 `files` 时上一次加载被取消。
- `printPreviewModel` useMemo 依赖 `[printPlanInput, previewFile, dimsVersion]`（:587）。`printPlanInput` 又依赖 `placements`（:564，但 placements 是死代码，见 F5）。
- `buildPrintPreviewModel` 仅在 `contentPx` 有效时算 `placement`（PrintPreviewModel.js:230）。故 preview 存在「无尺寸(placement=null, fallback) ↔ 有尺寸(placement 有, transform)」两态，且切换由**异步 dims 事件**触发，与用户切页/切方向的同步状态变更**不同步**。
- 这是 Bug B 最可能的**触发机制**：快速操作使 preview 在"旧文件尺寸/新设置"与"新文件尺寸/旧设置"之间被异步事件反复重算。

### 💭 F4 — `SlotImage` memo/key/thumbnailUrl 的复位竞态（问题类 4：异步结果回写）
- `SlotImage = memo`，key = `${slot.fileId}-${slot.pageIndex}-${i}`（PrintPreviewCanvas.jsx:366）。
- `useEffect([slot.thumbnailUrl])`（:43-46）仅在 `thumbnailUrl` **字符串变化**时重置 `loaded/error`。若切换后 `thumbnailUrl` 字符串相同但底层图已变（如同一 docId+page 后端重新生成），effect 不复位，`loaded` 沿用旧值，可能掩盖 error 状态或显示陈旧内容。
- 次要因素，单独不足以造成"消失"，但与 F1/F2 叠加会放大不稳定。

### 🟢 F3 — 退化 placement（问题类 2）：已基本排除
- `resolveContentPlacement` 不产出 `scale=0/NaN`（:264 兜底，且非法输入直接 throw）；throw 被 `printPreviewModel` useMemo 捕获 → 整 preview 变 null → Canvas 占位（无纸）。
- 故"content 因 transform 退化而不可见、但纸仍在"在本代码结构中**不成立**。修复时勿在 Resolver 里搜 scale=0。

### 💭 F5 — `placements` useMemo 是死代码（已知，非 Bug B 主因）
- `usePrint.js:522-562`：`resolveContentPlacement` 入参写错键 `contentSize`（应为 `contentPhysicalSize`，:551），每次调用在 :191 校验处 throw → 被 :557 catch 静默吞掉 → `placements` 恒为 `{}`。
- 但 preview 渲染**不走 `placements`**（PrintPreviewModel 自己调 `resolveContentPlacement`），故它是死代码，不影响 Bug B。注释已标记 Issue P11，按 bisect 纪律本调查不碰。

## 4. 假设排序

1. **F2（fileId→files 解析失败 → thumbnailUrl null）** — 与"纸在内容消失"最贴合；需确认 plan/files 同源同快照。
2. **F1（dimsVersion 异步驱动重算不同步）** — 最可能的触发机制，使 F2 或 fallback/transform 两态在快速操作时错位。
3. **F4（SlotImage 复位竞态）** — 叠加放大器，非独立主因。
4. F3 已排除。

## 5. 验证方案（不改代码，复用已有 DIAG 日志）

复现：打开打印确认弹窗 → 快速连续切页 / 反复切纸张方向 → 观察内容是否消失。同时打开 DevTools Console，关注：

- `[usePrint dims loaded]`（usePrint.js:615）— 尺寸到达时机，是否晚于切页。
- `[DIAG-14 contentDims]`（PrintPreviewModel.js:222）— 消失那一刻 `contentPx` 是否为 `null`。
- `[DIAG-11 rotation matrix]` / `[DIAG-11 no placement]`（:326 / :330）— placement 是 null 还是 present。
- `[DIAG-13 slotImage SVG]`（PrintPreviewCanvas.jsx:58）— 实际 `svgTransform` 与 `rotationDeg`；若 `t` 存在但内容仍消失，重点查 `thumbnailUrl`。
- `[DIAG-16 pageToModel null]`（:188）— 整页因边距超纸被丢弃（会致该页无内容，但属配置错误非竞态）。

判定：
- 若消失时 `[DIAG-14] contentPx=null` 且 `[DIAG-13] t` 不存在 → 走 F1/F2（尺寸/文件快照）。
- 若 `[DIAG-13] t` 存在但 `<image>` 不显示 → 查 `thumbnailUrl`（F2：f 取不到 → null；或 F4：error 态）。
- 若整 preview 变 null（占位"暂无预览数据"）→ 是 throw（非本症状），另查边距/尺寸。

## 6. 范围纪律

- 本报告仅静态追踪，**未修改任何源码、未提交**。
- Bug B 与 Bug A（同票两页 1/1）、M1 Pass 5/6、Resolver 均独立，不混。
- 下一步若授权修复，应基于上述验证结论定位确切断点，单独立 commit（与 M1 隔离）。

## 7. 复现证据与假设重排（2026-08-09 19:30，用户复现）

用户复现后抓取各 DIAG 最后一条：
- 无 `[usePrint dims loaded]`（usePrint.js:615）
- `[DIAG-14 contentDims] fileKey=51-8de8-d317a587fd95 raw='595x397' contentPx='2479x1654' pdfPage=595`
- `[DIAG-11 rotation matrix] contentRotation=0 layoutRotation=0 effectiveSize=[object Object] rotationDeg=0 requestedPaperOrientation=landscape`
- `[DIAG-13 slotImage SVG] rotationDeg=0 svgTransform=translate(2.96,7.88) scale(1.3867563025210086) rotate(0,104.95,70.03) slotRotation=0`
- 无 DIAG-16

### 反推（对照真实代码 if/else）

1. **DIAG-14 触发 ⇒ `f` 取到且 `_pdfPageWidth` 有效**（PrintPreviewModel.js:204/220-228）。
   → **F2 原表述「fileId 取不到文件」被推翻**：文件是取到的。
2. **DIAG-11 + DIAG-13 均 fired 且 scale=1.387 非退化** ⇒ placement 存在且有效。
   → **F3（退化 transform）彻底排除**；"placement 为 null"的 F1 变体也排除。
3. 无 `[usePrint dims loaded]` 属正常：contentPx 已 2479x1654 ⇒ 尺寸早被缓存，usePrint.js:595 `needDims.length===0` 早退，无新日志。
   → 说明 bug 是**稳定态**（尺寸稳定后内容仍消失），非"尺寸异步未到"瞬时态 ⇒ **F1 大幅降级**。
4. 无 DIAG-16 ⇒ 页面未被边距超纸丢弃。

### 重排后的根因

placement 与 svgTransform 全对 ⇒ 内容消失的唯一代码路径是 `SlotImage` 的 `hasThumbnail`（PrintPreviewCanvas.jsx:48/72-112）：
`hasThumbnail = !!slot.thumbnailUrl && !error`；为 false 时画极淡占位 `<rect>`，非 `<image>`。

`slot.thumbnailUrl = getThumbnailUrl(f,0,rot)`（PrintPreviewModel.js:296）；`getThumbnailUrl`（:164-175）仅当 `f.docId`（→`/thumbnail/{docId}`）或 `f.previewImage` 存在才返回 URL，否则 null。

🔑 **关键**：DIAG-14 只证明 `f` 有 dims（`_pdfPageWidth`），而 thumbnailUrl 需要 `docId`/`previewImage`——**两个独立字段**。一份文件可"有 dims 但无 docId"。

**⇒ Bug B 真正断点不在旋转/placement 数学，而在参与构建预览的文件对象有 PDF 尺寸、却缺 `docId`/`previewImage` 缩略图来源 → `getThumbnailUrl` 返回 null → 内容不可见。**
这吻合 Identity≠Capability / P-Render-Resource-Unification：快速切换时预览可能指向"带 render 尺寸、缺 Source docId"的文件对象；且 `printPreviewModel` useMemo 依赖 `[printPlanInput, previewFile, dimsVersion]`（usePrint.js:587）**不含 per-file docId**，docId 晚到也不重算 → 稳定不恢复。

### 假设新排序
1. **F2-revised**：f 取到但有 dims、缺 docId/previewImage → thumbnailUrl null → 内容消失（强证据支撑，原 F2「取不到文件」表述作废）。
2. F4（SlotImage error 态 / 同 URL 不复位）— 仍可能叠加，需查 DevTools 是否有 `[PrintPreviewCanvas] 缩略图加载失败`。
3. F1 / F3 基本排除。

### 下一步确认（零改码）
DevTools 元素审查预览 SVG 内 slot 的 `<g transform>`：
- 见 `<rect fill="var(--accent-soft)">`、无 `<image>` ⇒ 坐实 hasThumbnail=false → thumbnailUrl null（F2-revised 成立）。
- 见 `<image>` 但 href 空/破图 ⇒ onError 路径（控制台有 `[PrintPreviewCanvas] 缩略图加载失败`）。
可选：在 getThumbnailUrl 加一行 investigation 诊断（打印 f.docId 与最终 thumbnailUrl），下次复现直接确认。

### 7.1 DOM 实证（2026-08-09 19:37，用户贴 DevTools 实际 SVG）

用户贴出 content 消失态的真实 DOM（A4 横向、rotate 270°、content_rotation=90）：
```html
<g transform="translate(51.4,-40.56) scale(1.3867563025210086) rotate(270,70.03,104.95)">
  <image href="http://localhost:5000/thumbnail/3e5426e6f34e08b824b3afb5?page=1&amp;content_rotation=90"
         x="0" y="0" width="140.05" height="209.9" preserveAspectRatio="none"
         style="opacity: 0; transition: opacity 0.2s ease-in;"></image>
  <rect x="0" y="0" width="140.05" height="209.9" fill="var(--accent-soft)" fill-opacity="0.3" rx="0.5"></rect>
</g>
```

**铁证三重**：
1. `<image href>` 存在且含真实 docId（`3e5426e6f34e08b824b3afb5`）→ `thumbnailUrl` 非 null、docId 存在。**⇒ F2-revised（缺 docId→thumbnailUrl null）当场推翻。**
2. `style="opacity: 0"` ⇒ `loaded===false`（PrintPreviewCanvas.jsx:84 `opacity: loaded?1:0`）。`<image>` 在 DOM、位置/旋转正确，但被透明度压不可见。
3. 存在 `fill-opacity="0.3"` 的 `!loaded` 分支 rect（:98），且无 `fill-opacity="0.2"` 的 error 分支 rect（:106）⇒ `hasThumbnail===true` 且 `error===false`。即 **onLoad 未触发、onError 也未触发**，图片加载卡在"未完成"。

**⇒ 真实断点（确定性）：`SlotImage` 的 `<image> onLoad`（:88-89）未触发 → `loaded` 永 false → 内容 opacity:0 永久不可见。** 属于 F4（缓存/异步结果）类的「图片 onLoad 不触发」具体形态，非旋转/placement 数学、非文件身份。

**与切方向强相关**：`useEffect([slot.thumbnailUrl])(:43-46)` 在 content_rotation 变化时重置 `loaded=false`；新图 onLoad 应回填，但坏态未触发。最可能机制：① 缓存图 load 竞态（SVG `<image>` 经典坑：complete 在 React 挂 onLoad 前就 fire，事件错过）；② `content_rotation=90` 缩略图请求被丢弃/挂起。

**附带观察（次要，opacity 修好后再验）**：坏态 `rotate(270,70.03,104.95)` 旋转中心 cx/cy 与正常态 DIAG-13 `rotate(0,104.95,70.03)` 反序；rotationDeg=0 时中心无关，270° 时关键。需验证旋转后内容是否仍落纸内，但非"完全消失"主因（opacity:0 已解释）。

**最后确认（零改码）**：① Console 搜 `[DIAG-15 thumb natural]`（:91 onLoad 触发）—消失图若无此日志⇒onLoad 确未触发；② Network 看 `?content_rotation=90` 请求状态（200/404/500/pending）区分前后端；③ 正常页（rotationDeg=0 内容可见）是否有 DIAG-15 对比。

**修复方向（授权后单独立 commit，不碰 M1/Pass5-6/Resolver）**：`SlotImage` 对 onLoad 不触发健壮化——重置 useEffect 内查 `imgRef.current.complete`，若已 complete 且 naturalWidth>0 立即 setLoaded(true)；或 ref 手动挂 load 监听替代 JSX onLoad。仅改 SlotImage 组件。

---

## 8. 决定性证据：请求从未发出（推翻"缓存 load 竞态"假设）

### 8.1 用户复现后补充观测（2026-08-09 二次回归）

在「快速切页 / 切纸张方向」后查看坏态页面：

- **完全没有 `[DIAG-15 thumb natural]` 日志** → `onLoad`（:88-89）确未触发。
- **Network 面板里完全没有 `?content_rotation=90` 那条请求** → 浏览器**根本没发出这个 URL 的 HTTP 请求**。

结合上一轮已确认的 DOM（`PrintPreviewCanvas.jsx:77-97` 渲染段）：

```html
<image href="http://localhost:5000/thumbnail/3e5426e6f34e08b824b3afb5?page=1&content_rotation=90"
       ... style="opacity: 0; transition: opacity 0.2s ease-in;"></image>
<rect ... fill="var(--accent-soft)" fill-opacity="0.3"></rect>
```

### 8.2 反推（每条假设被证据裁决）

| 假设 | 状态 | 证据 |
|---|---|---|
| F2-revised：缺 docId → thumbnailUrl null | ❌ 推翻 | DOM 中 href 含有效 docId，thumbnailUrl 非空 |
| F3：退化 transform（scale=0/NaN） | ❌ 排除 | DIAG-13 scale=1.387 非退化 |
| F1：dims 异步不同步 | ❌ 排除 | 无 `[usePrint dims loaded]`，是稳定态非瞬时态 |
| **"缓存 load 竞态"（onLoad 在 React 挂 handler 前就 fire）** | ❌ **推翻** | 若如此，Network 至少会有该 URL 的请求（可能 from cache）；但**完全没有请求** |
| **F4 细化：`<image>` 节点被 React 复用、仅 `href` 属性变化、Chromium 未重新发起 fetch** | 🔴 **确定** | `<image>` 在 DOM 中且 href 正确，但**请求从未发出 + onLoad 未触发** |

### 8.3 确定性根因

> **快速切方向时，`slot.thumbnailUrl` 变化（content_rotation 0→90），但 React 复用同一个 SVG `<image>` DOM 节点，只改其 `href` 属性。Chromium 在「已有 `<image>` 节点、仅 `href` 变化」时**不可靠地重新发起网络请求**——本坏态下干脆**完全不发起请求**。于是：**
> - 没有 Network 请求 → `onLoad` 永不触发 → `loaded` 永 false → `opacity: 0`；
> - 纸张 / 安全边距 / 槽位边框不依赖 `<image>`，照常渲染 → 正是「只剩纸和边距」。

这是教科书级的 **React + SVG `<image>` reconciliation bug**：第一次**全新挂载** content_rotation=90 的页（非切换）通常正常，因为是新节点、新 href、会 fetch；而**从已加载页快速切到另一旋转态**时节点被复用、href 原地改、fetch 不重发 → 卡死。完美解释"切方向后消失"的触发条件。

### 8.4 修复方案（仍待授权，单独立 commit，不碰 M1）

**核心思路：让每次 thumbnailUrl 变化都对应一个"全新 `<image>` 节点"或"可靠的 load 检测"，强制重发 fetch。**

**修复 A（最小、直击根因）**：给两处 `<image>`（:77 的 `t` 分支、:119 的 fallback 分支）加 `key={slot.thumbnailUrl}`。
- 机制：key 变化 → React **卸载旧 `<image>`、挂载新 `<image>`**（新节点 + 新 href）→ Chromium 必发新请求 → `onLoad` 必触发 → `loaded=true`。
- 直接消除「复用节点 + href 原地改 + 不重发 fetch」这一病根。

**修复 B（纵深防御，建议与 A 同做）**：不独依赖 JSX `onLoad`。加 `ref` + `useEffect` 兜底：
```jsx
const imgRef = useRef(null)
useEffect(() => {
  setLoaded(false); setError(false)
  const el = imgRef.current
  if (el && el.complete && el.naturalWidth > 0) {
    setLoaded(true)  // 瞬时缓存命中等 onLoad 已"错过"的情况兜底
  }
}, [slot.thumbnailUrl])
// <image ref={imgRef} ... />
```
- 覆盖"A 之外"的边界：若某环境即便新节点也出现 onLoad 早于 React handler 的竞态，B 仍能补上。

**不做的范围**：不动 RotationResolver / placement 数学 / M1 Pass 5-6 / Resolver；不动后端（修复后若后端对 content_rotation=90 返回异常，会表现为 onError 控制台告警，届时再单独排查，与本次前端根因无关）。

### 8.5 修复后的验证

1. 修复 A+B 后复现快速切方向：坏态页应出现 `[DIAG-15 thumb natural]` 且 Network 出现 `?content_rotation=90` 的 200 请求，内容可见。
2. 若仍无 DIAG-15 但 Network 有 200 → 说明是 onError（后端问题），看控制台 `[PrintPreviewCanvas] 缩略图加载失败`。
3. 旋转几何（8.4 提到的 rotate 中心 cx/cy）待内容可见后单独验证是否落纸内。
