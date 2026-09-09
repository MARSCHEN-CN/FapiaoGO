# Phase 2：真机端到端分层测量（只读探针，不改任何优化逻辑）

日期：2026-09-08 · 目标：**回答 Warm A 到底慢在哪里**

---

## 0. 为什么是测量而不是优化

Phase 1 已经钉死两件事：

```text
A → B → C → A 增量 Render MISS = [2, 2, 2, 0]
                                          ↑ 切回 A 后端 0 次渲染
```

所以「切回 A 仍慢」的**后端渲染责任已经排除**。但"浏览器侧慢"目前仍是
**嫌疑集合**，不是已分解的事实：

```text
HTTP revalidation / Image fetch / WebP decode / GPU upload
/ React state reset / naturalDims reset / opacity transition / layout&reflow
```

这些嫌疑的**优化方向完全不同**，在分解清楚之前动手等于赌。
Phase 2 的目标只有一个：把它压缩成具体数字。

> ⚠️ 本文以及探针**不做任何优化**。所有开关默认 OFF，合并后行为与改动前一致。

---

## 1. 分层定义（T0 → T6）

| 点 | 含义 | 来源 |
|---|---|---|
| **T0** | 用户点击选择发票 | `App.jsx` 包裹的 `tracedHandlePreview` |
| **T1** | ViewerViewport 收到新 `previewUrl`（effect） | `ViewerViewport` `[previewUrl]` effect |
| T2 | 资源请求开始 | `PerformanceResourceTiming.startTime` |
| T3 | 响应可用 | `PerformanceResourceTiming.responseEnd` |
| **T4** | `img.onload` | `handleImageLoad` |
| **T5** | decode 完成 | `img.decode()` 解算 |
| **T6** | 真正可见（dimsKnown 后下一帧） | 双 `requestAnimationFrame` |

探针输出的分段：

```text
T0→T1   React 事件处理 + 状态传播 + 重渲染
T1→T4   资源获取（网络 or 缓存）
T4→T5   解码
T5→T6   commit + 布局 + 合成上屏
```

---

## 2. 真机开启步骤（**开发模式**，三进程）

> ⚠️ 必须用开发模式。`release_final_v5/` 里的打包产物是 10 天前的，
> **不包含本次 Phase 1 / Phase 2 的任何探针代码**（该目录下也只有
> `FapiaoGO-Setup-1.0.0.exe` 与 Portable.zip，没有可直接运行的 `FapiaoGO.exe`）。
> 用打包版测等于测旧代码。

开发模式由**三个独立进程**组成（`electron/main.js` 判定 `isDev = !app.isPackaged`）：

| 进程 | 端口/入口 | 说明 |
|---|---|---|
| Flask 后端 | `127.0.0.1:5000` | **需手动启动** —— `main.js:931` 开发模式跳过自动 spawn |
| Vite dev server | `localhost:5173` | `main.js:229` 开发模式 `loadURL('http://localhost:5173')` |
| Electron | — | `npm start` |

按**下表的 1 → 2 → 3 顺序**开（后端先起，避免首屏连不上）。三个窗口各自保持运行。

### 步骤 1：后端（带资源时序授权，关键）

前端 origin `http://localhost:5173` 与预览地址 `http://localhost:5000` **不同端口 ⇒ 跨域**。
后端不返回 `Timing-Allow-Origin` 时，Chrome 对跨域资源只暴露
`startTime/responseEnd/duration`，`transferSize / decodedBodySize / responseStatus`
**全部为 0**，探针只能标注 `NO-TAO`，**无法判断缓存路径**（而 304 与 memory cache 的优化方向完全不同）。

PowerShell **单行**（PowerShell 5.1 请务必用 `;` 而非 `&&`）：

```text
cd E:\print706; $env:RE_TIMING_ALLOW_ORIGIN=1; backend\venv\Scripts\python.exe backend\app.py
```

看到 `Running on http://127.0.0.1:5000` 即就绪。
不设此变量 ⇒ 后端不发该头，行为与改动前完全一致。

### 步骤 2：Vite dev server（新开一个窗口）

```text
cd E:\print706\frontend; npm run dev
```

确认输出里有 `Local: http://localhost:5173/`。
（若你已有 dev server 在跑，可跳过；但**改动过前端代码后它会 HMR 热更新，无需重启**。）

> 注意 `vite.config.js` 的 proxy 只代理了 `/api`、`/parse_invoice`、`/get_pdf_pages`、
> `/split_pdf`、`/import/batch`，**不含 `/preview/`**。预览走的是
> `config.js:27` 的 `BACKEND_URL = 'http://localhost:5000'` 直连，不经代理 ——
> 这正是跨域、从而需要 `Timing-Allow-Origin` 的原因。

### 步骤 3：Electron（再开一个窗口）

```text
cd E:\print706; npm start
```

开发模式 `devTools: true`，窗口起来后直接 DevTools 可用。

### 步骤 4：DevTools Console 开前端探针（单行一条）

```text
localStorage.setItem('fapiao.perf.switchTrace','1')
```

无需重启应用（探针实时读 localStorage）。

### 步骤 5（可选）：叠加 Phase 1 的去噪开关

```text
localStorage.setItem('fapiao.perf.disableLegacyReProbe','1')
localStorage.setItem('fapiao.perf.disableFrontendPrefetch','1')
```

> 「去噪基线」要求**两层预取全部关闭**：前端 `disableFrontendPrefetch`
> + 后端 `RE_PREFETCH_ENABLED=0`。只关一个不干净。
>
> 后端那个是**环境变量**，必须在步骤 1 启动后端时就带上（改完要**重启后端进程**，
> 前端 localStorage 不用重启）。把步骤 1 换成这一行：
>
> ```text
> cd E:\print706; $env:RE_TIMING_ALLOW_ORIGIN=1; $env:RE_PREFETCH_ENABLED=0; backend\venv\Scripts\python.exe backend\app.py
> ```

---

## 3. 测量动作

> ### ⚠️ 开发模式的读数口径：只看**分层占比**，不看**绝对毫秒**
>
> 开发模式跑的是 React **development build**，且 `main.jsx:8` 启用了 `StrictMode`
> （effect 会双跑）。因此：
>
> - ✅ 可用：**哪一段大**（`T1→T4` 网络？`T4→T5` 解码？`T5→T6` 上屏？）—— 这是 Phase 2 的唯一目标
> - ❌ 不可用作交付 KPI：总耗时的绝对值（会比生产版显著偏高）
>
> 绝对性能数字要等优化落地后**重新打包**再测。
>
> 附带影响：`StrictMode` 会让 `ViewerViewport` 的 effect 触发两次，探针的 token 机制
> 取后一次写入，误差在同一帧内，可忽略。

### 3.1 清空并开始

```text
__fapiaoSwitchTrace.reset()
```

### 3.2 按序切换（**严格按这个顺序**）

```text
A → B → C → A
```

每次切换**停 2~3 秒**（等图片完全可见再切下一个），保证 T6 能落到真实帧。

### 3.3 输出

```text
__fapiaoSwitchTrace.dump()
```

每次切换完成还会自动打一行 `[switchTrace]` 摘要（DevTools Console 里按序可见）。

### 3.4 建议补做的对照

```text
A → B → A → B → A   （同一对来回切，放大 warm 与 cold 的差异）
```

---

## 4. 关键读数列：`cache`

这是 Phase 2 最核心的产出，直接决定下一步方向。

| 显示值 | 含义 |
|---|---|
| `network-200` | 完整下载（`transferSize > 0`，status 200） |
| `304-revalidate` | 发了请求、服务端回 304，**复用已有 body，但仍需重新解码** |
| `cache(likely-memory)` | 无网络传输且耗时极短（<3ms），倾向内存缓存 |
| `cache(likely-disk)` | 无网络传输但耗时较长，倾向磁盘缓存 |
| `NO-TAO(...)` | 后端未授权 ⇒ 字段不可信，**必须按步骤 1 重开** |
| `unknown(no-resource-timing)` | 取不到该 URL 的 ResourceTiming |

> ⚠️ **memory vs disk 无法从 Web API 精确区分**，`likely-*` 只是基于 duration 的提示，
> 不能当结论。如需确认，用 DevTools Network 面板的 `Size` 列人工核对
> （`(memory cache)` / `(disk cache)` / `304` / 具体字节数）。

---

## 5. 需要填的那张表

```text
                    Cold A      Warm A
后端 Render MISS        1            0
cache               ?            ?
status              ?            ?
transferBytes       ?            ?
decodedBytes        ?            ?
T0→T1               ?            ?
T1→T4  加载          ?            ?
T4→T5  decode       ?            ?
T5→T6  可见          ?            ?
T1→T6  总计          ?            ?
```

**Warm A 那一列就是 Phase 2 的答案。**

---

## 6. 结果判读 → 下一步方向

判读必须看 **Warm A**（后端 0 渲染的那一列），Cold A 只作对照。

| Warm A 观察到的形态 | 说明 | 下一步方向 |
|---|---|---|
| `cache=304-revalidate` + `T4→T5` 很大 | 没重新下载，但**重新解码**大图 | 优先降输出尺寸（R1），而不是展示层 |
| `cache=304-revalidate` + `T1→T4` 大 | 回源往返本身贵 | 考虑 immutable URL / 去掉 must-revalidate |
| `cache=cache(likely-*)` 但 `T5→T6` 大 | 字节已在本地，慢在 React/commit/布局 | 展示层 `dimensions cache` 成为**高可信候选**（此时才值得做） |
| `cache=cache(likely-*)` 且 `T4→T5` 大 | 本地命中但解码仍贵 | 尺寸仍是主因（解码成本 ∝ 像素数） |
| `T0→T1` 大 | 慢在 React 状态传播，不在资源 | 与预览渲染无关，属列表/状态层 |
| 全部形态都出现 `NO-TAO` | 测量无效 | 回到步骤 1 重开后端环境变量 |

> 关键纪律：**只有拿到上表，才允许决定 R1 与展示层优化谁先做。**
> 在 Warm A 分解出来之前，R1 与 dimensions cache 都只是候选，不是根因。

---

## 7. 本次改动清单（默认全部 OFF）

| 文件 | 改动 |
|---|---|
| `frontend/src/utils/previewSwitchTrace.js` | 新建：T0~T6 分层探针 + 缓存路径判定，默认 OFF |
| `frontend/src/components/ViewerViewport.jsx` | 3 处埋点（T1 / T4+T5 / T6）。T6 **刻意用 rAF 链而非新增 `useEffect`**——该组件有 `if (!page \|\| !previewUrl) return` 早退分支，任何新增 hook 都会落在早退之后从而违反 hooks 规则；token 为 null（探针 OFF）时不排帧 |
| `frontend/src/App.jsx` | `tracedHandlePreview` 透传包装，埋 T0 |
| `backend/render_engine/api.py` | 新增 `_timing_allow_origin_enabled()` + `after_request` 钩子（`RE_TIMING_ALLOW_ORIGIN`，默认 0） |

**零行为变化保证**：探针所有导出函数在 OFF 时第一行即 return；
`tracedHandlePreview` 仅透传参数与返回值；后端仅在显式设环境变量时才追加响应头。

---

## 8. 收尾

- 测量结束后建议关闭探针，避免长期留着 console 输出：
  `localStorage.setItem('fapiao.perf.switchTrace','0')`
- Phase 1 的实验开关（`disableLegacyReProbe` / `disableFrontendPrefetch`）
  是**实验设施**，不是最终架构。真机验证通过后，R3 的正式实现应当是
  「DocumentViewer 激活时 legacy RE probe 根本不启动」，而不是长期保留 localStorage 分支。
