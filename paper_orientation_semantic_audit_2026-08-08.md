# Paper Orientation Semantic Audit（P0）— 2026-08-08

> 结论先行：**你的怀疑成立，而且比你想的更严重。**
> 不只是「语义反了」——是三个独立缺陷叠加：
> ① 横向纸型下 UI 方向与实际几何**恒相反**；
> ② 同一个 `paperOrientation` 参数在 Resolver 内同时承载两种互相矛盾的语义；
> ③ source 直通打印路径下，**UI 纸张方向根本没有传给 Sumatra**。
>
> 已按你的要求：**未改 RotationResolver、未加横纸规则、未动缓存。** 本文只钉语义。

---

## 0. 数值证据（可复跑）

```bash
node scripts/audit-paper-orientation.mjs     # 前端 Preview 链
node scripts/audit-sumatra-orientation.js    # Electron → Sumatra 链
```

### 探针 1 — UI orientation vs 实际纸张几何

| 票型 | 纸型 | UI 选择 | 下游纸张几何(mm) | 实际形状 | 一致? | layoutRot | scale |
|---|---|---|---|---|---|---|---|
| 横票 | A4 | portrait | 209.97×297.01 | portrait | OK | -90 | 1.386 |
| 横票 | A4 | landscape | 297.01×209.97 | landscape | OK | 0 | 1.386 |
| 横票 | Voucher240x140 | portrait | **240.03×140.04** | **landscape** | **反了** | -90 | **0.639** |
| 横票 | Voucher240x140 | landscape | **140.04×240.03** | **portrait** | **反了** | 0 | **0.639** |
| 竖票 | Voucher240x140 | portrait | **240.03×140.04** | **landscape** | **反了** | 0 | **0.559** |
| 竖票 | Voucher240x140 | landscape | **140.04×240.03** | **portrait** | **反了** | -90 | **0.559** |

**A4 全对，凭证纸全反。** 你观察到的物理现象被 1:1 复现：

```
actualPhysicalPaperOrientation = inverse(UI paperOrientation)
                                 ↑ 仅当纸型几何本身是横向时成立
```

### 探针 2 — UI orientation 传到 Sumatra 了吗？

| 纸型 | UI 选择 | 传给 Sumatra 的 paperOrientation | baseFlag | rotate |
|---|---|---|---|---|
| A4 | portrait | portrait | landscape | 0 |
| A4 | landscape | **portrait** | landscape | 0 |
| Voucher240x140 | portrait | landscape | landscape | 90 |
| Voucher240x140 | landscape | **landscape** | landscape | 90 |

**同一纸型下，UI 选 portrait 和 landscape，送给 Sumatra 的参数逐字节相同。**
回答你 Step 3 的问题：这条链上根本不存在「UI portrait → Sumatra landscape」的反转——
**UI 的值压根没进入这条链。**

---

## 🔴 BLOCKER-1 — `isLandscape ? swap : keep` 硬编码了「基础纸型恒为竖向」

**位置**
- `frontend/src/print/PrintPreviewModel.js:185-186`（预览纸面尺寸）
- `frontend/src/print/PrintPreviewModel.js:227-228`（送进 Resolver 的 paperSize）
- `frontend/src/print/PrintPreviewModel.js:154-158`（`landUsable` 票位可用区）
- `frontend/src/layout/RenderLayoutFactory.js:178, 204, 216`（Canvas 打印链，同构）
- `electron/main.js:466-470`（Canvas→PDF MediaBox，同构）

```js
// PrintPreviewModel.js:185
const isLandscape = page.orientation === 'landscape'
const widthMM  = (isLandscape ? layout.paperRect.h : layout.paperRect.w) * PX_TO_MM
const heightMM = (isLandscape ? layout.paperRect.w : layout.paperRect.h) * PX_TO_MM
```

**Why**
这段代码的隐含前提是 `paperRect` 恒满足 `w < h`。该前提对 A4(210×297)/A5(148×210)/A3(297×420)/Letter 成立，
对 `Voucher240x140` (**240×140，w > h**) 不成立。于是：

| paperRect 原生形状 | UI=portrait | UI=landscape |
|---|---|---|
| 竖向（A4） | 不 swap → 竖 ✅ | swap → 横 ✅ |
| **横向（凭证纸）** | 不 swap → **横 ❌** | swap → **竖 ❌** |

这就是你说的「横向纸张类型」现象的**唯一根因**，且它同时污染三条链（Preview / Canvas 打印 / PDF MediaBox）。

**Suggestion（不要现在改，先钉语义）**
swap 的判据不是「用户选了什么」，而是「用户想要的方向 vs 纸张原生形状是否一致」：

```js
const nativeIsLandscape = paperRect.w > paperRect.h
const wantLandscape     = requestedPaperOrientation === 'landscape'
const needSwap          = wantLandscape !== nativeIsLandscape
```

这一个表达式同时修好 A4 与凭证纸，且对未来任意横向纸型自动正确。

---

## 🔴 BLOCKER-2 — `paperOrientation` 一个字段承载两种矛盾语义

**位置** `frontend/src/print/PrintPreviewModel.js:234-246` → `frontend/src/layout/RotationResolver.js:210-232`

```js
resolveContentPlacement({
  paperSize:        { widthMM: paperW_mm, heightMM: paperH_mm },  // ← 已 swap 的「几何」
  paperOrientation: page.orientation,                              // ← 未 swap 的「UI 标签」
  ...
})
```

Resolver 内部：

```js
// L210 —— 有入参就用 UI 标签，没有才从几何推
const paperOrientation = paperOrientInput || detectPaperOrientation(paperSize)
// L211-212 —— 但画布/可用区/scale 全部走几何
const paperW = roundPx(paperSize.widthMM * pxPerMm)
const paperH = roundPx(paperSize.heightMM * pxPerMm)
// L223 —— 旋转决策走 UI 标签
const layoutRotation = computeLayoutRotation(contentOrientation, paperOrientation)
```

**Why**
`detectPaperOrientation(paperSize)` 与 `paperOrientInput` 在 A4 下恒相等，在凭证纸下**恒相反**。
所以 **旋转决策站在 UI 坐标系，几何度量站在物理坐标系** —— 两者互相矛盾。

这正是你说的「旋转对了但尺寸变形」「怎么修都只是把错误挪到另一个 case」的**机制性解释**：
Resolver 内部就是分裂的，任何单点补丁都只能对齐一半。

量化损失（探针数据）：

```
横票 + 凭证纸，正确 layoutRotation=0  → scale = min(234/210, 134/99)  = 1.114（撑满）
系统实际 layoutRotation=-90           → scale = min(234/99,  134/210) = 0.639（缩到 57%，横躺）
                                        ↑ 1.74× 的尺寸偏差
```

**Suggestion**
`resolveContentPlacement` 应当**只接受一个已归一化的物理纸张**，禁止同时接受几何和标签：

```js
resolveContentPlacement({
  contentPhysicalSize,
  contentRotation,
  physicalPaper: { widthMM, heightMM },   // 已按 requested orientation 归一化
  // ❌ 删掉 paperOrientation 入参 —— 方向必须从 physicalPaper 推导，不可外部覆写
})
```
即：把「方向」降级为几何的**派生属性**，而不是一个可被独立传入、可能与几何冲突的自由变量。
非法状态不可表示——这与 `resolvePaper.js` 顶部那段 CONTRACT 是同一条纪律。

---

## 🔴 BLOCKER-3 — source 直通路径：UI 纸张方向被完全丢弃

**位置**
- `frontend/src/services/PrintService.js:62-83` — `buildPrintSettings()` 返回对象里**没有** `landscape` / `paperOrientation` 字段
- `electron/print-service/print-backend.js:127-132`
- `electron/print-service/OsLauncherBridge.js:262-263`
- `electron/print-service/print-settings.js:71-92` — `getPaperOrientation(paperId, customPaper)`

```js
// print-backend.js:129 —— 唯一一处决定送给 Sumatra 的 paperOrientation
normalizedSettings.paperOrientation = getPaperOrientation(
  normalizedSettings.paper,          // 纸型 ID
  normalizedSettings.customPaper     // 自定义宽高
);                                   // ⚠️ 没有任何 UI orientation 入参
```

**Why**
`getPaperOrientation` 是**纯几何函数**：查 `LANDSCAPE_PAPERS` 白名单 or 比 `customPaper` 宽高比。
用户在 UI 上选的方向从未进入这个函数，也从未出现在 `settings` 里（前端就没塞）。

**后果**：在 source 直通路径（单文件 PDF/图片打印，最常用的路径）下，
**「纸张方向」下拉框是一个纯装饰控件——它只改变预览（而且预览还是反的），对实际打印零影响。**

这解释了你的两个现象：
- 「改 orientation 有时看着完全没用」→ 因为对 source 路径确实没用
- 「单页/多页表现不同」→ 见 SUGGEST-1，两条路径行为分叉

**Suggestion**
`requestedPaperOrientation` 必须作为**一等字段**贯穿 `PrintSettings → PrintSpec → Sumatra`：
`getPaperOrientation()` 应当重命名为 `getPaperShapeOrientation()`（它算的确实是形状），
再新增一层 `resolvePhysicalPaperOrientation(shapeOrientation, requestedOrientation)`。

---

## 🟡 SUGGEST-1 — 两条打印路径的方向语义已经分叉

| | source 直通（Sumatra） | canvas 合并（PNG→PDF） |
|---|---|---|
| UI orientation 是否传下去 | **否**（BLOCKER-3） | 是（`usePrint.js:1172`） |
| 纸张 swap 逻辑 | 无（Sumatra 自己处理） | `main.js:467` 无条件 swap（BLOCKER-1 同构） |
| 净效果 | UI 无效 | UI 有效但横向纸型下反转 |

同一个 UI 开关，在两条路径上一个「无效」一个「反向」。这是 P0 之下最需要收口的架构裂缝。

---

## 🟡 SUGGEST-2 — `ROTATE_LOOKUP` 是在错误语义上拟合出来的经验表

**位置** `electron/print-service/print-settings.js:45-50`

```js
'landscape|landscape': { 0: 90, 90: 180, 180: 270, 270: 0 },
//  ↑ 横内容 + 横纸 → 居然要 rotate=90？几何上无法解释。
```

**Why**
这张表注释写着「经表格验证」，即实测凑出来的。既然它的 `paperOrient` 入参一直是**纸型几何方向**
（BLOCKER-3 已证），那它实际编码的是 `content geometry × paper geometry`，
而 `landscape|landscape → 90` 是典型的「在错误坐标系上抵消上游误差」的产物。

**Suggestion**
**在 BLOCKER-1/2/3 钉死之前，绝对不要碰这张表**——它现在正在抵消上游的错误。
语义修正后必须整表重推，并且新表应当能被几何推导出来，而不是查表。
如果修完仍需要一张不可推导的查找表，说明还有一层语义没钉死。

---

## 💭 NIT-1 — `rotate=` 读错字段

`electron/print-service/print-settings.js:168-173`

```js
const sourceRotation = normalized.sourceRotation ?? normalized.rotation ?? 0
...
if (sourceRotation && sourceRotation !== 0) {
  parts.push(`rotate=${normalized.rotation}`);   // ← 判断用 sourceRotation，取值用 rotation
}
```
调用方若只传 `sourceRotation` 不传 deprecated alias `rotation` → 输出 `rotate=undefined`。
目前 `PrintService.js:67-68` 两个都传所以没暴露，但这是个等着被踩的雷。

## 💭 NIT-2 — 正方形内容方向判定两处相反

- `RotationResolver.js:83` → `w > h ? landscape : portrait`（正方形 → portrait）
- `previewState.js:44` → `w >= h ? landscape : portrait`（正方形 → landscape）

## 💭 NIT-3 — `computeLayoutRotation` 统一返回 -90 的约定不成立

`RotationResolver.js:135-139` 注释称「横内容塞竖纸 / 竖内容塞横纸 同约定」统一 -90。
两种 case 都需要 90° 轴对齐没错，但**符号取决于希望内容顶边朝哪**，统一 -90 意味着其中一种
case 的内容相对另一种是倒置的。你实测「UI 纵向要 +90 / UI 横向要 -90」的另一半来源就在这里。

## 💭 NIT-4 — 纸张表三处重复，且绕过了自称唯一事实来源的 `resolvePaper()`

- `frontend/src/config.js:102` `REGISTRY_DATA`
- `frontend/src/print/PrintPreviewModel.js:65` `PAPER_MM`（内联副本）
- `electron/shared/paper-registry.js:23`

`resolvePaper.js:6-11` 明写：「消费者 MUST NOT 直接由 paperSize / customPaper 推导纸张尺寸」。
而 `PrintPreviewModel.previewPaperLayout()` 正是直接推导的——它是第 3 个决策点。
注释说靠数值锚点测试防漂移，但**测试防的是数值漂移，防不了语义漂移**（本次 BUG 恰恰是语义漂移，
三处数值完全一致却全错）。

## 💭 NIT-5 — 无条件 DIAG 日志进生产

`PrintPreviewModel.js:198, 213, 302, 316` 每 slot 每次 render 都 `console.log`，无 env 守卫。

---

## ✅ 值得肯定

- `resolvePaper.js` 顶部那段 CONTRACT 注释是我在这个项目里看到的最好的架构防御文档——
  它准确预言了本次 bug 的形态（「重新解释输入 = 制造第二个决策点」），可惜 `PrintPreviewModel` 没遵守。
- `RotationResolver.js:240-241` 关于「scale 必须在 fitRotation 之后计算」的顺序约束注释，
  以及 `L246-248` 的 `Number.isFinite` 兜底，都是经验型防御，很扎实。
- `PrintPreviewModel.js:150-158` 拒绝用 `slotToLandscape` 简单轴交换、改为在物理可用区重算的决策是对的，
  注释里把「非对称边距会溢出」的推导写清楚了。**这个思路只差一步**——它已经意识到「margins 属 Paper 坐标」，
  却没意识到「Paper 本身的原生形状也不能假设」。
- `OsLauncherBridge.js` 的 `validateSpec` + comma DSL 守卫是很好的边界防御。

---

## 结论：你的四层模型是对的，但要再明确一件事

你提的分层：

```
Layer 1  Content        → effectiveContentOrientation
Layer 2  Paper Geometry → paperShapeOrientation
Layer 3  User Selection → requestedPaperOrientation
Layer 4  Printer        → physicalPaperOrientation
```

审计后我认为 **Layer 4 不是「打印机做的转换」，而是「Layer 2 + Layer 3 的纯函数合成」**：

```
physicalPaperOrientation = requestedPaperOrientation        // 用户说了算
physicalPaperSize        = needSwap(shape, requested)
                             ? { w: nativeH, h: nativeW }
                             : { w: nativeW, h: nativeH }
```

打印机不会自己反转——**反转是我们在 `isLandscape ? swap : keep` 里自己制造的**（BLOCKER-1），
而 Sumatra 那一层甚至没收到用户的选择（BLOCKER-3）。
所以不需要引入「打印机物理转换层」这个新概念，只需要让 Layer 2 和 Layer 3 正确合成出 Layer 4。

然后布局函数比较：`effectiveContentOrientation` VS **`physicalPaperOrientation`（从 physicalPaperSize 推导，不可外部传入）**。

### 建议的修复顺序（每步一个 commit，一个验证，符合项目 bisect 纪律）

| # | 内容 | 验证 |
|---|---|---|
| 0 | 冻结现状：把 `scripts/audit-*.mjs` 两张表落成快照测试 | 表格逐格锁定 |
| 1 | 命名去歧义：`paperOrientation` → 拆 `paperShapeOrientation` / `requestedPaperOrientation` / `physicalPaperOrientation`，**纯改名不改行为** | 快照表零变化 |
| 2 | 修 BLOCKER-1：三处 swap 统一改 `needSwap` | A4 行不变，Voucher 行「反了」→「OK」 |
| 3 | 修 BLOCKER-2：`resolveContentPlacement` 删 `paperOrientation` 入参，改收 `physicalPaper` | layoutRot / scale 恢复 0 / 1.114 |
| 4 | 修 BLOCKER-3：`requestedPaperOrientation` 打通到 Sumatra | 探针 2 表格出现 UI 分化 |
| 5 | 重推 `ROTATE_LOOKUP` | 真机四象限实测 |

**在第 1 步完成前，不要动 RotationResolver、不要写 `resolvePaperTransform()`、不要清缓存。**
你这个判断是对的——第三层建在错误坐标系上只会再造一层补丁。
