# Phase 2 计划复核（用户复核意见存档 · 2026-09-08）

> 本文是用户对 Phase 1 实测结果的复核意见 + Phase 2 测量计划的原始存档。
>
> 核心结论：
> - **Phase 1 通过**（属"根因验证通过"，不是"性能优化通过"）；
> - R2 措辞应从「预取竞争」改为「**前后台渲染未隔离导致的资源竞争**」，
>   且应冻结**行为契约**（Foreground 不能被 Prefetch 显著拖慢）而非实现方案（priority queue）；
> - R3 的正式 KPI 是 `Render MISS 2→1`，**不是**「切换时间 -50%」；
> - 「200 文件挤掉后端缓存」**已证伪**，不得在后续因果链中引用；
> - `dimensions cache` 目前只是**高可信候选**，尚未单变量验证，不得等同根因；
> - 下一步 = **真机端到端分层测量（Phase 2）**，不进入 R1。
>
> ⚠️ 本文件曾被误写入 `switch-slow-phase1-experiment.md`（覆盖原报告），已恢复并另存于此。

---

我已按你这次 **Phase 1 实测结果**重新校正判断。结论：**这版比首份诊断可信度明显提高，而且你对三个错误结论的主动修正是正确的。**

我只关注当前主题：**切换发票 → 展示区加载慢**。

---

# 总体结论：Phase 1 可以成立，但我建议 Phase 2 的“真机验收口径”再收紧

目前已经可以确认四件事：

## ① R3：确定存在，确定值得消除

这个已经不是推测。

```text
一次切换
├─ DocumentViewer 请求
└─ legacy RE probe 请求
```

而且现在进一步确认：

- 两个 ETag 不同
- 两个缓存条目不同
- 两条执行路径不同
- MISS `2 → 1`
- CPU 工作量 `2 → 1`

所以：

> **R3 是确定的重复工作，应当消除。**

但你现在的修正也完全正确：

> **不能承诺墙钟减半。**

实测：

- 矢量：30.3%
- 扫描件：8.3%
- 12MP：16.1%

因此，R3 的正式 KPI 应该是：

```text
Render MISS: 2 → 1
```

而不是：

```text
切换时间：-50%
```

这是非常重要的修正。

---

# ② R2：目前是 Phase 1 中最强的“前台延迟”证据

你新的数据：

```text
无后台任务：280 ms
6 路后台并发：598 ms
```

即：

```text
+113%
```

这个结论成立。

但我建议正式报告里把：

> R2 预取竞争 / QoS

改成：

> **R2 前后台渲染未隔离导致的资源竞争**

因为真正的问题不是“预取”这个功能本身。

问题是：

```text
Foreground
    与
Background prefetch
```

在当前架构中处于竞争关系。

所以你 Phase 1 的最终架构判断：

> 根治不是 `±3 → ±1`，而是 QoS / 优先级隔离

我赞同。

不过，**现在还不能证明 QoS 是唯一正确实现方案**。至少还有：

```text
A. 前台存在时完全禁止后台渲染
B. 前台完成后 idle prefetch
C. 单独低优先级队列
D. 可取消的 prefetch
E. QoS priority queue
```

因此现在冻结的应该是：

```text
行为契约：
Foreground 永远不能被 Prefetch 显著拖慢
```

而不是立即冻结：

```text
实现方案：
必须 priority queue
```

这是我唯一建议你在措辞上再区分清楚的地方。

---

# ③ R7 / “200 文件挤掉后端缓存”：已经明确证伪，应从本问题中彻底移除

这个修正非常重要。

现在事实是：

```text
RenderCache = 1000 entries

210 × 单页文档
        ↓
210 entries
        ↓
切回 A
        ↓
MISS = 0
```

所以原来的：

> 200+ 文件导致 RenderCache 被挤掉，切回重渲染

应该正式标记：

# ❌ 已证伪

不要再在后续 Phase 2 / Phase 3 的因果链中引用。

同时你也正确地区分了：

```text
前端 usePreview LRU = 50
```

和：

```text
后端 RenderCache = 1000
```

这是两个完全不同的缓存。

---

# ④ A → B → C → A 的关键事实已经改变了整个诊断方向

这是 Phase 1 最有价值的结果。

```text
A → B → C → A

增量 Render MISS：

[2, 2, 2, 0]
```

开启 P1-A：

```text
[1, 1, 1, 0]
```

所以现在可以非常明确地说：

# 切回 A 慢，不是后端重新渲染

这条因果链已经成立：

```text
A
↓
后端渲染

B
↓
后端渲染

C
↓
后端渲染

A
↓
RenderCache HIT
↓
后端 0 次渲染
↓
展示仍慢
```

因此：

```text
A 切回慢
        ≠
RenderEngine 慢
```

而是浏览器展示路径问题。

这一点比首份报告清晰很多。

---

# 但这里我有一个重要保留意见：现在还不能把 R6 当成“已证实根因”

你目前写：

> 切回 A 后端 0 渲染仍慢 ⇒ 慢在浏览器侧：重复下载、解码、以及展示层主动 `setNaturalDims(null)` 重置。

前半句成立：

```text
后端 0 render
→
瓶颈不在后端渲染
```

但是后半句：

```text
重复下载
+
重新解码
+
setNaturalDims(null)
```

目前还是一个**浏览器侧嫌疑集合**。

尤其：

```jsx
setNaturalDims(null)
```

它可以证明：

```text
UI 主动进入 loading state
```

但它本身不能证明：

```text
浏览器一定重新下载
```

也不能单独证明：

```text
浏览器一定重新解码
```

所以我建议把 S4 的状态写得更严谨：

### 当前

> 实验 B 佐证其必要性

### 建议

> **实验 B 证明浏览器展示路径存在剩余瓶颈；`dimensions cache` 是高可信优化候选，但尚未完成单变量验证。**

这是 Phase 2 之后最值得继续做的事情之一。

---

# 你的修正后优先级，我建议再微调一次

你目前：

```text
S1 R2
S2 R3
S3 R1
S4 dimensions cache
```

我建议分成两个维度。

---

## 第一维：当前已经证实的浪费

### 🔴 E1 — R2 前后台资源竞争

证据：

```text
280 → 598 ms
+113%
```

状态：

**已实测**

---

### 🔴 E2 — R3 双渲染

证据：

```text
MISS 2 → 1
ETag 不同
执行路径不同
```

状态：

**已实测**

---

## 第二维：下一阶段真正的大头

### 🔴 P1 — R1 位图 Preview Render Contract

证据：

```text
12MP → 6.5s
16MP → 29.3s
```

状态：

**已实测**

但尚未知道：

```text
Phase 1 去噪后
R1 在真实 Electron 端到端路径中
到底贡献多少
```

---

### 🟠 P2 — 浏览器展示路径

当前证据：

```text
后端 Render MISS = 0
但切回仍慢
```

状态：

**已定位到浏览器侧，但尚未精确分解。**

可能包括：

```text
HTTP revalidation
Image fetch
WebP decode
GPU upload
React state reset
naturalDims reset
opacity transition
layout/reflow
```

因此：

> `dimensions cache` 目前应该是候选方案，不应该直接等于根因。

---

# 所以我认为你现在不应该直接进入“Phase 3 R1 契约冻结”

你原计划是：

```text
Phase 1
↓
真机基线
↓
Phase 3 R1
```

我建议中间补一个非常小的：

# Phase 2 = 真机端到端分层测量

不是改生产代码。

也不是继续猜。

只需要把：

```text
切换开始
```

拆开。

---

## 推荐的 Phase 2 测量点

```text
T0
用户选择 B

T1
ViewerViewport 收到新的 previewUrl

T2
<img> 请求开始

T3
HTTP response / cache response 可用

T4
img onload

T5
natural dimensions ready

T6
图片真正可见
```

对于：

```text
A → B → C → A
```

分别记录。

---

## 特别是 A 的第二次访问

你真正需要得到：

```text
A (cold)
A (warm)
```

的差异：

| 指标        | Cold A | Warm A |
| --------- | ------ | ------ |
| 后端 Render | ?      | 0      |
| HTTP      | ?      | ?      |
| img load  | ?      | ?      |
| Decode    | ?      | ?      |
| Visible   | ?      | ?      |

这样就可以把：

> “浏览器侧慢”

继续压缩成具体事实。

---

# 我特别建议验证一个点：304 到底是不是 Warm A 的主要路径

你的首份报告说：

```text
Cache-Control:
max-age=0, must-revalidate
```

那么浏览器即使已经有资源，也可能：

```text
重新发请求
↓
ETag revalidation
↓
304
↓
使用已有 body
```

但：

```text
304
```

和：

```text
memory cache
```

的体验完全不同。

所以 Phase 2 应该明确记录：

```text
A 切回：

memory cache?
disk cache?
304?
200?
```

这会直接决定下一步。

如果 Warm A 是：

```text
304
+
重新 decode
```

那么优化方向与：

```text
memory cache
+
GPU upload
```

完全不同。

---

# 我对三个实验开关的评价

## `disableLegacyReProbe`

设计合理。

尤其：

> 仅 DocumentViewer 激活时关闭，不影响 legacy merge 路径

这是正确的边界。

但最终正式实现时，我建议不要长期保留：

```text
localStorage 实验开关
```

它适合作为：

```text
Phase 1 实验
```

不适合作为最终架构。

真机验证通过后，正式改动应该变成：

```text
DocumentViewer active
↓
legacy RE probe 根本不启动
```

而不是：

```text
if localStorage flag
```

---

## `disableFrontendPrefetch`

适合作为实验。

但要注意：

```text
Frontend Prefetch OFF
```

只关闭了一个竞争源。

---

## `RE_PREFETCH_ENABLED=0`

同样适合作为实验。

Phase 2 基线必须明确区分：

```text
PREFETCH ALL OFF
```

即：

```text
Frontend prefetch = OFF
Backend neighbor prefetch = OFF
```

否则“去噪基线”不干净。

---

# 关于 `documentViewerActiveRef`，我认为可以接受，但要注意它是实验桥接，不是最终架构

你描述：

```text
App
render 同步写 ref
↓
usePreview effect
↓
读取 ref
```

用于解决：

```text
activeDocument
依赖
usePreview.previewFile
```

的循环。

对于当前实验目的：

> **可以接受。**

因为你的目标是：

```text
验证：
DocumentViewer active 时
关闭 RE probe
```

不是长期重构 Preview 状态模型。

但是正式落地 R3 时，我建议重新审查：

```text
为什么 usePreview
需要通过 App 的 ref
才能知道 DocumentViewer 是否激活？
```

因为这说明：

```text
Preview ownership
```

仍然有一点双向耦合。

**现在不要扩大范围。** Phase 1 实验阶段这样处理没有问题。

---

# 我认为目前最准确的根因图应该变成

```text
切换发票慢
                     │
        ┌────────────┴────────────┐
        │                         │
     首次访问                   再次访问
        │                         │
        │                         ├── 后端 RenderCache HIT
        │                         │
        │                         └── 浏览器展示路径仍慢
        │
        ├── R1 位图输出尺寸失控
        │      │
        │      ├── 栅格化慢
        │      ├── 编码慢
        │      ├── 文件大
        │      └── 浏览器 decode 大
        │
        ├── R3 双渲染
        │      └── CPU 2 → 1 可消除
        │
        └── R2 后台预取竞争
               └── 前台 280 → 598ms
```

而不是首版的：

```text
200 文件
↓
缓存挤掉
↓
切回重新渲染
```

这条应该删除。

---

# 我对当前状态的最终判断

## Phase 1：通过

但不是“性能优化通过”。

而是：

> **根因验证 Phase 1 通过。**

已经完成了三件非常有价值的事：

### ✅ R3

确认：

```text
确实双渲染
```

并且量化了真实墙钟收益：

```text
8~30%
```

---

### ✅ R2

确认：

```text
后台预取会显著伤害前台
```

当前实验：

```text
+113%
```

---

### ✅ RenderCache

确认：

```text
210 单页文档
不会挤掉后端 RenderCache
```

并且：

```text
A → B → C → A
最后 A = 0 render
```

---

# 我建议的下一步只有一个

## 先做真机 Phase 2，不进入 R1

Phase 2 的目标不是优化。

目标是回答：

# Warm A 到底慢在哪里？

必须把：

```text
浏览器侧慢
```

拆成：

```text
Network
↓
HTTP cache / 304
↓
Image load
↓
Decode
↓
Viewer state
↓
Visible
```

---

## 真机验收顺序

### 实验 1：R3

只开：

```js
localStorage.setItem(
  'fapiao.perf.disableLegacyReProbe',
  '1'
)
```

确认：

```text
/preview/
2 → 1
```

---

### 实验 2：去前端预取

再开：

```js
localStorage.setItem(
  'fapiao.perf.disableFrontendPrefetch',
  '1'
)
```

---

### 实验 3：去后端预取

启动：

```text
RE_PREFETCH_ENABLED=0
```

---

### 实验 4：A → B → C → A

记录：

```text
T0 → T6
```

尤其：

```text
第一次 A
vs
第二次 A
```

---

# 最后一句判断

**你现在不应该急着修改 R1，也不应该急着实现 dimensions cache。**

目前最正确的状态是：

> **后端重复渲染的问题已经被实测钉死；后端缓存切回问题已经被证伪；剩下最大的未知数，是“浏览器到底为什么在后端 0 渲染时仍然慢”。**

因此下一步应该是：

# **Phase 2 真机端到端分层测量 → 精确定位 Warm Switch 浏览器瓶颈 → 再冻结 R1 / 展示层优化契约。**

这会比现在直接进入 `engine.py` 更稳。
