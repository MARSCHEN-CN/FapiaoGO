/**
 * previewTrace 自检 —— R2 取证工具的自身可信度保障。
 *
 * 为什么探针也要测试：本模块是 R2 全部结论的唯一数据源。
 * 它若「静默丢事件 / 关闭态仍有副作用 / caller 归因错位」，
 * 我们拿到的时间轴就是假的，比没有探针更危险。
 *
 * 运行：
 *   cd frontend && node --test test/previewTrace.test.mjs
 *
 * @module test/previewTrace
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  previewTrace,
  previewTraceLog,
  previewTraceState,
  previewTraceReset,
  previewTraceSetEnabled,
  previewTraceReport,
  snapshotFlags,
  docIdOf,
  parseFrame,
  callerOf,
  callerFrames,
} from '../src/perf/previewTrace.js'

/** 临时接管 console.log，返回 {calls, restore} */
function captureConsole() {
  const calls = []
  const original = console.log
  console.log = (...args) => { calls.push(args) }
  return {
    calls,
    restore() { console.log = original },
  }
}

test('R2-T0：默认关闭 —— log/state 返回 null，不写事件、不碰 console', () => {
  assert.equal(previewTrace.on, false, '导入即关闭（环境无开关标志）')

  previewTraceReset()
  const cap = captureConsole()
  let r1
  let r2
  try {
    r1 = previewTraceLog('HANDLE_PREVIEW', { key: 'k1' })
    r2 = previewTraceState('RETRY_SKIP', { reason: 'x' }, 'tag')
  } finally {
    cap.restore()
  }

  assert.equal(r1, null)
  assert.equal(r2, null)
  assert.equal(cap.calls.length, 0, '关闭态不得产生任何 console 输出')
  assert.equal(previewTraceReport().eventCount, 0, '关闭态不得写入环形缓冲')
})

test('R2-T1：开启后记录 seq / t / type / caller / fields 并计数', () => {
  previewTraceSetEnabled(true)
  previewTraceReset()

  const cap = captureConsole()
  try {
    previewTraceLog('HANDLE_PREVIEW', { intent: 'select', key: 'k1' })
    previewTraceLog('LOAD_RETURN', { key: 'k1', hasPdfData: false })
    previewTraceState('RETRY_SKIP', { reason: 'no-previewFile' }, 'usePreview:2129')
  } finally {
    cap.restore()
  }

  const rep = previewTraceReport()
  assert.equal(rep.eventCount, 3)
  assert.deepEqual(rep.counters, {
    HANDLE_PREVIEW: 1,
    LOAD_RETURN: 1,
    RETRY_SKIP: 1,
  })

  assert.equal(rep.events[0].seq, 1)
  assert.equal(rep.events[0].type, 'HANDLE_PREVIEW')
  assert.deepEqual(rep.events[0].fields, { intent: 'select', key: 'k1' })
  assert.equal(typeof rep.events[0].t, 'number')
  assert.equal(rep.events[2].caller, 'usePreview:2129', 'state() 用显式 tag 作 caller')

  assert.equal(cap.calls.length, 3, '开启态每条事件输出一行 console')
  assert.equal(cap.calls[0][0], '[P2-PREVIEW]')

  previewTraceSetEnabled(false)
})

test('R2-T2：环形缓冲上限 —— 溢出丢最旧并计入 dropped，counters 不丢', () => {
  previewTraceSetEnabled(true)
  previewTraceReset()

  const cap = captureConsole()
  const N = 4001
  try {
    for (let i = 0; i < N; i++) previewTraceLog('FLOOD', { i })
  } finally {
    cap.restore()
  }

  const rep = previewTraceReport()
  assert.equal(rep.eventCount, 4000, '缓冲上限 4000')
  assert.equal(rep.dropped, 1, '溢出 1 条')
  assert.equal(rep.counters.FLOOD, N, '计数器统计真实发生次数，不受缓冲裁剪影响')
  assert.equal(rep.events[0].fields.i, 1, '保留最新 4000 条（最旧的 i=0 被丢）')
  assert.equal(rep.events[rep.events.length - 1].fields.i, N - 1)

  previewTraceSetEnabled(false)
})

test('R2-T3：reset 清空 events / counters / dropped，seq 归零', () => {
  previewTraceSetEnabled(true)
  const cap = captureConsole()
  try {
    previewTraceLog('X', {})
  } finally { cap.restore() }

  previewTraceReset()
  const rep = previewTraceReport()
  assert.equal(rep.eventCount, 0)
  assert.equal(rep.dropped, 0)
  assert.deepEqual(rep.counters, {})

  const cap2 = captureConsole()
  try {
    previewTraceLog('Y', {})
  } finally { cap2.restore() }
  assert.equal(previewTraceReport().events[0].seq, 1, 'reset 后 seq 从 1 重新计数')

  previewTraceSetEnabled(false)
})

test('R2-T4：parseFrame 归一 V8 栈帧', () => {
  assert.equal(
    parseFrame('handlePreview (http://localhost:5173/src/hooks/usePreview.js:2008:11)'),
    'handlePreview@hooks/usePreview.js:2008:11',
  )
  // 保留两级路径（src/App.jsx）而非裸文件名：Electron 下同名文件更多，需要目录消歧
  assert.equal(
    parseFrame('http://localhost:5173/src/App.jsx:994:7'),
    'src/App.jsx:994:7',
  )
  // React 内部匿名帧：函数名被归一为 <anonymous>
  assert.equal(
    parseFrame('at Object.<anonymous> (file:///E:/print706/frontend/src/App.jsx:1019:9)'),
    '<anonymous>@src/App.jsx:1019:9',
  )
  assert.equal(parseFrame(''), 'unknown')
  assert.equal(parseFrame(null), 'unknown')
  assert.equal(parseFrame(undefined), 'unknown')
  assert.equal(parseFrame('   '), 'unknown', '纯空白 → unknown')
  // 注意：'at ' 经 trim 后变成 'at'，无法识别为栈帧 → 原样返回（不是 unknown，也不抛）
  assert.equal(parseFrame('at '), 'at')
})

test('R2-T5：callerOf 跳过 previewTrace 自身帧，skip 语义正确', () => {
  // 构造合成栈：第 1 帧是探针内部（应被剔除），其后是真实调用链
  const stack = [
    'Error',
    '    at emit (http://localhost:5173/src/perf/previewTrace.js:180:5)',
    '    at Object.previewTraceLog (http://localhost:5173/src/perf/previewTrace.js:200:10)',
    '    at handlePreview (http://localhost:5173/src/hooks/usePreview.js:2008:11)',
    '    at http://localhost:5173/src/App.jsx:994:7',
    '    at commitHookEffectListMount (http://localhost:5173/node_modules/react-dom/xx.js:1:1)',
  ].join('\n')

  assert.equal(
    callerOf(stack, 0),
    'handlePreview@hooks/usePreview.js:2008:11',
    'skip=0 → log() 的直接调用者',
  )
  assert.equal(
    callerOf(stack, 1),
    'src/App.jsx:994:7',
    'skip=1 → 真实来源（App 自动预览场景 1）',
  )
  assert.equal(callerOf(stack, 2), 'commitHookEffectListMount@react-dom/xx.js:1:1')
  assert.equal(callerOf(stack, 99), 'commitHookEffectListMount@react-dom/xx.js:1:1', 'skip 越界 → 取最后一帧')
  assert.equal(callerOf('', 0), 'unknown')
  assert.equal(callerOf(null, 1), 'unknown')
})

test('R2-T6：log 的 skip 端到端生效（显式栈，规避 V8 内联不确定性）', () => {
  // ⚠️ 为什么用显式栈：V8 在 JIT 预热后会把小函数内联并**抹掉其栈帧**
  //    （本文件 R2-T2 跑过 4001 次循环后实测：三级嵌套小函数全被抹，
  //     skip=1 落到 Test.run 而非 appAutoPreviewScenario1）。
  //    跳过 V8 直接注入栈，才能让这条断言对 JIT 状态不敏感。
  const stack = [
    'Error',
    '    at Object.previewTraceLog (http://localhost:5173/src/perf/previewTrace.js:200:10)',
    '    at handlePreview (http://localhost:5173/src/hooks/usePreview.js:2008:11)',
    '    at http://localhost:5173/src/App.jsx:1009:9',
  ].join('\n')

  previewTraceSetEnabled(true)
  previewTraceReset()
  const cap = captureConsole()
  try {
    previewTraceLog('HANDLE_PREVIEW', { intent: 'select' }, { stack, skip: 1 })
  } finally { cap.restore() }

  const ev = previewTraceReport().events[0]
  assert.equal(ev.caller, 'src/App.jsx:1009:9', 'skip=1 → App 自动预览场景 3 的真实行')
  previewTraceSetEnabled(false)
})

test('R2-T6b：自然语言栈归因 —— 只保证「有归因」，不保证精确帧（内联 caveat）', () => {
  previewTraceSetEnabled(true)
  previewTraceReset()
  const cap = captureConsole()
  try {
    previewTraceLog('NATURAL_STACK', { intent: 'select' }, { skip: 1 })
  } finally { cap.restore() }

  const ev = previewTraceReport().events[0]
  assert.ok(typeof ev.caller === 'string' && ev.caller.length > 0, 'caller 必须是非空字符串')
  assert.notEqual(ev.caller, 'unknown', '即使被内联也应落到某个真实帧')
  // 记录 caveat：此处不断言具体函数名，因为 V8 是否内联取决于 JIT 状态。
  // 真机取证依赖 callerFrames() 存的调用链做人工核对。
  previewTraceSetEnabled(false)
})

test('R2-T7：snapshotFlags —— 空壳判据（R2-3 核心）', () => {
  assert.deepEqual(snapshotFlags(undefined), {
    hasPreviewImageUrl: false, hasPdfData: false, hasPreviewImage: false,
  })
  assert.deepEqual(snapshotFlags(null), {
    hasPreviewImageUrl: false, hasPdfData: false, hasPreviewImage: false,
  })
  // 典型空壳：只有身份，无任何视觉内容
  assert.deepEqual(snapshotFlags({ key: 'f1', docId: null }), {
    hasPreviewImageUrl: false, hasPdfData: false, hasPreviewImage: false,
  })
  assert.deepEqual(snapshotFlags({ _previewImageUrl: 'blob:x' }), {
    hasPreviewImageUrl: true, hasPdfData: false, hasPreviewImage: false,
  })
  assert.deepEqual(snapshotFlags({ _pdfData: new Uint8Array([1]) }), {
    hasPreviewImageUrl: false, hasPdfData: true, hasPreviewImage: false,
  })
  assert.deepEqual(snapshotFlags({ previewImage: 'data:image/png;base64,AA' }), {
    hasPreviewImageUrl: false, hasPdfData: false, hasPreviewImage: true,
  })
})

test('R2-T8：docIdOf —— 三处约定的统一口径', () => {
  assert.equal(docIdOf(null), null)
  assert.equal(docIdOf(undefined), null)
  assert.equal(docIdOf({}), null)
  assert.equal(docIdOf({ docId: '' }), null, '空串归一为 null')
  assert.equal(docIdOf({ docId: 'abc123' }), 'abc123')
  assert.equal(docIdOf({ identity: { docId: 'ident1' } }), 'ident1', '回落 identity.docId')
  assert.equal(docIdOf({ docId: 'top', identity: { docId: 'nested' } }), 'top', 'docId 优先')
})

test('R2-T9：dump 产出可 JSON.parse 的报告，且 counters 完整', () => {
  previewTraceSetEnabled(true)
  previewTraceReset()
  const cap = captureConsole()
  try {
    previewTraceLog('COMMIT_SUCCESS', { key: 'k1' })
    previewTraceState('RETRY_FIRE', {}, 'usePreview:2138')
  } finally { cap.restore() }

  const text = previewTrace.dump()
  const parsed = JSON.parse(text)
  assert.equal(parsed.eventCount, 2)
  assert.deepEqual(parsed.counters, { COMMIT_SUCCESS: 1, RETRY_FIRE: 1 })
  assert.equal(parsed.events.length, 2)

  previewTraceSetEnabled(false)
})

test('R2-T10：disable 后再次静默（可随时关灯）', () => {
  previewTraceSetEnabled(true)
  previewTraceReset()
  previewTraceSetEnabled(false)

  const cap = captureConsole()
  try {
    previewTraceLog('AFTER_OFF', {})
  } finally { cap.restore() }

  assert.equal(previewTraceReport().eventCount, 0)
  assert.equal(cap.calls.length, 0)
})
