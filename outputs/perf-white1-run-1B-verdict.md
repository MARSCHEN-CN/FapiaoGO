# PERF-WHITE-1 1B — 复跑判读与根因判定

> 数据：`outputs/perf-runs/run-261-1B-20260903.json`（2026-09-03 11:26，261 张）
> 基线：`outputs/perf-runs/run-261-user-raw.json`（2026-09-02 17:34，261 张，冷路径）
> 判读工具：`node outputs/perf-white1-adjudicate.mjs <报告>`（自测 8/8 PASS）
> 纪律：本轮仍为**纯取证**，未改任何业务逻辑；A①② 保持冻结。

---

## 0. 一句话结论

**白屏不是预览造成的。** 预览在导入期（T0+840.7ms → T0+1139.6ms）就画完了一帧，100% 之后再没被触发过一次。

真正的成因是：**弹窗在 T4+269ms 就关闭了，而列表的最终内容直到 T4+30.4s 才 commit** —— 用户对着空白显示区看了约 **30 秒**。

---

## 1. A/B/C/D 判定：**A-**（导入期渲染过，100% 后无新尝试）

| 判据 | 值 | 读法 |
|------|-----|------|
| `previewRenderStart`（T4 后） | **缺失** | 弹窗关闭后没有新的渲染尝试 |
| `previewRenderEnd`（T4 后） | **缺失** | —— |
| `previewRenderStart_pre` | 840.7ms | 导入期第 1 次尝试起点 |
| `previewRenderEnd_pre` / `T7_pre` | 1139.6ms | 导入期渲染**完成**，耗时 298.9ms |
| `previewRenderAttempts` / `Completed` | 2 / 1 | 全程仅 2 次尝试，1 次完成（均在导入期） |
| `handlePreview` | 308 | 预览 hook 被调用 308 次，只有 2 次真正落到 canvas 渲染 |

**含义**：排除「预览渲染慢 / 渲染卡住」（B/C）。预览子系统在 100% 之后**没有收到渲染请求**——不是它慢，是没被调用。

⚠️ 推断（有证据支持，未直接测量像素）：`handlePreview` 308 次 vs 渲染 2 次，说明 306 次被 gate 掉（选中项未变 / 数据未就绪 / 正在渲染中）。因此「预览区一片黑」**不成立**——导入期那帧大概率还留在画布上，白的是**列表区**。

---

## 2. 关键时间线（相对 T0 / T5）

| 锚点 | T0+ (ms) | 相对 T5 | 说明 |
|------|---------|---------|------|
| T0 | 0 | −68140.9 | 导入开始 |
| T1 split 完成 | 19735.6 | −48405.3 | |
| T2 后端解析完成 | 67871.4 | −269.5 | |
| T4 **进度 100%** | 67871.5 | −269.4 | |
| T5 **弹窗关闭（代码调用点）** | 68140.9 | 0 | `useFileOps.js:1136` mark 在 `setImporting(false)` **之前** |
| ⚠️ T6p（paint，陈旧标记） | 67878.1 | −262.8 | 见 §4，**不可信** |
| ★ **T6 列表首次 commit** | **98307.5** | **+30166.6** | **白屏终点：30.2 秒** |
| 最晚一条 long task | 121257.4 | +53116 | 阻塞一直持续到 53 秒后 |

辅助锚点（导入期，`*_pre` 留档）：`T6_pre=20.8`（列表在 20.8ms 就 commit 过）、`T6p_pre=194.6`（194.6ms 上屏过一次）。

**白屏机制**：194.6ms 那次 paint 时列表还几乎是空的；此后直到 98.3s，主线程的 long task 一直没让 React commit 新的列表内容。弹窗在 68.1s 关掉，露出的是「194.6ms 时代的空列表」→ 用户看到空白约 30 秒。

---

## 3. 新旧对比（🔴 本轮是**热路径**，与基线不可比）

| 字段 | run-261（冷） | 本轮（热） | 变化 | 判读 |
|------|--------------|-----------|------|------|
| `importHistoryWrite` | 0 | **454** | 新增 | 🔴 热路径激活（importCount≥2） |
| `importHistoryQuery` | 561 | 899 | 1.6× | 查询轮次更多 |
| `applySort` | 8 | **195** | **24×** | 全量重排风暴 |
| `setFiles` | 116 | 297 | 2.6× | |
| `handlePreview` | 122 | 308 | 2.5× | |
| longTasks count | 112 | **300（触顶）** | ≥2.7× | 触 `MAX_LONG_TASKS` 上限，真实更多 |
| longTasks totalMs | 16130 | **42024** | 2.6× | 下限（被截断） |
| `invoiceDocumentToRow` | 561 | 538 | 0.96× | ✅ 派生负载相当 |
| `renderPathConsoleLog` | 556 | 529 | 0.95× | ✅ 相当 |
| `parseMs` | 45363.1 | 48135.8 | +6.1% | ✅ 解析段基本稳定 |
| `splitMs` | 19669.3 | 19735.6 | +0.3% | ✅ 稳定 |
| `dismissDelayMs` | 275.7 | 269.4 | −6.3 | ✅ 一致（固定 250ms 策略） |

**可比性判定**：导入前半段（split/parse）两轮高度一致，可比；**分叉点在 T4 之后**——热路径的重排风暴把主线程占用推到 2.6 倍以上。

> ⚠️ 别误读成「冷路径没问题」：基线的 long task 一直排到 **T5+121s**，只是 6 秒窗口没抓到 T6，所以 `whiteScreenMs=null`。冷路径同样有长时间阻塞，只是没测出终点。

**热路径实锤**（跑完即查 `database/invoice_import_history.json`）：
- 266 条记录，其中 **262 条 `importCount≥2`**，仅 4 条为 1
- 例：`25322000000330109958` 已被导入 **9 次**（firstImportedAt 2026-08-27）
- → 这轮是「重复导入」，不是 run-261 的冷路径复现

---

## 4. 🔴 证据质量缺陷：**T6p 会被 T4 之前的陈旧 rAF 打上**（两轮都中招）

**矛盾**：本轮 `T6p`（paint）= 67878.1 = T4+6.6ms，却**早于** `T6`（commit）= 98307.5 达 30.4 秒。按定义 paint 不可能早于 commit。

**代码定位**（`frontend/src/components/FileList.jsx:262-269`）：
```jsx
useLayoutEffect(() => {
  if (!files || files.length === 0) return
  perfProbe.mark('T6')
  const rafId = requestAnimationFrame(() => {
    setTimeout(() => perfProbe.mark('T6p'), 0)   // ← 这个回调可能在 T4 之后才触发
  })
  return () => cancelAnimationFrame(rafId)
}, [files])
```

**机制**：rAF 在 T4 **之前**的某个 commit 周期里排程；T4 触发 `importPerfProbe.js:126-129` 重置锚点（删掉 T6/T6p 并留档 `*_pre`），但**不会取消这个已排程的 rAF**。于是 T4 之后 rAF 回调照常执行，把 T6p 打上 —— 记的是一次**陈旧 paint**，不是 100% 之后的首次 paint。

**影响面（两轮都中招）**：
- 本轮：`paintGapMs = −30429.4`（负得离谱）、`whiteToPaintMs = −262.8` 失真
- 基线：`T6p = 65037.5 = T4+5.1ms` 同样是陈旧标记 → 基线那条「列表在弹窗关闭前已 paint」的结论**部分失效**
- `listReadyBeforeDismiss` 用的是 `T6_pre`（20.8ms，真实留档），这部分结论**仍然成立**

**修复方向（P0，取证-only）**：给排程打一个「世代戳」——T4 重置时递增 epoch，rAF 回调里比对 epoch，不一致则放弃打点。行为不变，只修测量。

---

## 5. 测量窗口本身也被阻塞扭曲了

- `finishReason` 写着 `T5+15000ms`，但报告里出现了 `T6 = T5+30166.6ms` 且 long task 排到 `T5+53116ms` → **15 秒的 `setTimeout` 实际被推迟到约 53 秒才执行**。所谓「15 秒窗口」在被阻塞时是**下限**。
- `longTasks.count = 300` 正好等于 `MAX_LONG_TASKS`（`importPerfProbe.js:49`）→ 列表被截断，`totalMs=42024` 是**下界**。
- `T5` 标记在 `setImporting(false)` **之前**（`useFileOps.js:1136`），它是「代码决定关闭」的时刻，不是「弹窗像素消失」的时刻 → `whiteScreenMs` 精度受限（推断为同数量级，非精确值）。

---

## 6. 30 秒阻塞的放大器：每命中一次就重建整张 Map

`frontend/src/contexts/FileContext.jsx:262-281`：

```js
if ((res.importCount ?? 0) < 2) return
perfProbe.count('importHistoryWrite')      // 本轮 454 次
setImportHistoryInfo(prev => {
  const next = new Map()
  for (const [k, v] of prev) if (liveKeys.has(k)) next.set(k, v)   // ← 整表复制 O(n)
  for (const k of fileKeys) { ... next.set(k, {...}) }
  return next                                                       // ← 新引用 → 触发全量重排
})
```

**量化**：
- 454 次命中 → **454 次整表 Map 重建**，每次约 266–538 条目 → 约 **22.7 万次** Map 写入 + 同量级对象分配
- 每次 `setImportHistoryInfo` 产生新引用 → 下游 memo/effect 失效 → `applySort` **195 次**（基线 8 次）
- 已有的 300ms debounce 只作用于**查询轮次起点**（`:250-284`），**写入完全没做批处理**：6 并发的响应是流式到达的，每条命中各自 setState

**结果**：React 19 并发调度下，持续涌入的状态更新不断打断/压过「渲染 538 行列表」这个昂贵任务，列表 commit 被饿死到 98.3s。这也顺带解释了预览为何 100% 后再没触发——同一场饥饿。

---

## 7. 对冻结方案 A①/A② 的判定（我们押的两个修复方向）

| 方案 | 判定 | 依据 |
|------|------|------|
| **A①（弹窗等「预览首帧」或 3s 超时）** | ❌ **方向错了** | 100% 后预览**从未被触发**（`previewRenderStart` 缺失）。等一个永远不会来的信号 = 每次都等满超时，白屏一秒不少 |
| **A①′（等「列表首帧 paint T6p」或超时）** | ✅ 对症，但**只是止血** | 弹窗 T4+269ms 关，列表 T4+30436ms 才 commit。但 3s 上限只能遮住 30 秒里的 3 秒 |
| **A②（预览区「正在生成预览…」占位）** | ⭕ 与本轮白屏无直接因果 | 预览区大概率还留着导入期那帧；白的是列表区 |

**结论**：A① 需要**重定向**（从「等预览」改为「等列表首帧」），且它必须与 §6 的性能修复配套，单靠改弹窗时序治不了 30 秒。

---

## 8. 下一步（建议优先级）

| 级别 | 动作 | 理由 |
|------|------|------|
| **P0** | 修探针陈旧 `T6p`（epoch 世代戳） | 不修则后续所有 paint 侧 KPI 都不可信，两轮历史数据也受影响 |
| **P1** | `FileContext.jsx:266` 写入批处理：一轮查询结果合并为**一次** setState，避免每次整表重建 | 这是 30 秒的直接来源（454 次重建 + 195 次全量重排） |
| **P1′** | A① 重定向为「等列表首帧 paint + 超时」，与 P1 配套 | 单独做只能止血 |
| **P2** | 冷路径复跑：停后端 → `Rename-Item database\invoice_import_history.json …bak` → 重启 → 导 261 → 等 ≥20s | 本轮是热路径，缺冷/热对照；历史文件当前 266 条、262 条 count≥2 |
| **P3** | 长任务采样上限 `MAX_LONG_TASKS=300` 提高或改为累计统计 | 本轮触顶截断，阻塞总量被低估 |

---

## 9. 诚实边界（本轮**推不出**的结论）

1. 预览区是否真的还显示着导入期那一帧 —— 未测量像素，只有「无新渲染尝试」的间接证据
2. 冷路径下白屏持续多久 —— 本轮是热路径，且基线 6 秒窗口没抓到 T6
3. `whiteScreenMs=30166.6ms` 的精确秒数 —— T5 是「决定关闭」时刻，非「像素消失」时刻
4. 主线程阻塞的**真实总量** —— longTasks 触 300 上限被截断
5. 第二次渲染尝试（`previewRenderAttempts=2` 但未完成的那次）的起点 —— 被 first-wins 吞掉，未留档
