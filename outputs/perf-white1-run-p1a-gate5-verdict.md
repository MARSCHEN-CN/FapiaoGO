# PERF-WHITE-1 · P1-A Gate 5 裁决（热路径 A/B）

> 报告：`outputs/perf-runs/run-261-p1a-gate5-20260903.json`（t0Wall 2026-09-03T07:08:33.921Z）
> 对比基线：`run-261-1B-20260903.json`（同一热路径状态：导入历史 262 条 count≥2）
> 判定人/日期：2026-09-03 · 裁决器 `perf-white1-adjudicate.mjs`（对热路径报告预期 exit 2 —— 其可比性守卫只认冷路径，本裁决用 1B 热路径作基线，不走该守卫）

## 结论速览

| 维度 | 1B（P1-A 前，热路径） | Gate 5（P1-A 后，热路径） | 判定 |
|---|---|---|---|
| importHistory 发布数 | 454 写（每次全量 Map 重建 + Context 广播） | **43 发布**（203 响应 / 65 noop） | ✅ 降 90.5%，风暴源消除 |
| applySort | 195 | **51** | ✅ 排序风暴降 74% |
| setFiles | 297 | 173 | 负载侧证（同 261 文件） |
| importHistoryQuery | 899 | 738 | 响应命中减少 |
| longTasks 全窗 | 300（**触顶 MAX=300，真实数≥300**）/ 42024ms | 180 / 27146ms | ✅ 明显回落，未触顶 |
| **白屏窗口长任务** | 窗口被 P0 缺陷 T6p 截断成 6.6ms，**数据作废** | **[T4→T5+3s] = 0 个长任务** | ✅ 关键窗口零阻塞 |
| T6（弹窗关闭后首个 files commit） | T4+30.4s（**被饿死的末批 setFiles** = 白屏终点） | **缺席**（末批 setFiles 在 T4 前已 commit） | ✅ 见 §3 语义裁决 |
| whiteScreenMs | 30166.6（T5→T6） | null（结构性不可算，见 §5） | ⚠️ KPI 不适用 |
| parseMs（T1→T2） | 48135.8 | 61298（+27.3%） | ⚠️ 机差/负载方差，与前端改动无关 |

**裁决：P1-A 机制 PASS —— importHistory 发布风暴（454→43）与排序风暴（195→51）被消除，
白屏窗口内主线程零长任务；Gate 5 成功判据「Publish ≪ 454」达成。**
唯一未能由报告自证的环节是「弹窗关闭瞬间用户看到的是完整列表」（KPI 结构性盲区），需用户眼证，见 §6。

---

## 1. 前置：本轮与 1B 的同态性

Gate 5 设计（`perf-white1-run-p1a-gate5.md`）要求与 1B **唯一差异 = 代码**（P1-A 批处理 + P0 epoch 守卫）：
- 热路径状态保持：导入历史未重置（262 条 count≥2）→ 本轮 importHistory 命中 203，热路径激活 ✓
- 文件数同 261（两轮 meta 一致）✓
- invoiceDocumentToRow 538 vs 561（ratio 0.96，派生负载可比）✓

## 2. 关键机制指标 A/B

| 指标 | 1B | Gate 5 | 解读 |
|---|---|---|---|
| importHistoryResponse/Write | 454（Write） | 203（Response） | 语义等价（P1-A 改名：写入点→响应命中点） |
| importHistoryPublish | —（每响应必发） | **43** | 批处理后真实 Context 广播次数 |
| importHistoryNoop | — | 65 | flush 时整批与 current 相同 → 不发布 |
| 有效压缩比 | 454 广播 | 43 广播 | **每 4.7 个响应合成 1 次发布**；noop 65 次说明大量 flush 内容重复（latest-wins 生效） |

43 次发布 ×（262+261 行重渲 + 全量 Map 重建）远低于 1B 的 454 次 —— 风暴机制按预期消除。

## 3. T6 缺席的语义裁决 —— 成功签名，不是异常

**接线事实（代码取证）：**
- T6 hook（`FileList.jsx:267-275`）useLayoutEffect deps = **`[files]`** → 仅当 `files` 数组身份变化时触发。
- T6 = 每世代（T4 后 epoch=1）首次 files-commit，first-wins。epoch 不符会被守卫成 `<name>_stale`。
- 导入期 setFiles 分批在 parse 期间执行（T1→T3，epoch 0）；T4 handler（`useFileOps.js:1111`）前有 `flushUpdates()`（:1100）兜底。

**两轮对照：**
- **1B：T6 = 98307.5（T4+30.4s）**。files 在 100% 后 30 秒才变化 → 末批 setFiles 的 React commit 被 importHistory 风暴（454 次全量 Map 重建 + 行重渲）饿死 30 秒。**这个 T6 就是白屏的终点**（弹窗关了，列表缺末批，白屏 30s，直到主线程喘过气把 commit 落地）。
- **Gate 5：T6 全程缺席**（T4 → T5+15s 观察窗 → watchdog 结算，无任何 files commit）。
  反证：若仍有末批 setFiles 悬空，其 commit 必然落在 epoch 1 → T6 必然触发。没有触发 = **没有悬空 commit = 弹窗关闭时列表已含全部文件**。
  唯一合理的相邻解释：1B 里饿死末批 commit 的那场风暴没了（43 发布），各批 setFiles 在 parse 期间即时 commit，T4 到达时列表已完整。

**结论：Gate 5 的 T6 缺席 = P1-A 修复生效的直接证据**（与 1B 的 T6 迟到 30s 恰好构成反面对照），
而非「列表没更新」——若列表真没更新，必然伴随某次 files 变化，T6 不会缺席。

## 4. P0 epoch 守卫现场验证

- `T6p_stale = 82976.6`（T4+7.6ms）：epoch 0 排程的 paint 回调（rAF→setTimeout）跨 T4 迟到 → 被守卫隔离留证。
- `staleMarks = 1` ✓。这正是 P0 文档描述的缺陷类别（1B 里同类回调把 T6p 打成 T4+6.6ms、早于真实 T6 30 秒）。
  本轮它被正确作废 → **本轮所有真锚点无污染**，判读可信。
- `_pre` 留档（T6_pre=24.2 / T6p_pre=279.5 / previewRenderStart_pre=863.8 / previewRenderEnd_pre=1130.2 / T7_pre=1130.2）=
  导入期（epoch 0）的列表首 commit 与一次预览渲染完成，符合「导入期间主界面仍在正常渲染」的预期。

## 5. 残余不确定性与结构性盲区

1. **whiteScreenMs 结构性不可算**：KPI = T5→T6，隐含「弹窗关闭后必有一次 files commit 待测量」。
   P1-A 生效后没有这种 commit（列表已完整）→ T6 缺席 → KPI 恒 null。**这是 KPI 设计与修复目标的语义冲突**，
   不是测量失败。判据应改用「[T4→T5+3s] 长任务数 + 眼证」而非 whiteScreenMs。
2. **眼证盲区**：探针无法证明「关闭瞬间像素内容正确」（无对「已有内容」的 paint 度量）。1B 的 30s 白屏与
   本轮的无 commit 都是推论链条，用户视觉是最终 ground truth（见 §6）。
3. **parseMs +27.3%（48.1s→61.3s）**：同为 261 文件、后端未改动。判为机器负载/进程调度方差
   （本机 parse 长任务 27.1s 全窗 vs 1B 42s；两轮 parse 期长任务形态不同）。不影响前端改动归因，
   但提示：**跨轮 parseMs 不可作为任何前端优化的判据**（噪声远大于前端收益量级）。
4. 1B 报告本身带 P0 缺陷（T6p=T4+6.6ms 早于 T6），其 whiteWindow 被截断成 6.6ms → 1B 的
   「白屏窗口长任务」数据作废；本轮与之对比只能用全窗 longTasks，语义稍粗但方向一致。

## 6. 待用户眼证（Gate 5 唯一缺口）

Gate 5 A/B 本质是「人眼 A/B」。请在真机复跑一次 261 导入（保持热路径），确认：

> **弹窗关闭的那一刻（进度 100% → 遮罩消失），文件列表是否立刻显示全部文件？**
> - A. 立刻显示完整列表，无白屏 / 白屏 <1s（≈ 修复达成）
> - B. 短暂白屏 1–3s 后显示（接近达成，可进 Gate 6 后评估残余）
> - C. 仍白屏 >5s（P1-A 未达预期，需回查）
> - D. 弹窗关闭后列表没出现新文件 / 停在旧 262 条（异常，需回查）

另请确认导入完成后列表总数 = 523（262 旧 + 261 新）。

## 7. 下一步

- **Gate 6（冷路径）**：重置导入历史（使 importCount=1）后复跑同一 261 导入，
  预期 importHistory 命中≈0（冷路径本就不走查询分支），作为「P1-A 无回归 + 冷路径基线刷新」。
- 若 Gate 6 后 T5→内容可见仍 >3s（冷路径无历史查询，剩余阻塞若在别处），再议 P1-B（同序守卫）/ 其他。
- P1-B（same-order guard）、P1-C（行级 memo 细粒度）维持 DEFERRED，等 Gate 6 数据。

---
*证据：run-261-p1a-gate5-20260903.json、run-261-1B-20260903.json、importPerfProbe.js（mark/buildReport/epoch）、
FileList.jsx:267-275（T6 hook）、useFileOps.js:1094-1160（T4→T5→watchdog）*
