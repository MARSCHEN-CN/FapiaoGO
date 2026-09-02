# PERF-WHITE-1 1B — 复跑方案（真实 261 张，用户批准 2026-09-02）

> 目标：补上 run-261 缺的那一刀证据 —— **区分「预览没触发 / 很晚才触发 / 开始但没画完 / 其实画完了」**。
> 手段：观察窗 6s→15s + 新增 `previewRenderStart` / `previewRenderEnd` 锚点（canvas 渲染路径）。
> 纪律：纯取证 patch，A①② 冻结未动，③ 只读审计未删任何日志。

## 本轮代码变更（提交后以 commit 记录为准）

| 文件 | 变更 |
|------|------|
| `frontend/src/perf/importPerfProbe.js` | T4 重置清单扩为 5 项（+previewRenderStart/End，均留档 *_pre）；derived 新增 `previewStartAfterDismissMs` / `previewEndAfterDismissMs` / `previewWorkMs` / `previewStartedBeforeDismiss`；missingMarks 扩到 T7+两个预览锚点；summaryText 新增 A/B/C/D 判定行 |
| `frontend/src/hooks/useFileOps.js:1138` | 结算观察窗 6s→15s，finishReason `T5+6000ms`→`T5+15000ms` |
| `frontend/src/hooks/usePreview.js:888-891,1013` | `renderToCanvas` 进入即 mark `previewRenderStart` + count `previewRenderAttempts`；成功路径 mark `previewRenderEnd` + count `previewRenderCompleted` |
| `frontend/src/hooks/usePreview.js`（其余） | 无改动（未改渲染时序/弹窗行为） |
| `frontend/test/perfProbe.test.mjs` | +3 用例（T4 留档 / D 完成 / C 未完成），15/15 全绿 |
| `outputs/perf-white1-median.mjs` | 聚合表 +3 判据字段 |

## 判读规则（新报告到手后按此分类）

| 情形 | 判据（相对 T5） | 结论 |
|------|----------------|------|
| **A 未触发** | `previewRenderStart` 缺失 | 预览根本没尝试 → 白屏与渲染无关，查自动预览触发/RE 路径占用 |
| **B 很晚才触发** | start 存在但 T5+N ms 很大 | 触发时机是问题（自动预览调度/等待） |
| **C 开始但没画完** | start 有、end 缺失/很晚（观察窗内） | 渲染慢/卡/被取消 → 主线程长任务阻塞方向 |
| **D 其实画完了** | start/end 齐备且 end 较早 | 渲染本身完成 → 白屏另有其处（commit→paint / 占位缺失） |

辅助判据：`previewRenderAttempts` vs `previewRenderCompleted`（计数差值 = 被取消/未完成的尝试数）；
`previewStartedBeforeDismiss`（true=100% 前有渲染过、false=100% 后才开始、null=全程无渲染）。

## 复跑步骤（PS 5.1 单行，勿改分隔符）

### 0. 为什么先要「重置导入历史」再跑
后端按**发票号**累计 `importCount`（`E:\print706\database\invoice_import_history.json`），run-261 后这批号码
已是 count=1。**不重置直接再导 → count=2 → 触发前端热路径**（importHistoryWrite 全量重排），
与 run-261 的冷路径不是一回事，对比会失真。重置用**改名**（可逆），不用删除。

### 1. 停后端（必须先停，进程 atexit 会把内存历史写回文件，停了再改名才有效）
在后端黑窗口按 `Ctrl+C`。确认 5000 端口无残留：

```powershell
Get-NetTCPConnection -LocalPort 5000 -ErrorAction SilentlyContinue | Format-Table -AutoSize
```

### 2. 给导入历史改名（可逆备份）
```powershell
Rename-Item E:\print706\database\invoice_import_history.json invoice_import_history.json.bak-1B -Force
```
> 之后想还原：把 `.bak-1B` 改回原名即可。此文件只记「某发票号导入过几次」，无其他业务价值。

### 3. 起三件套（三个独立窗口，各敲各的）
```powershell
cd E:\print706; backend\venv\Scripts\python.exe backend\app.py
```
```powershell
cd E:\print706\frontend; npm run dev
```
```powershell
cd E:\print706; npm start
```

### 4. 开工自检（应看到「全部就绪」+ EXIT 0）
```powershell
cd E:\print706; node outputs/perf-white1-preflight.mjs
```

### 5. 确认探针仍是 clipboard 模式（重启后 origin 不变应还在；变了就重设）
应用内按 F12 → Console：
```js
localStorage.getItem('FAPIAOGO_PERF_PROBE')   // 期望 'clipboard'
```
若返回 null：
```js
localStorage.setItem('FAPIAOGO_PERF_PROBE','clipboard'); location.reload()
```

### 6. 导入同一批 261 张真实发票
- 应用刚重启、列表为空时导入（绝对路径去重按会话内列表，同会话二次导入会被整体跳过）
- ⚠️ 已知差异（诚实声明）：`database/invoices.json` 已含 run-261 的这批文档（17:35 写入），
  本轮是「DB 已有文档 + 首次计数」的再导入。后端按发票号组装合并时路径应与 run-261 相当；
  判读时会用计数器交叉校验（期望 `importHistoryWrite=0`、`invoiceDocumentToRow` 量级相近）。
  若偏差大到影响 A/B/C/D 判定，再考虑「连同 invoices.json 一起备份改名后空库复跑」（需你单独批准，涉及真实数据）。

### 7. 取数（等弹窗关后 ≥20 秒——结算点在 T5+15s）
clipboard 模式会在结算时自动写入剪贴板，直接来聊天框 `Ctrl+V` 把 JSON 贴给我；
若剪贴板空，F12 → Console：
```js
copy(JSON.stringify(__perfProbe.getReport(), null, 2))
```
再粘贴。

**新报告预期看到的签名**（与 run-261 的分界）：
- `finishReason: "T5+15000ms"`（旧报告是 `T5+6000ms`）
- 报告出现 `previewRenderStart` / `previewRenderEnd` / `previewStartedBeforeDismiss` 字段
- counters 出现 `previewRenderAttempts` / `previewRenderCompleted`

## 新旧对比交付
跑完把报告贴来，我会产出对比文档（run-261 vs run-261-1B）：
- 时间线并排（T0–T7 + 新锚点）
- A/B/C/D 判定 + 是否推翻/坐实「白屏=预览窗口」假设
- 计数器变化（importHistoryWrite、invoiceDocumentToRow、previewRenderAttempts/Completed）
- 下一步建议（进 A①② / 只做 A1 / 继续取证）
