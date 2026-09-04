/**
 * importPerfProbe — PERF-WHITE-1 Gate 0 探针自检（node --test，纯 node 可跑）
 *
 * 覆盖（只验证探针自身正确性，不涉及任何业务路径）：
 *  1. 默认禁用态：isEnabled()===false，所有 API 为 no-op 不抛错、零副作用
 *  2. 开启态：startSession 自动打 T0，mark/count/begin 聚合正确
 *  3. mark first-wins：同锚点重复调用不覆盖（T6 语义依赖此特性）
 *  4. T4 重置 T6/T6p/T7：白屏窗口锚点重定位（占位符 commit 不污染测量）
 *  5. count 累加 + 增量计数（importHistoryQuery 用 entries.length 一次加 N 的场景）
 *  6. begin/end 幂等 + duration 聚合（n/total/max/avg 字段齐全）
 *  7. finishSession 幂等：重复结算不翻倍、id 一致
 *  8. 报告结构：derived.whiteScreenMs 等 KPI 字段齐全、longTasks 降级安全
 *
 * 环境说明：本模块对 node 友好——localStorage/navigator 缺失全部走 ?. 安全路径；
 *           PerformanceObserver 不支持 longtask 时被 try/catch 降级为 supported=false，
 *           不影响其余指标。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { perfProbe } from '../src/perf/importPerfProbe.js'

test('禁用态：isEnabled() false，所有 API no-op 不抛错、无副作用', () => {
  assert.equal(perfProbe.isEnabled(), false)
  assert.doesNotThrow(() => perfProbe.startSession('x'))
  assert.doesNotThrow(() => perfProbe.setMeta({ a: 1 }))
  assert.doesNotThrow(() => perfProbe.mark('T1'))
  assert.doesNotThrow(() => perfProbe.count('a'))
  const end = perfProbe.begin('d')
  assert.equal(typeof end, 'function')
  assert.doesNotThrow(() => end())
  assert.doesNotThrow(() => perfProbe.time('t', () => 42))
  assert.equal(perfProbe.getReport(), null)
  assert.equal(perfProbe.finishSession('test'), null)
  assert.equal(perfProbe.dump(), null)
})

test('开启态：startSession 自动打 T0，mark/count/begin 聚合正确', () => {
  perfProbe.enable('1')
  assert.equal(perfProbe.isEnabled(), true)
  perfProbe.startSession('self-test')
  perfProbe.count('hit')
  perfProbe.count('hit', 5)
  perfProbe.mark('T1')
  const end = perfProbe.begin('derive')
  const t = Date.now()
  while (Date.now() - t < 20) { /* 忙等 ~20ms 模拟耗时（r1 取整留余量） */ }
  end()
  const report = perfProbe.finishSession('unit-test')
  assert.ok(report, '开启态 finishSession 必须返回报告')
  assert.equal(report.id, 1)
  assert.equal(report.marksRel.T0, 0, 'T0 是相对基准')
  assert.ok(report.marksRel.T1 > 0, 'T1 相对 T0 为正')
  assert.equal(report.counters.hit, 6, 'count 累加 + 增量')
  assert.ok(report.durations.derive.n === 1)
  assert.ok(report.durations.derive.total >= 15, `total=${report.durations.derive.total} 应≥15ms`)
  assert.ok(report.durations.derive.max >= 15)
  assert.ok(report.durations.derive.avg >= 15)
  assert.equal(report.derived.whiteScreenMs, null, '无 T5/T6 → KPI 为 null 不炸')
  assert.equal(typeof report.longTasks.supported, 'boolean')
  assert.equal(typeof report.t0Wall, 'string')
})

test('mark first-wins：同锚点重复调用不覆盖', () => {
  perfProbe.startSession('first-wins')
  perfProbe.mark('T1')
  const first = perfProbe.getReport().marksRel.T1
  perfProbe.mark('T1') // 第二次调用（更晚）不应覆盖
  const second = perfProbe.getReport().marksRel.T1
  assert.equal(first, second)
  perfProbe.finishSession('unit')
})

test('T4 重置 T6/T6p/T7：白屏窗口锚点重定位', () => {
  // 场景：导入过程中占位符导致 FileList commit（T6 提前打上），
  // 100% 时应清除这些锚点，让「100% 之后的首次 commit」成为真正的白屏终点。
  perfProbe.startSession('t4-reset')
  perfProbe.mark('T6')   // 占位符 commit（应被 T4 清除）
  perfProbe.mark('T6p')
  perfProbe.mark('T7')   // 占位符预览（应被 T4 清除）
  perfProbe.mark('T4')   // 进度 100% → 清 T6/T6p/T7
  perfProbe.mark('T5')   // 弹窗关闭
  perfProbe.mark('T6')   // 100% 后的首次 commit（应保留）
  const r = perfProbe.finishSession('unit')
  assert.ok(r.marksRel.T4 !== undefined)
  assert.ok(r.marksRel.T5 !== undefined)
  assert.ok(r.marksRel.T6 !== undefined, 'T4 之后的 T6 必须保留')
  assert.ok(r.derived.whiteScreenMs >= 0, `T5<T6 时序下 whiteScreenMs=${r.derived.whiteScreenMs} 应为非负（同毫秒内可为 0）`)
})

test('T4 重置（反向顺序）：T4 之后无 T6 时报告不炸', () => {
  perfProbe.startSession('t4-reset-2')
  perfProbe.mark('T4')
  perfProbe.mark('T5')
  const r = perfProbe.finishSession('unit')
  assert.equal(r.derived.whiteScreenMs, null)
  assert.equal(r.derived.whiteToPaintMs, null)
})

test('T4 重置保留 T6_pre：可判定「弹窗关闭前列表是否已渲染」', () => {
  // 为什么必须留档：只保留「T4 之后的 T6」会丢掉关键判据 ——
  // 若列表在弹窗关闭前就已 commit，白屏根本不是列表渲染问题，归因方向完全不同。
  perfProbe.startSession('t4-keep-pre')
  perfProbe.mark('T6')   // 弹窗还开着时的占位符 commit
  perfProbe.mark('T4')   // 进度 100% → 清 T6，但留档为 T6_pre
  perfProbe.mark('T5')   // 弹窗关闭
  const r = perfProbe.finishSession('unit')
  assert.ok(r.marksRel.T6_pre !== undefined, 'T4 重置前的 T6 必须留档为 T6_pre')
  assert.equal(r.marksRel.T6, undefined, 'T4 之后的 T6 尚未触发，应为 undefined')
  assert.equal(r.derived.listReadyBeforeDismiss, true, 'T6_pre 早于 T5 → 列表在弹窗关闭前已渲染')
  assert.ok(r.derived.commitVsDismissMs <= 0, `commitVsDismissMs=${r.derived.commitVsDismissMs} 应 ≤ 0`)
  assert.ok(r.derived.firstCommitMs >= 0, 'firstCommitMs 有值（首次 commit 相对 T0）')
})

test('T6 全程未触发：判据字段为 null 而非 0，missingMarks 含 T6', () => {
  perfProbe.startSession('no-t6')
  perfProbe.mark('T4')
  perfProbe.mark('T5')
  const r = perfProbe.finishSession('unit')
  assert.equal(r.derived.whiteScreenMs, null)
  assert.equal(r.derived.commitVsDismissMs, null, '既无 T6_pre 也无 T6 → null，不能用 0 冒充')
  assert.equal(r.derived.firstCommitMs, null)
  assert.equal(r.derived.listReadyBeforeDismiss, null)
  assert.ok(r.missingMarks.includes('T6'), `missingMarks=${JSON.stringify(r.missingMarks)} 应含 T6`)
  assert.ok(!r.missingMarks.includes('T4'), '已打的 T4 不应出现在 missingMarks')
  assert.ok(!r.missingMarks.includes('T5'), '已打的 T5 不应出现在 missingMarks')
  assert.ok(!r.missingMarks.includes('T0'), 'startSession 自动打的 T0 不应出现在 missingMarks')
})

test('T6 落在 T4 与 T5 之间：仍应判为「弹窗关闭前已渲染」', () => {
  // T4 到 T5 之间还有 2 帧 + 250ms 的窗口，列表完全可能在这段时间内 commit。
  // 早期实现写成「有 T6 就判 false」，会把这种情况误判为白屏真实存在。
  perfProbe.startSession('t6-between')
  perfProbe.mark('T4')
  perfProbe.mark('T6')   // commit 发生在弹窗关闭之前
  perfProbe.mark('T5')
  const r = perfProbe.finishSession('unit')
  assert.equal(r.derived.listReadyBeforeDismiss, true, 'T6 早于 T5 → 关闭前已渲染，不能判 false')
  assert.ok(r.derived.commitVsDismissMs <= 0, `commitVsDismissMs=${r.derived.commitVsDismissMs} 应 ≤ 0`)
  assert.ok(r.derived.whiteScreenMs <= 0, '此时 whiteScreenMs 为非正值，本身不代表白屏时长')
})

test('missingMarks：全锚点齐备时为空数组', () => {
  perfProbe.startSession('all-marks')
  // missingMarks 扫描清单 = T0..T7 + previewRenderStart/End（1B 起），须全部打上
  for (const k of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'previewRenderStart', 'previewRenderEnd']) perfProbe.mark(k)
  const r = perfProbe.finishSession('unit')
  assert.deepEqual(r.missingMarks, [], '全锚点齐备 → 空数组')
})

test('begin/end 幂等：重复 end 只记一次', () => {
  perfProbe.startSession('idem')
  const end = perfProbe.begin('d2')
  end()
  end()
  end()
  const r = perfProbe.finishSession('unit')
  assert.equal(r.durations.d2.n, 1)
})

test('finishSession 幂等：重复结算 id 一致、计数不重置', () => {
  perfProbe.startSession('fin')
  perfProbe.count('x')
  const r1 = perfProbe.finishSession('a')
  perfProbe.count('x')
  const r2 = perfProbe.finishSession('b')
  assert.equal(r1.id, r2.id)
  assert.equal(r2.counters.x, r1.counters.x + 1, '结算后 count 追加仍被后续报告读到')
})

test('time 包装：返回值透传，关闭态零开销', () => {
  perfProbe.disable()
  const v = perfProbe.time('wrapped', () => 123)
  assert.equal(v, 123)
  assert.equal(perfProbe.isEnabled(), false)
})

// ── PERF-WHITE-1 1B：previewRenderStart/End 锚点（T4 留档 + A/B/C/D 判据）──

test('1B：T4 重置保留 previewRender*_pre（导入期渲染被留档）', () => {
  perfProbe.enable('1')
  perfProbe.startSession('1b-pre-archival')
  perfProbe.mark('previewRenderStart')   // 导入中（T4 前）的一次渲染尝试
  perfProbe.mark('previewRenderEnd')
  perfProbe.mark('T4')                    // 100% → 清锚点但留档 *_pre
  perfProbe.mark('T5')                    // 弹窗关闭
  const r = perfProbe.finishSession('unit')
  assert.ok(r.marksRel.previewRenderStart_pre !== undefined, 'T4 前的 start 必须留档 *_pre')
  assert.ok(r.marksRel.previewRenderEnd_pre !== undefined, 'T4 前的 end 必须留档 *_pre')
  assert.equal(r.marksRel.previewRenderStart, undefined, 'T4 后无新尝试 → 当前锚点应为 undefined')
  assert.equal(r.derived.previewStartAfterDismissMs, null)
  assert.equal(r.derived.previewStartedBeforeDismiss, true, '有 *_pre → 渲染发生在 100% 之前')
  assert.ok(r.missingMarks.includes('previewRenderStart'), 'T4 后未重打 → 应进缺失清单')
})

test('1B：100% 后渲染完成（D 方向）：start/end 判据齐全且为数值', () => {
  perfProbe.startSession('1b-done')
  perfProbe.mark('T4')
  perfProbe.mark('T5')
  perfProbe.mark('previewRenderStart')    // 100% 后开始渲染
  perfProbe.mark('previewRenderEnd')      // 并完成
  const r = perfProbe.finishSession('unit')
  assert.ok(r.marksRel.previewRenderStart_pre === undefined, '无 T4 前尝试 → 无 *_pre 留档')
  assert.ok(r.derived.previewStartAfterDismissMs >= 0, `start 滞后=${r.derived.previewStartAfterDismissMs} 应 ≥ 0`)
  assert.ok(r.derived.previewEndAfterDismissMs >= r.derived.previewStartAfterDismissMs, 'end 不早于 start')
  assert.ok(r.derived.previewWorkMs >= 0, `work=${r.derived.previewWorkMs} 应 ≥ 0`)
  assert.equal(r.derived.previewStartedBeforeDismiss, false, '渲染在 100% 之后 → false')
  assert.ok(!r.missingMarks.includes('previewRenderStart'), '已打锚点不应进缺失清单')
  assert.ok(!r.missingMarks.includes('previewRenderEnd'))
})

test('1B：100% 后渲染开始但未完成（C 方向）：end 缺失 → 判据区分', () => {
  perfProbe.startSession('1b-started-no-end')
  perfProbe.mark('T4')
  perfProbe.mark('T5')
  perfProbe.mark('previewRenderStart')    // 渲染开始了……
  // ……观察窗结束时仍未完成（end 缺失）
  const r = perfProbe.finishSession('unit')
  assert.ok(r.derived.previewStartAfterDismissMs >= 0, 'start 有值 → 有渲染尝试')
  assert.equal(r.derived.previewEndAfterDismissMs, null, 'end 缺失 → null 而非 0')
  assert.equal(r.derived.previewWorkMs, null)
  assert.ok(r.missingMarks.includes('previewRenderEnd'), '缺失的 end 应进 missingMarks')
  assert.ok(!r.missingMarks.includes('previewRenderStart'), '已打的 start 不应进 missingMarks')
})

// ── PERF-WHITE-1 P0：epoch 世代守卫（陈旧异步回调污染锚点缺陷）──
//
// 缺陷现场（run-261 与 run-261-1B 两轮数据均中招）：
//   FileList 在 T0+20.8ms 的 commit 里排程了 rAF→setTimeout(()=>mark('T6p'))，
//   该回调被主线程 long task 饿到 **T4 之后 67 秒** 才执行。此时 T4 已经把
//   T6p 清掉过，于是这个「20.8ms 那次 commit 的 paint」被当成 100% 后的首次 paint
//   记录下来 → T6p(67878.1) 竟早于 T6(98307.5) 30.4 秒（paint 早于 commit 物理上不可能）。
//   run-261 基线 T6p = T4+5.1ms 同病，导致「关闭前已 paint」结论部分失效。
//
// 修法：T4 递增 epoch；异步回调在排程时捕获 epoch，回调比对不符即作废。

test('P0：stamp() 在 T4 前后返回不同 epoch（世代隔离）', () => {
  perfProbe.enable('1')
  perfProbe.startSession('epoch-bump')
  const e0 = perfProbe.stamp()
  assert.equal(typeof e0, 'number')
  perfProbe.mark('T4')          // 100% → 世代 +1
  const e1 = perfProbe.stamp()
  assert.equal(e1, e0 + 1, 'T4 必须把 epoch 推进 1')
  // ⚠️ 交互固化：T4 本身受 first-wins 约束，重复调用是 no-op → epoch **不**再推进。
  // 即「一个会话内世代只前进一次（首次 100%）」，这也是我们要的语义：
  // 白屏窗口起点 = 首次 100%，后续重复的 100% 不应再重置锚点 / 作废回调。
  perfProbe.mark('T4')          // 重复的 100%（多批导入场景）
  assert.equal(perfProbe.stamp(), e0 + 1, 'T4 first-wins → epoch 不再推进')
  perfProbe.finishSession('unit')
})

test('P0：陈旧 T6p 落 _stale 留证，不污染真锚点（run-261 缺陷复现）', () => {
  perfProbe.startSession('epoch-stale-t6p')
  const e0 = perfProbe.stamp()
  perfProbe.mark('T6', e0)      // 导入期占位符 commit
  perfProbe.mark('T4')          // 100% → T6 归档为 T6_pre，epoch 推进
  perfProbe.mark('T5')          // 弹窗关闭
  // 模拟：20.8ms 排程的 setTimeout 回调，被 long task 饿了 60 秒才执行
  perfProbe.mark('T6p', e0)     // 陈旧世代 → 必须作废
  const r = perfProbe.finishSession('unit')
  assert.equal(r.marksRel.T6p, undefined, '陈旧 paint 绝不能写入真锚点')
  assert.ok(r.marksRel.T6p_stale !== undefined, '应落 T6p_stale 留证（不丢证据）')
  assert.equal(r.counters.staleMarks, 1, '作废次数应可见')
  assert.equal(r.derived.whiteToPaintMs, null, '作废后 whiteToPaintMs 为 null，不是伪造的小值')
  assert.equal(r.derived.paintGapMs, null)
  assert.ok(r.marksRel.T6_pre !== undefined, '导入期 commit 仍留档 T6_pre')
})

test('P0：同世代的 T6p 正常记录（epoch 守卫不误杀）', () => {
  perfProbe.startSession('epoch-fresh-t6p')
  perfProbe.mark('T4')
  perfProbe.mark('T5')
  const e = perfProbe.stamp()   // 100% 之后的世代
  perfProbe.mark('T6', e)
  perfProbe.mark('T6p', e)      // 同世代 → 正常记录
  const r = perfProbe.finishSession('unit')
  assert.ok(r.marksRel.T6 !== undefined, '同世代 T6 必须记录')
  assert.ok(r.marksRel.T6p !== undefined, '同世代 T6p 必须记录')
  assert.equal(r.marksRel.T6p_stale, undefined, '不该落 _stale')
  assert.equal(r.counters.staleMarks, undefined, '不该计 staleMarks')
  assert.ok(r.derived.whiteScreenMs >= 0)
  assert.ok(r.derived.paintGapMs >= 0, `paintGap=${r.derived.paintGapMs} 应 ≥ 0（同毫秒内可为 0）`)
  assert.ok(r.derived.whiteToPaintMs >= 0)
})

test('P0：跨 T4 的在途预览渲染不得伪造 D 判定', () => {
  perfProbe.startSession('epoch-inflight-render')
  const e0 = perfProbe.stamp()
  perfProbe.mark('previewRenderStart', e0)   // T4 前就开始渲染
  perfProbe.mark('T4')                        // 100% → start 归档 _pre
  perfProbe.mark('T5')                        // 弹窗关闭
  perfProbe.mark('previewRenderEnd', e0)      // 在途渲染直到 T4 后才完成
  const r = perfProbe.finishSession('unit')
  assert.ok(r.marksRel.previewRenderStart_pre !== undefined, 'T4 前的 start 归档 _pre')
  assert.equal(r.marksRel.previewRenderEnd, undefined, '在途完成不得写入真 end —— 否则伪造 D「渲染完成」')
  assert.ok(r.marksRel.previewRenderEnd_stale !== undefined, '落 _stale 留证')
  assert.equal(r.derived.previewStartAfterDismissMs, null, '100% 后无新尝试 → 仍是 A 方向，不被伪造')
  assert.equal(r.derived.previewStartedBeforeDismiss, true)
})

test('P0：禁用态 stamp() 返回 0，带 epoch 的 mark 为 no-op', () => {
  perfProbe.disable()
  assert.equal(perfProbe.stamp(), 0, '关闭态 epoch 恒为 0（调用方无需判空）')
  assert.doesNotThrow(() => perfProbe.mark('T6', 7))
  assert.doesNotThrow(() => perfProbe.mark('T6p', 7))
  assert.equal(perfProbe.getReport(), null)
})

// ── 回退期缺陷：clipboard 模式结算不得逃逸 unhandled rejection ──
//
// 现场（主线 92b2460 实测，2026-09-04）：
//   弹窗关闭 15s 后 finishSession 自动结算（useFileOps.js:1140）。此时窗口通常已经失焦 →
//   navigator.clipboard.writeText reject `NotAllowedError: Document is not focused`。
//   原实现用**同步** try/catch 包**异步** Promise —— 同步块捕获不到 rejection，
//   逃逸为「Uncaught (in promise) NotAllowedError」，既污染控制台也干扰取证判读。
//
// 语义约定：剪贴板只是「无 DevTools 环境取数」的旁路，失败必须静默 ——
//   报告始终另有两条取数路径：console.log('[PERF_REPORT]') 与 localStorage REPORT_KEY。

test('clipboard 模式：writeText 被拒绝时不逃逸为 unhandled rejection', async () => {
  const prevNavigator = globalThis.navigator
  const unhandled = []
  const onUnhandled = (err) => { unhandled.push(err) }
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: () => Promise.reject(
            Object.assign(new Error('Document is not focused'), { name: 'NotAllowedError' }),
          ),
        },
      },
      configurable: true,
      writable: true,
    })
    process.on('unhandledRejection', onUnhandled)
    perfProbe.enable('clipboard')
    perfProbe.startSession('clipboard-reject')
    perfProbe.mark('T4')
    const r = perfProbe.finishSession('unit')
    assert.ok(r, '剪贴板失败不应影响报告产出')
    await new Promise((resolve) => { setTimeout(resolve, 10) })   // 给 rejection 一个浮出窗口
  } finally {
    process.off('unhandledRejection', onUnhandled)
    if (prevNavigator === undefined) {
      try { delete globalThis.navigator } catch { /* 不可删则保持替身 */ }
    } else {
      Object.defineProperty(globalThis, 'navigator', { value: prevNavigator, configurable: true, writable: true })
    }
    perfProbe.disable()
  }
  assert.deepEqual(unhandled, [], `writeText rejection 不得逃逸：${unhandled.map((e) => e && e.name).join(',')}`)
})
