# PERF-WHITE-1 取证复核报告（run-261 真实数据）

> 日期：2026-09-02 ｜ 性质：对用户首份真实 PERF 报告（261 张真实发票）的代码级复核
> 纪律：先取证，不猜。每条结论标注【已证实】/【推断】/【无法推出】，并附数据或代码出处。
> 原始报告存档：`outputs/perf-runs/run-261-user-raw.json`（逐字节保存用户粘贴内容）

---

## 1. 取证文件清单

| 证据 | 路径 | 用途 |
|---|---|---|
| 原始 PERF 报告 | `outputs/perf-runs/run-261-user-raw.json` | 本报告全部数据来源（已用聚合器验证可解析，EXIT 0） |
| 探针实现 | `frontend/src/perf/importPerfProbe.js` | 锚点/结算/留档语义的唯一权威 |
| 埋点位置 | `frontend/src/hooks/useFileOps.js` | T0/T1/T2/T3/T4/T5 的触发点 |
| 列表 commit 锚点 | `frontend/src/components/FileList.jsx` | T6/T6p 的触发点 |
| 预览首帧锚点 | `frontend/src/hooks/usePreview.js` | T7 的触发点 + 自动预览逻辑 |
| modal 显示条件 | `frontend/src/App.jsx` | modal 何时可见 |
| importHistory 查询 | `frontend/src/contexts/FileContext.jsx` | 561 条目计数语义 |
| 渲染路径 console.log | `frontend/src/utils/invoiceDocumentViewModel.js` | 556 次计数来源 |

---

## 2. 时间线核对表（T0–T7）

锚点语义以 `importPerfProbe.js:15-31` 注释与埋点位置为准。

| 锚点 | 定义（代码出处） | 实测（相对 T0, ms） | 自洽性 |
|---|---|---|---|
| T0 | 导入开始（`useFileOps.js:322` startSession → `importPerfProbe.js:82`） | 0 | ✓ |
| T1 | split 完成（`useFileOps.js:595`） | 19669.3 | ✓ |
| T2 | 后端解析完成（`useFileOps.js:1094`） | 65032.4 | ✓ |
| T3 | hydration 完成（`useFileOps.js:1101`） | 65032.4 | 与 T2 同毫秒（同一同步块，见 §4） |
| T4 | 进度 100%（`useFileOps.js:1111`） | 65032.4 | 同上 |
| T5 | 弹窗关闭（`useFileOps.js:1136`，dismissModal） | 65308.1 | ✓ T4→T5 = 275.7ms，与代码 doubleRAF+250ms 吻合 |
| T6 | FileList 首次 commit（`FileList.jsx:264`，T4 之后） | **缺失** | 见 §4 |
| T6p | commit 后首次 paint（`FileList.jsx:266`） | 65037.5 | 见 §4（T4+5.1ms） |
| T7 | 预览首帧（`usePreview.js:1013`，T4 之后） | **缺失** | 见 §4 |
| T6_pre | T4 留档（`importPerfProbe.js:113-116`） | 23.6 | T4 前最早一次 commit |
| T6p_pre | 同上 | 344.0 | 其后某次 commit 的 paint |
| T7_pre | 同上 | 1363.2 | 归属存疑（§4.6） |

派生值：splitMs=19669.3 ｜ parseMs=45363.1 ｜ dismissDelayMs=275.7 ｜ whiteScreenMs=**null** ｜ whiteToPaintMs=**−270.6** ｜ firstCommitMs=23.6 ｜ commitVsDismissMs=−65284.5 ｜ listReadyBeforeDismiss=**true** ｜ missingMarks=[**"T6"**]

---

## 3. 探针机制事实（代码级，先钉死语义）

1. **mark() 是 first-wins**：`importPerfProbe.js:104` `if (session.marks[name] !== undefined) return` —— 同一锚点重复调用不覆盖。
2. **T4 留档 + 删除**：`importPerfProbe.js:107-117` —— mark('T4') 时把 T6/T6p/T7 现值存为 `*_pre` 再 delete。
3. **missingMarks 只查 7 个锚点**：`importPerfProbe.js:227-228` `['T0'..'T6']` —— **不含 T7/T6p**。因此 `missingMarks=["T6"]` **不能**推出"T7 存在"；T7 实际也缺失（marksRel 中无 T7）。
4. **T6/T6p 只在 FileList 打**：`FileList.jsx:262-269`，`useLayoutEffect` deps=[files]，`files` 为空时直接 return。
5. **T7 只在 setPreviewCanvas 前打**：`usePreview.js:1013`。
6. **单会话**：`importPerfProbe.js:69` startSession 会先结算旧会话；报告 `id:1` 说明**页面生命周期内只开过一次会话** → 排除"多次导入整包数据混叠"。
7. **longTask 与 marks 同时间基准**（performance.now 绝对时间，`importPerfProbe.js:56,174`），可互相换算。

---

## 4. 关键推演（数据自洽性）

### 4.1 T0 绝对时间 ≈ 121,641ms ——【推断，可信度高】
`whiteWindow.from = marks.T4 绝对值 = 186,673.8`（`importPerfProbe.js:239-250`，r1 保留 1 位）。T4 相对 T0 = 65,032.4 → **T0(performance.now) ≈ 186,673.8 − 65,032.4 = 121,641.4ms**。

### 4.2 112 个长任务全部落在本次导入窗口内 ——【已证实（以此换算）】
top10 的 start ∈ [130,320.6, 185,842.5] → 相对 T0 为 [+8.7s, +64.2s]，全部落在 T0（导入开始）与 T4（65.0s）之间。
→ **本次导入期间主线程确实被 112 个 longtask 阻塞共 16.13s**，不是旧会话残留。
→ 结合 T1=19.7s / parse=45.4s：阻塞横跨 split 尾段与整个 parse 段。

### 4.3 T6_pre=23.6ms 与 T6p_pre=344ms 的自洽解释 ——【推断】
- T0+23.6ms 有一次非空 files commit（占位列表）→ mark('T6')=23.6。
- 之后 116 次 setFiles（`FileContext.jsx:61` 计数）产生多次 commit，但 first-wins 使 marks.T6 停在最早一次 23.6。
- T6p_pre=344：某次 commit 的 paint 链（rAF→setTimeout(0)）被主线程繁忙推迟约 320ms 后才执行 → 佐证**导入早期主线程已繁忙**。
- 该解释与 first-wins + 大量 setFiles 的事实一致，但"23.6ms 那次 commit 是否为占位列表"无法从本数据直接证实。

### 4.4 T6 缺失 = T4 之后 files 引用未再变化 ——【推断，与全部数据自洽】
- T4(65032.4) delete T6 后，T6p=65037.5 被写入（T4+5.1ms）。
- T6p 只可能由 FileList 的 paint 链写入（§3.4），即 T4 前最后一次 files commit 的 rAF 回调延迟到 T4 之后执行 → 写 T6p 成功（当时 T6p 已被 delete）。
- 而那次 commit 的 layout effect 在 T4 **之前**执行（mark('T6') 被 first-wins 挡，未留下 T4 后的 T6）→ **T4 后没有任何新的 files commit**。
- 含义：**列表最后一次 paint（65037.5）早于弹窗关闭（65308.1）约 270ms**（whiteToPaintMs=−270.6 印证）；T6 缺失是"T4 后列表没再变过"，**不是"列表一直没画出来"**。

### 4.5 T7 缺失 = 观察窗（T5+6000ms，到 T0+71.3s）内无预览首帧 ——【已证实】
T7 只在预览渲染完成时打（§3.5）。本报告 marksRel 无 T7 → **弹窗关闭后 6 秒内，没有任何一次预览渲染走到 setPreviewCanvas**。
注意：这只能证明"6 秒内没到"，**不能**证明"预览最终没出来"或"用户盯的空白就是预览区"（结算后未观测）。

### 4.6 无法自洽项（诚实列出）
| 疑点 | 说明 |
|---|---|
| T7_pre=1363.2 归属 | T0+1.36s 处于 split 阶段（T1=19.7s），此时不可能有解析结果可供预览。该值来源不明——可能与导入前页面已有文件/前次预览有关，但 id:1 单会话使此解释也不完整。**本数据无法推出，需要复测或代码加探针。** |
| T6_pre=23.6 的具体 commit 内容 | 占位列表 vs 其他，无法从数据区分。 |
| T6p=65037.5 对应哪次 commit | 推演为"T4 前最后一次 commit 的延迟 paint"，与全部数据自洽但非直接可证。 |

---

## 5. 三件事的区分（用户要求第 3 点）

| 事件 | 代码锚点 | 本 run 实测 | 结论 |
|---|---|---|---|
| ① 列表首次 commit | T6（FileList layout effect） | 最早 T0+23.6ms（T6_pre），此后多次 commit，**最迟一次 paint 在 T4+5.1ms** | 列表在弹窗关闭前已渲染完成 |
| ② 弹窗关闭 | T5（dismissModal） | T4+275.7ms | 硬编码 doubleRAF+250ms（§6），不等待任何"渲染完成"信号 |
| ③ 预览首帧 | T7（setPreviewCanvas） | 观察窗内未到达 | 弹窗关闭后 6s 内预览未就绪 |

→ 三者关系：**①早于②（约 270ms），③晚于②（>6s 或未发生）**。用户感知的"白屏等待 + 没提示"落在 ②→③ 之间。

---

## 6. "250ms 关闭"代码原文（用户要求第 4 点）

`frontend/src/hooks/useFileOps.js:1125-1157`（导入完成收尾）：

```js
// 按文件数动态调整关闭策略：
// - 少量文件（≤5）：单 rAF + 0ms 延迟
// - 中等批量（6-50）：双 rAF + 100ms 延迟
// - 大批量（>50）：双 rAF + 250ms 延迟（缩略图/预览区需要更多时间绘制）
const fileCount = acceptedFiles.length
const useDoubleRAF = fileCount > 5
const dismissDelay = fileCount > 50 ? 250 : (fileCount > 5 ? 100 : 0)

const dismissModal = () => {
  completeDismissTimerRef.current = null
  currentAbortRef.current = null
  perfProbe.mark('T5')   // 弹窗关闭 = 白屏窗口计时开始
  setTimeout(() => perfProbe.finishSession('T5+6000ms'), 6000)
  setParsing(false)
  setParseProgress({ current: 0, total: 0 })
  setImporting(false)
}
// double rAF 后 setTimeout(dismissModal, 250)
```

确认事实：
- **250ms 是写死的经验值**，依据只有文件数阈值，**不检查列表是否 commit、预览是否出帧**。
- modal 可见性 = `Boolean(importing || parsing) && !reimporting`（`App.jsx:1310`）；dismissModal 同时 `setParsing(false)+setImporting(false)` → modal 消失时刻 = T5。
- 实测 T4→T5 = 275.7ms ≈ double rAF（约 2 帧 ~32ms）+ 250ms + 调度余量 → **与代码完全吻合**。

---

## 7. 分级结论

### ✅ 已证实（数据 + 代码双证）

1. **弹窗关闭时机是硬编码时序，不等待任何渲染/预览完成信号。**
   证据：`useFileOps.js:1129-1131`（250ms 写死）；实测 275.7ms 与代码吻合；无任何"就绪检查"。
2. **"弹窗关闭后的白屏"不是列表渲染问题。**
   证据：列表最迟 paint（T6p=65037.5）早于弹窗关闭（T5=65308.1）约 **270ms**；T4 后 files 无新 commit（T6 缺失 + first-wins 语义）；探针自带判据 `listReadyBeforeDismiss=true`。
3. **导入窗口（约 65s）内主线程被 112 个 longtask 阻塞共 16.13s。**
   证据：longtask 绝对时间全部落在 [T0, T4]（§4.2），与 T4 反推的 T0 基准自洽。
4. **渲染路径存在每文档 console.log（A1 目标），本 run 计数 556 次 / 561 行。**
   证据：`invoiceDocumentViewModel.js:116-125`（注释自认"位于渲染期派生路径…删除属 Gate 1 (A1) 范围"）。
5. **T5 后 6 秒观察窗内无预览首帧。**
   证据：T7 缺失（§4.5），自动预览逻辑存在（`usePreview.js:2063-2067`：`!previewFile && files.length>0` → 预览 files[0]）。
6. **importHistory 热路径（写回 + 全量重排）本 run 未激活。**
   证据：counters **无 `importHistoryWrite` 键** → 该计数从未触发；`FileContext.jsx:264` 仅 `importCount>=2` 才写回。本批发票在本机 importCount<2（首次导入）→ **最初诊断中"每批回包触发全量重排"的网络尾巴，在本 run 没有发生**。561 仅是累计查询条目数（分批、并发 6，`FileContext.jsx:256-257`），**不是 561 次串行 HTTP**（修正此前表述）。

### 🔶 高度怀疑（方向合理，证据不足）

1. **用户看到的"白屏等待"= 弹窗关闭后、预览首帧真正上屏前的窗口**，即 ②→③ 之间。
   支撑：①早于②、③未在 6s 内到达（§5）；但"用户注视区域 = 预览区"未直接证实。
2. **预览首帧延迟与主线程长任务 16s / 渲染路径 console.log / importHistory 回包处理叠加有关。**
   支撑：三者均为本 run 已证实事实；但**没有分段计时证明因果**（预览渲染自身耗时未埋点）。
3. **"没提示在加载" = ②→③ 窗口内缺少用户可感知的加载指示。**
   支撑：预览 loading 有 UI（`PreviewCanvas.jsx:100,143`），但 previewLoading 何时置 true、是否覆盖用户注视区域、modal 关闭瞬间其状态均未取证。

### ⛔ 不能从这份数据推出

1. **T0→T1 split 19.7s 的内部构成**（该段无子探针；占位/读文件/分组耗时未知）。
2. **预览"最终"何时出现**（结算窗 T5+6s 截断，之后未观测）。
3. **"白屏"区域到底是列表区 / 预览区 / 整窗**（需要用户目视描述或截图）。
4. **556 次 console.log 与 16.13s 长任务的定量关系**（计数 ≠ 耗时）。
5. **T7_pre=1363.2 的归属**（§4.6）。
6. **导入前应用状态**（列表是否为空、previewFile 是否已设）——它决定自动预览是否会被触发（`usePreview.js:2064` 要求 `!previewFile`）。若导入前已有预览对象，本次 261 张根本不会自动预览 → T7 缺失可能是"没触发"而非"没完成"，两者在本数据中不可区分。

---

## 8. 是否进入 A 修复（建议）

**结论：可以进，但要拆开进，且补一次 30 秒的目视取证。**

| A 的子项 | 证据强度 | 建议 |
|---|---|---|
| A2-① 弹窗改"等列表 commit + 预览首帧（或最长 ~3s 超时）再关" | 已证实缺陷 #1 + #2 | ✅ 可做，直击"250ms 拍脑袋关闭" |
| A2-② modal 关闭后、预览首帧前给主区加载占位 | 已证实缺陷 #5 + 高度怀疑 #3 | ✅ 可做，直击"没提示在加载" |
| A1 删除渲染路径 console.log | 已证实 #4 | ✅ 可做（收益 = 长任务/主线程释放，A 后复测验证） |

**进 A 前必须补的取证（二选一）：**
- 你目视回答 3 个问题（modal 关闭瞬间你盯的区域是什么；那块区域空白多久才出内容；期间有没有任何转圈/"加载中"字样）；或
- 我先把 T7 观察窗从 6s 延长到 ~15s 并加"预览渲染开始/结束"两个子锚点，你再导一次同一批 261 张（不需要换数据集，因为首次导入已确认无热路径污染）。

**不建议**：把本 run 当"白屏时长"的定量基线直接用于 Gate 决策——观察窗 6s 截断 + split 段无子探针 + 导入前状态未知，定量结论不成立；本报告的价值在**定性归因**（列表渲染出局、modal 关闭时机出局后可修、预览链路嫌疑上升）。
