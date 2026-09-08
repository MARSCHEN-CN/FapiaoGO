# Phase 1 实验：R3 / R2 单变量验证（含对首份诊断的结论修正）

日期：2026-09-08 · 分支 `rotation-b1-hardening` · **实验开关默认全部 OFF，合并后行为与改动前一致**

## 0. 为什么先做这个，而不是直接改 R1

首份诊断（[`switch-slow-root-cause.md`](./switch-slow-root-cause.md)）同时抛出了 R1~R7 七个嫌疑项。
若直接改 `engine.py` 修 R1，性能变好后**无法归因**——不知道收益来自 R1、R3 还是 R2。

因此按最小变量原则分阶段：

```text
Phase 1  清理纯浪费 + 建立无竞争基线   ← 本文
Phase 2  拿去噪后的冷路径基线
Phase 3  冻结 Preview Render Contract，再动 R1
Phase 4  展示层 dimensions cache
```

本文只做 Phase 1，并把实测结果与首份诊断逐条对照。

---

## 1. 已落地的实验开关（默认 OFF = 零行为变化）

| 层 | 开关 | 位置 | 默认 |
|---|---|---|---|
| 前端 | `localStorage['fapiao.perf.disableLegacyReProbe']='1'` | `usePreview.js` RE probe 分支前门控 | OFF |
| 前端 | `localStorage['fapiao.perf.disableFrontendPrefetch']='1'` | `App.jsx` 文件间预取 effect | OFF |
| 后端 | 环境变量 `RE_PREFETCH_ENABLED=0` | `api.py` 页内邻居预取 | 1（保持现状） |

开关模块：`frontend/src/utils/perfExperimentFlags.js`（实时读 localStorage，无需重启应用）。
`disableLegacyReProbe` 仅在 **DocumentViewer 激活**时生效（legacy merge 路径不受影响），
判据经 `documentViewerActiveRef` 在 render 期间同步写入，早于 usePreview 的 effect 执行，无滞后一帧问题。

真机开启（DevTools Console，**单行**）：

```text
localStorage.setItem('fapiao.perf.disableLegacyReProbe','1')
localStorage.setItem('fapiao.perf.disableFrontendPrefetch','1')
```

---

## 2. 实验结果

脚本：`outputs/perf-runs/switch-slow/_phase1_verify.py`（只读，不改生产代码）。
MISS = RenderCache 未命中 = **真实发生了一次渲染**。

### 实验 A —— 一次切换到底渲染几次（冷）

两条管线**并发**发起（模拟浏览器两个 `<img>` 同时加载），测墙钟：

| 文档类型 | 现状 渲染次数 | 现状 墙钟 | P1-A 渲染次数 | P1-A 墙钟 | 墙钟节省 |
|---|---:|---:|---:|---:|---:|
| 矢量 PDF A4 | **2** | 397 ms | **1** | 277 ms | **30.3%** |
| 扫描件 1240×1754 | **2** | 1508 ms | **1** | 1383 ms | **8.3%** |
| 手机拍照 3000×4000 | **2** | 8093 ms | **1** | 6787 ms | **16.1%** |

**确认的事实**：两条请求的 **ETag 不同** ⇒ `engine.py:321` 的 `spec_tag` 确实进入了 `cache_key`
⇒ 一次切换 = **两条独立缓存条目 + 两次真实渲染**。
（附带印证：带 spec 的请求会进入 `_render_spec_page` → `validate_render_command`，
与 legacy 是**两条不同的渲染执行路径**，不只是缓存键不同。）

**必须下调的预期**：墙钟只省 **8~30%**，不是首份诊断隐含的"省一半"。
原因是两线程存在重叠（fitz 栅格化期间释放 GIL），墙钟接近 `max(t1,t2)` 而非 `t1+t2`。
**CPU 总工作量确实减半**（MISS 2→1 已证实），这在后端饱和、内存占用、浏览器解码上仍是实打实的收益，
但不要把「墙钟减半」当成承诺 KPI。

### 实验 B —— A→B→C→A 来回切换（热）

三份内容不同的文档，记录**每次切换的增量渲染次数**：

| 文档类型 | 现状 A,B,C,A | P1-A A,B,C,A |
|---|---|---|
| 矢量 PDF A4 | [2, 2, 2, **0**] | [1, 1, 1, **0**] |
| 扫描件 1240×1754 | [2, 2, 2, **0**] | [1, 1, 1, **0**] |

> ⚠️ 首版脚本把三份文档用了同一份 blob，而 docId 是 **content-only sha256** ⇒ 三份实为同一份，
> 测出来全是 [2,2,2,2] 的假象。已修：三份内容不同。

**结论（关键）**：切回 A 时后端渲染 **0 次**。
⇒ **「A→B→C→A 切回来仍慢」的责任不在后端 RenderCache**。
后端缓存命中后（0.02 ms）剩下的耗时全在浏览器侧：重复下载、解码、以及展示层主动 `setNaturalDims(null)` 重置。
这与"缓存没作用在展示体验上"的判断一致，且现在有了实测支撑。

### 实验 C —— 预取竞争对前台延迟的影响（**上修**）

| 场景 | 中位 | min | max |
|---|---:|---:|---:|
| 无后台预取 | 280 ms | 256 ms | 387 ms |
| 6 路后台并发 | 598 ms | 537 ms | 770 ms |

⇒ 前台延迟 **+113%**（首份诊断为 +84%，**低估**）。

> ⚠️ 首版脚本的后台线程渲染的是**未注册文档**，异常被 `except` 吞掉 ⇒ 实际零负载，得出假的「+0%」。已修。
>
> ⚠️ 该数字**仅对矢量 PDF、本测试环境、本并发模型成立**，不可外推到 12MP/16MP 大图——
> 大图单张 6.5 s / 29 s，多张并发会造成形态完全不同的饱和。

### 实验 D —— 200+ 文件会把后端缓存挤掉吗（**证伪**）

```text
RenderCache 上限 = 1000
注册 210 份文档并全部访问后，切回最早的 A：MISS=0（命中），耗时 0.0 ms
当前 cache 条目数 = 210
```

⇒ **「200 文件把后端缓存挤掉、导致切回重渲染」不成立**（单页文档场景）。
后端 `RenderCache` 上限 1000，210 份单页文档仅占 210 条。

首份诊断里"LRU 上限 50 < 200 文件"指的是**前端** `usePreview` 的缓存（`MAX_CACHE_ENTRIES`），
而它本来就不服务展示区——这是两个不同的东西，原报告的表述容易误导，此处澄清。

> 注：多页文档会按页占多条缓存，页數多时才需重新评估容量。

---

## 3. 修正后的优先级

对照实测，把首份诊断的排序与权重更新如下：

| 级别 | 项 | 实测状态 | 说明 |
|---|---|---|---|
| 🔴 S1 | **R2 前后台渲染未隔离导致的资源竞争** | **+113%（上修）** | 前台被后台拖慢一倍。问题不在"预取"功能本身，而在 Foreground 与 Background prefetch **同级竞争**。⚠️ 本阶段冻结的是**行为契约**：`Foreground 永远不能被 Prefetch 显著拖慢`；实现方案（A 前台存在时禁后台 / B idle prefetch / C 低优先级队列 / D 可取消 prefetch / E priority queue）**尚未选定，不在此阶段冻结**。 |
| 🔴 S2 | **R3 消除重复渲染** | **CPU 2→1 已证实** | 100% 的重复工作，无产品价值（产物在 DocumentViewer 激活时无人消费）。⚠️ **正式 KPI = `Render MISS 2→1`，不是「切换时间 -50%」** —— 并发下墙钟只省 8~30%（见实验 A）。 |
| 🟠 S3 | **R1 位图 Preview Render Contract** | 仍是最大**首次加载**根因 | 12MP 冷渲染 6.5 s / 16MP 29.3 s。**不要现在改**——先拿 Phase 2 的去噪基线。 |
| 🟠 S4 | **展示层 dimensions cache** | 实验 B 证明**浏览器展示路径存在剩余瓶颈**，但尚未单变量验证 | 切回 A 后端 0 渲染仍慢 ⇒ 瓶颈不在后端渲染。按 `documentId → naturalDims` 缓存是**高可信优化候选**，但**不等于已确认根因**："重复下载 / 重解码 / setNaturalDims(null)"目前仍是嫌疑集合，需 Phase 2 分层测量分解后再定。 |
| 🟡 S5 | 遗留 `fullCacheRef` / 前端 LRU | 确认无消费者后**删除**，不要优化 | 展示区是 `<img>` 架构，不消费 canvas cache；不要维护两套 Preview Cache。 |
| 🟡 S6 | Registry 生命周期（220 fitz 句柄） | 单独立项 | 属内存/句柄/长稳问题，**无证据**表明它导致 A→B 切换慢。 |
| ❌ — | ~~后端缓存被挤掉~~ | **已证伪，从本问题中彻底移除** | 见实验 D。⚠️ **后续 Phase 2 / Phase 3 的因果链中不得再引用**「200 文件挤爆 RenderCache 导致切回重渲染」这条。 |

**相对首份诊断的变化**：R2 与 R3 的位次互换（R2 实测影响更大且更易根治），
R7/缓存容量降级，R1 保持但推到 Phase 3。

---

## 4. 下一步（Phase 2）

拿到「无重复渲染 + 无后台竞争」的去噪冷路径基线，才能确认 R1 的真实贡献：

```text
开关全开（disableLegacyReProbe + disableFrontendPrefetch + RE_PREFETCH_ENABLED=0）
        ↓
测四类文档的冷切换：矢量 PDF / 扫描件 / 12MP / 16MP
        ↓
与本文实验 A 的「现状」列对比 → R1 之外的剩余量 = R1 的真实贡献
```

真机验收 R3（用户提的判据）：

```text
开启 disableLegacyReProbe 后，A→B 一次切换
后端 preview 渲染次数应为 1（开启前为 2）
```

可在 DevTools Network 里数 `/preview/` 请求条数作为近似验证（两条 URL 分别带/不带 `?spec=`）。

---

## 5. 复现

```text
backend/venv/Scripts/python.exe outputs/perf-runs/switch-slow/_phase1_verify.py
```

依赖：`backend/venv`、PyMuPDF、Pillow。耗时约 2 分钟（含 3000×4000 大图冷渲染）。

## 6. 本次改动清单（均可回滚、默认不生效）

| 文件 | 改动 |
|---|---|
| `frontend/src/utils/perfExperimentFlags.js` | 新建：localStorage 实验开关，默认 OFF |
| `frontend/src/hooks/usePreview.js` | 新增 `documentViewerActiveRef` 参数；RE probe 分支前加门控 |
| `frontend/src/App.jsx` | 创建并同步写 `documentViewerActiveRef`；预取 effect 加门控 |
| `backend/render_engine/api.py` | 新增 `_neighbor_prefetch_enabled()`（`RE_PREFETCH_ENABLED`，默认 1） |

验收：`vite build` 通过；import 符号交叉校验 PASS（替代 eslint `no-undef`）。
