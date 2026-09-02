# PERF-WHITE-1 · 真机基线运行手册（Gate 0 → Gate 1）

> 目标：拿到真实的 `T0–T7` 时间线，算出 **WHITE_SCREEN = T6 − T5**，据此决定 Gate 1 是否值得动 A1。
> 原则：**一次只改一个变量 · DevTools 全程关闭 · 3 runs 取中位数**。

---

## 0. 已经替你准备好的东西（无需你做）

| 项目 | 状态 | 说明 |
|------|------|------|
| 探针代码 | ✅ 已提交并推送 | `05b3164`（远端已确认同步） |
| S-200 数据集 | ✅ 已生成 | `E:\print706\test_fixtures\perf\S-200\`，200 份 PDF / 0.69 MB |
| 数据集发票号唯一性 | ✅ 已校验 | `25952000000127670001` … `…0200`，200 个互不重复 |
| 中位数聚合器 | ✅ 已自测 | `outputs/perf-white1-median.mjs` |

⚠️ **为什么发票号必须唯一**：前端 `importHistory` 是按发票号分组后批量查询的。若 200 份文件号码相同，
`importHistoryQuery` 只会记到 **1 次**，「网络尾巴」这条归因链会被直接证伪（假的证伪）。这一点很容易踩。

> 如果你手上有**真实的 200 张发票**，优先用真实的（更贴近线上）。生成数据仅用于「没有真实数据」时保底。
> 用真实数据的话，把第 2 步的目标目录换成你自己的文件夹即可，其余步骤不变。

### ⚠️ 0.5 两个必须先确认的前提

**① 必须用开发模式启动，不要双击桌面上的 FapiaoGO 图标。**
你安装的生产版（Setup / 绿色版）里**不包含探针代码**——探针是这次新加的，只存在于源码。
跑生产版会得到「开关设了、但一条数据都没有」的结果。**请严格按 1.1 用 `npm start` 启动。**

**② 开工前先关掉正在运行的 FapiaoGO。**
如果生产版已在后台运行，它会占住后端 5000 端口，导致开发模式的后端起不来。
启动前用任务管理器确认没有 `FapiaoGO.exe` / `server.exe` 残留进程。

---

## 1. 一次性准备（只在第一次做）

### 1.1 启动三件套

开发模式下 Electron **不会**自动拉起后端（`electron/main.js:879` 注释明确写了「开发模式：手动启动 python backend/app.py」），
所以必须开 **3 个终端窗口**，按顺序启动：

**终端 ① —— 后端**（Flask，端口 5000）
```bash
cd /e/print706 && backend/venv/Scripts/python.exe backend/app.py
```
等到出现 `Running on http://127.0.0.1:5000` 再继续。

**终端 ② —— 前端**（Vite dev server，端口 5173）
```bash
cd /e/print706/frontend && npm run dev
```
等到出现 `Local: http://localhost:5173/` 再继续。

**终端 ③ —— 客户端**
```bash
cd /e/print706 && npm start
```

三个都起来后，会看到 FapiaoGO 主窗口。

### 1.2 打开探针开关（唯一一次需要开 DevTools）

1. 在 FapiaoGO 窗口里按 **Ctrl + Shift + I**，打开 DevTools
2. 切到 **Console** 标签页，粘贴下面这一行后回车：
   ```js
   localStorage.setItem('FAPIAOGO_PERF_PROBE', 'clipboard')
   ```
   > 用 `'clipboard'` 而不是 `'1'`：结算时报告会**自动写进系统剪贴板**，
   > 后面每次取数只要 `Ctrl + V` 粘贴到记事本，**全程不必再开 DevTools**（DevTools 开着会严重放大 console I/O，测量直接失真）。
3. 再按 **Ctrl + Shift + I** 关闭 DevTools
4. **完全退出 FapiaoGO 并重新启动终端 ③**（`npm start`）

   > 探针开关在模块加载时读取一次，必须重启才生效。localStorage 本身是持久化的，重启不会丢，
   > 所以这个开关**开一次就够**，后面 3 次 run 都不用再碰。

### 1.3 验证开关生效（可选但建议做）

重启后按 **Ctrl + Shift + I**，Console 里执行：
```js
__perfProbe.isEnabled()
```
返回 `true` 即生效。确认后**立刻关掉 DevTools**。

---

## 2. 单次测量流程（一次 run）

> ⚠️ **每次 run 前必须重启应用**。导入按 `absolutePath` 去重（`useFileOps.js:347`），
> 第二次导入同样 200 个文件会被整体判定为重复而跳过，测出来的是空数据。

**步骤：**

1. **重启 FapiaoGO**（关掉窗口 → 终端 ③ 重新 `npm start`）
2. 确认 DevTools **处于关闭状态**（没开过就不用管）
3. 导入：把 `E:\print706\test_fixtures\perf\S-200\` 里的 **200 个 PDF 全选**，拖进 FapiaoGO，或用「选择文件」按钮批量选
4. 盯着进度条，等它走完 → 弹窗自动关闭
5. **弹窗关闭后继续等约 7 秒**（探针在 T5 之后 6000ms 自动结算，见 `useFileOps.js:1138`）
6. 打开记事本，**Ctrl + V** 粘贴 —— 这就是本次 run 的完整报告（JSON）

   如果剪贴板是空的（Electron 权限可能拦截），改用兜底取数：
   按 Ctrl+Shift+I → Console → 执行 `__perfProbe.summaryText()` 复制输出，
   或执行 `copy(localStorage.getItem('FAPIAOGO_PERF_REPORT'))`。
7. 把粘贴出来的内容存成一**行** JSON（见下）

### 数据怎么存

新建一个文件 `E:\print706\outputs\perf-runs-s200.jsonl`（用记事本/VSCode 都行），
**每次 run 的结果占一行**，例如：

```
{"id":1,"label":"import:200","derived":{"whiteScreenMs":1234,...},...}
{"id":2,"label":"import:200","derived":{"whiteScreenMs":1180,...},...}
{"id":3,"label":"import:200","derived":{"whiteScreenMs":1301,...},...}
```

> 关键点：**一行一条完整 JSON，行与行之间换行，不要加逗号、不要加 `[]`**。
> 报告本身是多行美化过的 JSON，存之前需要**压成一行**（VSCode 里可以用「合并行」，
> 或者直接把 `__perfProbe.getReport()` 的结果 `JSON.stringify` 后复制）。

最简单的做法（避免手工压行）：结算后按 Ctrl+Shift+I，Console 执行
```js
copy(JSON.stringify(__perfProbe.getReport()))
```
剪贴板里就是规整的单行 JSON，直接粘贴到文件里。这一步只在取数时开一下 DevTools，
发生在测量窗口之外（T5+6s 之后），**不影响测量精度**。

---

## 3. 跑满 3 次

把第 2 节完整重复 **3 次**，得到 3 行数据。

**控制变量清单（每次 run 都要一致）：**
- DevTools 关闭
- 应用刚重启，列表是空的
- 同一个数据集（S-200）
- 后端、Vite、Electron 都没有重启（只有 FapiaoGO 窗口重启）
- 测量期间不要点别的、不要切窗口做重活

---

## 4. 聚合出中位数

```bash
cd /e/print706 && node outputs/perf-white1-median.mjs outputs/perf-runs-s200.jsonl
```

输出是全字段的 `median / min / max` 表（时间线全段 + 六类计数器 + durations + longTasks 及白屏窗口子集）。

---

## 5. 判读 → 决策

### 5.1 先看核心 KPI

```
WHITE_SCREEN = median(derived.whiteScreenMs)     ← 弹窗关闭 → 列表首次 commit
PAINT_GAP    = median(derived.paintGapMs)        ← commit → 真正上屏
PREVIEW_LAG  = median(derived.previewLagMs)      ← 弹窗关闭 → 预览首帧
```

### 5.2 决策规则

| 条件 | 行动 |
|------|------|
| `WHITE_SCREEN < 500ms` | 白屏不是主要矛盾 → **A1 + A2 做完后停止**，不要因为发现了 O(N²) 就去重构 |
| `WHITE_SCREEN > 500ms` | 按下面的归因分支定位，一次只动一个变量 |

### 5.3 归因分支（`> 500ms` 时按顺序排查）

| 信号 | 指向 | 对应措施 |
|------|------|----------|
| `durations.invoiceDocumentsToRows.total` 大（> 300ms）<br>且 `counters.invoiceDocumentToRow` ≫ 200 | **派生重**：同一批数据被反复重算 | A3（回包合并）/ A4（`fileKeysSig` useMemo） |
| `counters.renderPathConsoleLog` 大 **且** 白屏窗口 longTask 忙时与它同步放大 | **console 放大器**（注意：相关 ≠ 因果） | A1 |
| `counters.importHistoryQuery` ≈ 200<br>且 `longTasks.whiteWindow.totalMs` 集中在网络回包后 | **网络尾巴** | A3 |
| `counters.handlePreview` 在 T6 之前就 ≥ 1<br>且 `PREVIEW_LAG` 与 `WHITE_SCREEN` 接近 | **预览抢占** | B3（预览防抖） |
| `derived.parseMs` 占大头 | **后端** | C 组（`/results` 分页、轻量视图） |

### 5.4 判读陷阱（务必记住）

- ❌ `renderPathConsoleLog` 计数大 **≠** console.log 是主因。必须同时满足：
  ① 白屏窗口内 longTask 忙时显著；② `invoiceDocumentsToRows` 累计时长同量级。
  这正是「用数据代替推断」——A1 之前不要宣称它是根因。
- ❌ 不要拿单次 run 下结论，必须取 median（离群值很常见，比如后台杀软扫描）。
- ❌ 不要在 DevTools 开着时测（console I/O 会被放大数倍）。

---

## 6. 故障排除

| 现象 | 原因 | 处理 |
|------|------|------|
| 导入后提示「所有文件均为重复，导入已跳过」 | 上次 run 的文件还在列表里 | 重启应用再导入 |
| 剪贴板空的 | Electron 拒绝无手势的写剪贴板 | 用 `__perfProbe.summaryText()` 或 `copy(JSON.stringify(__perfProbe.getReport()))` |
| 报告里 `whiteScreenMs` 为 `null` | T6 未触发（FileList 未在 100% 后 commit） | 先确认列表真的渲染出来了；若确认是 null，这本身就是强证据（弹窗关闭时列表还没提交） |
| 报告 `longTasks.supported = false` | 浏览器不支持 longtask observer | 不影响 T0–T7 与计数器，只少一个维度 |
| Vite 端口 5173 被占用 | 上次的 dev server 没关 | 关掉旧终端，或 `npm run dev -- --port 5174`（同时 main.js 的 URL 也得改，不推荐） |
| 后端 5000 端口占用 | 上次的 python 没关 | 关掉旧终端 |

---

## 7. 跑完之后

把 `outputs/perf-runs-s200.jsonl` 和聚合器输出发给我，我会：
1. 判读数据，确认归因分支
2. 单独实施对应措施（Gate 1 起一次只改一个变量）
3. 给你下一轮的复测指令

**S-200-OFD 先不要跑** —— 第一次先把 S-200 链路跑通、拿到数据再说。
OFD 样本目前只有 1 份真实文件，数据集本身也需要先造，那是另一件事。
